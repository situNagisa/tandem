//go:build windows

package ops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// createNoWindow 对应 CREATE_NO_WINDOW，syscall 包里没有这个常量。
const createNoWindow = 0x08000000

// configure 取消时用 taskkill /T 杀掉整棵进程树。
func configure(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
	cmd.Cancel = func() error {
		kill := exec.Command(systemExe("taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}

func systemExe(name string) string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32", name)
	}
	return name
}

func shellName() string { return "cmd.exe" }

// shellCommand 把命令写进 UTF-8（无 BOM、CRLF）的 .cmd 文件执行：chcp 65001 让输出是 UTF-8。
// 直接把命令当参数交给 cmd 时输出是 GBK，见 docs/features/executor.md。
// 命令行由 CmdLine 原样给出，避免 Go 的参数转义破坏 cmd 的引号规则（路径可以含空格）。
func shellCommand(ctx context.Context, command string, wrap []string) (*exec.Cmd, func(), *Error) {
	if len(wrap) > 0 {
		return nil, nil, errorf(EUNSUPPORTED, "Windows 上不支持沙箱包装")
	}
	f, err := os.CreateTemp("", "tandem-exec-*.cmd")
	if err != nil {
		return nil, nil, fromOS(err)
	}
	body := "@echo off\r\nchcp 65001>nul\r\n" + strings.ReplaceAll(command, "\n", "\r\n") + "\r\n"
	_, werr := f.WriteString(body)
	if cerr := f.Close(); werr != nil || cerr != nil {
		os.Remove(f.Name())
		return nil, nil, errorf(EIO, "写入 .cmd 失败")
	}
	cmd := exec.CommandContext(ctx, systemExe("cmd.exe"))
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd.exe /d /s /c ""` + f.Name() + `""`}
	return cmd, func() { os.Remove(f.Name()) }, nil
}

func signalName(*os.ProcessState) string { return "" }
