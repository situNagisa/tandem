//go:build windows

package service

import (
	"fmt"
	"os/exec"
	"strings"
)

const runKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

// install 写当前用户的登录启动项；只写注册表，不启动第二个进程。
func install() (string, error) {
	exe, err := execPath()
	if err != nil {
		return "", err
	}
	value := `"` + exe + `" run`
	out, err := exec.Command("reg", "add", runKey, "/v", "TandemExec", "/t", "REG_SZ", "/d", value, "/f").CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if detail != "" {
			return "", fmt.Errorf("%v：%s", err, detail)
		}
		return "", err
	}
	return "已设置开机自启：登录 Windows 后自动连接。", nil
}
