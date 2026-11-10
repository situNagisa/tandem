package wire

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func pair(t *testing.T) (*ecdh.PrivateKey, []byte, []byte) {
	t.Helper()
	a, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := a.ECDH(b.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	return a, b.PublicKey().Bytes(), shared
}

func TestNonceLayout(t *testing.T) {
	n := Nonce(DirDown, 0x0102030405)
	want := []byte{0, 0, 0, 2, 0, 0, 0, 1, 2, 3, 4, 5}
	if len(n) != 12 || !bytes.Equal(n, want) {
		t.Fatalf("nonce = %x, want %x", n, want)
	}
}

func TestFrameRoundTrip(t *testing.T) {
	f, err := Decode(Encode(Req, 7, []byte("hi")))
	if err != nil {
		t.Fatal(err)
	}
	if f.Type != Req || f.Stream != 7 || string(f.Payload) != "hi" {
		t.Fatalf("frame = %+v", f)
	}
	if _, err := Decode([]byte{1, 2}); err == nil {
		t.Fatal("short frame accepted")
	}
}

func TestTranscriptBindsHostAndKeys(t *testing.T) {
	e := bytes.Repeat([]byte{1}, 32)
	w := bytes.Repeat([]byte{2}, 32)
	base := string(Transcript("h1", e, w))
	if base == string(Transcript("h2", e, w)) || base == string(Transcript("h1", w, e)) {
		t.Fatal("transcript does not bind hostId and key order")
	}
	if string(Transcript("", e, w)) != "tandem-exec-v1||"+base64.StdEncoding.EncodeToString(e)+"|"+base64.StdEncoding.EncodeToString(w) {
		t.Fatalf("enroll transcript = %q", Transcript("", e, w))
	}
}

func TestSealOpenBothDirections(t *testing.T) {
	a, bPub, shared := pair(t)
	aPubBytes := a.PublicKey().Bytes()
	tr := Transcript("h", aPubBytes, bPub)
	up, down, err := DeriveKeys(shared, tr)
	if err != nil {
		t.Fatal(err)
	}
	seal := NewSealer(up, DirUp)
	open := NewOpener(up, DirUp)
	for i := 0; i < 3; i++ {
		msg := Encode(Data, uint32(i), []byte("payload"))
		got, err := open.Open(seal.Seal(msg))
		if err != nil || !bytes.Equal(got, msg) {
			t.Fatalf("round %d: err=%v got=%x", i, err, got)
		}
	}
	// 两个方向密钥不同：用上行密钥解下行记录必须失败。
	if _, err := NewOpener(down, DirDown).Open(seal.Seal([]byte("x"))); err == nil {
		t.Fatal("record opened with the other direction's key")
	}
}

func TestTamperedRecordRejected(t *testing.T) {
	a, bPub, shared := pair(t)
	tr := Transcript("h", a.PublicKey().Bytes(), bPub)
	up, _, err := DeriveKeys(shared, tr)
	if err != nil {
		t.Fatal(err)
	}
	sealed := NewSealer(up, DirUp).Seal(Encode(Ping, 0, nil))
	sealed[3] ^= 0x01
	if _, err := NewOpener(up, DirUp).Open(sealed); err != ErrTampered {
		t.Fatalf("tampered record: err = %v, want ErrTampered", err)
	}
}

func TestOutOfOrderRecordRejected(t *testing.T) {
	a, bPub, shared := pair(t)
	tr := Transcript("h", a.PublicKey().Bytes(), bPub)
	up, _, err := DeriveKeys(shared, tr)
	if err != nil {
		t.Fatal(err)
	}
	seal := NewSealer(up, DirUp)
	first := seal.Seal(Encode(Ping, 0, nil))
	second := seal.Seal(Encode(Ping, 0, nil))
	open := NewOpener(up, DirUp)
	if _, err := open.Open(second); err == nil {
		t.Fatal("record with counter 1 accepted at counter 0")
	}
	if _, err := open.Open(first); err != nil {
		t.Fatalf("in-order record rejected: %v", err)
	}
}
