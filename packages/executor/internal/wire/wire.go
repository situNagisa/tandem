// Package wire 是执行器与工作站之间的线协议：帧格式、握手消息、握手 transcript 与记录加密。
// 协议权威说明见 docs/features/executor.md。
package wire

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
)

const Version = 1

// 帧类型（type u8）。握手阶段是明文，握手完成后整帧加密。
const (
	Hello   byte = 0x01
	Welcome byte = 0x02
	Auth    byte = 0x03
	AuthOK  byte = 0x04
	Req     byte = 0x10
	Data    byte = 0x11
	Out     byte = 0x12
	Err     byte = 0x13
	End     byte = 0x14
	Cancel  byte = 0x15
	Flow    byte = 0x16
	Ping    byte = 0x17
	Pong    byte = 0x18
)

const (
	MaxData    = 64 << 10 // 数据帧（DATA/OUT/ERR）负载上限
	MaxControl = 1 << 20  // 控制帧（JSON）负载上限
	Window     = 1 << 20  // 每流每方向的初始窗口
	FlowEvery  = 256 << 10
)

// 记录方向，写入 nonce 前缀，保证两个方向即使计数器相同也不会复用 nonce。
const (
	DirUp   uint32 = 1 // 执行器 → 工作站
	DirDown uint32 = 2 // 工作站 → 执行器
)

var ErrTampered = errors.New("密文校验失败")

type Frame struct {
	Type    byte
	Stream  uint32
	Payload []byte
}

func Encode(typ byte, stream uint32, payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	out[0] = typ
	binary.BigEndian.PutUint32(out[1:5], stream)
	copy(out[5:], payload)
	return out
}

func Decode(b []byte) (Frame, error) {
	if len(b) < 5 {
		return Frame{}, errors.New("帧过短")
	}
	return Frame{Type: b[0], Stream: binary.BigEndian.Uint32(b[1:5]), Payload: b[5:]}, nil
}

// Nonce 为 [方向 u32 BE][计数器 u64 BE]。
func Nonce(dir uint32, counter uint64) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint32(n[0:4], dir)
	binary.BigEndian.PutUint64(n[4:12], counter)
	return n
}

// Transcript 是双方签名的内容，绑定 hostId 与两端临时公钥（标准 base64 文本）。
func Transcript(hostID string, execEph, wsEph []byte) []byte {
	return []byte("tandem-exec-v1|" + hostID + "|" + base64.StdEncoding.EncodeToString(execEph) + "|" +
		base64.StdEncoding.EncodeToString(wsEph))
}

// DeriveKeys 由 X25519 共享密钥派生两个方向的 AES-256-GCM 密钥。
func DeriveKeys(shared, transcript []byte) (up, down cipher.AEAD, err error) {
	upKey, err := hkdf.Key(sha256.New, shared, transcript, "tandem-exec-v1 exec->ws", 32)
	if err != nil {
		return nil, nil, err
	}
	downKey, err := hkdf.Key(sha256.New, shared, transcript, "tandem-exec-v1 ws->exec", 32)
	if err != nil {
		return nil, nil, err
	}
	if up, err = newGCM(upKey); err != nil {
		return nil, nil, err
	}
	if down, err = newGCM(downKey); err != nil {
		return nil, nil, err
	}
	return up, down, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Sealer 按发送顺序给每条记录编号；计数器不上线，接收方隐式计数。
type Sealer struct {
	aead cipher.AEAD
	dir  uint32
	seq  uint64
}

func NewSealer(aead cipher.AEAD, dir uint32) *Sealer { return &Sealer{aead: aead, dir: dir} }

func (s *Sealer) Seal(plain []byte) []byte {
	out := s.aead.Seal(nil, Nonce(s.dir, s.seq), plain, nil)
	s.seq++
	return out
}

type Opener struct {
	aead cipher.AEAD
	dir  uint32
	seq  uint64
}

func NewOpener(aead cipher.AEAD, dir uint32) *Opener { return &Opener{aead: aead, dir: dir} }

func (o *Opener) Open(sealed []byte) ([]byte, error) {
	plain, err := o.aead.Open(nil, Nonce(o.dir, o.seq), sealed, nil)
	if err != nil {
		return nil, ErrTampered
	}
	o.seq++
	return plain, nil
}

// 握手与认证消息（JSON）。
type HelloMsg struct {
	V      []int    `json:"v"`
	Eph    string   `json:"eph"`
	HostID string   `json:"hostId"`
	Caps   []string `json:"caps"`
}

type WelcomeMsg struct {
	V    int      `json:"v"`
	Eph  string   `json:"eph"`
	Pub  string   `json:"pub"`
	Sig  string   `json:"sig"`
	Caps []string `json:"caps"`
}

type AuthMsg struct {
	HostID   string `json:"hostId"`
	Sig      string `json:"sig"`
	Token    string `json:"token,omitempty"`
	ExecPub  string `json:"execPub,omitempty"`
	Name     string `json:"name,omitempty"`
	Platform string `json:"platform,omitempty"`
}

type AuthOKMsg struct {
	HostID string `json:"hostId"`
}
