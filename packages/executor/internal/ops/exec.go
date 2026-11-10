package ops

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

type shellArgs struct {
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMs int64             `json:"timeoutMs"`
	Wrap      []string          `json:"wrap"`
}

type argvArgs struct {
	File      string            `json:"file"`
	Args      []string          `json:"args"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMs int64             `json:"timeoutMs"`
}

type execResult struct {
	Exit     int    `json:"exit"`
	Signal   string `json:"signal,omitempty"`
	TimedOut bool   `json:"timedOut,omitempty"`
	Canceled bool   `json:"canceled,omitempty"`
}

// 进程输出在工作站侧以 Stream 的 OUT/ERR 帧返回；有 2 秒的 WaitDelay，后台子进程占着管道也不会永远挂住。
const waitDelay = 2 * time.Second

func execShell(s Stream, raw json.RawMessage) (any, *Error) {
	var a shellArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if strings.TrimSpace(a.Command) == "" {
		return nil, errorf(EINVAL, "命令为空")
	}
	if e := checkDir(a.Cwd); e != nil {
		return nil, e
	}
	ctx, cancel := withTimeout(s.Context(), a.TimeoutMs)
	defer cancel()
	cmd, cleanup, e := shellCommand(ctx, a.Command, a.Wrap)
	if e != nil {
		return nil, e
	}
	defer cleanup()
	return runCommand(s, ctx, cmd, a.Cwd, a.Env)
}

func execArgv(s Stream, raw json.RawMessage) (any, *Error) {
	var a argvArgs
	if e := decode(raw, &a); e != nil {
		return nil, e
	}
	if a.File == "" {
		return nil, errorf(EINVAL, "缺少 file")
	}
	if e := checkDir(a.Cwd); e != nil {
		return nil, e
	}
	ctx, cancel := withTimeout(s.Context(), a.TimeoutMs)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.File, a.Args...)
	return runCommand(s, ctx, cmd, a.Cwd, a.Env)
}

func withTimeout(parent context.Context, ms int64) (context.Context, context.CancelFunc) {
	if ms <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, time.Duration(ms)*time.Millisecond)
}

func checkDir(p string) *Error {
	if p == "" {
		return errorf(EINVAL, "缺少 cwd")
	}
	info, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return errorf(ENOENT, "cwd 不存在：%s", p)
	}
	if err != nil {
		return fromOS(err)
	}
	if !info.IsDir() {
		return errorf(ENOTDIR, "cwd 不是目录：%s", p)
	}
	return nil
}

func runCommand(s Stream, ctx context.Context, cmd *exec.Cmd, cwd string, env map[string]string) (any, *Error) {
	cmd.Dir = cwd
	cmd.Env = mergeEnv(env)
	cmd.Stdout = s.Stdout()
	cmd.Stderr = s.Stderr()
	cmd.WaitDelay = waitDelay
	configure(cmd)
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return nil, errorf(ENOENT, "找不到可执行文件：%v", err)
		}
		return nil, errorf(EIO, "启动失败：%v", err)
	}
	_ = cmd.Wait()
	res := execResult{Exit: -1}
	if ps := cmd.ProcessState; ps != nil {
		res.Exit = ps.ExitCode()
		res.Signal = signalName(ps)
	}
	res.Canceled = s.Context().Err() != nil
	res.TimedOut = !res.Canceled && ctx.Err() != nil
	return res, nil
}

func mergeEnv(extra map[string]string) []string {
	env := os.Environ()
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+extra[k])
	}
	return env
}
