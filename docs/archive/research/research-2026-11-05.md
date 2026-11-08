# Tandem 竞品调研（截至 2026-11）

> 方法：官方文档/官网直读为主（Claude Code Docs、Codex、Cursor、Conductor、Happy、Omnara、opencode、opcode、Cline、Roo），辅以公开报道。标注"文档未述"的即为空白，不作推测。

## 0. 结论先行

- **两条路线成型**：① 云沙箱派（Codex Cloud、Cursor Cloud Agents、Conductor）跑厂商 VM，关电脑也跑；② 本地遥控派（Happy、Omnara、opcode）跑自有机器，手机/网页只是控制面。**Claude 官方两条都做，但会话割裂**：Desktop 明确"不在常规跨会话视图里列出 CLI / VS Code / 云端会话"；`--teleport` 是复制而非镜像，且要求干净 checkout + 已 push 分支 + 同账号。
- **2026 整合信号**：Conductor 于 11/04 宣布并入 Meta（0.93.0）；Roo Code 5/15 停运（社区 fork 为 ZooCode）；Happy CLI 转维护模式、主推 Desktop harness。→ 单点工具被收编，**"跨端 + 跨机器 + 跨模型的中立会话层"仍空着**。
- **Tandem 的靶心**：Host-first（会话唯一事实源）+ 多机网格 + 每会话独立账号/Key/模型 + 移动端一等公民 + **会话可迁移/可接管**（真双向，不是 teleport 式拷贝）。

---

## 1. Claude Code 全表面盘点

### 1.1 表面矩阵

| 表面 | 执行位置 | 关键差异 |
|---|---|---|
| CLI `claude` | 本机 | 全功能基线；`-p` 无头；`--teleport` 拉云端会话 |
| VS Code / Cursor / JetBrains | 本机 | 内联 diff、@ 提及、计划审阅、Command Palette |
| **Desktop（Code 标签页）** | Local / Cloud / SSH / WSL | 多面板工作台、可视化 diff、并排会话、定时任务、Remote Control、computer use |
| Web `claude.ai/code` | 云端 VM | 长任务、并行、Projects、云会话、移动/桌面接力 |
| Mobile（iOS/Android） | 云端/遥控本机 | Code 标签页启停云会话；Remote Control 遥控本地会话 |
| 其它 | — | Chrome 扩展、Slack（@Claude 修 bug→PR）、GitHub/GitLab CI、Channels（Telegram/Discord/iMessage/webhook）、Agent SDK |

### 1.2 Desktop 交互细节（重点抄）

- **入口**：Desktop 内 `Code` 标签页，与 Claude 聊天、Cowork 并列；一个会话 = 独立历史 + 项目目录 + 上下文 + 变更集。
- **启动前置选项**（发第一条 prompt 前必须选）：环境（Local/Cloud/SSH/WSL）、项目目录、权限模式、模型 + effort、是否 Worktree。
- **左侧栏**：并行会话、分组、排序、搜索、重命名、**分屏（split view）**、独立窗口、归档、通知。
- **主区 Panes**：Chat / Diff / Browser / Terminal / File editor / Plan / Tasks / Subagent / iOS Simulator(macOS)。可拖拽、缩放、停靠、弹出为独立窗口。
- **右侧 Session rail**：环境与连接信息、变更文件 + PR 状态、运行中进程/后台工作、**上下文用量**。可隐藏。
- **输入区**：`@` 文件、图片/PDF 附件、`+` 菜单（Skills/Connectors/Plugins）、**任务进行中直接纠偏（无需先停）**、`Esc` 停止、建议 prompt（`Tab`/`→` 接受，消耗额度）。
- **快捷键（肌肉记忆点）**：`Cmd+N` 新会话、`Ctrl+Tab` 切会话、`Cmd+Shift+D` diff、`Cmd+Shift+B` 浏览器、`Ctrl+`` 终端、`Cmd+;` 侧聊、`Cmd+Shift+M` 权限菜单、`Cmd+Shift+I` 模型菜单、`Cmd+Option+1..9` 切环境。
- **Remote Control**：按会话开关或 `/remote-control`；`remoteControlAtStartup` 控制新会话行为；`disableRemoteControl` 可全域禁用；归档会移除远端副本。
- **Computer use**（研究预览）：macOS 14+/Windows，Pro/Max/Ultra；默认关；分级 View only / Click only / Full；浏览器 view-only、终端/IDE click-only；Team/Enterprise 不可用。
- **定时任务**：Desktop scheduled tasks / 云 scheduled tasks / `/schedule` / `/loop`。
- **跨会话**：Claude 可查看/给其它 Desktop 会话发消息（接收方有自己的 inbound 管控与权限）；归档别人的会话需审批（Auto/Bypass 除外）。

### 1.3 Web / Cloud

- **Environment** = 网络规则 + 环境变量 + 启动脚本 + 预装工具；首次可生成 Default（可信网络）。
- 隔离：Anthropic 托管 VM；**git 凭据与签名密钥不进 VM**，由代理代做 GitHub 操作；网络密钥留在沙箱外；另有 self-hosted 环境。
- **Projects** 编排同一工作的多个云会话并跟踪进度；仓库需 Claude GitHub App。
- 并行：每次 `--cloud` 独立会话；并行更快烧额度。
- 持久性：合盖不中断；**闲置超时会回收 VM**；重开恢复对话，但未完成命令/子代理/定时工作可能要重跑。
- **Teleport**：`--teleport` 把云会话拉进本地终端，要求干净 checkout + 已 push 的会话分支 + 同账号；拉取后是**另一份拷贝，不回写原云会话**。
- 计费：与其它 Claude 用量共享限额，无单独 VM 费；有命令/启动 hook 超时；setup 脚本约 5 分钟内完成才缓存。
- 非 GitHub 仓库可上传本地 bundle，但托管会话**无法推回远端**。

### 1.4 Mobile

- Claude app 的 Code 标签页：启动、查看、**steer** 云会话；在浏览器/手机/桌面/终端间切换时云会话不断。真正的"遥控本机"靠 Remote Control（以桌面/CLI/IDE 会话为源，手机为控）。

### 1.5 权限模式（跨端语义）

| 模式 | 别名/语义 | 备注 |
|---|---|---|
| `default` | Manual | 每种工具首次使用前询问；工作目录内只读不询问 |
| `acceptEdits` | Accept edits | 自动接受编辑 + `mkdir/touch/mv/cp`；其它命令仍问 |
| `plan` | Plan | 只读探索 + 只读 shell；不改源码 |
| `auto` | Auto | 后台分类器判定常规操作，抑制例行提示；需较新模型，管理员可禁 |
| `dontAsk` | — | 本该弹窗的动作**直接拒绝**；预批准规则仍生效 |
| `bypassPermissions` | Bypass | 跳过绝大多数提示；不跳过安全分类器/部分桌面动作/外站保护 |

- 模式**按目录记忆**；Plan 仅当前会话；云会话支持 acceptEdits/Plan/Auto，**不支持 Bypass**；企业可限制可选模式。
- 规则：`allow` / `ask` / `deny`；**求值顺序 deny → ask → allow**，宽 deny 不能被窄 allow 覆盖；`Bash(npm run *)`、`Read(./.env)`、`WebFetch(domain:x.com)`。
- 裸 `deny: Bash` 会把该工具从模型工具表中移除；带参 deny 只拦匹配调用。
- Bash 规则在复合命令拆分后逐条匹配；**不是安全边界**（变量/包装器/等价写法可绕过）。
- `Read/Edit` 用 gitignore 风格路径；`Write/Glob/NotebookEdit` 的路径规则**不生效**（要用 Edit/Read 规则）。
- 审批交互：一次性 / 持久规则 / 切 Auto / 拒绝；`Tab` 可给审批加注释（WebFetch/浏览器除外）；持久 Bash & WebFetch 审批通常写入**仓库内 settings**。
- 沙箱：OS 级限制 Bash/PowerShell/Monitor 及子进程；`autoAllowBashIfSandboxed` 可免提示；`blockReads/WritesOutsideWorkingDirectories` 在所有模式生效，但**不约束 shell 与 MCP**；绕过提示时沙箱仍生效。

### 1.6 Diff 审阅

- Changes 卡片行数链接 / 标题栏 Changes 打开；**逐文件**审阅；行内 `+` 加评论；`Cmd/Ctrl+Enter` 批量提交；Claude 收评论后产出新 diff。
- 云端 diff 可能缺未 push 的变更。
- `/code-review`（别名 `/review`）：本地/SSH/WSL 会话给出**分组 findings**，可逐条走查/修复/忽略/全部应用；另有 Ultrareview、安全扫描、CI review。

### 1.7 Worktree / 并行

- 需 Git；会话启动前开启；默认 `.claude/worktrees/`；可配目录与分支前缀；`.worktreeinclude` 带入 `.env` 等被忽略文件。
- "添加的目录"直接在原目录工作，**不做 worktree 隔离**。
- 归档可能**丢弃未提交的 worktree 变更**；本地归档 worktree 约 30 天后清理；未归档可恢复。

### 1.8 检查点 / 回退

- 每条触发新一轮的 prompt 前，快照**被编辑工具改过的文件**；保留最近 100 个，随对话保存，约 30 天清理（`cleanupPeriodDays`）。
- `/rewind` 或空输入连按两次 `Esc`；可选：文件+对话 / 仅对话 / 仅文件；也可只总结某段对话。
- 回退后该 prompt 回到输入框可改再发；**未发新 prompt 就退出，被删消息可能复活**。
- 盲区：纯 shell 改动、其它并发会话的改动、**子代理编辑大多保留**（前台 fork 的 skill 除外）、符号/硬链接跳过、工作中追加的消息无独立检查点。
- 官方定位：临时恢复，不替代 Git。

### 1.9 斜杠命令 / Skills

- 自定义命令已并入 **Skills**：`.claude/skills/<name>/SKILL.md`（旧 `.claude/commands/*.md` 兼容）；frontmatter 可配 `description`、`allowed-tools`、`model`、`effort`、`subagent`、`hooks`、`paths`、`shell`、`disable-model-invocation`、`user-invocable`。
- 参数：`$ARGUMENTS`、`$0/$1`、命名参数；开头即执行，正文中出现只是"授权执行"。
- `!` 注入 shell 输出（失败即中止）；终端可在一行消息开头**叠加多个 skill**，SDK/`-p` 只吃第一个。
- 加载优先级：enterprise → personal → project → nested → add-dir → plugin → synced account。
- 常用内置：`/help /compact /context /cost(/usage) /status /model /permissions /mcp /agents /tasks /clear /init /resume /export /add-dir /cd /login /plugin /skills /doctor /code-review /review /debug /batch /loop /run /verify /rewind /btw /remote-control /schedule /desktop /teleport /web-setup`。
- 注意：`/doctor`、`/code-review` 等是**打包的 skill**，不是硬编码命令。

### 1.10 子代理

- Markdown + YAML：必填 `name`、`description`；可选 `tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`memory`、`hooks`、`mcpServers`、`background`、`effort`、`isolation`。
- 位置：`.claude/agents/`、`~/.claude/agents/`、插件/托管/`--agents` JSON。
- 触发：按 description 自动委派；`@` 补全；`--agent` 整会话；运行中在 **task panel 与 transcript** 显示名字+任务；`/tasks` 看活跃/完成/失败。
- 默认后台跑，主会话可继续；**权限请求冒泡到主会话**，结果以完成通知返回。
- 限制：共用额度；独立上下文只拿 prompt + 启动信息；后台工具更窄；嵌套有深度限制；主会话权限可覆盖子代理模式。

### 1.11 Hooks

- 结构：`事件 → matcher → handler`；handler 类型 `command / http / mcp_tool / prompt / agent`。
- 可拦截：`UserPromptSubmit`、`UserPromptExpansion`、`PreToolUse`（allow/ask/deny/defer/改入参）、`PostToolBatch`、`Stop`、`SubagentStop`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`ConfigChange`、`PreCompact`、`PreModelSwitch`、`Elicitation(Result)`、`WorktreeCreate/Remove`。
- 权限专用：`PermissionRequest` 返回 allow/deny；`PermissionDenied` 请求模型重试（不能撤销拒绝）。
- 只观察：`SessionStart/End`、`Setup`、`InstructionsLoaded`、`MessageDisplay`、`PostToolUse(Failure)`、`Notification`、`SubagentStart`、`CwdChanged`、`DirectoryAdded`、`FileChanged`、`PostCompact`、`PostModelSwitch`。
- 关键：**Plan 未批准前 hooks 不能替用户批准**。

### 1.12 MCP 与 2026 新能力

- MCP：共享 MCP 配置、连接器/插件；工具/资源/prompt；OAuth；作用域 local/project/user；`/mcp` 管理。
- 新物种：**Cowork**（桌面协作会话，shell/fetch 走 workspace MCP 工具，Bash allow 规则不迁移、deny 会迁移）、**Channels**、**Dispatch**（手机派单）、**dynamic workflows**、**Claude Tag**、**Agent SDK**、**Ultrareview**、**auto memory**、**effort 档位**。
- 可迁移方法论：`CLAUDE.md` / `AGENTS.md` 已互认（Tandem 应直接兼容）。

### 1.13 官方空白 = 我们的机会

1. Desktop 只列本地会话，**CLI/IDE/云端会话不进同一个列表**。
2. Teleport 是拷贝、要求干净 checkout + 同账号，**无实时双向**。
3. 云会话闲置回收，**未完成子代理/命令丢失**。
4. Remote Control 只"从本机向外"，**没有"客户端主动接管另一台机器"的网格概念**。
5. 会话绑单一账号/组织，**不能一会话一账号/Key/模型供应商**；检查点不覆盖子代理与跨会话改动；worktree 归档会丢未提交变更。

---

## 2. 同类产品

### 2.1 对比矩阵

| 产品 | 形态 | 执行位置 | 多端 | 远程机器 | 多模型 | 云沙箱 | 开源 | 会话迁移 |
|---|---|---|---|---|---|---|---|---|
| Claude Code | 全家桶 | 本地/云/SSH | ★★★★★ | SSH/Remote Control | ✗（仅 Anthropic） | ✓ | ✗ | teleport（拷贝） |
| Codex | App+Cloud+CLI | 本地/云 | ★★★★ | 云为主 | ✗（OpenAI） | ✓ | CLI 开源 | 云会话跨端 |
| Cursor Cloud Agents | Web/iOS/desktop/Slack/API | 云 VM（可自托管） | ★★★★★ | 云 VM 远程桌面 |  curated | ✓ | ✗ | 分支推送（非工作区） |
| Conductor | 桌面+移动+API | 本地/云 microVM | ★★★★ | Remote control(0.92) | ✓ BYO | ✓ | ✗ | 工作区共享链接 |
| Happy | 移动+桌面+CLI | 自有机器 | ★★★★ | ✓ 多机 | ✓ 四家混合 | ✗ | ✓ MIT | 端到端同源 |
| Omnara | Web+API/SDK | 本地/VM/云 | ★★★ | ✓ daemon 外联 | ✓ | 可选 | ✓ | 持久状态 |
| opcode | 桌面(Tauri) | 本机 | ✗ | ✗ | ✗（CC） | ✗ | ✓ | 本地时间旅行 |
| OpenCode | TUI/桌面/IDE | 本机 | ★★ | server 模式 | ✓ 任意 | ✗ | ✓ | 本地 |
| Cline | IDE/CLI/Desktop/SDK | 本机/CI | ★★★ | headless CI | ✓ | ✗ | ✓ | 检查点 |

### 2.2 OpenAI Codex

- Cloud：可复用 Environment（仓库+依赖+启动脚本+网络规则+secrets+变量+访问控制）；并行任务**共享 setup、独立工作区**；ChatGPT 移动端启停/监控；CLI 发起与查状态；GitHub 连接与自动配置；审阅改动+测试结果→追问/提交/开 PR；界面有 approval mode 与模型档位（GPT-6 Sol Medium）。
- Desktop App：多 chat/project 同屏、产物（文档/表格/图）就地打开、并行、worktrees、**Automations 定时**、浏览器/桌面应用/插件集成。评价要点：与 ChatGPT 账号强绑定、模型单一、"Chat vs Work"增加心智负担。

### 2.3 Cursor Cloud Agents

- 隔离云 VM（克隆仓库、装依赖、secrets、启动命令、网络、完整工具链）；表面覆盖 Web / iOS / Desktop / Slack / GitHub·Bitbucket 评论 / Linear / API，Android 走 PWA。
- 支持**自托管**；可**远程桌面进 VM** 检查/操作；多 agent 并行、可跨多仓库；每 agent 独立分支，推回仓库审阅合并（文档未提 worktree）。
- 限制：需 Premium/Teams/Enterprise；**模型为 curated 列表**；运行开始后新增 secret 对该次不可见；**云 VM 里没有用户级 hooks**，初始只读探索阶段 hooks 不跑；交接是"仓库级"，不是工作区级。

### 2.4 Conductor（→ Meta）

- 定位"在云上跑一支 agent 团队"：Firecracker microVM + 仓库快照秒级恢复；**多人协作**（⌘⇧C 共享 workspace 链接、在线状态、实时共同 prompt）。
- **BYO 订阅与 Key**，底层直接跑 first-party Claude Code / Codex / Cursor / OpenCode。
- 桌面 + 移动 + Conductor API；0.92 加 Remote control；100k+ builders；SOC2。
- 风险信号：11/04 宣布并入 Meta，产品路线存在不确定性（对 Tandem 是窗口期）。

### 2.5 Happy（原 Happy Coder）

- MIT、~24k stars；QR 配对、**端到端加密**；手机/平板/浏览器控制**自有机器**（笔记本/服务器/树莓派）。
- 卖点：零工作流改动、**Claude Code 全功能上手机**（plan mode、自定义 agent、MCP 都在）、多会话并行、语音、推送。
- 2026 转向：CLI 进维护模式，主推 **Desktop harness**，支持 Claude Code / Codex / Grok / Gemini **混合于同一任务**；团队共享会话。
- 弱点：仍是"镜像终端"，无跨机器资产视图；云端/离线执行缺失；CLI→Desktop 迁移摩擦。

### 2.6 Omnara

- 开源控制面（hosted/自托管）：REST + TS SDK + CLI + Slack/Discord/GitHub + Web dashboard；执行位置任选本地/VM/容器/云，daemon **主动外联**无需入站端口，持久状态可恢复。
- 企业味：审批流、scoped credentials、RBAC、审计；模型 OpenAI/Anthropic/OpenRouter/LiteLLM/自建。
- 弱点：文档**未见独立移动 app**；不点名 Claude Code；偏平台/基础设施，非开发者桌面体验。

### 2.7 opcode（原 Claudia）

- Tauri 2 + React + Rust，本地优先、无云依赖；可视化项目/会话浏览、自定义 agent（沙箱执行）、**成本/用量看板**、Markdown 编辑 system prompt、MCP 可视化管理、**"会话时间旅行"检查点+分支**。
- 自陈痛点即市场验证：终端混乱、无历史浏览、成本不透明、CLAUDE.md 难编辑、agent 复用难、会话难分支。弱点：单机、单供应商、无移动端、Windows 未发。

### 2.8 OpenCode / Cline / Roo

- **OpenCode**：TUI/桌面/IDE；任意 provider；`/init` 生成 AGENTS.md；**Plan/Build 用 Tab 切换**；`/undo` `/redo`；主题/键位/格式化/自定义命令；server 模式可被外部驱动。V1/V2 并存致安装混乱。
- **Cline**：11M+ 开发者；一个 runtime 覆盖 IDE/CLI/Desktop/SDK；Plan-and-Act、逐步 diff、检查点与一键撤销；BYOK 全模型（含 Ollama/LM Studio/OpenAI 兼容）；`.clinerules`；MCP + 生命周期 hooks；Slack/Discord/Telegram/Linear + CI headless；**多 agent 团队 + cron 调度**。
- **Roo Code**：5/15 停运，社区 fork 为 ZooCode；历史价值在 Modes（Architect/Code/Ask/Debug/Orchestrator）与 auto-approve。

### 2.9 用户痛点归纳（跨产品）

| 痛点 | 证据 |
|---|---|
| 会话孤岛 | Claude Desktop 不列 CLI/IDE/云会话；teleport 后两份拷贝漂移 |
| 迁移成本高 | teleport 要干净 checkout/已 push/同账号；Cursor 交接只到分支 |
| 云会话会"死" | 闲置回收 VM，未完成子代理/命令需重跑 |
| 回退不可靠 | 检查点漏 shell/子代理/并发会话改动；worktree 归档丢未提交 |
| 权限语义不统一 | 6 种模式跨端不一致；dontAsk 下 MCP/AskUserQuestion 受限；plan 未批准 hooks 不能放行 |
| 远程能力打折 | SSH 会话无 Browser/预览/PR 合并；云 VM 无用户级 hooks |
| 成本黑箱 | 并行烧额度、云端按模型计费、上下文窗口放大成本 |
| 供应商锁定/停运风险 | Roo 停运、Conductor 被收编、Cursor 模型 curated |
| 移动端只是"遥控器" | 审批/纠偏体验弱，推送与断线恢复是共同短板 |

---

## 3. Tandem 功能优先级（对应 M1–M4）

> 原则：M1 把"单机闭环 + 会话协议"打穿；M2 把"多端同源"打穿；M3 补"随时可达"；M4 才做生态对齐。**任何 M4 功能不得反向污染协议**。

### P0（M1–M2，不做就没有产品）

| # | 功能 | 验收要点 |
|---|---|---|
| 1 | Host 单事实源 + WS 增量同步 + 断线重放（seq/ack） | 双端同时在线不重复不乱序；弱网重连补齐 |
| 2 | 会话模型：项目/工作目录/环境(local·ssh)/worktree 标记 | 一会话一上下文；归档/重命名/搜索/分组 |
| 3 | 流式对话 + 工具卡片 + 中断 + 排队消息 + 任务中纠偏 | Esc 即停；纠偏不丢已产出 |
| 4 | 权限四模式（Manual/AcceptEdits/Plan/Auto）+ allow/ask/deny 规则 | deny>ask>allow；**任一端可审批**；审批带注释；超时策略 |
| 5 | Diff 审阅：逐文件、行内评论、批量提交、按 hunk 接受 | 手机可审；评论回灌模型产出新 diff |
| 6 | 多 profile / 每会话模型 + 上下文与花费显示 | 会话级切换；不串号；token/成本可见 |
| 7 | @文件 + 图片/PDF 附件 | 大文件截断策略明确 |
| 8 | 移动单栏：会话列表/聊天/审批/停止/推送 | 冷启动 <2s；审批 3 击内完成 |
| 9 | 多 Host 管理 + 配对（扫码/口令）+ PWA + 跨端接续 | 一台客户端管 N 台；切换不丢流 |
| 10 | 检查点 v1：每轮文件快照 + 恢复文件/对话 | 明确"不替代 Git"；30 天清理 |
| 11 | 斜杠命令最小集 + 自定义命令 | `/clear /compact /model /cost /help` + `.tandem/commands` |
| 12 | 会话导出/导入（JSONL + 元数据） | 跨 Host 迁移的地基 |

### P1（M3–M4，形成竞争力）

| # | 功能 | 说明 |
|---|---|---|
| 13 | 中继服务（NAT 穿透）+ 推送 + 托盘/系统通知 | 关电脑后云端不可替代，先解决"随时可达" |
| 14 | SSH/远程 Host 一等公民 | 连接健康、密钥管理、断线自动重连 |
| 15 | 子代理 + Tasks 面板 + 后台任务 | 权限冒泡到主会话；可停单个子代理 |
| 16 | Worktree 并行会话 + 分支前缀 + `.worktreeinclude` | 归档前强制提示未提交 |
| 17 | MCP 管理（作用域/OAuth/健康检查） | 与权限系统联动 |
| 18 | Hooks（至少 PreToolUse/PostToolUse/Stop/SessionStart） | 兼容 Claude 的 JSON 形状，降低迁移成本 |
| 19 | 计划模式 + Plan 面板 + 批准后执行 | 计划可评论、可 diff |
| 20 | 完整 rewind UI（文件/对话/两者）+ 分支会话 | 对标 opcode 的"时间旅行" |
| 21 | 用量统计（按 Host/会话/模型/日） + 预算告警 | 多 Key 场景的核心 |
| 22 | CLAUDE.md / AGENTS.md / skills 兼容层 | 直接复用用户资产 |
| 23 | PR 集成（gh）：状态、失败自动修、merge when ready | 先 GitHub，后 GitLab |
| 24 | 定时任务 `/schedule` | 与离线 Host 队列配合 |

### P2（M5+ / 机会型）

- 云沙箱执行（或接第三方：Daytona/Blaxel/Unikraft）——**不自建 VM 池**，用插件化 runtime。
- 团队多人同会话（Conductor 式 presence + 共 prompt）、审批转交。
- 语音输入/播报、浏览器预览面板、iOS Simulator、computer use（合规重，最后做）。
- 开放 API/SDK + webhook + Channels（Slack/Telegram）。
- 企业：RBAC、审计、SSO、策略下发（把权限规则做成可管理配置）。

---

## 4. 差异化 5 点（建议主推）

1. **Host 网格：一个客户端，N 台机器，M 个账号**
   Claude 的会话绑账号、Desktop 只看本地；Happy 是终端镜像。Tandem 把"机器 × 账号 × 模型"做成会话启动参数，一台手机总览全部机器上的活。

2. **会话可迁移、可接管（Live Handoff，而非 teleport 拷贝）**
   同一会话在 Host 间/端间切换保持单一事实源：断点续跑、状态回放、不要求干净 checkout。直击 teleport"两份拷贝 + 同账号 + 已 push"三大痛点。

3. **移动端是审批台，不是监视器**
   推送直达审批、行内 diff 评论、语音纠偏、离线草稿、断线重放；支持"把审批转交给同事"。对标 Happy 的镜像与 Cursor 的云任务，做**决策发生在手机上**。

4. **多模型/多 Key 的路由与成本治理**
   会话级 provider+key+模型；失败回退、按任务选模型、预算与配额看板、成本归因到会话/机器。Claude/Codex 结构性做不到，Conductor/Cline 有 BYO 但无治理。

5. **自托管优先 + 可选 E2E + 兼容既有资产**
   局域网/Tailscale 直连为默认，中继可自建；端到端加密可选；直接吃 `CLAUDE.md/AGENTS.md/skills/hooks/MCP` 配置，迁移成本近零。隐私敏感团队（金融/内网）是 Claude 云与 Cursor 云覆盖不到的市场。

> 备选第 6 点：**协议即产品**——会话 JSONL + 事件流可导出、可审计、可被第三方客户端接入，形成生态而非单 app。

---

## 5. 风险与明确不做

- **不做**：自建大模型、通用 chat、IDE 内核、云 VM 池（M5 前）。
- 风险 1：中继上线前"关电脑还能跑"讲不圆 → M3 必须交付，或用"常开小主机"叙事过渡。
- 风险 2：provider 适配层须可插拔，避免被单一厂商的区域/条款限制卡住。
- 风险 3：多端同步一致性（审批竞态、重复执行）→ 写操作 Host 串行化 + 幂等 id + 版本号。
- 风险 4：权限模式命名/默认值必须与 Claude 对齐，否则迁移踩坑。

---

## 6. 来源

Claude Code：总览 https://docs.claude.com/en/docs/claude-code/overview ；Desktop https://docs.claude.com/en/docs/claude-code/desktop ；云端 https://docs.claude.com/en/docs/claude-code/claude-code-on-the-web ；权限 https://docs.claude.com/en/docs/claude-code/permissions ；检查点 https://docs.claude.com/en/docs/claude-code/checkpointing ；子代理 https://docs.claude.com/en/docs/claude-code/sub-agents ；Hooks https://docs.claude.com/en/docs/claude-code/hooks ；Skills/命令 https://docs.claude.com/en/docs/claude-code/slash-commands ；产品页 https://claude.com/product/claude-code ；Web 公告 https://claude.com/resources/articles/claude-code-on-the-web

OpenAI：Codex Cloud https://developers.openai.com/codex/cloud/ ；Codex App https://developers.openai.com/codex/app/

Cursor：Cloud Agents https://cursor.com/docs/background-agent

Conductor：https://conductor.build/ ；changelog https://www.conductor.build/changelog

Happy：https://happy.engineering/ ；docs https://happy.engineering/docs/

其它：Omnara https://www.omnara.com/ ；opcode https://opcode.sh/ ；OpenCode https://opencode.ai/docs/ ；Cline https://cline.bot/ ；Roo Code 停运公告 https://docs.roocode.com/
