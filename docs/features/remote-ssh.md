# 远程主机一键接入（SSH）

> 更新：2026-11-09。

> 适用范围：公司内网，或用户自己的两台机器（Windows ↔ 自己的 Linux）。Tandem 只使用**用户自己的 SSH 凭据**连接用户指定的机器；不连接任何公网服务，不上传数据到第三方。远程 Host 默认只监听 `127.0.0.1`，对外不可见。

## 1. 它做什么

在「设置 → 主机 → 远程主机」填 `user@host`、SSH 端口和认证方式，本机 Host 会：

1. 用系统 `ssh-keyscan` 读取目标机公钥，把 SHA256 指纹展示给你确认（首次连接必须人工核对；指纹变化会阻止连接）。
2. 通过 SSH 检测远端系统 / 架构 / Node / systemd。
3. 把本机 Host 的构建产物与生产依赖打成 tar 包（`packages/server/dist` + `web/dist` + 生产 `node_modules`），`scp` 到远端 `~/.tandem-host` 并解压；**不访问公网下载任何东西**。
4. 在远端写配置（`~/.tandem/config.json`，已有配置会保留原有 token），用 `systemd --user` 或 `nohup + cron 检查` 启动 Host。
5. 在本机启动 `ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:<远程端口>` 隧道并自动重连；客户端把隧道地址当作普通主机添加，带 `SSH` 标签与延迟。

远程 Host 的数据仍在其 `~/.tandem`（会话、账号 Key、设置、用量），升级会保留；卸载时可选择保留或删除。

## 2. 前置条件

- **本机（控制端）**
  - Windows 10/11 自带的 OpenSSH 客户端：`ssh.exe`、`scp.exe`、`ssh-keyscan.exe`、`ssh-keygen.exe` 在 PATH 中。
  - 或 Linux / macOS 的 OpenSSH。
  - Tandem Host 能访问目标机的 SSH 端口（内网 / VPN / 用户自己的机器）。
- **远程机**
  - 已开启 SSH 服务，且允许你的用户登录。
  - **Node.js ≥ 22**（`node -v` 可看到）。没有时不会自动从公网下载：
    - 推荐先在远程安装（发行版包管理器 / nvm / 官方包，由用户自行决定）；
    - 若本机 Host 也是 Linux 且架构一致，可在界面上勾选「从本机上传 Node」。上传的是当前进程的 Node 二进制，依赖远端 glibc 兼容；失败时仍建议在远端自行安装。
  - `tar`；有 `systemd --user` 时用它，没有则用 `nohup + crontab`（每分钟检查进程是否存活）。
  - 目标目录可写：`~/.tandem-host`（程序）与 `~/.tandem`（数据）。

## 3. 认证方式

| 方式 | 说明 | 密码/Key 落在哪里 |
|---|---|---|
| ssh-agent | 使用本机已加载的 Key（Windows 需启动「OpenSSH Authentication Agent」服务并 `ssh-add`） | 不保存任何秘密 |
| 私钥文件 | 填本机私钥路径（支持 `~`）。会加 `IdentitiesOnly=yes`，只试这一把 Key | 只保存路径，不复制私钥 |
| 密码 | 只在本次连接与其后的隧道保活中使用；**不写入磁盘、不入日志** | 仅本机 Host 进程内存 |

密码认证通过 `SSH_ASKPASS` 把密码交给系统 `ssh`，不出现在命令行参数里。**本机 Host 重启后内存中的密码会清空**，密码型远程主机会显示「需要重新输入密码」；重新输入后才能恢复隧道。

Windows 的 OpenSSH 对 `SSH_ASKPASS` 支持有限，建议在 Windows 上优先使用 ssh-agent 或私钥文件；密码方式主要面向 Linux/macOS 控制端。

主机公钥保存在本机 `~/.tandem/ssh_known_hosts`（不是 `~/.ssh/known_hosts`），与用户的其它 SSH 连接隔离。首次确认的指纹写入后，后续指纹不一致会被拒绝。

## 4. 安全模型

- 只使用用户自己的 SSH 凭据与用户指定的目标；Tandem 不内置任何账号、不连接公网中继、不上传代码/会话。
- 默认远程 Host 监听 `127.0.0.1`，客户端通过 SSH 隧道访问；目标机防火墙无需开放任何端口。
- 可选「远程监听局域网」：远程 Host 监听 `0.0.0.0`，持有主机 token 的局域网设备可直接连接。**不建议**；开启前确认网段可信，并优先使用「设置 → 成员」签发的成员 token，而不是所有者 token。
- 部署产物来自本机当前 Tandem 版本，经 SSH 加密传输；远端只执行固定的安装/启动脚本，路径与端口均做单引号转义，不使用本地 shell 拼接。
- 远程 `~/.tandem` 含账号 Key（加密存储）、会话与设置；卸载默认保留，彻底删除需在确认框里关闭「保留远程数据」。
- SSH 主机指纹在首次连接时展示，需人工核对；指纹变化（重装系统 / 中间人）会阻止连接。

## 5. Windows 自带 OpenSSH

1. 「设置 → 应用 → 可选功能 → 添加功能 → OpenSSH 客户端」。
2. 以管理员打开 PowerShell：`Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent`。
3. `ssh-add $env:USERPROFILE\.ssh\id_ed25519`（或你的 Key）。
4. 在 Tandem 里选择「ssh-agent」；若用私钥文件，路径可填 `C:\Users\<你>\.ssh\id_ed25519`。
5. 首次连接会在界面显示主机指纹，和远程机 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的结果核对。

## 6. 管理操作（主机项 ⋯ 菜单）

- **重启**：`systemctl --user restart tandem-host.service`，或执行远端 `start.sh`；随后验证隧道与 `/api/host`。
- **查看日志**：systemd 用 `journalctl --user -u tandem-host.service -n 200`，否则 `tail -n 200 ~/.tandem-host/tandem-host.log`。
- **升级**：重新打包当前本机版本、上传、替换 `~/.tandem-host/app`，保留 `~/.tandem`，重启并验证。远程版本与本机不一致时，主机列表显示「可升级」。
- **诊断**：对列表中的远程主机运行普通「诊断」（走隧道请求远端 `/api/doctor`）。
- **卸载**：停止并禁用服务、移除 unit / cron 行、删除 `~/.tandem-host`；可选同时删除 `~/.tandem`。需要二次确认。

## 7. 排错

| 现象 | 处理 |
|---|---|
| 检测主机失败 / `Connection reset` | 目标 sshd 可能对短时间多次探测做了限速；等 15–30 秒重试。确认 `ssh user@host -p 端口` 手动可登录。 |
| `Permission denied (publickey)` | ssh-agent 未启动 / Key 未加载 / 用户名不对；改用「私钥文件」并填绝对路径。 |
| 指纹不一致 | 远程重装过系统或换了主机 Key；确认无误后删除本机 `~/.tandem/ssh_known_hosts` 中对应条目再重新检测。 |
| 部署卡在「检测远程系统与 Node」 | 远端非交互 shell 的 PATH 找不到 node。界面填写 Node 绝对路径，或勾选「从本机上传 Node」。 |
| 远程 Node 低于 22 | 先在远端安装 Node ≥ 22；不会自动公网下载。 |
| 卡在「安装并启动服务」 | 远端没有 systemd --user（常见于容器 / 精简系统）：把服务方式改为「nohup + cron」，并确认有 `crontab`。 |
| systemd 服务在 SSH 退出后停止 | 用户服务需要 linger：在远程执行 `sudo loginctl enable-linger $USER`；或把服务方式改为「nohup + cron」。 |
| 部署成功但「验证远程 Host」失败 | 查看 ⋯ → 查看日志；确认 `~/.tandem-host/app/server/dist/cli.js` 存在、端口未被占用。 |
| 重启本机 Host 后密码型主机离线 | 点 ⋯ → 重新输入密码（密码不保存）。 |
| 隧道断开 | 本机 Host 会每 5 秒重连；检查网络 / SSH 会话是否被踢。延迟在主机列表与切换器中显示。 |
| 远程监听局域网后连不上 | 确认防火墙放行端口，并使用正确 token；仍建议改回默认（仅隧道）。 |

## 8. 相关代码与接口

- 契约：`packages/protocol/src/index.ts` 的 `SshHostInput` / `RemoteSshHost` / `SshJob` 与 `/api/ssh-hosts*` 注释。
- 服务端：`packages/server/src/ssh/{exec,remote,package,manager}.ts`、`src/routes/ssh-hosts.ts`。
- 客户端：`packages/web/src/components/settings/RemoteSshDialog.tsx`、`HostsSection.tsx`、`lib/api.ts`。
- 测试钩子：`TANDEM_SSH_BIN` 可指向包含假 `ssh/scp/ssh-keyscan/ssh-keygen` 的目录（仅用于自动化回归，生产不设置）。
