//go:build !windows

package ops

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

// configure 让子进程独占进程组，取消时整组 SIGKILL（进程树）。
func configure(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

func shellName() string {
	if _, err := exec.LookPath("bash"); err == nil {
		return "bash"
	}
	return "sh"
}

func shellCommand(ctx context.Context, command string, wrap []string) (*exec.Cmd, func(), *Error) {
	argv := append(append([]string{}, wrap...), shellName(), "-c", command)
	return exec.CommandContext(ctx, argv[0], argv[1:]...), func() {}, nil
}

func signalName(ps *os.ProcessState) string {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return ws.Signal().String()
	}
	return ""
}
