package ops

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"tandem/executor/internal/wire"
)

type pathArgs struct {
	Path string `json:"path"`
}

type readArgs struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Length *int64 `json:"length"`
}

type listArgs struct {
	Path  string `json:"path"`
	Limit int    `json:"limit"`
}

type writeArgs struct {
	Path        string `json:"path"`
	Mode        *int64 `json:"mode"`
	ExpectMtime *int64 `json:"expectMtime"`
	Mkdirp      bool   `json:"mkdirp"`
}

type recursiveArgs struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type renameArgs struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite"`
}

const defaultListLimit = 10000

type statResult struct {
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
	Mode    uint32 `json:"mode"`
	Symlink bool   `json:"symlink"`
}

func fileType(m fs.FileMode) string {
	switch {
	case m.IsDir():
		return "dir"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	case m.IsRegular():
		return "file"
	default:
		return "other"
	}
}

func fsStat(_ Stream, raw json.RawMessage) (any, *Error) {
	var a pathArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	lst, err := os.Lstat(a.Path)
	if err != nil {
		return nil, fromOS(err)
	}
	info := lst
	symlink := lst.Mode()&fs.ModeSymlink != 0
	if symlink {
		if target, err := os.Stat(a.Path); err == nil {
			info = target
		}
	}
	return statResult{
		Type:    fileType(info.Mode()),
		Size:    info.Size(),
		MtimeMs: info.ModTime().UnixMilli(),
		Mode:    uint32(info.Mode().Perm()),
		Symlink: symlink,
	}, nil
}

func fsList(_ Stream, raw json.RawMessage) (any, *Error) {
	var a listArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	if a.Limit <= 0 {
		a.Limit = defaultListLimit
	}
	dirEntries, err := os.ReadDir(a.Path)
	if err != nil {
		return nil, fromOS(err)
	}
	truncated := len(dirEntries) > a.Limit
	if truncated {
		dirEntries = dirEntries[:a.Limit]
	}
	type entry struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Size    int64  `json:"size"`
		MtimeMs int64  `json:"mtimeMs"`
	}
	entries := make([]entry, 0, len(dirEntries))
	for _, de := range dirEntries {
		info, err := de.Info()
		if err != nil {
			continue
		}
		entries = append(entries, entry{
			Name:    de.Name(),
			Type:    fileType(de.Type()),
			Size:    info.Size(),
			MtimeMs: info.ModTime().UnixMilli(),
		})
	}
	return map[string]any{"entries": entries, "truncated": truncated}, nil
}

func fsRead(s Stream, raw json.RawMessage) (any, *Error) {
	var a readArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	f, err := os.Open(a.Path)
	if err != nil {
		return nil, fromOS(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, fromOS(err)
	}
	if st.IsDir() {
		return nil, errorf(EISDIR, "是目录：%s", a.Path)
	}
	if a.Offset < 0 {
		return nil, errorf(EINVAL, "offset 不能为负")
	}
	if a.Offset > 0 {
		if _, err := f.Seek(a.Offset, io.SeekStart); err != nil {
			return nil, fromOS(err)
		}
	}
	var src io.Reader = f
	if a.Length != nil {
		src = io.LimitReader(f, *a.Length)
	}
	n, err := io.CopyBuffer(s.DataOut(), src, make([]byte, wire.MaxData))
	if err != nil {
		if s.Context().Err() != nil {
			return nil, errorf(ECANCELED, "已取消")
		}
		return nil, fromOS(err)
	}
	return map[string]any{
		"size":    st.Size(),
		"mtimeMs": st.ModTime().UnixMilli(),
		"bytes":   n,
		"eof":     a.Offset+n >= st.Size(),
	}, nil
}

// fsWrite 把请求体写入同目录临时文件，fsync 后在提交前检查 expectMtime，再 rename 覆盖。
// 无论中途出错与否，都会把请求体读到 END，保证协议不乱、窗口能继续回 FLOW。
func fsWrite(s Stream, raw json.RawMessage) (any, *Error) {
	body := s.DataIn()
	defer io.Copy(io.Discard, body)
	var a writeArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	dir := filepath.Dir(a.Path)
	if a.Mkdirp {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fromOS(err)
		}
	}
	perm := fs.FileMode(0o644)
	if st, err := os.Stat(a.Path); err == nil {
		if st.IsDir() {
			return nil, errorf(EISDIR, "是目录：%s", a.Path)
		}
		perm = st.Mode().Perm()
	}
	if a.Mode != nil {
		perm = fs.FileMode(*a.Mode).Perm()
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(a.Path)+".*.tmp")
	if err != nil {
		return nil, fromOS(err)
	}
	name := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(name)
		}
	}()
	_ = tmp.Chmod(perm)
	if _, err := io.Copy(tmp, body); err != nil {
		if s.Context().Err() != nil {
			return nil, errorf(ECANCELED, "写入已取消")
		}
		return nil, errorf(EIO, "写入失败：%v", err)
	}
	if err := tmp.Sync(); err != nil {
		return nil, fromOS(err)
	}
	if err := tmp.Close(); err != nil {
		return nil, fromOS(err)
	}
	if a.ExpectMtime != nil {
		st, err := os.Stat(a.Path)
		switch {
		case err == nil && st.ModTime().UnixMilli() != *a.ExpectMtime:
			return nil, errorf(ECONFLICT, "文件已被修改：%s", a.Path)
		case err != nil && !errors.Is(err, fs.ErrNotExist):
			return nil, fromOS(err)
		}
	}
	if err := os.Rename(name, a.Path); err != nil {
		return nil, fromOS(err)
	}
	committed = true
	st, err := os.Stat(a.Path)
	if err != nil {
		return nil, fromOS(err)
	}
	return map[string]any{"size": st.Size(), "mtimeMs": st.ModTime().UnixMilli()}, nil
}

func fsMkdir(_ Stream, raw json.RawMessage) (any, *Error) {
	var a recursiveArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	var err error
	if a.Recursive {
		err = os.MkdirAll(a.Path, 0o755)
	} else {
		err = os.Mkdir(a.Path, 0o755)
	}
	if err != nil {
		return nil, fromOS(err)
	}
	return map[string]any{}, nil
}

func fsRename(_ Stream, raw json.RawMessage) (any, *Error) {
	var a renameArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.From == "" || a.To == "" {
		return nil, errorf(EINVAL, "缺少 from 或 to")
	}
	if !a.Overwrite {
		if _, err := os.Lstat(a.To); err == nil {
			return nil, errorf(EEXIST, "目标已存在：%s", a.To)
		}
	}
	if err := os.Rename(a.From, a.To); err != nil {
		return nil, fromOS(err)
	}
	return map[string]any{}, nil
}

func fsRemove(_ Stream, raw json.RawMessage) (any, *Error) {
	var a recursiveArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.Path == "" {
		return nil, errorf(EINVAL, "缺少 path")
	}
	p := filepath.Clean(a.Path)
	if filepath.Dir(p) == p {
		return nil, errorf(EINVAL, "拒绝删除根目录：%s", p)
	}
	if _, err := os.Lstat(p); err != nil {
		return nil, fromOS(err)
	}
	var err error
	if a.Recursive {
		err = os.RemoveAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil {
		return nil, fromOS(err)
	}
	return map[string]any{}, nil
}

func sysInfo(_ Stream, _ json.RawMessage) (any, *Error) {
	home, _ := os.UserHomeDir()
	host, _ := os.Hostname()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	tools := map[string]bool{}
	for _, name := range []string{"git", "rg", "bwrap"} {
		_, err := exec.LookPath(name)
		tools[name] = err == nil
	}
	return map[string]any{
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"hostname":  host,
		"home":      home,
		"tmp":       os.TempDir(),
		"shell":     shellName(),
		"version":   Version,
		"protocol":  wire.Version,
		"tools":     tools,
		"heapInuse": ms.HeapInuse,
	}, nil
}
