// Package identity 保存执行器登记后的身份：主机 ID、工作站公钥（用于核对）与执行器自己的 Ed25519 密钥。
package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const fileName = "identity.json"

type Identity struct {
	HostID   string `json:"hostId"`
	Server   string `json:"server"`
	Name     string `json:"name"`
	WSPub    string `json:"wsPub"`    // 工作站 Ed25519 公钥，base64
	ExecPub  string `json:"execPub"`  // 执行器 Ed25519 公钥，base64
	ExecPriv string `json:"execPriv"` // 执行器 Ed25519 私钥（64 字节），base64
}

// Home 返回执行器主目录：TANDEM_EXEC_HOME 优先，否则 ~/.tandem-executor。
func Home() (string, error) {
	if h := os.Getenv("TANDEM_EXEC_HOME"); h != "" {
		return h, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".tandem-executor"), nil
}

// Load 读取身份文件；不存在时返回的错误满足 errors.Is(err, os.ErrNotExist)。
func Load(home string) (*Identity, error) {
	b, err := os.ReadFile(filepath.Join(home, fileName))
	if err != nil {
		return nil, err
	}
	var id Identity
	if err := json.Unmarshal(b, &id); err != nil {
		return nil, fmt.Errorf("身份文件损坏：%w", err)
	}
	if _, _, _, err := id.Keys(); err != nil || id.HostID == "" || id.Server == "" {
		return nil, errors.New("身份文件不完整，请删除后重新 join")
	}
	return &id, nil
}

// Save 原子写入（临时文件 + rename），权限 0600。
func Save(home string, id *Identity) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(home, fileName)
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(b, '\n'))
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp)
		return errors.Join(werr, cerr)
	}
	return os.Rename(tmp, path)
}

// Keys 解码三把公钥/私钥，长度不对直接报错。
func (id *Identity) Keys() (wsPub ed25519.PublicKey, execPub ed25519.PublicKey, execPriv ed25519.PrivateKey, err error) {
	if wsPub, err = decodeLen(id.WSPub, ed25519.PublicKeySize); err != nil {
		return nil, nil, nil, err
	}
	if execPub, err = decodeLen(id.ExecPub, ed25519.PublicKeySize); err != nil {
		return nil, nil, nil, err
	}
	raw, err := decodeLen(id.ExecPriv, ed25519.PrivateKeySize)
	if err != nil {
		return nil, nil, nil, err
	}
	return wsPub, execPub, ed25519.PrivateKey(raw), nil
}

func decodeLen(s string, n int) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != n {
		return nil, fmt.Errorf("密钥长度应为 %d 字节，实际 %d", n, len(b))
	}
	return b, nil
}
