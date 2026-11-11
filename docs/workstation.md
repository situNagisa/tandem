# 工作站：程序本体

> 更新：2026-11-11。代测步骤见 [test-guides/workstation.md](test-guides/workstation.md)。

## 1. 模型

**整个程序就是一个工作站服务。** 客户端（浏览器、桌面窗口、手机）只连工作站；工作站与各主机建立会话连接，agent 在主机上跑。

- **工作站服务**：`tandem-host`（`npm start` / 桌面版）唯一的对外进程。一个端口（默认 8481），同时提供账号 API、Web UI 与 `/h/<hostId>` 主机访问。
- **主机上下文**：`Host` + Fastify 应用，运行在工作站进程内、只监听回环随机端口。两类：
  - **本机上下文**：运行工作站的这台机器，`HostEnv` 是 `LocalHostEnv`，数据在 `<TANDEM_HOME>/local-host/`。不走隧道、不走执行器。
  - **执行器主机**：远端机器只跑 `tandem-exec`，出站连工作站；工作站为它建一个远端上下文（`RemoteHostEnv`），数据在 `<TANDEM_HOME>/remote-hosts/<hostId>/`。见 [features/executor.md](features/executor.md)。
- 两类上下文是同一份 Host 代码，出现在同一份主机列表里，客户端都经 `<工作站>/h/<hostId>` 访问（账号令牌由主机上下文本地验签）。
- 所有角色只在内网 / VPN 使用；不做端口映射、公网代理、第三方隧道与推送。

## 2. 首次使用

1. `npm start`（或桌面版）启动工作站；终端打印 `http://127.0.0.1:8481/`（局域网用 `--host 0.0.0.0`）。
2. 浏览器打开该地址：未初始化时显示「创建工作站」——工作站名称 + 管理员用户名/密码。**第一个注册的用户是管理员**；之后内网任何人可注册（或改为仅邀请）。
3. 登录后进入「我的主机」：没有主机时显示空状态「先添加一台主机」，新会话入口禁用并说明原因。
4. 点「添加主机」→ **添加这台电脑**（只在回环地址可用）：把运行工作站的这台机器登记为当前账号的主机。之后可新建会话、发消息、跑 agent。
5. 其他机器用「添加主机」里的一行命令安装执行器（见 §3）。

登录 ≠ 添加主机：浏览器、桌面、手机都只是登录入口；执行任务的主机必须显式加入账号。

## 3. 添加远端主机（执行器）

客户端「添加主机」（空状态、设置 → 主机、命令面板均可打开）给出按平台切换的一行命令（Windows PowerShell / macOS / Linux）：

```powershell
& ([scriptblock]::Create((irm http://192.168.1.10:8481/install.ps1))) -Token 'ach_…'
```

```bash
curl -fsSL http://192.168.1.10:8481/install.sh | sh -s -- --token ach_…
```

- 命令里是**一次性注册令牌** `ach_<密钥>.<指纹>`：15 分钟有效、只能用一次。`<指纹>` 是工作站公钥 SHA-256 的前 16 位十六进制，执行器发送令牌前先核对；工作站只存令牌的 SHA-256。
- 目标机器只需能访问工作站，不需要 Node.js、不需要管理员权限；执行器只出站、不监听端口。
- 登记成功后工作站为它建立远端主机上下文；主机列表出现这台机器，会话、agent、模型调用都在工作站，工具经执行器在远端运行。
- 开机自启 `--service` / `-Service` 只写启动项（systemd --user / LaunchAgent / HKCU Run），下次登录生效。

## 4. 数据目录与端口

- `TANDEM_HOME`（默认 `~/.tandem`）是工作站数据目录：`accounts.json`（账号、主机登记、授权、审计、工作站私钥）、`profiles.json` + `profiles.key`（账号级模型账号，加密存储）、`model-usage.json`（按账号/主机记账）、`sessions`/`tasks`/`boards` 等工作站级数据。
- 主机上下文按主机分目录：本机 `local-host/`，执行器 `remote-hosts/<hostId>/`；会话、工具状态、检查点都在各自目录。
- 一个端口（默认 8481，`--port` 可改，占用时启动失败）；桌面版从 8481 起找空闲端口，并把实际端口加载到窗口。8481 上已有同一数据目录的工作站时直接复用。

## 5. 账号、可见性与授权

- 注册默认**开放**；管理员可改为**仅邀请**。首个注册者为管理员。账号状态 `active/disabled`，吊销即时生效（访问令牌失效 + 成员上下文关闭长连接）。
- 新账号只看到自己添加的主机；别人的主机/设备要主人授权才可见。管理员默认也不获得他人会话语义的访问权。
- 授权模型：主机主人把主机（或项目目录/设备）授权给某账号，角色沿用 所有者 / 协作者 / 审批者 / 观察者；范围外 404。
- **模型账号按账号**：provider 账号、分组、Key、倍率与模型勾选归工作站账号，Key 加密保存在工作站；主机上下文直接调用账号模型（同一进程），上游请求按账号与主机记账。
- 审计按账号：注册/登录/失败、主机登记/移除、授权变更、会话与审批。

## 6. 调试版

调试版（默认构建）在**回环地址**打开时自动登录内置调试账号（用户名 `debug`，密码在 `<TANDEM_HOME>/debug-account.json`，0600），并自动添加本机与演示主机（演示主机是工作站进程内的第二个本地上下文，数据在 `<TANDEM_HOME>/demo-host/`）；发布版与 `TANDEM_DEBUG_ACCOUNT=0` 没有这些行为，主机都要显式添加。

## 7. 部署

团队服务器（内网 Linux，Node ≥ 22）：

```bash
TANDEM_HOME=/var/lib/tandem-workstation tandem-host --host 0.0.0.0 --port 8481
```

Docker（只发布到内网）：

```bash
docker build -f deploy/workstation/Dockerfile -t tandem-workstation .
docker run -d --name tandem-workstation -p 8481:8481 \
  -v tandem-workstation-data:/data -e TANDEM_HOME=/data tandem-workstation
```

防火墙只允许公司网段访问 8481；不配置公网反代、不做端口映射。工作站被攻破 = 可拒绝服务、可伪造账号/授权，所以只部署在信任的服务器与可信内网。

## 8. 验证（开发期自测）

- 只跑工作站：`TANDEM_HOME=/tmp/tandem-ws tandem-host --port 8481`。
- 全新客户端只填 `http://127.0.0.1:8481`：创建管理员 → 空状态 → 添加这台电脑 → 新建会话 → 流式回复。
- 远端执行器：客户端复制一行命令，在 `/tmp` 的假 `HOME` 下执行，前台显示「已登记并连接工作站」，主机在线；自动化见 `e2e/executor-check.mjs`。
- 账号与模型：Key 只出现在工作站 `profiles.json`（加密）与上游请求里，主机上下文目录搜不到明文 Key。
- 自动化：`e2e/workstation-check.mjs`、`e2e/regression.mjs`「工作站客户端-服务」用例；步骤见 `test-guides/workstation.md`。
