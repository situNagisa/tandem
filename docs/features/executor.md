# 远端执行器（tandem-exec）

> 更新：2026-11-10。设计依据与里程碑见 [archive/plan/thin-host-2026-11-10.md](../archive/plan/thin-host-2026-11-10.md)。当前是 M4：执行器已接入产品，一行命令安装后机器出现在主机列表，会话的工具在远端运行（见下文「接入产品」）。设备、浏览器、MCP、串口与旧会话导入不在本版范围。

## 是什么

`packages/executor`（Go，只依赖标准库与 `github.com/coder/websocket`，`CGO_ENABLED=0` 静态编译）。单文件，装在远端机器的用户目录，不需要 Node，不监听端口，只主动出站连接工作站。远端只负责执行：命令、文件读写、系统信息；agent 循环、会话与模型调用都在工作站。

子命令：`tandem-exec join --server <工作站> --token <令牌>`（首次登记，之后前台保持连接）、`tandem-exec run`（按身份文件连接）、`tandem-exec --version`。主目录 `~/.tandem-executor`（`TANDEM_EXEC_HOME` 可覆盖），身份文件 `identity.json`（0600）只存工作站公钥与执行器自己的 Ed25519 密钥。

## 协议（v1，`internal/wire`）

- **帧**：`[type u8][streamId u32 BE][payload]`。握手阶段明文；握手完成后每帧整体 AES-256-GCM 加密，nonce = `[方向 u32][计数器 u64]`，两个方向不同密钥，计数器隐式递增，篡改或乱序即断开。
- **握手**：HELLO（执行器临时 X25519 公钥）→ WELCOME（工作站临时公钥 + Ed25519 签名）→ 执行器校验签名 → 加密的 AUTH（执行器签名）。transcript 绑定 hostId 与两端临时公钥，每次连接临时密钥都不同，旧消息无法重放。
- **登记**：令牌 `ach_<secret>.<fp>`，`fp` 是工作站公钥 SHA-256 的前 16 位十六进制。执行器先核对指纹，再发令牌（只在加密通道内）。15 分钟内有效，一次性。登记超时或指纹不符时退出，不反复重试。
- **重连**：身份文件里固定了工作站公钥，握手时必须一致，否则退出。断线后 1s 起指数退避（最长 30s，±20% 抖动），握手成功后重置。心跳：工作站每 15 秒 PING，执行器 45 秒无任何帧即断开。
- **流控**：每流每方向 1 MiB 窗口，接收方每消费 256 KiB 回 FLOW；DATA/OUT/ERR 单帧不超过 64 KiB；同一进程同时最多 32 个请求，超出排队。
- **操作**（`internal/ops`）：`exec.shell`（POSIX `bash -c`；Windows 写 UTF-8 无 BOM 的 `.cmd` 再交给 `cmd /d /s /c`，`chcp 65001`，输出为 UTF-8）、`exec.argv`（不经 shell）、`fs.stat / list / read / write / mkdir / rename / remove`、`fs.walk`（M2，路径以 NUL 分隔的 DATA 流）、`sys.info`。`fs.stat` 跟随符号链接，失效链接返回 `ENOENT`。取消时杀进程树：POSIX 进程组 SIGKILL，Windows `taskkill /T /F`。超时与取消分别在 END 中标记。
- **写入**：同目录临时文件 → fsync → 若给了 `expectMtime` 且不一致返回 `ECONFLICT` → rename。中途出错或取消会删除临时文件，目标保持原样。
- **错误码**：`ENOENT EEXIST EACCES ENOTDIR EISDIR ENOTEMPTY EINVAL ECONFLICT EUNSUPPORTED ECANCELED EIO`。错误是非致命的 END 结果，不断开连接。
- **能力协商**：HELLO 带执行器操作表，WELCOME 返回工作站支持的操作；执行器只执行两者交集，其余返回 `EUNSUPPORTED`。

## 边界与取舍

- 工作站到执行器的 TLS 证书不校验（`InsecureSkipVerify`）：认证靠上面的签名与指纹，TLS 只用来隐藏流量元数据，内网自签证书可用。
- 断线时未结束的 exec 流杀掉进程树；后台任务、`fwd.*`、`pty.*`、自更新未实现（v2 或之后的里程碑）。
- Windows `.cmd` 的 `%`：成对的 `%NAME%` 原样保留，其余 `%` 双写，结果与 cmd 命令行一致；未定义的 `%NAME%` 在命令行保持原文、在 `.cmd` 里变成空，未处理。`wrap`（沙箱包装）只在 POSIX 生效。CreateProcess 的当前目录上限是 260 字符，超出时本机与远端都无法启动命令。
- 执行器 `join` 之后，身份文件存在即优先使用，`--token` 被忽略。

## 工作站侧接口（M2–M3）

工具只经 `ToolContext.env`（`packages/server/src/host-env.ts` 的 `HostEnv`）访问项目所在机器。两个实现：

- `localHostEnv`：node:fs 与 child_process。`shell` 在 POSIX 下 `/bin/bash -c`、Windows 下 `cmd /d /s /c`，中断时杀进程树（POSIX 进程组，Windows `taskkill /T`）。`fs.write` 为同目录临时文件 + rename，符号链接指向的文件被改写。
- `RemoteHostEnv`（`packages/server/src/executor/remote-env.ts`）：翻译成 `exec.argv`、`exec.shell`、`fs.stat / read / write / walk`；启动时用 `sys.info` 取远端系统、home、tmp，以及 rg、bwrap 是否可用。路径语义取远端系统，远端 Windows 的盘符与反斜杠按 win32 解析。

`HostEnv.shell` 以流式输出返回：远端中断时 reject（AbortError），本机中断时等进程结束后 resolve，调用方以自己的 signal 判断原因。`fs.write` 的 `expectMtime` 不一致返回 `ECONFLICT`，远端与本机一致。

连接对象 `ExecutorConn`（`packages/server/src/executor/conn.ts`）是握手的响应方：校验 AUTH、首次登记（令牌校验由调用方的 `ExecutorAuth.enroll` 实现）、流复用、接收窗口、请求体上行（DATA 按执行器的 FLOW 限速，发完 END）、心跳（工作站每 15 秒 PING，45 秒无帧即断开）。线原语在 `executor/wire.ts`。

沙箱：`sandboxWrap(env, cwd, profile)`（`sandbox.ts`）按执行的机器取引擎与可写目录。远端 Linux 有 bwrap 时包装；没有时命令不包装，输出开头给一行提示。远端 Windows 不支持沙箱。

后台任务（`tasks.ts`）经 `env.shell` 启动，输出缓冲与日志在工作站。远端执行器断线时任务以 `exited`（退出码 -1）结束，输出里标注 `执行失败: 执行器连接已断开`。**不做断线续跑**：需要 `bg.*` 操作由执行器持有进程，是 M4 待办。

检查点：Write、Edit 在改写前用 `fs.read` 取旧内容交给 `ToolContext.snapshot`，快照仍存在工作站。**回退（rewind）只能写本机**，远端文件的回退是 M4 待办。

已迁移的工具：Read、Glob、Grep（M2），Write、Edit、Bash、BashOutput、KillBash（M3）。`packages/server/test/host-env-static.test.ts` 禁止这些文件直接 import `node:fs`、`node:child_process` 与 `util/fs-walk`；每迁移一个工具文件就把它加进清单。

本机行为的两处调整（与远端一致）：Bash 的 stdin 改为 ignore（读标准输入的命令立即得到 EOF，不再挂到超时）；Windows 本机中断时 `taskkill /T` 杀整棵树（此前只杀 cmd.exe）。

远端与本机的已知差异：`mtimeMs` 远端为整毫秒（`fs.write` 的 `expectMtime` 也按整毫秒比较），本机为小数毫秒；目录大小是平台值（Windows 为 0）；Grep 的 JS 路径输出顺序取决于各系统的目录读取顺序，比较时按行排序。

测试：`packages/server/test/executor/m2-env.test.ts` 与 `m3-env.test.ts` 用同一组用例分别跑本机与远端。Linux 远端运行 linux-amd64 执行器；Windows 远端经 WSL 互操作运行 windows-amd64.exe，fixture 建在 `/mnt/c/Users/JDHC/AppData/Local/Temp/`，结束后删除。M3 的 Windows 用例对照 cmd 命令行直接执行的结果（非 ASCII 路径除外，参数经 WSL 互操作会被打乱，那一项直接断言结果），并覆盖临时目录含空格与中文、接近 MAX_PATH 的工作目录。Windows 符号链接需要 mklink 权限，没有时相关用例跳过。

## 接入产品（M4）

- **安装**：`/install.sh`、`/install.ps1` 嵌入各平台 sha256（构建产物 `SHA256SUMS`），从 `<工作站>/executor/<平台>` 下载（无压缩），装到 `~/.tandem-executor/bin/tandem-exec`，前台 `join`。`--service` / `-Service` 只写启动项（systemd --user、LaunchAgent、HKCU Run），下次登录生效。
- **登记**：绑定码 `ach_<密钥>.<指纹>`（`POST /api/workstation/hosts/bind-code`）。`ExecutorHub.enroll`（`executor/hub.ts`）用与本机加入相同的 `registerAsHost` 登记，执行器公钥记入 `remote-hosts/executors.json`（0600）。
- **远端主机上下文**：每台执行器是工作站进程里的一个 `Host`（`remote: true`），数据在 `remote-hosts/<主机 ID>/`，经本机回环隧道接入（`createApp` + `WorkstationAgent`）。客户端照旧走 `/h/<主机 ID>` 与端到端加密，前端不改。
- **工具环境**：连接时 `Host.env` 换成 `RemoteHostEnv`，Read、Glob、Grep、Write、Edit、Bash、BashOutput、KillBash、Task 经 `ctx.env` 在远端运行。断开后 `env` 保留，调用以「执行器未就绪」失败；主机在线 = 执行器已连接（`hub.isLive`）。
- **远端不支持**（`host.remote`）：隐藏 browser_*、Device*、Adb*、Serial*、Skill、Wiki*、MCP；钩子不执行；不做 git 检测（无 worktree、分支、PR）；切换会话目录返回 501。`REMOTE_UNSUPPORTED`（`server.ts`）对文件浏览、外部会话、浏览器、设备、MCP、技能、Wiki、评测、看板、钩子、诊断、语音及会话的 git/worktree/PR/回退/导入返回 501。
- **重启与授权**：`ExecutorHub.restore` 为每台已登记执行器重建上下文，不等执行器连接；工作站端口变化后需重新执行安装命令。授权沿用普通主机模型（`perHost`），被授权账号的操作未单独验证。
- **未做**：`bg.*` 后台任务（断线续跑）、远端检查点回退、自更新、设备/浏览器/串口/MCP、旧会话导入。远端 Windows 的路径语义已接入，未在真实 Windows 会话上端到端验证。

## 构建

```bash
node scripts/build-executor.mjs              # 五个平台 + SHA256SUMS → packages/executor/dist/（gitignore）
node scripts/build-executor.mjs --if-stale   # 产物缺失或源码/版本变化时才构建（check.mjs 的 build-executor 步）
node scripts/build-executor.mjs --test       # go vet + go test（npm test 的最后一步）
```

Go 解析顺序：PATH 上 ≥1.24 的 `go` → `~/.cache/tandem/go/go1.27.3`（缓存）→ 从 go.dev 下载并校验 sha256。依赖在 `packages/executor/vendor/`，构建时 `GOPROXY=off`。目标：linux-amd64/arm64、windows-amd64、darwin-arm64/amd64。

## 测试

- Go 单测：`internal/wire`（nonce、transcript、加解密与篡改、乱序）、`internal/ops`（写入冲突不留残留、rename/mkdir/remove 边界、分段读）、`internal/client`（令牌与地址解析）。
- 协议端到端：`packages/server/test/executor/`（vitest），TS 测试服务端驱动真实二进制：认证（错误工作站公钥、伪造签名、重放、篡改密文、断线重连）、操作、流控、32 并发、大文件分块与内存上限。Linux 直接运行，Windows 产物经 WSL 互操作运行。
- 两项都在 `npm test` 中运行（`check.mjs` 的 test 步）；产物缺失时 TS 测试会提示先运行构建脚本。
