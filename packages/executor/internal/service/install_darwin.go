//go:build darwin

package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
)

// install 写入 LaunchAgent 属性列表；只写文件，不 launchctl load（下次登录生效）。
func install() (string, error) {
	exe, err := execPath()
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	agentDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		return "", err
	}
	plistPath := filepath.Join(agentDir, "dev.tandem.exec.plist")
	logPath := filepath.Join(home, "exec.log")

	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.tandem.exec</string>
  <key>ProgramArguments</key>
  <array>
    <string>`)
	b.WriteString(xmlText(exe))
	b.WriteString(`</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>`)
	b.WriteString(xmlText(logPath))
	b.WriteString(`</string>
  <key>StandardErrorPath</key>
  <string>`)
	b.WriteString(xmlText(logPath))
	b.WriteString(`</string>
</dict>
</plist>
`)
	if err := os.WriteFile(plistPath, b.Bytes(), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("已写入开机自启 %s：下次登录后自动连接（日志 %s）。", plistPath, logPath), nil
}

func xmlText(s string) string {
	var b bytes.Buffer
	if err := xml.EscapeText(&b, []byte(s)); err != nil {
		return s
	}
	return b.String()
}
