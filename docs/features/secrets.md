# 项目 Secrets 注入 + 输出脱敏

> 更新：2026-11-10。按项目把数据库密码、内部令牌等注入 agent 进程环境，而模型、会话记录、日志、界面与 WS 推送都看不到明文。全部本机完成，不接第三方密钥托管、不向公网发送。

## 数据与接口

- 存储 `~/.tandem/secrets.json`（600），值为 AES-256-GCM 密文 `v1:iv:tag:ciphertext`；密钥 `~/.tandem/secrets.key`（随机 32 字节，600，分开存放）。Windows 上 chmod 可能无效，依赖用户目录 ACL。
- 项目键：向上找 `.git`（worktree 指回主仓库）；不在仓库内用会话 cwd。全局 secret 对所有项目生效，同名项目覆盖全局。
- 作用范围：`bash`（Bash + 后台任务）、`mcp`（stdio）、`hooks`（Claude Code 兼容）。同一 secret 可多选。
- REST：`GET/POST/PATCH/DELETE /api/secrets*`、`PUT /api/secrets/settings`；只返回 `name/description/scopes/project/lastUsedAt`，**永不返回值**；更新时值输入框不回显。
- 不用系统钥匙串（keytar/libsecret 需原生模块与打包链路）；以后可只替换 `loadKey()` 存取层。

## 注入

| 路径 | 注入点 |
|---|---|
| Bash 前台 | `spawn(..., { env: { ...process.env, ...secretEnv } })` |
| Bash 后台 | `BackgroundTaskManager.start({ env })`，输出进缓冲/日志前打码 |
| Hooks | `execHookCommand` 的 env（含 `CLAUDE_PROJECT_DIR`），每次按 cwd 重新取 |
| stdio MCP | `StdioClientTransport` 的 env，secret 变化时重连（`envKey` 比对） |

系统提示只追加名称、描述与作用范围，不含值；提示模型在 Bash 里直接引用 `$NAME`（Windows `%NAME%`），不要 echo/env/写文件。

## 脱敏

进入会话 / 发模型 / 广播客户端 / 写日志前统一打码：工具结果（Bash stdout/stderr、BashOutput、Read、Grep、MCP、browser console、Task 子代理最后文本）、Hook 输出、后台任务缓冲/日志/WS、每轮请求的 system+messages 副本、上下文面板预览。

替换为 `[secret:NAME]`，匹配原值、`encodeURIComponent`、base64/base64url/去 padding、JSON 转义；长度 <4 的值不打码。通用规则（可关）：`sk-/rk-/pk-`、`ghp_`、`github_pat_`、`glpat-`、`xox[baprs]-`、`AKIA/ASIA` → `[secret:generic]`；PEM 私钥 → `[secret:private-key]`。前端把 `[secret:NAME]` 渲染成小标签，hover 显示「已隐藏 secret：NAME」；右栏详情显示本项目可用 secret 数量。

## 威胁模型

- **模型间接泄露**：模型知道名称不知道值；echo/env/base64/写文件后工具输出与后台日志都会打码。局限：逐字符变换、哈希、压缩等无法穷举；脱敏是降低影响面，不是密码学边界。
- **写入文件后被 Read**：Read 结果同样打码，但磁盘文件仍含明文；若提交/推送会离开本机。Tandem 不自动提交；建议不要写 secret 到仓库，并使用最小权限账号与轮换。
- **会话与日志**：工具结果进消息数组前打码，会话 JSON/WS/请求体只有标签；用户直接粘贴的值由请求前兜底打码覆盖。
- **多端/团队**：成员拿不到 secret 值；Secrets 设置属于 Host 所有者；共享会话看到打码输出。
- **本机攻击者**：能读 `~/.tandem` 的同用户进程可同时拿密文与密钥；AES-GCM 只防单文件被拷走/误传。
- **图片/二进制**：不做像素级脱敏；短值 <4 字符不参与打码，建议不要作为 secret。

## 验证

`TANDEM_HOME=/tmp/tandem-secrets`、mock provider 记录请求体；模型执行 `echo $DB_PASSWORD; env | grep DB_; printf %s "$DB_PASSWORD" | base64`，确认命令拿到值；断言 mock 请求体、会话 JSON、WS、Host 日志、工具结果只有 `[secret:DB_PASSWORD]`。回归「Secrets 工具输出显示打码标签」验证标签与 hover。
