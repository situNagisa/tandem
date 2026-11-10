//go:build linux

package service

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

const (
	unitName = "tandem-exec.service"
	// unitTemplate 的 ExecStart 写绝对路径；%s 已按 systemd 规则转义。
	unitTemplate = `[Unit]
Description=Tandem 执行器（连接工作站）
After=network-online.target

[Service]
ExecStart=%s run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
)

// install 写入 systemd 用户单元并 enable（不带 --now，当前前台进程保持连接）。
func install() (string, error) {
	exe, err := execPath()
	if err != nil {
		return "", err
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	unitDir := filepath.Join(configDir, "systemd", "user")
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		return "", err
	}
	unitPath := filepath.Join(unitDir, unitName)
	unit := fmt.Sprintf(unitTemplate, systemdArg(exe))
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return "", err
	}

	name := os.Getenv("USER")
	if u, err := user.Current(); err == nil && u.Username != "" {
		name = u.Username
	}
	hint := fmt.Sprintf("已写入开机自启 %s：下次登录后自动连接。", unitPath)
	if name != "" {
		hint += fmt.Sprintf("未登录时也要运行，请管理员执行：loginctl enable-linger %s", name)
	}
	if out, err := exec.Command("systemctl", "--user", "enable", unitName).CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(out))
		if detail != "" {
			return "", fmt.Errorf("%s 但 systemctl --user enable 失败（%v：%s），可稍后手动执行 systemctl --user enable %s", hint, err, detail, unitName)
		}
		return "", fmt.Errorf("%s 但 systemctl --user enable 失败（%v），可稍后手动执行 systemctl --user enable %s", hint, err, unitName)
	}
	return hint, nil
}

// systemdArg 给 ExecStart 的路径加引号，并转义 systemd 的说明符与反斜杠。
func systemdArg(path string) string {
	path = strings.ReplaceAll(path, `\`, `\\`)
	path = strings.ReplaceAll(path, `"`, `\"`)
	path = strings.ReplaceAll(path, `%`, `%%`)
	return `"` + path + `"`
}
