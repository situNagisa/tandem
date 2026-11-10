//go:build !linux && !darwin && !windows

package service

import "errors"

func install() (string, error) {
	return "", errors.New("当前系统不支持设置开机自启（仅支持 Linux、macOS、Windows）")
}
