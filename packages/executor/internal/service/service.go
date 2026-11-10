// Package service 把执行器写进当前用户的登录自启项：只写配置，不启动第二个进程。
package service

import (
	"os"
	"path/filepath"
)

// Install 写入当前用户的开机自启项，返回给用户看的提示；失败时返回错误，调用方只打印警告。
// 具体实现按平台分文件：Linux 的 systemd 用户单元、macOS 的 LaunchAgent、Windows 的 HKCU Run。
func Install() (string, error) {
	return install()
}

// execPath 返回当前可执行文件的绝对路径并解析符号链接：自启配置里必须写稳定的绝对路径。
func execPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}
