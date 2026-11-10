// Package ops 实现 v1 操作：exec.*、fs.*、sys.info。每个操作只通过 Stream 与工作站通信，不直接碰协议帧。
package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"syscall"
)

// Version 由 scripts/build-executor.mjs 通过 -ldflags 注入。
var Version = "dev"

// 错误码，与 docs/features/executor.md 一致。
const (
	ENOENT       = "ENOENT"
	EEXIST       = "EEXIST"
	EACCES       = "EACCES"
	ENOTDIR      = "ENOTDIR"
	EISDIR       = "EISDIR"
	ENOTEMPTY    = "ENOTEMPTY"
	EINVAL       = "EINVAL"
	ECONFLICT    = "ECONFLICT"
	EUNSUPPORTED = "EUNSUPPORTED"
	ECANCELED    = "ECANCELED"
	EIO          = "EIO"
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// fromOS 把 OS 错误映射为协议错误码。
func fromOS(err error) *Error {
	code := EIO
	switch {
	case errors.Is(err, fs.ErrNotExist):
		code = ENOENT
	case errors.Is(err, fs.ErrExist):
		code = EEXIST
	case errors.Is(err, fs.ErrPermission):
		code = EACCES
	case errors.Is(err, syscall.ENOTDIR):
		code = ENOTDIR
	case errors.Is(err, syscall.EISDIR):
		code = EISDIR
	case errors.Is(err, syscall.ENOTEMPTY):
		code = ENOTEMPTY
	}
	return &Error{Code: code, Message: err.Error()}
}

// Stream 是操作看到的一条请求流。Stdout/Stderr/DataOut 写入时自动分帧并受对端窗口约束。
type Stream interface {
	Context() context.Context
	Stdout() io.Writer
	Stderr() io.Writer
	DataOut() io.Writer
	// DataIn 读取工作站发来的请求体，读到 END 返回 io.EOF。
	DataIn() io.Reader
}

type Handler func(s Stream, raw json.RawMessage) (any, *Error)

var handlers = map[string]Handler{
	"exec.shell": execShell,
	"exec.argv":  execArgv,
	"fs.stat":    fsStat,
	"fs.list":    fsList,
	"fs.read":    fsRead,
	"fs.write":   fsWrite,
	"fs.mkdir":   fsMkdir,
	"fs.rename":  fsRename,
	"fs.remove":  fsRemove,
	"sys.info":   sysInfo,
}

func Lookup(op string) Handler { return handlers[op] }

// Names 返回全部操作名（排序），用于能力协商。
func Names() []string {
	names := make([]string, 0, len(handlers))
	for name := range handlers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func decode(raw json.RawMessage, v any) *Error {
	if err := json.Unmarshal(raw, v); err != nil {
		return errorf(EINVAL, "参数不合法：%v", err)
	}
	return nil
}
