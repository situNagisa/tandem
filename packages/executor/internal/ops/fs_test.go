package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type fakeStream struct {
	ctx context.Context
	in  io.Reader
	out bytes.Buffer
}

func newStream(body []byte) *fakeStream {
	return &fakeStream{ctx: context.Background(), in: bytes.NewReader(body)}
}

func (f *fakeStream) Context() context.Context { return f.ctx }
func (f *fakeStream) Stdout() io.Writer        { return io.Discard }
func (f *fakeStream) Stderr() io.Writer        { return io.Discard }
func (f *fakeStream) DataOut() io.Writer       { return &f.out }
func (f *fakeStream) DataIn() io.Reader        { return f.in }

func call(t *testing.T, op string, s Stream, args map[string]any) (any, *Error) {
	t.Helper()
	args["op"] = op
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return Lookup(op)(s, raw)
}

func codeOf(e *Error) string {
	if e == nil {
		return ""
	}
	return e.Code
}

func TestWriteReadRoundTripAndMtimeConflict(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sub", "a.txt")
	body := bytes.Repeat([]byte("0123456789"), 100000) // 约 1 MB，跨多个分片

	res, e := call(t, "fs.write", newStream(body), map[string]any{"path": p, "mkdirp": true})
	if e != nil {
		t.Fatalf("write: %v", e)
	}
	size := res.(map[string]any)["size"].(int64)
	if size != int64(len(body)) {
		t.Fatalf("size = %d, want %d", size, len(body))
	}

	stat, _ := call(t, "fs.stat", newStream(nil), map[string]any{"path": p})
	mtime := stat.(statResult).MtimeMs

	rs := newStream(nil)
	if _, e := call(t, "fs.read", rs, map[string]any{"path": p}); e != nil {
		t.Fatalf("read: %v", e)
	}
	if !bytes.Equal(rs.out.Bytes(), body) {
		t.Fatal("read back differs from written bytes")
	}

	// expectMtime 与磁盘不一致：目标内容不变，目录里不留临时文件。
	stale := mtime - 5000
	_, e = call(t, "fs.write", newStream([]byte("new")), map[string]any{"path": p, "expectMtime": stale})
	if codeOf(e) != ECONFLICT {
		t.Fatalf("conflict code = %q, want ECONFLICT", codeOf(e))
	}
	got, _ := os.ReadFile(p)
	if !bytes.Equal(got, body) {
		t.Fatal("conflicting write changed the target")
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %d entries", len(entries))
	}

	// expectMtime 与磁盘一致：提交成功。
	if _, e := call(t, "fs.write", newStream([]byte("ok")), map[string]any{"path": p, "expectMtime": mtime}); e != nil {
		t.Fatalf("matching expectMtime: %v", e)
	}
}

func TestWriteWithoutParentIsENOENT(t *testing.T) {
	p := filepath.Join(t.TempDir(), "missing", "a.txt")
	_, e := call(t, "fs.write", newStream([]byte("x")), map[string]any{"path": p})
	if codeOf(e) != ENOENT {
		t.Fatalf("code = %q, want ENOENT", codeOf(e))
	}
}

func TestListAndStatTypes(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, e := call(t, "fs.list", newStream(nil), map[string]any{"path": dir})
	if e != nil {
		t.Fatalf("list: %v", e)
	}
	raw, _ := json.Marshal(res)
	var got struct {
		Entries []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"entries"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 2 || got.Entries[0].Name != "d" || got.Entries[0].Type != "dir" || got.Entries[1].Type != "file" {
		t.Fatalf("entries = %+v", got.Entries)
	}
	if got.Truncated {
		t.Fatal("unexpected truncation")
	}

	_, e = call(t, "fs.stat", newStream(nil), map[string]any{"path": filepath.Join(dir, "nope")})
	if codeOf(e) != ENOENT {
		t.Fatalf("stat missing: code = %q", codeOf(e))
	}
}

func TestRenameAndMkdirErrors(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	os.WriteFile(a, []byte("1"), 0o644)
	os.WriteFile(b, []byte("2"), 0o644)

	if _, e := call(t, "fs.rename", newStream(nil), map[string]any{"from": a, "to": b}); codeOf(e) != EEXIST {
		t.Fatalf("rename onto existing without overwrite: code = %q", codeOf(e))
	}
	if _, e := call(t, "fs.rename", newStream(nil), map[string]any{"from": a, "to": b, "overwrite": true}); e != nil {
		t.Fatalf("rename with overwrite: %v", e)
	}
	if _, e := call(t, "fs.mkdir", newStream(nil), map[string]any{"path": dir}); codeOf(e) != EEXIST {
		t.Fatalf("mkdir existing: code = %q", codeOf(e))
	}
	if _, e := call(t, "fs.mkdir", newStream(nil), map[string]any{"path": dir, "recursive": true}); e != nil {
		t.Fatalf("mkdir -p existing: %v", e)
	}
}

func TestRemoveRefusesRoot(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	if _, e := call(t, "fs.remove", newStream(nil), map[string]any{"path": root, "recursive": true}); codeOf(e) != EINVAL {
		t.Fatalf("remove root: code = %q, want EINVAL", codeOf(e))
	}
}

func TestReadRangeAndDirectory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "r.bin")
	os.WriteFile(p, []byte("0123456789"), 0o644)
	s := newStream(nil)
	res, e := call(t, "fs.read", s, map[string]any{"path": p, "offset": 2, "length": 3})
	if e != nil {
		t.Fatalf("read range: %v", e)
	}
	if s.out.String() != "234" {
		t.Fatalf("range = %q, want 234", s.out.String())
	}
	if res.(map[string]any)["eof"].(bool) {
		t.Fatal("eof reported for a partial range")
	}
	if _, e := call(t, "fs.read", newStream(nil), map[string]any{"path": filepath.Dir(p)}); codeOf(e) != EISDIR {
		t.Fatalf("read directory: code = %q, want EISDIR", codeOf(e))
	}
}
