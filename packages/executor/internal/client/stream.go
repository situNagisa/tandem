package client

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"sync"

	"tandem/executor/internal/ops"
	"tandem/executor/internal/wire"
)

// stream 是一条请求。发送方向（exec→ws）受对端回的 FLOW 限制；接收方向（ws→exec）按消费量回 FLOW。
type stream struct {
	c   *conn
	id  uint32
	ctx context.Context
	// cancel 由 CANCEL 帧、连接断开或请求结束触发。
	cancel context.CancelFunc

	mu      sync.Mutex
	changed chan struct{} // 状态变化时关闭并替换，用于唤醒等待方
	credit  int64         // 还能发给工作站的字节数
	in      [][]byte      // 已收未读的请求体分片
	inEnd   bool
	recvd   int64 // 已收请求体字节
	acked   int64 // 已经回过 FLOW 的字节
	pending int64 // 已消费、尚未回 FLOW 的字节
}

func newStream(parent *conn, id uint32) *stream {
	ctx, cancel := context.WithCancel(parent.ctx)
	return &stream{
		c:       parent,
		id:      id,
		ctx:     ctx,
		cancel:  cancel,
		changed: make(chan struct{}),
		credit:  wire.Window,
	}
}

func (s *stream) notifyLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *stream) grant(n int64) {
	s.mu.Lock()
	s.credit += n
	s.notifyLocked()
	s.mu.Unlock()
}

func (s *stream) acquire(n int) error {
	for {
		if err := s.ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		if s.credit >= int64(n) {
			s.credit -= int64(n)
			s.mu.Unlock()
			return nil
		}
		ch := s.changed
		s.mu.Unlock()
		select {
		case <-ch:
		case <-s.ctx.Done():
		}
	}
}

// push 接收工作站的 DATA 帧；超过单帧或窗口上限是协议错误。
func (s *stream) push(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inEnd {
		return errProtocol("END 之后收到 DATA")
	}
	n := int64(len(data))
	if n > wire.MaxData {
		return errProtocol("DATA 帧超过 64 KiB")
	}
	if s.recvd-s.acked+n > wire.Window {
		return errProtocol("超出接收窗口")
	}
	s.recvd += n
	if n > 0 {
		s.in = append(s.in, data)
		s.notifyLocked()
	}
	return nil
}

func (s *stream) endIn() {
	s.mu.Lock()
	s.inEnd = true
	s.notifyLocked()
	s.mu.Unlock()
}

// finish 发送 END（成功是结果 JSON，失败是 {"error": …}）。
func (s *stream) finish(res any, e *ops.Error) {
	var payload []byte
	switch {
	case e != nil:
		payload, _ = json.Marshal(map[string]any{"error": e})
	case res == nil:
		payload = []byte("{}")
	default:
		payload, _ = json.Marshal(res)
	}
	_ = s.c.writeFrame(wire.End, s.id, payload)
	s.cancel()
}

// Context、Stdout、Stderr、DataOut、DataIn 实现 ops.Stream。

func (s *stream) Context() context.Context { return s.ctx }
func (s *stream) Stdout() io.Writer        { return &chunkWriter{s: s, typ: wire.Out} }
func (s *stream) Stderr() io.Writer        { return &chunkWriter{s: s, typ: wire.Err} }
func (s *stream) DataOut() io.Writer       { return &chunkWriter{s: s, typ: wire.Data} }
func (s *stream) DataIn() io.Reader        { return dataIn{s: s} }

type chunkWriter struct {
	s   *stream
	typ byte
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		k := min(len(p), wire.MaxData)
		if err := w.s.acquire(k); err != nil {
			return n, err
		}
		if err := w.s.c.writeFrame(w.typ, w.s.id, p[:k]); err != nil {
			return n, err
		}
		p = p[k:]
		n += k
	}
	return n, nil
}

type dataIn struct{ s *stream }

func (r dataIn) Read(p []byte) (int, error) {
	s := r.s
	for {
		s.mu.Lock()
		if len(s.in) > 0 {
			n := copy(p, s.in[0])
			s.in[0] = s.in[0][n:]
			if len(s.in[0]) == 0 {
				s.in = s.in[1:]
			}
			s.pending += int64(n)
			var ack int64
			if s.pending >= wire.FlowEvery {
				ack = s.pending
				s.pending = 0
				s.acked += ack
			}
			s.mu.Unlock()
			if ack > 0 {
				var b [4]byte
				binary.BigEndian.PutUint32(b[:], uint32(ack))
				_ = s.c.writeFrame(wire.Flow, s.id, b[:])
			}
			return n, nil
		}
		if s.inEnd {
			s.mu.Unlock()
			return 0, io.EOF
		}
		ch := s.changed
		s.mu.Unlock()
		select {
		case <-ch:
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		}
	}
}
