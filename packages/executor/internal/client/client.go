// Package client 负责执行器到工作站的出站连接：登记、握手、心跳、断线重连与请求分发。
package client

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	websocket "github.com/coder/websocket"

	"tandem/executor/internal/identity"
	"tandem/executor/internal/ops"
	"tandem/executor/internal/wire"
)

const (
	handshakeTimeout = 15 * time.Second
	idleTimeout      = 45 * time.Second // 工作站每 15 秒 PING，45 秒无任何帧即视为断线
	writeTimeout     = 30 * time.Second
	tokenTTL         = 15 * time.Minute
	maxBackoff       = 30 * time.Second
	maxConcurrent    = 32
)

// fatalError 表示重试无意义（指纹不符、身份文件与工作站不一致等），Serve 直接返回。
type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }
func (e *fatalError) Unwrap() error { return e.err }

func errProtocol(msg string) error { return fmt.Errorf("协议错误：%s", msg) }

type Client struct {
	home string
	log  *log.Logger
	http *http.Client
	// sem 限制同一进程内同时运行的请求数，断线重连后仍然生效。
	sem chan struct{}
}

func New(home string, logger *log.Logger) *Client {
	return &Client{
		home: home,
		log:  logger,
		http: &http.Client{Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			// 对端由握手签名认证（工作站公钥由令牌指纹或身份文件固定），TLS 只用于隐藏流量，内网自签证书可用。
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}},
		sem: make(chan struct{}, maxConcurrent),
	}
}

type enrollment struct {
	server   string
	token    string
	fp       string
	pub      ed25519.PublicKey
	priv     ed25519.PrivateKey
	deadline time.Time
}

// Serve 常驻连接工作站。身份文件存在时直接用它连接；否则用 token 首次登记。
func (c *Client) Serve(ctx context.Context, server, token string) error {
	id, err := identity.Load(c.home)
	var enr *enrollment
	switch {
	case err == nil:
		if token != "" {
			c.log.Printf("身份文件已存在，忽略 --token，按已登记身份连接 %s", id.Server)
		}
	case errors.Is(err, os.ErrNotExist):
		if token == "" {
			return errors.New("尚未登记：请执行 tandem-exec join --server <工作站> --token <令牌>")
		}
		if enr, err = newEnrollment(server, token); err != nil {
			return err
		}
	default:
		return err
	}
	return c.loop(ctx, id, enr)
}

func newEnrollment(server, token string) (*enrollment, error) {
	server = strings.TrimRight(server, "/")
	if _, err := wsURL(server); err != nil {
		return nil, err
	}
	fp, err := parseToken(token)
	if err != nil {
		return nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &enrollment{
		server:   server,
		token:    token,
		fp:       fp,
		pub:      pub,
		priv:     priv,
		deadline: time.Now().Add(tokenTTL),
	}, nil
}

// parseToken 解析 ach_<secret>.<fp>，fp 为工作站公钥 SHA-256 的前 16 位十六进制。
func parseToken(token string) (string, error) {
	i := strings.LastIndex(token, ".")
	if !strings.HasPrefix(token, "ach_") || i < 0 {
		return "", errors.New("令牌格式不对，应为 ach_<secret>.<指纹>")
	}
	fp := strings.ToLower(token[i+1:])
	if _, err := hex.DecodeString(fp); err != nil || len(fp) != 16 {
		return "", errors.New("令牌格式不对，指纹应为 16 位十六进制")
	}
	return fp, nil
}

func (c *Client) loop(ctx context.Context, id *identity.Identity, enr *enrollment) error {
	backoff := time.Second
	for {
		if enr != nil && time.Now().After(enr.deadline) {
			return errors.New("登记未完成：令牌已过期（15 分钟内有效）、已被使用或无效，请在工作站重新生成")
		}
		newID, authed, err := c.session(ctx, id, enr)
		if ctx.Err() != nil {
			return nil
		}
		var fatal *fatalError
		if errors.As(err, &fatal) {
			return fatal.err
		}
		if newID != nil {
			id, enr = newID, nil
		}
		if authed {
			backoff = time.Second
		}
		delay := jitter(backoff)
		c.log.Printf("连接已断开：%v；%s 后重试", err, delay.Round(100*time.Millisecond))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func jitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.8 + 0.4*mrand.Float64()))
}

// session 建立一条连接并服务到断开。握手成功时返回（登记后的）身份与 authed=true。
func (c *Client) session(ctx context.Context, id *identity.Identity, enr *enrollment) (*identity.Identity, bool, error) {
	var server string
	if enr != nil {
		server = enr.server
	} else {
		server = id.Server
	}
	u, err := wsURL(server)
	if err != nil {
		return nil, false, &fatalError{err}
	}
	dctx, dcancel := context.WithTimeout(ctx, handshakeTimeout)
	ws, _, err := websocket.Dial(dctx, u, &websocket.DialOptions{
		HTTPClient:      c.http,
		CompressionMode: websocket.CompressionDisabled,
	})
	dcancel()
	if err != nil {
		return nil, false, fmt.Errorf("连接工作站失败：%w", err)
	}
	ws.SetReadLimit(wire.MaxControl)
	cctx, ccancel := context.WithCancel(ctx)
	defer ccancel()
	cn := &conn{c: c, ws: ws, ctx: cctx, cancel: ccancel, streams: map[uint32]*stream{}}
	defer ws.CloseNow()

	var result *identity.Identity
	if enr != nil {
		result, err = cn.enroll(enr)
	} else {
		result, err = cn.reconnect(id)
	}
	if err != nil {
		return nil, false, err
	}
	if enr != nil {
		if err := identity.Save(c.home, result); err != nil {
			return nil, true, &fatalError{fmt.Errorf("登记已成功，但写入身份文件失败：%w", err)}
		}
		c.log.Printf("已登记并连接工作站 %s，主机 %s（%s）；关闭此窗口即断开", result.Server, result.HostID, result.Name)
	} else {
		c.log.Printf("已重新连接工作站 %s", result.Server)
	}
	return result, true, cn.serve()
}

func wsURL(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return "", fmt.Errorf("工作站地址不合法：%w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("工作站地址必须以 http:// 或 https:// 开头：%s", server)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/executor/ws"
	return u.String(), nil
}

// conn 是一条已建立的 WebSocket 连接。写入由 wmu 串行化，保证加密计数器与线上顺序一致。
type conn struct {
	c      *Client
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	caps   map[string]bool

	wmu  sync.Mutex
	seal *wire.Sealer // 握手完成后非空
	open *wire.Opener // 只在读循环所在的 goroutine 中访问

	mu      sync.Mutex
	streams map[uint32]*stream
}

func (cn *conn) writeFrame(typ byte, sid uint32, payload []byte) error {
	frame := wire.Encode(typ, sid, payload)
	cn.wmu.Lock()
	defer cn.wmu.Unlock()
	if cn.seal != nil {
		frame = cn.seal.Seal(frame)
	}
	ctx, cancel := context.WithTimeout(cn.ctx, writeTimeout)
	defer cancel()
	if err := cn.ws.Write(ctx, websocket.MessageBinary, frame); err != nil {
		cn.cancel()
		return err
	}
	return nil
}

func (cn *conn) readFrame(timeout time.Duration) (wire.Frame, error) {
	ctx, cancel := context.WithTimeout(cn.ctx, timeout)
	defer cancel()
	_, msg, err := cn.ws.Read(ctx)
	if err != nil {
		return wire.Frame{}, err
	}
	if cn.open != nil {
		if msg, err = cn.open.Open(msg); err != nil {
			return wire.Frame{}, err
		}
	}
	return wire.Decode(msg)
}

func (cn *conn) writeJSON(typ byte, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return cn.writeFrame(typ, 0, b)
}

func (cn *conn) readWelcome() (wire.WelcomeMsg, error) {
	var w wire.WelcomeMsg
	f, err := cn.readFrame(handshakeTimeout)
	if err != nil {
		return w, fmt.Errorf("等待工作站应答失败：%w", err)
	}
	if f.Type != wire.Welcome {
		return w, errProtocol(fmt.Sprintf("期望 WELCOME，收到 %#x", f.Type))
	}
	if err := json.Unmarshal(f.Payload, &w); err != nil {
		return w, errProtocol("WELCOME 不是合法 JSON")
	}
	if w.V != wire.Version {
		return w, &fatalError{fmt.Errorf("工作站协议版本 %d 不受支持（本执行器只支持 %d）", w.V, wire.Version)}
	}
	return w, nil
}

func (cn *conn) readAuthOK() (wire.AuthOKMsg, error) {
	var ok wire.AuthOKMsg
	f, err := cn.readFrame(handshakeTimeout)
	if err != nil {
		return ok, fmt.Errorf("等待认证结果失败：%w", err)
	}
	if f.Type != wire.AuthOK {
		return ok, errProtocol(fmt.Sprintf("期望 AUTH_OK，收到 %#x", f.Type))
	}
	if err := json.Unmarshal(f.Payload, &ok); err != nil || ok.HostID == "" {
		return ok, errProtocol("AUTH_OK 缺少 hostId")
	}
	return ok, nil
}

// keysFrom 用本次临时私钥与工作站临时公钥派生两个方向的密钥，此后所有帧加密。
func (cn *conn) keysFrom(ephPriv *ecdh.PrivateKey, wsEph, transcript []byte) error {
	peer, err := ecdh.X25519().NewPublicKey(wsEph)
	if err != nil {
		return err
	}
	shared, err := ephPriv.ECDH(peer)
	if err != nil {
		return err
	}
	up, down, err := wire.DeriveKeys(shared, transcript)
	if err != nil {
		return err
	}
	cn.wmu.Lock()
	cn.seal = wire.NewSealer(up, wire.DirUp)
	cn.wmu.Unlock()
	cn.open = wire.NewOpener(down, wire.DirDown)
	return nil
}

func newEph() (*ecdh.PrivateKey, []byte, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	return priv, priv.PublicKey().Bytes(), nil
}

func (cn *conn) negotiateCaps(welcome []string) {
	cn.caps = map[string]bool{}
	for _, name := range ops.Names() {
		if slices.Contains(welcome, name) {
			cn.caps[name] = true
		}
	}
}

func (cn *conn) enroll(enr *enrollment) (*identity.Identity, error) {
	ephPriv, ephPub, err := newEph()
	if err != nil {
		return nil, err
	}
	if err := cn.writeJSON(wire.Hello, wire.HelloMsg{V: []int{wire.Version, wire.Version}, Eph: b64(ephPub), Caps: ops.Names()}); err != nil {
		return nil, err
	}
	w, err := cn.readWelcome()
	if err != nil {
		return nil, err
	}
	wsPub, wsEph, sig, err := decodeWelcome(w)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(wsPub)
	if hex.EncodeToString(sum[:])[:16] != enr.fp {
		return nil, &fatalError{errors.New("工作站公钥与令牌指纹不符：令牌可能来自另一台工作站，请重新生成令牌")}
	}
	transcript := wire.Transcript("", ephPub, wsEph)
	if !ed25519.Verify(wsPub, transcript, sig) {
		return nil, &fatalError{errors.New("工作站签名无效，已停止登记")}
	}
	cn.negotiateCaps(w.Caps)
	if err := cn.keysFrom(ephPriv, wsEph, transcript); err != nil {
		return nil, err
	}
	name, _ := os.Hostname()
	platform := runtime.GOOS + "/" + runtime.GOARCH
	auth := wire.AuthMsg{
		Sig:      b64(ed25519.Sign(enr.priv, transcript)),
		Token:    enr.token,
		ExecPub:  b64(enr.pub),
		Name:     name,
		Platform: platform,
	}
	if err := cn.writeJSON(wire.Auth, auth); err != nil {
		return nil, err
	}
	ok, err := cn.readAuthOK()
	if err != nil {
		return nil, err
	}
	return &identity.Identity{
		HostID:   ok.HostID,
		Server:   enr.server,
		Name:     name,
		WSPub:    b64(wsPub),
		ExecPub:  b64(enr.pub),
		ExecPriv: b64(enr.priv),
	}, nil
}

func (cn *conn) reconnect(id *identity.Identity) (*identity.Identity, error) {
	wsPub, _, execPriv, err := id.Keys()
	if err != nil {
		return nil, &fatalError{fmt.Errorf("身份文件损坏：%w", err)}
	}
	ephPriv, ephPub, err := newEph()
	if err != nil {
		return nil, err
	}
	if err := cn.writeJSON(wire.Hello, wire.HelloMsg{V: []int{wire.Version, wire.Version}, Eph: b64(ephPub), HostID: id.HostID, Caps: ops.Names()}); err != nil {
		return nil, err
	}
	w, err := cn.readWelcome()
	if err != nil {
		return nil, err
	}
	pub, wsEph, sig, err := decodeWelcome(w)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(pub, wsPub) {
		return nil, &fatalError{errors.New("工作站公钥与身份文件不符：这台执行器登记在另一台工作站上，请删除身份文件后重新 join")}
	}
	transcript := wire.Transcript(id.HostID, ephPub, wsEph)
	if !ed25519.Verify(wsPub, transcript, sig) {
		return nil, errors.New("工作站签名无效")
	}
	cn.negotiateCaps(w.Caps)
	if err := cn.keysFrom(ephPriv, wsEph, transcript); err != nil {
		return nil, err
	}
	auth := wire.AuthMsg{HostID: id.HostID, Sig: b64(ed25519.Sign(execPriv, transcript))}
	if err := cn.writeJSON(wire.Auth, auth); err != nil {
		return nil, err
	}
	ok, err := cn.readAuthOK()
	if err != nil {
		return nil, err
	}
	if ok.HostID != id.HostID {
		return nil, errProtocol("AUTH_OK 的 hostId 与身份文件不符")
	}
	return id, nil
}

func decodeWelcome(w wire.WelcomeMsg) (pub, eph, sig []byte, err error) {
	if pub, err = b64Len(w.Pub, ed25519.PublicKeySize); err != nil {
		return nil, nil, nil, errProtocol("WELCOME.pub 不合法")
	}
	if eph, err = b64Len(w.Eph, 32); err != nil {
		return nil, nil, nil, errProtocol("WELCOME.eph 不合法")
	}
	if sig, err = b64Len(w.Sig, ed25519.SignatureSize); err != nil {
		return nil, nil, nil, errProtocol("WELCOME.sig 不合法")
	}
	return pub, eph, sig, nil
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func b64Len(s string, n int) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != n {
		return nil, fmt.Errorf("长度应为 %d", n)
	}
	return b, nil
}

// serve 读取工作站发来的帧并分发，直到连接断开或出现协议错误。
func (cn *conn) serve() error {
	defer cn.cancel()
	for {
		f, err := cn.readFrame(idleTimeout)
		if err != nil {
			return err
		}
		switch f.Type {
		case wire.Ping:
			if err := cn.writeFrame(wire.Pong, 0, nil); err != nil {
				return err
			}
		case wire.Pong:
		case wire.Req:
			if err := cn.startStream(f.Stream, f.Payload); err != nil {
				return err
			}
		case wire.Data:
			if s := cn.lookup(f.Stream); s != nil {
				if err := s.push(f.Payload); err != nil {
					return err
				}
			}
		case wire.End:
			if s := cn.lookup(f.Stream); s != nil {
				s.endIn()
			}
		case wire.Cancel:
			if s := cn.lookup(f.Stream); s != nil {
				s.cancel()
			}
		case wire.Flow:
			if len(f.Payload) != 4 {
				return errProtocol("FLOW 长度不是 4")
			}
			if s := cn.lookup(f.Stream); s != nil {
				s.grant(int64(binary.BigEndian.Uint32(f.Payload)))
			}
		default:
			return errProtocol(fmt.Sprintf("未知帧类型 %#x", f.Type))
		}
	}
}

func (cn *conn) lookup(sid uint32) *stream {
	cn.mu.Lock()
	defer cn.mu.Unlock()
	return cn.streams[sid]
}

func (cn *conn) startStream(sid uint32, payload []byte) error {
	if sid == 0 {
		return errProtocol("REQ 的 streamId 不能为 0")
	}
	s := newStream(cn, sid)
	cn.mu.Lock()
	if _, dup := cn.streams[sid]; dup {
		cn.mu.Unlock()
		s.cancel()
		return errProtocol("streamId 重复")
	}
	cn.streams[sid] = s
	cn.mu.Unlock()
	go cn.run(s, payload)
	return nil
}

func (cn *conn) run(s *stream, payload []byte) {
	res, e := cn.dispatch(s, payload)
	s.finish(res, e)
	cn.mu.Lock()
	delete(cn.streams, s.id)
	cn.mu.Unlock()
}

func (cn *conn) dispatch(s *stream, payload []byte) (any, *ops.Error) {
	var head struct {
		Op string `json:"op"`
	}
	if err := json.Unmarshal(payload, &head); err != nil {
		return nil, &ops.Error{Code: ops.EINVAL, Message: "请求不是合法 JSON"}
	}
	h := ops.Lookup(head.Op)
	if h == nil || !cn.caps[head.Op] {
		return nil, &ops.Error{Code: ops.EUNSUPPORTED, Message: "不支持的操作：" + head.Op}
	}
	select {
	case cn.c.sem <- struct{}{}:
	case <-s.ctx.Done():
		return nil, &ops.Error{Code: ops.ECANCELED, Message: "排队中被取消"}
	}
	defer func() { <-cn.c.sem }()
	return h(s, payload)
}
