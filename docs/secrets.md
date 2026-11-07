# 项目 Secrets 注入 + 输出脱敏

> 目标：按项目把数据库密码、内部服务令牌等注入 agent 执行的进程环境，而模型、会话记录、日志、界面与 WS 推送都看不到明文。全部在本机完成，不接第三方密钥托管、不向公网发送任何 secret。

## 1. 数据与接口

- 存储：`~/.tandem/secrets.json`，文件权限 `600`；值是 AES-256-GCM 密文（`v1:iv:tag:ciphertext`）。
- 密钥：`~/.tandem/secrets.key`（随机 32 字节，`600`，与密文分开存放）。Windows 上 `chmod` 可能无效，此时依赖用户目录 ACL。
- 项目键：向上查找 `.git`（文件或目录）；worktree 的 `.git` 文件会指回主仓库，归到主仓库根；不在仓库内则用会话 cwd。全局 secret 对所有项目生效，同名时项目覆盖全局。
- 作用范围：`bash`（Bash + 后台任务）、`mcp`（stdio MCP）、`hooks`（Claude Code 兼容 Hooks）。同一条 secret 可多选。
- REST：
  - `GET /api/secrets?cwd=` → 全局/各项目元信息、可选项目、通用打码开关。
  - `POST /api/secrets`、`PATCH /api/secrets/:id`（`value` 省略表示保留）、`DELETE /api/secrets/:id`。
  - `PUT /api/secrets/settings` → `{ genericMask }`。
  - 所有接口只返回 `name/description/scopes/project/lastUsedAt`，**永不返回值**；更新时值输入框也不会回显。
- 操作系统钥匙串：评估过 `keytar` / `libsecret` 等方案，均需要原生模块并会进入 Electron 打包链路（Node ABI、交叉编译、Windows 安装器额外依赖）。本轮采用无原生依赖的“Host 生成密钥 + AES-GCM 落盘”，满足本机加密与可移植；后续如需系统钥匙串，可只替换 `loadKey()` 的存取层，接口与调用方不变。

## 2. 注入

| 执行路径 | 注入点 |
|---|---|
| Bash（前台） | `spawn(..., { env: { ...process.env, ...secretEnv } })` |
| Bash 后台任务 | `BackgroundTaskManager.start({ env })`；输出进入缓冲/日志前先打码 |
| Hooks | `execHookCommand` 的 `env`（含 `CLAUDE_PROJECT_DIR`）；每次 Hook 执行时按 cwd 重新取 |
| stdio MCP | `StdioClientTransport` 的 `env`；项目 secret 变化时重连（`envKey` 比对） |

系统提示只追加一段：

```
# 项目环境变量（Secrets）
以下变量的值已注入对应进程环境，模型看不到值：
- DB_PASSWORD：数据库密码（Bash/MCP/Hooks）
在 Bash 中直接引用 $NAME（Windows cmd 用 %NAME%），不要 echo/env/写入文件；…
```

只给名称、描述与作用范围，不含值。模型会自然地在命令里写 `$DB_PASSWORD`。

## 3. 脱敏

以下位置在“进入会话 / 发给模型 / 广播客户端 / 写日志”之前统一打码：

- 工具结果：Bash stdout/stderr、BashOutput、Read 文件内容、Grep、MCP 返回、browser console、Task 子代理最后文本。
- Hook 输出：PreToolUse 阻止原因、PostToolUse 反馈、Stop Hook 反馈、SessionStart / UserPromptSubmit 附加上下文。
- 后台任务：内存环形缓冲、`~/.tandem/tasks/*.log`、`task_updated` WS 推送。
- 模型请求：每轮请求前对整个 system + messages 副本再打码一次（防御用户粘贴、AGENTS.md 里误放值等）。
- 上下文面板的预览也来自打码后的副本。

替换为 `[secret:NAME]`。匹配的变体：

- 原值；
- `encodeURIComponent` 的 URL 编码；
- base64、base64url、去掉 padding 的 base64；
- JSON 字符串转义形式；
- 长度 < 4 的值不打码（否则会把普通数字/字母全量替换）。

通用规则（设置 → Secrets 可关）：

- `sk-…` / `rk-…` / `pk-…`、`ghp_…`、`github_pat_…`、`glpat-…`、`xox[baprs]-…`、`AKIA…` / `ASIA…` → `[secret:generic]`；
- PEM 私钥块 → `[secret:private-key]`。

前端：工具输出里的 `[secret:NAME]` 渲染成小标签，hover 显示「已隐藏 secret：NAME」；右栏「详情」显示本项目可用 secret 数量，点击跳到设置页。

## 4. 威胁模型

**模型间接泄露。** 模型知道环境变量名但不知道值；若它执行 `echo $DB_PASSWORD`、`env`、`printenv`、base64 编码或把值写进文件，工具输出与后台日志都会被打码。局限：模型可以把值做任意变换（如逐字符 `cut`、哈希、压缩后再读），工具无法穷举所有编码；脱敏是防误泄露与降低影响面，不是密码学边界。

**命令把值写进文件后被 Read。** Read 的结果同样经过打码，所以再次进入会话仍是 `[secret:...]`。但磁盘上的文件本身仍含明文：若该文件在仓库内且被 `git add/commit/push`，值会离开本机。Tandem 不会自动提交；仍建议在 AGENTS.md / 项目说明里明确“不要把 secret 写入仓库”。需要更硬的边界时，用最小权限数据库账号并定期轮换。

**会话与日志。** 工具结果在 push 到消息数组之前打码，因此 `~/.tandem/sessions/*.json`、WS 推送、模型请求体里只有标签。模型自己输出的文本（例如用户把值直接粘进聊天）不在工具脱敏范围内，因为它不是“secret 注入”的产物；请求前兜底打码可覆盖历史里已出现的值。

**多端与团队。** 成员连接永远拿不到 secret 值；Secrets 设置页属于 Host 所有者设置，成员请求会被访问控制拒绝。会话若共享给成员，看到的是打码后的工具输出。

**本机攻击者。** 能读 `~/.tandem` 的同用户进程可以同时拿到 `secrets.json` 与 `secrets.key`，AES-GCM 只能防止文件被单独拷走/误传；不能防御同用户恶意进程。系统钥匙串同样不能防御同用户进程，但可减少明文密钥文件。

**图片与二进制。** 截图、图片文件与二进制输出不做像素级脱敏；如果命令把 secret 打印到网页再截图，值会以图像形式留在会话里。文档与提示词都要求不要把值写入文件/页面。

**短值。** < 4 字符的值不参与打码，避免把正常输出替换得不可读；此类值建议不要作为 secret 使用。

## 5. 验证

- `TANDEM_HOME=/tmp/tandem-secrets`、端口 `8303`，mock OpenAI 兼容 provider 记录请求体。
- 模型执行 `echo $DB_PASSWORD; env | grep DB_; printf %s "$DB_PASSWORD" | base64`，值写入 `/tmp` 文件后由测试脚本直接比对，确认命令确实拿到了值。
- 断言 mock 请求体、会话 json、WS 推送、Host 日志、工具结果里只有 `[secret:DB_PASSWORD]`。
- `e2e/regression.mjs` 的「Secrets 工具输出显示打码标签」用例验证标签与 hover 提示；截图在 `/tmp/secrets-shots/`。
