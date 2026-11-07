# Tandem 功能探索 v2（2026-11-08）

> 增量口径：explore-v1 截稿 11-06。本文只写 v1 未覆盖的 10-20 之后条目、11-06/07 增量，并补 v1 完全缺席的 Windsurf 与社区 issue 侧；已做/已否决不复述。
> 硬约束不变：内网部署、不暴露公网、不接第三方推送/云、暂不做 iOS。"出站 GitHub"仅指调用用户自己的 `gh`/`glab`。
> 成本：S ≤3 天，M 1–2 周，L 3 周+（单人）。

## 1. 新动向

**主线：从"会话"转向"项目编排"**
- Codex Desktop 社区最热请求 #59324：协调者会话 + 持久子任务卡——独立模型/worktree/权限、依赖与审批门、结构化结果回传、重启可恢复；关联 #32017/#51180/#52644。
- Windsurf（6 月起更名 Devin Desktop）10-23 Agent Window：与 Devin Web 同一界面，最多 8 会话并排、workspace 分组、child sessions、Review/Wiki、Remote SSH + WSL、应用预览（设备尺寸/元素选择）、云会话读未保存改动。
- Cursor：Projects/worker 双流；手机可把 agent 跑在"在线个人机器"的仓库上（1.15）；Agent SDK 把编排写成代码。
- Copilot 11-06：嵌套会话分离、My Work 多自定义视图、JetBrains Air / Xcode 接入；VS Code 1.145 远程应用预览 + interactive canvas。
- 判断：竞品都在做"一个项目 = 多个可观测子任务"；Tandem 有子代理/worktree/定时任务/收件箱，缺的是项目视图这层。

**成本与路由产品化**
- Copilot Fusion 10-28 GA：不选模型选 effort（Standard/High/Max），Single/Cascade/Critique 三种编排，管理员限定模型池，按各模型计费。
- Claude 2.1.316–319：pooled gateway budgets、分层网关策略、花费汇总、OTel 身份字段——企业按团队治理多 Key（v1 已提预算，治理面继续加厚）。
- Windsurf 选择器显示 token 价格与缓存计时（4 月起，非新）；Codex 内联选模型/推理/速度。
- 判断：模型选择正从"下拉框"变成"策略"；Tandem 的多账号分组 + 预算天然适合做本地路由。

**审批与沙箱**
- Copilot 11-06 "assisted approval"：个人自然语言指令决定哪些工具请求免问（仅本地会话）。
- Claude 2.1.314 `permissions.blockWritesOutsideWorkingDirectories`；2.1.319 `denyInsteadOfPrompting`；auto mode 服务端安全检查。
- 社区：权限/沙箱占 Claude 6.2%、Codex 8.5% issue；Claude #30882 每次 resume 权限重置、#66043 "允许一次"循环、#93985 移动端列表页审批入口回退。
- 判断：痛点不是"能不能批"，是"重复问"和"入口找不到"。

**上下文与历史**
- Copilot 11-06：从 context limit 错误处直接 compact，并查看空间占用。
- Claude 2.1.314 idle compaction（VS Code/Desktop）；Zed 1.25.2 外部 agent 上下文压缩，1.27 移除 agent checkpoints（成本 > 收益）。
- Codex 0.166 transcript 选择/搜索/可配快捷键；0.165 按仓库过滤 + worktree 分组；#59619 要 scoped pinning 与状态筛选。
- 判断：上下文管理前移到"出错前"；会话历史从"列表"变成"可检索的工作记录"。

**移动端：从遥控转向消费结果**
- Cursor 手机 1.15/1.16：锁屏/灵动岛语音、断线重连补结果、PR 审阅、Inbox、CarPlay。
- Codex iOS：全屏附件、已读状态跨端、失败提示与附件保留重试。
- Tandem 迭代 14/24 已覆盖本地通知、收件箱、44px 触控；差距在 PR 审阅与"结果消费"。

**自托管/内网路线被验证**
- Omnara 9 月转型开源可自托管 agent 平台（Docker Compose、RBAC、secrets、schedules、PR review agents、Slack/GitHub 触发、多租户）——v1 "停在 2026-04" 的判断已过期。
- Happy：10-25 Stem cells beta（工作项自命名、按主题自动整理侧栏）、10-26 停止状态跨重启、bot/task 自带 MCP、WorkOS 团队登录、远程 runner、Tailcat 密文中继。
- Warp 10 月无大功能：ACP/Claude Code transcript 捕获、batch/child-run 元数据、无人值守完成语义。
- 参照但排除：Cursor 托管建站、Copilot 云沙箱、Jules 并入 Antigravity——均与"不出公网"冲突。

**社区声音（12.7 万 issue 统计，截至 10-28）**
- 类别占比（Claude/Codex）：界面 23.4%/28.4%，输出质量 13.0%/6.0%，权限 6.2%/8.5%，会话历史 5.8%/7.8%，MCP 6.7%/6.3%，安装 5.4%/6.3%，限额 5.2%/6.1%，性能 2.7%/5.6%。
- 最高赞 issue 中 60% 是功能请求（全部 issue 仅 22.9%）："想要"比"报错"更能驱动投票。
- 高频诉求：限额感知 + 自动交接（Codex #59810）、协调者子任务卡（#59324）、侧栏固定/状态筛选（#59619）、列表页直接审批（#93985）、权限跨 resume 保持（#30882）。

## 2. 候选功能

> "现有能力"列写要扩展的模块；契合：H=Host 多机，M=多端，R=中继，P=协议/数据模型。

| # | 功能 | 用户场景（一句话） | 竞品参考 | 现有能力（扩展点） | 公网 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 命令面板 + 设置搜索 | Ctrl+K 找会话、切 Host、跳任一设置项（现有 24 个设置页） | Copilot `/settings` 搜索、Windsurf command search、Codex 可配快捷键 | web/ui + SettingsDialog + SearchDialog + 快捷键 | 否 | S | P0 |
| 2 | 上下文自动压缩 + 占用明细 | 长会话到阈值自动摘要；点开看系统提示/工具输出/历史各占多少 | Copilot 错误处 compact、Claude idle compaction、Windsurf 缓存计时 | `context.ts`、`compactSession`、ContextRing/`/context` | 否 | S/M | P0 |
| 3 | 配额预估 + 会话交接 | 5 小时/周额度将尽，自动存检查点、换同组账号续跑 | Codex #59810、Claude 限额抱怨 | `key-rotation.ts`、`budgets.ts`、`run-state.ts`、用量 | 否 | S/M | P0 |
| 4 | 任务看板（协调者 + 子任务卡） | 项目会话拆 N 个带依赖/审批门/独立 worktree 的子任务，一屏看排队/运行/阻塞 | Codex #59324、Windsurf child sessions、Cursor Projects、Copilot My Work | subagent-presets、worktree、tasks、inbox、schedules | 否 | L（v1 可 M） | P0 |
| 5 | 自动模型路由 | 简单任务走便宜模型，难任务升级，按预算/延迟策略 | Copilot Fusion、Windsurf Adaptive、Codex auto | models/capabilities、providers、budgets、模型选择器 | 否 | M | P1 |
| 6 | 审批策略学习 | 从历史审批和一句自然语言生成 allow/ask/deny 规则，减少重复弹窗 | Copilot assisted approval、Claude denyInsteadOfPrompting | `permissions.ts`、设置-权限、收件箱 | 否 | S | P1 |
| 7 | 多会话分屏/网格 | 桌面同时盯 2–4 个会话，手机横滑切换 | Windsurf 8 panes、Cursor workers、Copilot nested chats | ChatView、SessionList、路由 | 否 | M | P1 |
| 8 | 项目 Wiki | 自动生成代码库 Wiki，agent 检索、团队浏览 | Windsurf Wiki、Cursor canvases | memory、skills、fs/Glob、右栏卡片 | 否 | M/L | P1 |
| 9 | 提交前 AI 评审 + PR 行内评论 | 提交/开 PR 前跑 reviewer 模型，意见挂到行，手机上 approve | Copilot code review、Devin Review、Cursor PR review | ChangeReviewPanel、evals 评审模型、`vcs.ts` | 出站 GitHub | M | P1 |
| 10 | 应用预览画布 | 按设备尺寸预览 Host 上的应用，点元素把选择器回传 agent | Copilot interactive canvas、Windsurf app preview | `browser.ts`、BrowserPanel、FilePreview | 否 | M | P1 |
| 11 | 项目 Secrets 注入 + 脱敏 | 按项目给命令注入环境变量，日志/工具输出自动打码 | Happy Secrets、Codex credential masking | config、tools 环境、gateway/redact | 否 | S/M | P1 |
| 12 | 命令沙箱 + 网络白名单 | 只读/联网分级，越界命令转审批 | Claude 工作目录写保护/网络检查、Codex managed rules、Copilot 访问限制 | `permissions.ts`、tools/bash、worktree | 否 | L | P2 |
| 13 | Host doctor | 一键查 Node/模型连通/Key/gh/whisper/端口，导出可复制报告 | Codex `doctor --network-only`、Copilot usage 缺口提示 | host routes、HostsSection、设置 | 否 | S | P1 |
| 14 | 远程 Host 一键接入 | 输 SSH 就部署 Host 并加为设备，带状态/重连 | Windsurf Remote SSH/WSL、Zed remote、Happy remote runner | host、pair、relay、HostsSection | 内网 | M | P2 |
| 15 | 双向语音 | 回合结束/审批语音播报，可语音回"允许"；全本地 TTS | Cursor voice chat、Codex 音频回放、Copilot 语音 | stt、voice、notifications | 否（本地 TTS） | M | P2 |
| 16 | 会话状态筛选/固定/全文搜索 | 按运行/待审批/失败筛；按项目固定；搜消息正文 | Codex #59619、transcript search、Copilot My Work | SessionList、store、SearchDialog | 否 | S | P1 |
| 17 | 用量/审计 OTel 导出 | 团队用量、审批、网关指标接内部监控 | Claude OTel 身份字段、Copilot usage API/dashboard | usage、gateway/stats、team/audit | 否 | S/M | P2 |
| 18 | Agent auto-merge | CI 绿 + 评审通过自动合并，规则门可控 | Copilot Agent Merge | `vcs.ts`、PrPanel、inbox | 出站 GitHub | S | P2 |

## 3. 已有功能里竞品做得更好的地方（打磨，不新增模块）

- **上下文/压缩**：Codex 在报错处直接 compact、Claude 空闲自动压缩、Copilot 展示占用明细；Tandem 只有手动 `/compact` + 环，长会话仍会撞墙。
- **模型选择**：Copilot Fusion 的 effort 路由、Windsurf 的价格/缓存提示、Codex 内联切换；Tandem 账号›分组›模型›强度已好用，但无价格、无"自动"档。
- **审批**：Copilot 个人审批指令、Claude 工作目录写保护/静默 deny；Tandem 静态规则之外没有"从习惯学习"，且规则作用域说明偏弱。
- **会话历史**：Codex transcript 搜索、按仓库/worktree 分组、scoped pinning、状态筛选；Tandem 搜索偏标题，归档后找回成本高。
- **多会话**：Windsurf 8 并排 + child sessions、Cursor worker 双流；Tandem 仍是单会话切换。
- **移动收件箱**：Cursor Inbox 带 PR 审阅与 Live Activity、Codex 已读跨端；Tandem 收件箱偏审批/回合完成，缺"结果消费"与 PR 操作。
- **变更审阅**：Cursor 手机端 PR 行内评论/approve/request changes、Copilot reviewer 状态 + Agent Merge；Tandem PR 面板偏状态与"让 agent 修"。
- **预览**：Copilot 远程 app preview + canvas、Windsurf 设备尺寸/元素选择；Tandem BrowserPanel 偏截图与点击。
- **性能**：Zed 1.27 主动降 agent panel 内存/磁盘；Tandem 大仓库已优化，但 31MB 会话仍全量下发、未分页。
- **设置**：Copilot `/settings` 统一搜索；Tandem 24 个设置页只能翻。

## 4. 推荐的下一批 4 个

1. **#1 命令面板 + 设置搜索**——S 成本收口 24 个设置页与全部快捷键入口，是每天几十次的高频动作，竞品已标配而 Tandem 完全缺失。
2. **#2 上下文自动压缩 + 占用明细**——社区最大类别（限额/输出质量）直接相关，Tandem 只有手动 `/compact`，这一条决定长会话能不能放心跑。
3. **#6 审批策略学习**——审批疲劳是跨产品第一痛点，Tandem 已有规则引擎与审批数据，只差"从历史生成规则"，S 成本见效快。
4. **#4 任务看板 v1（协调者 + 子任务卡）**——Codex 社区最热需求，Windsurf/Cursor 都在做项目编排；Tandem 已有子代理/worktree/定时任务/收件箱，拼装成本低于竞品，是下一阶段最大的差异化。

未入选但建议排期：#3 配额交接（重用户刚需）、#13 Host doctor（Windows 实机问题定位）、#16 历史筛选（大量会话后的基础体验）。

## 5. 来源

- 社区统计：https://noteheld.com/research/claude-code-codex-issues-2026
- Claude Code changelog：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md ；#30882 https://github.com/anthropics/claude-code/issues/30882 ；#66043 https://github.com/anthropics/claude-code/issues/66043 ；#93985 https://github.com/anthropics/claude-code/issues/93985
- Codex：https://developers.openai.com/codex/changelog ；#59324 https://github.com/openai/codex/issues/59324 ；#59810 https://github.com/openai/codex/issues/59810 ；#59619 https://github.com/openai/codex/issues/59619
- Cursor：https://cursor.com/changelog ；mobile https://cursor.com/docs/release-notes/mobile
- Copilot：Fusion https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion/ ；weekly 11-06 https://github.blog/changelog/2026-11-06-github-copilot-weekly-releases-november-2/
- Windsurf/Devin Desktop：https://releasebot.io/updates/windsurf ；https://devin.ai/blog/windsurf-is-now-devin-desktop
- Zed：https://zed.dev/releases/stable ；Warp：https://docs.warp.dev/changelog/2026
- Happy：https://happy.engineering/changelog/ ；https://happy.engineering/mobile-app/
- Omnara：https://github.com/omnara-ai/omnara
