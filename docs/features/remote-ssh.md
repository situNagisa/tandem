# 远程主机一键接入（SSH）

> 更新：2026-11-10。适用范围：公司内网，或用户自己的两台机器。只使用**用户自己的 SSH 凭据**连用户指定的机器；不连接公网服务、不上传数据到第三方。远程 Host 默认只监听 `127.0.0.1`。

## 是什么

「设置 → 主机 → 远程主机」填 `user@host`、端口与认证方式，本机 Host 会：

1. `ssh-keyscan` 读目标公钥，展示 SHA256 指纹要求人工确认；指纹变化阻止连接。
2. 检测远端系统/架构/Node/systemd。
3. 把本机 `packages/server/dist` + `web/dist` + 生产 `node_modules` 打成 tar（或 Windows ZIP），`scp` 到 `~/.tandem-host` 解压；**不访问公网下载**。
4. 写远端配置（保留已有 token），用 `systemd --user` 或 `nohup + cron` 启动。
5. 本机建 `ssh -N -L 127.0.0.1:<本地>:127.0.0.1:<远程>` 隧道并自动重连；客户端把隧道地址当普通主机添加，带 `SSH` 标签与延迟。

远程数据仍在远端 `~/.tandem`；升级保留，卸载可选保留或删除。

## 前置条件

- 本机：Windows 10/11 OpenSSH（`ssh/scp/ssh-keyscan/ssh-keygen`）或 Linux/macOS OpenSSH；能访问目标 SSH 端口。
- 远端：SSH 可登录；**Node ≥22**（没有时不会自动公网下载；可先在远端装，或在本机 Host 也是 Linux 且架构一致时勾选「从本机上传 Node」）；`tar`；有 systemd --user 用它，否则用 `nohup + crontab`；`~/.tandem-host` 与 `~/.tandem` 可写。

## 认证方式

| 方式 | 说明 | 秘密落在哪里 |
|---|---|---|
| ssh-agent | 用本机已加载 Key（Windows 需启动 OpenSSH Authentication Agent 并 `ssh-add`） | 不保存 |
| 私钥文件 | 填本机路径（支持 `~`），`IdentitiesOnly=yes` | 只保存路径 |
| 密码 | 仅本次连接与隧道保活用；`SSH_ASKPASS` 交给系统 ssh，不进命令行 | 仅 Host 进程内存，重启清空 |

Windows OpenSSH 对 `SSH_ASKPASS` 支持有限，优先 ssh-agent/私钥。主机公钥存 `~/.tandem/ssh_known_hosts`（与用户其它 SSH 隔离）；指纹不一致拒绝。

## 安全模型

- 只用用户凭据与指定目标；不内置账号、不通过公网中转、不上传代码/会话。
- 默认远程 Host 监听 `127.0.0.1`，经 SSH 隧道访问，目标防火墙无需开放端口。
- 可选「远程监听局域网」：监听 `0.0.0.0`，持 token 的局域网设备可直连；**不建议**，优先用成员 token。
- 部署产物来自当前 Tandem 版本，经 SSH 加密传输；远端只跑固定安装/启动脚本，路径/端口单引号转义。
- 远程 `~/.tandem` 含加密 Key、会话与设置；卸载默认保留，彻底删除需在确认框关闭「保留远程数据」。

## Windows 自带 OpenSSH

「设置 → 应用 → 可选功能 → OpenSSH 客户端」→ 管理员 PowerShell 启动 `ssh-agent` 并设为自动 → `ssh-add $env:USERPROFILE\.ssh\id_ed25519` → Tandem 选 ssh-agent 或私钥路径 → 首次连接核对界面指纹与远端 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。

## 管理操作

- 重启：`systemctl --user restart tandem-host.service` 或远端 `start.sh`，随后验证隧道与 `/api/host`。
- 日志：`journalctl --user -u tandem-host.service -n 200` 或 `tail -n 200 ~/.tandem-host/tandem-host.log`。
- 升级：重新打包上传、替换 `~/.tandem-host/app`，保留 `~/.tandem`，重启验证；版本不一致时列表显示「可升级」。
- 诊断：走隧道请求远端 `/api/doctor`。卸载：停服务、移除 unit/cron、删 `~/.tandem-host`，可选删 `~/.tandem`，二次确认。

## 排错

| 现象 | 处理 |
|---|---|
| 检测失败 / Connection reset | sshd 可能限速，等 15–30 秒；先手动 `ssh` 确认 |
| Permission denied (publickey) | ssh-agent 未启动/Key 未加载/用户名错；改用私钥绝对路径 |
| 指纹不一致 | 重装或换 Key；确认后删 `~/.tandem/ssh_known_hosts` 对应条目再检测 |
| 卡在检测 Node | 非交互 shell PATH 找不到 node；填绝对路径或勾选上传 Node |
| 远程 Node <22 | 远端先装 Node ≥22；不会自动公网下载 |
| 卡在安装服务 | 无 systemd --user（容器/精简系统）：改用 nohup+cron 并确认 crontab |
| SSH 退出后服务停 | `sudo loginctl enable-linger $USER` 或改 nohup+cron |
| 部署成功但验证失败 | 看日志，确认 `~/.tandem-host/app/server/dist/cli.js` 存在、端口未占 |
| 重启后密码型主机离线 | 点 ⋯ 重新输入密码（不保存） |
| 隧道断开 | Host 每 5 秒重连；检查网络/SSH 会话；延迟在主机列表显示 |
| 远程监听后连不上 | 防火墙放行并使用正确 token；建议改回仅隧道 |

## 代码位置

契约 `SshHostInput/RemoteSshHost/SshJob`；服务端 `packages/server/src/ssh/{exec,remote,package,manager}.ts`、`routes/ssh-hosts.ts`；客户端 `settings/RemoteSshDialog.tsx`、`HostsSection.tsx`、`lib/api.ts`。测试钩子 `TANDEM_SSH_BIN` 指向假 ssh 工具目录（仅自动化，生产不设置）。
