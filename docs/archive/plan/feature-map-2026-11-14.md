# Tandem 功能结构盘点（2026-11-14）

> 只读盘点，不改产品代码。依据：`AGENTS.md`、`docs/README.md`、`docs/design.md`、`docs/features/*.md`、`docs/workstation.md`、`docs/architecture.md`、`docs/archive/plan/*.md`、`scripts/decisions-check.mjs`、`e2e/regression.mjs`、`docs/feedback-ledger.md`、`packages/protocol/src/index.ts`、`packages/web/src/store/*`、`git log --since=2026-10-31`。
> 产品模型（已定）：程序是跑在服务器上的工作站服务；客户端只连工作站；工作站连接各主机；agent 在各主机上跑。

## 0. 口径与方法

### 0.1 三层

1. **领域**：一组共享同一用户任务与同一份核心数据的功能（10 个）。
2. **功能**：用户在界面上能完成的一件事（95 项），每项写目标、入口、数据/状态、代码位置、文档。
3. **零散规则**：`decisions-check` 的单点用户决定（108 条）与 `regression.mjs` 的用例（220 条），归到所属功能。

判定"用户可见功能"的口径：有独立入口或独立可见结果；纯内部模块（store slice、util）只有在改变用户可见行为时才单列。移动端与桌面端是同一功能的两种形态，不另列。

### 0.2 运行位置（用于判断改动影响面）

| 位置 | 承担的功能 |
|---|---|
| 客户端（web/desktop/android 同一份 web 构建） | 所有界面、输入框、消息区、会话图、看板视图、反馈模式、手机预览 |
| 工作站进程 | 登录/注册、主机登记与授权、账号级模型账号（Key 只在工作站）、模型转发与记账、网关、远端执行器接入、分享页托管 |
| 主机上下文（本机或远端，进程内 Fastify + agent） | 会话与消息、agent 循环、工具、权限/沙箱、Secrets、MCP/Hooks/Skills、记忆、检查点、改动审阅、看板调度、评测、Wiki、设备代理 |
| 远端机器 | 只跑 `tandem-exec`（命令/文件读写/系统信息），不跑 agent |

### 0.3 数量

| 项 | 数量 |
|---|---|
| 领域 | 10 |
| 功能 | 95 |
| `decisions-check` 决定 | 108（任务描述里约 86 条，实际已增至 108） |
| `e2e/regression.mjs` 用例 | 220（201 个 `desktop/mobile/small` 调用 + 10 个 `fb2102/fbAdjust` 调用 + 12 个对象用例，共 223 处注册，按名称去重后 220） |
| `docs/features` 文档 | 17 份 + `workstation.md`；覆盖约 52 项功能（多为片段覆盖） |
| 现有产品功能清单 `packages/web/src/lib/features.ts` | 42 项，5 组（仅用于反馈归类/体验清单，不含目标、入口、数据、测试归属） |

统计命令（可复现）：

```bash
git log --since=2026-10-31 --pretty=%s | wc -l                 # 811 条提交
grep -cE "^\s*id: '" scripts/decisions-check.mjs              # 108 条决定
grep -cE "^\s*(desktop|mobile|small)\('[^']+'" e2e/regression.mjs  # 201 个命名调用
grep -c "checks.push({" e2e/regression.mjs                    # 17（含 5 个 helper 定义）
```

---

## 1. 领域总览

| # | 领域 | 功能数 | 用户任务 | 近两周提交（含反馈号） | 主要文档 |
|---|---|---|---|---|---|
| D1 | 会话与对话 | 12 | 开会话、看回复、看用量、处理审批、翻长会话 | 消息区/滚动 64（36）+ 用量/耗时 57（18） | conversation.md |
| D2 | 会话结构 | 6 | 分叉、子代理、看清一棵会话树并跳转 | 65（23）+ 会话图 34（17） | session-tree.md、session-graph.md |
| D3 | 输入与发送 | 10 | 写消息、选目标主机/目录、发出去 | 22（5）+ 环境条 11 | composer.md |
| D4 | 模型与账号 | 11 | 选模型、管 Key、控成本、额度不够时继续 | 52（11）+ 模型/路由 42（14） | model-accounts.md、routing.md、gateway.md |
| D5 | 执行与权限 | 16 | 让 agent 安全地改代码、跑命令、审阅提交 | 审批/权限 41（9）+ 改动审阅/worktree 39（10） | sandbox.md、secrets.md |
| D6 | 主机与工作站 | 8 | 登录、加机器、授权、用远端设备 | 86（20）+ 执行器 7 | workstation.md、executor.md、devices.md |
| D7 | 任务看板与自动化 | 6 | 把多件事交给后台跑、定时跑、量效果 | 看板 9（0）、评测 4（0）、定时 3（0） | taskboard.md |
| D8 | 导航、发现与协作 | 11 | 找到会话/设置/某条消息，多人看同一会话 | 侧栏导航 40（与 D2 重叠）、搜索 5、收件箱 7、分屏 3 | share.md、wiki.md |
| D9 | 设置与外观 | 7 | 调设置、主题、通知、备份 | 设置 57（5） | design.md（原则） |
| D10 | 反馈与调试 | 8 | 记录问题、调整样式、演示与代测 | 调整工具 30（19） | feedback.md、mobile-preview.md、release.md |

提交数按关键字匹配（非互斥、不含 `Merge branch`），只用于比较量级。

---

## 2. 领域与功能明细

### D1 会话与对话

| 编号 | 功能 | 目标（用户为什么要） | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 1.1 | 新建 / 打开 / 切换会话 | 从一句话落到可对话的会话；发送失败能退回重试 | 侧栏「新会话」、欢迎页、命令面板 `session.new` | `active`/`sessionViews`、`SessionSummary`、草稿 id `draft-`、`pendingFocus`、`newSessionPick` | `web/store/appStore/sessionsSlice.ts`、`NewSessionDialog.tsx`、`lib/draftSession.ts` | composer.md（新会话段） |
| 1.2 | 消息流与 Markdown 渲染 | 读回复：正文、列表、代码块、表格、文件引用 | 会话主区 | `ActiveSession.messages`、`UiMessage`、`Message`；`fileLinks`/`fileRefExists` | `MessageList.tsx`、`Markdown.tsx`、`CodeBlock.tsx`、`lib/fileLinks.ts`、`lib/fileRefExists.ts`、`server/src/routes/fs.ts` | conversation.md |
| 1.3 | 工具调用卡与结果 | 看见 agent 做了什么、结果如何，并能点开子代理 | 消息流内 | `toolResults`、`liveToolInputs`、`subagents`、`parentToolUseId` | `ToolCard.tsx`、`toolcard/*`、`server/src/tools/*` | conversation.md（子代理段） |
| 1.4 | 轮次大纲与固定轮 | 在长会话里按轮跳转、固定关键轮 | 对话区右缘刻度；手机顶栏胶囊→底部抽屉 | `pinnedTurns`、`TurnRail` 选中态、`lib/turnWindow.ts` | `chat/TurnRail.tsx`、`turnRailScene.ts`、`TurnOutlineSheet.tsx` | conversation.md |
| 1.5 | 时间、用量与耗时 | 知道每条/每轮花了多少、多久 | 消息下方悬停；大纲行 tooltip | `Usage`、`costUsd`、`usage`、`turnUsage` | `chat/UsageLine.tsx`、`TurnActivity.tsx`、`lib/turnUsage.ts`、`lib/format.ts` | conversation.md |
| 1.6 | 运行提示、排队消息与错误重试 | 看得出在跑、排队不丢、失败可继续 | 消息流末尾、输入框排队气泡、顶栏重试胶囊 | `running`、`retryInfo`、`streamingMessageId`、本地 `local` 消息 | `chat/TurnActivity.tsx`、`ChatView.tsx`、`TopBar.tsx`、`store/appStore/messagesSlice.ts` | conversation.md |
| 1.7 | 断点续跑 | Host 重启后不丢正在跑的回合 | 顶栏胶囊（倒计时 / 继续） | `resumePaused`、`run-state.ts` | `TopBar.tsx`、`server/src/run-state.ts`、`agent/resume.ts` | —（仅 features.ts `resume`） |
| 1.8 | 上下文占用与压缩 | 知道还剩多少窗口、何时压缩 | 右栏上下文卡；输入框底栏；命令面板 `session.compact` | `ContextBreakdown`、`context.usedTokens/contextWindow`、`PanelPrefs` | `chat/ContextMeter.tsx`、`right-panel/ContextCard.tsx`、`server/src/context.ts`、`host/compaction.ts` | conversation.md |
| 1.9 | 审批卡（内联） | 在对话流里决定允许/拒绝，不打断输入 | 消息流内、收件箱、顶栏待审批 | `pending`、`PermissionRequest`、`permissionTrail` | `PermissionCard.tsx`、`host/permissions.ts`、`routes/permissions.ts` | conversation.md、sandbox.md |
| 1.10 | 长会话分页与跳转 | 千轮会话也能打开、跳转、加载更早 | 滚动、占位条、大纲/会话图/搜索/收件箱 | `hasEarlier`、`loadingSegment`、`turns`、`SessionTurnMark` | `lib/jump.ts`、`lib/messagePaging.ts`、`store/appStore/pagingSlice.ts`、`host/message-paging.ts` | conversation.md |
| 1.11 | 计划模式与待办 | 先看计划再执行；看本轮待办 | 权限模式菜单；右栏「计划」「待办」卡 | `plan`、`todos`、`SessionPlan` | `PlanCard.tsx`、`right-panel/PanelBodyContent.tsx`、`server/src/prompts/*` | — |
| 1.12 | 右栏信息面板框架 | 看会话信息（计划/待办/代理/上下文/Wiki/详情） | 顶栏右栏按钮、命令面板 | `panelOpen`、`panelWidth`、`PanelPrefs`、`changesNonce` | `RightPanel.tsx`、`right-panel/*`、`ui/Card`、`ui/ResizeHandle` | design.md P12/P14 |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 1.2 | `message-wide-reading-width`、`code-wrap-grid`、`table-scroll-hint`、`file-ref-explicit-only`、`edit-width`、`injection-not-user-turn`、`user-bubble-markdown`、`external-readonly` | 反馈16#02：宽表格与长代码行限制在正文宽度内（×2）；反馈12#02：自动换行行号对齐；反馈0220#04：只为明确文件引用生成链接；Windows 盘符路径文件链接可打开预览；反馈16#05：注入内容不作为用户轮；手机点按文件引用打开预览 |
| 1.3 | — | 反馈11#04：工具行调高；反馈2108#02：子代理工具行直接进入会话 |
| 1.4 | — | 轮次大纲跳到未加载的轮；轮次大纲滚轮只预览；占位条分段加载；固定轮滚到底仍挂载；大纲标识未加载轮；固定轮初次打开/滚动/跳转后仍挂载；轮次条点击第 30 轮精准定位；轮次固定：命中区 ≥24px、一个视图两用 |
| 1.5 | `message-usage-hover`、`message-actions-below`、`message-meta-last-only` | 轮次大纲悬停显示用量；消息用量只保留一行小字；消息耗时显示在用量行末尾；发送消息后记录耗时/首 token；反馈16#01：用量行默认隐藏、相对时间；用户消息：气泡紧贴、时间与输入估算；反馈0220#05：一轮内只有最后一条保留操作行 |
| 1.6 | `message-running-indicator`、`message-queued-replace` | 反馈16#10：等首个 token / 工具运行显示 spinner 与时长；反馈16#11：排队消息原位出现；反馈1919#07：贴底跟随；反馈1601#02：切换会话首帧同画面；反馈2102#01：切换会话不闪；手机重试胶囊独立一行 |
| 1.7 | — | 断点续跑胶囊显示倒计时与操作 |
| 1.8 | `context-no-cache-duplicate`、`context-card-structure`、`empty-groups-hidden` | 压缩确认与上下文面板按真实用户轮次统计；上下文卡：鲜明分类色、缓存条与阈值；轮次大纲固定按上下文占用着色；空分组 cases 见 1.12 |
| 1.9 | `approval-inline`、`approval-claude-style`、`approval-shortcuts` | 反馈14#07：审批是对话流里的一条消息；反馈14#07：Esc 拒绝、发送消息视为拒绝；反馈1603#03：审批卡宽度 352、按钮贴底；360 小屏：内联审批卡按钮 44px |
| 1.10 | `jump-single-spring` | 长会话打开贴最新；首屏只下发尾部；滚到顶加载且位置不跳；跳转统一个实现；跳转有动画；跳转结束不写 scrollTop；大纲未加载轮只取该片段；反馈2102#02：会话图快速连点；反馈0220#03 系列；反馈1110 跳转动画 |
| 1.11 | — | 预览/计划卡无独立用例（计划模式由审批/权限用例间接触及） |
| 1.12 | `panel-resize`、`panel-cards-collapse`、`panel-no-titlebar`、`panel-no-delete-session`、`panel-width-content-independent`、`card-toggle-right`、`card-drag-handle-right` | 会话信息面板左缘拖宽；反馈12#06/#07：无顶栏、分组可收起；反馈16#06：宽度不随折叠变化；反馈16#07/#08：折叠箭头与手柄在标题右侧；反馈11#02：面板不再提供删除会话 |
| 其他 | — | 外部会话预览：轮次大纲、用量 tooltip 与信息面板；编辑消息保持气泡宽度；回退对话框精简为单行引用/单选/警告；手机长按用户消息打开操作菜单；手机消息操作只剩一个更多按钮 |

### D2 会话结构

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 2.1 | 侧栏会话树（一行一树） | 分叉不刷屏；一眼看出整棵树在跑/待审批/未读 | 侧栏会话列表 | `SessionSummary.forkedFrom/parentId/depth`、`unread`、`pinned/pinnedInProject`、`collapsedProjects` | `lib/sessionTree.ts`、`session/sessionListUtils.ts`、`SessionRow.tsx` | session-tree.md |
| 2.2 | 更早会话收起 | 很久不用的会话不占位 | 项目分组末尾「更早的 N 个会话」 | `expandedOlderProjects`、`OLDER_SESSION_MS` | `sessionListUtils.ts`、`useUiStore.ts` | session-tree.md |
| 2.3 | 会话图 | 看清树里每一轮、分叉点、子代理派出与汇回 | 右栏「会话图」卡；全高模式 | `SessionGraphTree`、`SessionGraphTurn`、`running/waiting`、`layoutSessionGraph` 结果 | `sessionGraph/*`、`server/src/host/graph.ts`、`routes/sessions.ts` | session-graph.md |
| 2.4 | 侧栏悬停拓扑图 | 不离开列表就看这棵树从哪轮分叉/派出 | 悬停会话行右侧浮层 | 同上（`compact` 布局）+ `HoverCard` | `session/SessionTopology.tsx`、`ui/HoverCard.tsx` | session-tree.md |
| 2.5 | 子代理层级与只读子会话 | 进入子代理看它做了什么；换模型重跑 / 交回主会话 | 工具行、会话图节点、悬停拓扑、右栏代理卡、面包屑 | `subagents`、`SubagentSession`、`parentToolUseId`、`depth` | `chat/SubagentSessionView.tsx`、`right-panel/AgentsCard.tsx`、`host/subagents.ts` | session-tree.md、conversation.md |
| 2.6 | 分叉与主线切换 | 从某一轮另开一条路，且随时能回来源 | 消息 ⋯「分叉」；右栏图点分支；「查看」回来源 | `forkedFrom`、`POST /api/sessions/:id/fork`、主线规则见 2.3 | `sessionsSlice.forkSession`、`sessionGraph/layout.ts`、`host/sessions.ts` | session-tree.md、session-graph.md |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 2.1 | `sidebar-fork-same-row` | 侧栏分叉并入原会话行、悬停拓扑图、右栏切分支；反馈2156#02：未读点不再出现 |
| 2.2 | `sidebar-old-sessions-collapsed` | 反馈1603#01：超过 7 天默认收起，固定/未读始终显示 |
| 2.3 | `graph-height`、`graph-uniform-node`、`graph-lane-colors`、`graph-no-meta`、`graph-reversed`、`graph-edge-hover`、`graph-hover-node`、`graph-running-all-sessions`、`graph-row-hover-only`、`graph-waiting-input-marker`、`graph-main-click-from-subagent`、`graph-running-animation`、`graph-external-nodes-clickable`、`graph-trunk-current`、`graph-one-topology-per-tree`、`graph-subagent-opens-session` | 会话图：时间倒序、子代理始终展开、悬停线高亮、子代理视图回主会话；反馈0220#08：一棵树共用一张拓扑；反馈0220#01：外部会话节点可定位；反馈2156#01：跳转只定位无高亮；反馈2156#03：运行中节点呼吸；反馈1110 ×2；反馈1603#05/#07；反馈16#03/#09：高度自适应；会话图泳道线 tooltip |
| 2.4 | `sidebar-hover-topology`、`hover-card-single-session-hidden`、`hover-card-feedback-freeze`、`hover-topology-hit-area` | 反馈0220#07：名称行高亮、点节点/线跳转、命中区加大；反馈0220#06：单会话树不弹、反馈模式卡片停住 |
| 2.5 | `subagent-row-opens-session`、`subagent-hierarchy` | 反馈12#03/#05：子代理卡片定位子会话、层级不用子/孙；反馈1603#06：代理卡行尾无 ⋯、右键仍可换模型重跑；反馈2108#02；反馈1603#08：子代理会话每次都能加载 |
| 2.6 | — | 反馈2108#04：分叉会话「查看」回来源 |

### D3 输入与发送

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 3.1 | Markdown 编辑与快捷键 | 写 Markdown 时看到渲染效果，发送仍是原文 | 会话底部输入框 | CodeMirror 状态、`markdownLive` 装饰、`markdownInput` 变换 | `composer/ComposerEditor.tsx`、`markdownLive.ts`、`markdownInput.ts` | composer.md |
| 3.2 | @ 文件 / 文件夹补全 | 不手打路径，选中的路径是一块可整体删除的标记 | 输入 `@` | `CompletionEntry.isDir`、`ce-path` 原子范围 | `composer/completion.ts`、`richEditor.ts`、`routes/fs.ts` | composer.md |
| 3.3 | 附件与粘贴 | 发图、拖文件 | 输入框附件按钮 / 粘贴 / 拖放 | `ContentBlock` image、附件草稿状态 | `composer/useComposerAttachments.ts`、`Composer.tsx` | composer.md（部分） |
| 3.4 | 发送、排队、中断与斜杠命令 | 决定什么时候发、能不能打断、有哪些命令 | Enter/Ctrl+Enter；输入 `/`；停止按钮 | `send/interrupt`、`SlashCommand`、排队消息 | `composer/useComposerSend.ts`、`lib/api.ts`、`server/src/agent/commands.ts` | — |
| 3.5 | 输入 token 估算与切换确认 | 发送前知道代价；切模型/账号前知道缓存失效成本 | 输入框底栏 | `context.usedTokens`、`~x tok`、`发送后 ~y%`、`ConfirmAction` | `Composer.tsx`、`composer/ModelSwitchConfirm.tsx`、`lib/tokens.ts` | composer.md |
| 3.6 | 环境条（主机/文件夹/分支/worktree/设备） | 知道我在哪台机器、哪个目录、哪个分支，并能换 | 输入框上方环境条 | `SessionEnv`、`worktreeIntents`、`HostConfig`、`DeviceMount` | `EnvBar.tsx`、`lib/desktopFolder.ts`、`store/useDevicesStore.ts` | composer.md |
| 3.7 | 会话内换主机 | 把会话迁到另一台机器继续 | 环境条主机菜单 | 待切换状态、导出/导入、`PATCH /api/sessions/:id` cwd | `EnvBar.tsx`、`hostsSlice.ts`、`routes/host.ts` | composer.md |
| 3.8 | 新会话页 | 一次选好主机/账号/分组/模型/思考强度，下次还记得 | 侧栏新会话、欢迎页、命令面板 | `newSessionPick`（localStorage，按主机）、`CreateSessionInput`、草稿占位 | `NewSessionDialog.tsx`、`lib/newSessionPick.ts`、`lib/draftSession.ts` | composer.md |
| 3.9 | 语音输入 | 不想打字时口述 | 输入框麦克风 / 快捷键 | `SttInput/SttResult`、`VoiceSettings` | `composer/useComposerVoiceShortcut.ts`、`lib/voice.ts`、`server/src/stt.ts` | — |
| 3.10 | 草稿恢复 | 切走再回来不丢没发出去的内容 | 自动 | `useComposerDraft` 本地草稿 | `composer/useComposerDraft.ts`、`lib/storage.ts` | — |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 3.1 | `composer-markdown` | 输入框 Markdown 实时预览：光标外隐藏标记、代码块整块渲染、Enter 续号；用户气泡完整渲染 Markdown（也见 D1） |
| 3.2 | — | 输入框 @ 选文件与文件夹：文件夹可进入、路径标记只显示名字（反馈2102#07） |
| 3.3 | — | 粘贴一次同一张图片只生成一个附件 |
| 3.4 | — | 无独立用例（发送由大量会话用例间接覆盖） |
| 3.5 | `composer-no-cache-banner`、`composer-token-estimate` | 输入框：token 估算、切换确认与分工取向合并（含反馈8#01 #03 #05 #08 #09 #11 / 10#02 / 2009#01） |
| 3.6 | `envbar-git-only`、`envbar-folder-recent`、`envbar-host-icon` | 环境条容器透明、触发器可见且不越界；文件夹弹层向上弹出且完整可见；文件夹弹层只列最近文件夹与「打开文件夹…」（反馈1323#09）；非 Git 仓库不显示 Worktree 开关（反馈1323#07）；不显示分支触发器（反馈1323#08）；环境条下拉连续切换保持打开；「选择主机」可打开；文件夹弹层最近目录、浏览对话框首项为上一级；反馈2102#08 主机图标；手机环境条不越界、透明、触控 44px |
| 3.7 | `envbar-host-pending` | 环境条换主机先选文件夹：待定状态、输入禁用、可取消（反馈13#02） |
| 3.8 | `new-session-pick-memory`、`route-follows-session` | 侧栏「新会话」清空草稿并聚焦输入框；新会话默认带工作目录且双击发送只创建一次；反馈2102#05：账号/模型按主机记住、失效回落；反馈2102#06：发送后直接进入会话 |
| 3.9 | — | 无 UI 用例（`stt.test.ts` 覆盖解析） |
| 3.10 | — | 无用例 |

### D4 模型与账号

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 4.1 | 模型菜单与最近模型 | 快速换模型；常用模型排前面 | 输入框底栏模型芯片；新会话页 | `Profile/ProfileGroup/ModelInfo`、`recentModels` | `composer/ModelMenu.tsx`、`ui/ModelCascade.tsx`、`lib/recentModels.ts` | model-accounts.md |
| 4.2 | 思考强度 | 按型号能力选档，别发出模型不认的参数 | 模型菜单 | `effort`、`ModelCapabilities`、`capabilities.ts` | `composer/ModelMenu.tsx`、`server/src/providers/capabilities.ts`、`lib/effort.ts` | routing.md |
| 4.3 | 1M 上下文开关 | 长文档会话用满 1M，且只改本地预算 | 模型菜单（思考强度下方）；分组默认 | `longContext`、`claudeLongContext`、`contextWindowForModel` | `capabilities.ts`、`host/sessions.ts`（`withLiveWindow`）、`chat/ContextMeter.tsx`、`composer/useComposerStore.ts` | model-accounts.md |
| 4.4 | 分工 / 取向 / 原生 | 决定派不派子代理、子代理用什么档 | 模型菜单底部分组；设置「分工路由」 | `delegation`、`routeBias`、`routeNative`、`TurnRouteMode`、`RoutePlan` | `server/src/model-routing.ts`、`routing-settings.ts`、`host/turns.ts`、`chat/RoutePlanLine.tsx`、`chat/DivisionPlanCard.tsx` | routing.md |
| 4.5 | 自动模型路由 | 简单任务用便宜模型、难任务升级 | 设置「自动路由」；会话级开关 | `autoRoute`、`ModelRouteDecision`、`AutoRouteSavings` | `model-routing.ts`、`settings/ModelRoutingSection.tsx` | routing.md |
| 4.6 | 账号、分组与 Key | 一个账号多个分组；Key 只存工作站、只回掩码 | 设置「账号与模型」 | `Profile`、`ProfileGroup`、`KeyStrategy`、`WorkspaceProfilesSnapshot` | `settings/ProfilesSection.tsx`、`settings/profiles/KeysPanel.tsx`、`server/src/workstation/profiles.ts` | model-accounts.md |
| 4.7 | 余额查询 | 不用去各家网站看余额 | 设置账号行、模型菜单账号行 | `BalanceQueryConfig`、`ProfileBalance`、5 分钟缓存 | `server/src/workstation/balance.ts`、`test/balance.test.ts` | model-accounts.md |
| 4.8 | 价格、倍率与用量 | 知道这轮/这天花多少钱，计算式可核对 | 模型菜单、消息用量、设置「用量」 | `ModelPriceInfo`、`UsageStatsRow`、倍率、`resolvePriceForModel` | `server/src/usage.ts`、`host/usage.ts`、`web/lib/turnUsage.ts`、`settings/UsageSection.tsx` | routing.md |
| 4.9 | 预算规则 | 给账号/分组/模型设上限并阻止 | 设置「用量与预算」 | `BudgetRule`、`BudgetStatus`、`assertBudget` | `server/src/budgets.ts`、`settings/BudgetsSection.tsx` | — |
| 4.10 | 额度交接 | 额度将尽/冷却时换分组、等待或继续用当前分组 | 对话流交接卡；设置「额度交接」默认策略 | `HandoffState`、`HandoffPolicy`、`handoffBypass`、`QuotaEstimate` | `chat/HandoffCard.tsx`、`server/src/quota.ts`、`host/handoff.ts` | model-accounts.md |
| 4.11 | Key 网关 | 把模型请求统一转发、限流、记账、脱敏日志 | 设置「网关」 | `GatewaySettings`、`GatewayToken`、`GatewayLogEntry` | `server/src/gateway/*`、`routes/gateway.ts`、`settings/GatewaySection.tsx` | gateway.md |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 4.1 | `menu-recent-models`、`chip-no-effort-dot` | 模型菜单级联（账号→分组→模型）逐级飞出且不越界；模型菜单顶部显示最近使用模型；自定义兼容账号显示「自定义接口」 |
| 4.2 | `model-capabilities` | 思考强度档位来自模型能力，名称用厂商叫法 |
| 4.3 | —（能力表见 4.2） | 1M 上下文开关按型号能力显示、切换后分母变化；旧上下文快照分母实时计算 |
| 4.4 | `route-labels`、`route-native`、`route-plan-injected-visible` | 分工路由：原生不注入且 Task 可用、分工关闭零派发、取向省钱整单交执行者、分工积极协作、确认卡与学到的偏好；反馈1323#03：路由提示行可展开看注入 |
| 4.5 | — | 自动路由偏好点击即时切换且不闪回；自动模型路由：简单快速、困难强力、失败升级、回落与节省统计 |
| 4.6 | `key-mask-preserve`、`profile-group-single-key`、`model-latest-selection` | 账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉；反馈1323#02：分组只显示一个 Key、无拖动/故障切换/轮询；手机账号卡只有一行编辑/删除 |
| 4.7 | — | 余额在 `e2e/workstation-check.mjs`（mock 平台：显示/缓存/刷新） |
| 4.8 | — | 模型菜单：单价未设置可跳到单价覆盖；内置价格表命中显示「参考价」；账号/分组倍率叠加并显示计算方式 |
| 4.9 | — | 无 UI 用例（`budgets.test.ts`） |
| 4.10 | `handoff-continue-first`、`handoff-can-disable` | 配额将尽时交接卡可切换备用分组；反馈0220#02：可继续用当前分组跑完本轮；关闭额度交接后不再出现交接卡 |
| 4.11 | — | 无专用用例（共用 `upstream-engine` 单测） |

### D5 执行与权限

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 5.1 | 内置工具执行 | agent 能读写文件、跑命令、抓网页、记待办 | 由 agent 自动调用 | `ToolContext`、`posts`/`requiresApproval`、`BackgroundTask` | `server/src/tools/*`、`toolcard/*` | — |
| 5.2 | 权限模式与规则 | 少被打断，同时可控 | 输入框权限菜单；设置「权限」 | `PermissionMode`、`PermissionRule`、`PermissionInsights` | `permissions.ts`、`host/permissions.ts`、`settings/PermissionsSection.tsx` | conversation.md（审批） |
| 5.3 | 命令沙箱与网络白名单 | 防止误写目录外/敏感路径、访问非白名单网络 | 设置 → 权限 → 命令沙箱 | `SandboxSettings`、`SandboxStatus`、`permissions.json` | `server/src/sandbox.ts`、`routes/permissions.ts` | sandbox.md |
| 5.4 | Secrets 注入与脱敏 | 让命令拿到密钥，但模型/日志/界面看不到明文 | 设置「Secrets」 | `SecretMeta`、`SecretScope`、`secrets.json`、`[secret:NAME]` | `server/src/secrets.ts`、`redact.ts`、`settings/SecretsSection.tsx` | secrets.md |
| 5.5 | MCP 服务器 | 接入外部工具 | 设置「扩展 → MCP」 | `McpServerConfig`、`McpServerStatus` | `server/src/mcp.ts`、`settings/McpSection.tsx` | — |
| 5.6 | Hooks | 在工具前后跑用户脚本 | 设置「扩展 → Hooks」 | `HookEntry`、`HookEventNotice` | `server/src/hooks.ts`、`host/hooks.ts`、`settings/HooksSection.tsx` | — |
| 5.7 | Skills 与子代理预设 | 复用团队知识/角色 | 设置「Agent 能力」 | `SkillInfo`、`SubagentPreset` | `skills.ts`、`subagent-presets.ts`、`settings/SkillsSection.tsx`、`SubagentsSection.tsx` | — |
| 5.8 | 记忆 | 跨会话记住项目事实 | 右栏「记忆」卡；设置「记忆」；`#记住` | `MemoryFile`、`MemoryScope` | `server/src/memory.ts`、`MemoryEditorDialog.tsx`、`settings/MemorySection.tsx` | — |
| 5.9 | 提示词模板与注入透明 | 改系统提示；能看到这轮注入了什么 | 设置「Agent 能力 → 提示词」；会话开头注入快照 | `PromptTemplate`、`InjectionSnapshot`、`InjectionSegment` | `prompt-templates.ts`、`prompts/registry.ts`、`routes/prompt-templates.ts`、`host/turns.ts` | — |
| 5.10 | 后台任务 | 长命令不占本轮 | 工具卡、后台任务面板 | `BackgroundTask`、`BackgroundTaskOutput` | `server/src/tasks.ts`、`BackgroundTasksPanel.tsx` | — |
| 5.11 | 检查点与回退 | 把文件或对话退回到某个点 | 消息 ⋯「回退」 | `Checkpoint`、`RewindInput` | `server/src/checkpoints.ts`、`host/rewind.ts`、`RewindDialog.tsx` | — |
| 5.12 | 改动审阅与提交（含 AI 评审） | 看改了哪些、逐行评论、提交前让 AI 挑问题 | 右栏改动、命令面板 | `ChangesResult`、`FileChange`、`AiReviewRun` | `changes.ts`、`ai-review.ts`、`ChangeReviewPanel.tsx`、`useChanges.ts` | — |
| 5.13 | PR / CI | 在应用里建 PR、看检查状态 | 右栏 PR、命令面板 | `PullRequestInfo`、`PrCheck`、`VcsState` | `vcs.ts`、`PrPanel.tsx`、`useVcs.ts` | test-guides/pr-ci.md |
| 5.14 | worktree 会话与合并 | 在隔离分支里改，再合回 | 环境条 Worktree 开关；会话 ⋯ 合并 | `worktree`、`mergeWorktree` | `worktree.ts`、`worktreeSlice.ts`、`EnvBar.tsx` | — |
| 5.15 | 应用预览 | 在应用里看本机开发页面、点选元素、改完自动刷新 | 命令面板 / 预览面板 | `PreviewState`、`PreviewSelection`、`PreviewSnapshot` | `server/src/preview.ts`、`routes/preview.ts`、`PreviewPanel.tsx` | — |
| 5.16 | 浏览器工具与面板 | 让 agent 抓页面/截图，人在面板里看 | 命令面板 `session.browser`；设置「浏览器」 | `BrowserState`、`BrowserSettings` | `server/src/browser.ts`、`BrowserPanel.tsx`、`settings/BrowserSection.tsx` | — |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 5.1 | `tool-row-height` | 反馈11#04：工具行调高；反馈12#02 代码块换行（见 D1） |
| 5.2 | — | 审批策略：同类请求多次批准出现项目快捷规则；危险命令不出现快捷规则；权限页显示统计与建议；反馈1603#02：菜单危险项常态 danger 色（危险操作，也见 D9） |
| 5.3 | — | 命令沙箱：工作目录外写入在 acceptEdits 下仍出现审批卡；沙箱：worktree 会话写 cwd 内不弹审批 |
| 5.4 | — | Secrets 工具输出显示打码标签 |
| 5.5 | — | 移除 MCP 服务器需要二次确认（仅确认流程） |
| 5.6 | — | 无行为用例（仅设置页导航/字号） |
| 5.7 | — | 无行为用例（仅设置页导航） |
| 5.8 | — | 记忆编辑器不暴露内部元数据行 |
| 5.9 | —（注入透明见 D4 4.4） | 手机提示词点选后编辑区滚入视口；反馈1323#03：路由提示行可展开（见 D4） |
| 5.10 | — | 后台任务悬停展开列表并跳到对应输出 |
| 5.11 | `rewind-compact` | 无检查点的会话仍可只回退对话；回退对话框引用目标消息并显示删除范围 |
| 5.12 | `diff-colors` | 改动审阅把未跟踪目录展开为文件；文件列表贴顶、diff 紧跟、自动换行；行内评论浮窗与行标记；提交前 AI 评审挂行、忽略无效行并采纳；提交范围带文件数与二次确认 |
| 5.13 | — | 无独立用例（看板 PR 聚合见 D7） |
| 5.14 | — | 删除 dirty worktree 的确认列出文件与分支；看板合并确认（见 D7） |
| 5.15 | — | 应用预览：自动识别、设备切换、点选元素、Edit 自动刷新与改前对比 |
| 5.16 | — | 浏览器：工具卡与浏览器面板空态；手机嵌套弹窗 Esc 只关最上层（也见 D9） |

### D6 主机与工作站

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 6.1 | 登录 / 注册 / 创建工作站 | 进产品先有身份，之后才看得到自己的机器 | 全屏登录门；侧栏账号菜单「账号登录」 | `AccountSession`、`AccountTokens`、`WorkspaceStatus` | `auth/LoginGate.tsx`、`accounts/LoginDialog.tsx`、`accounts/store.ts` | workstation.md |
| 6.2 | 主机列表与详情 | 看哪些机器在线、能改名/诊断/授权/移除 | 设置「主机」 | `HostConfig`、`HostInfo`、`WorkspaceHostInfo`、`HostRuntime` | `HostsSection.tsx`、`HostDetailDrawer.tsx`、`hostsSlice.ts` | workstation.md |
| 6.3 | 添加主机 / 添加这台电脑 | 不装 Node、不配网络，一行命令把机器加进来 | 空状态、设置主机、环境条、命令面板、导览卡（6 个触发点） | 一次性令牌 `ach_…`、`AddHostDialog` 状态 | `AddHostDialog.tsx`、`lib/addHostCommand.ts`、`routes/accounts.ts` | workstation.md、executor.md |
| 6.4 | 成员授权与工作站管理 | 把主机/目录授权给同事，角色可控 | 设置「工作站」 | `WorkspaceHostGrant`、`WorkspaceAccount`、`WorkspaceAuditEntry`、`TeamRole` | `workstation/WorkstationSection.tsx`、`HostGrantDialog.tsx`、`accounts/store.ts` | workstation.md |
| 6.5 | 远端执行器 | 远端机器只装单文件执行器，agent 仍在工作站 | 「添加主机」一行命令；主机在线状态 | `identity.json`、握手/流控帧、`RemoteHostEnv`、`hub.isLive` | `packages/executor/*`、`server/src/executor/*` | executor.md |
| 6.6 | 连接状态、离线与重连 | 断网/主机掉线时看得见、能重试 | 顶栏状态、离线条、主机会话 | `retryInfo`、`HostRuntime.status`、`goOffline` | `TopBar.tsx`、`hostsSlice.ts`、`lib/ws.ts` | workstation.md |
| 6.7 | 设备共享（ADB/串口/终端/演示） | 插在 A 机的手机/板子，B 机会话能用；手机能看串口 | 环境条已挂载设备胶囊；设置「主机」→ 主机详情「设备」（打开工作站设备视图） | `DeviceInfo`、`DeviceMount`、`SerialTransport`、租约/审计 | `workstation/WorkstationDialog.tsx`、`SerialTerminalDialog.tsx`、`store/useDevicesStore.ts`、`server/src/devices/*` | devices.md |
| 6.8 | 主机诊断 | 排障：Node/目录/git/账号连通性逐项检查 | 主机行「诊断」；会话报错时 | `DoctorReport`、`DoctorCheck` | `DoctorDialog.tsx`、`server/src/doctor.ts`、`routes/doctor.ts` | —（有 test-guide） |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 6.1 | `login-gate` | 登录门：未登录先登录、无主机空状态、添加这台电脑后可开会话；调试版自动登录带演示主机；工作站重启后仍在线能开会话；调试版不带 token 自动进入且不循环 401 |
| 6.2 | `hosts-single-entry` | 主机管理：唯一主机列表与详情抽屉、唯一添加入口、工作站页仅管理员 |
| 6.3 | `no-host-empty-state` | 无直接用例（入口由「登录门」「主机管理」覆盖） |
| 6.4 | — | 主机管理（工作站页仅管理员）；工作站客户端-服务（注册/添加主机/授权/E2E 流式） |
| 6.5 | — | 远端执行器：一行命令安装、主机在线、远端会话写入并读回文件 |
| 6.6 | — | 断网后立即显示重新连接条 |
| 6.7 | — | 工作站：跨主机 ADB/串口挂载、审批与终端；主机没装 adb 时显示说明而不报错；设备单行密度、板载串口折叠、无权限修复说明；演示设备：演示工作区提供可挂载的安卓/串口设备 |
| 6.8 | — | Host 诊断：面板打开、失败项排在最前、报告不含 Key |

### D7 任务看板与自动化

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 7.1 | 看板与卡片调度 | 多件事交给后台跑，人只看「需要我」的列 | 侧栏「任务看板」、命令面板、路由 `#/h/<hostId>/b` | `Board*`、`BoardCard*`、`BoardEvent`、`~/.tandem/boards/*.json` | `server/src/board/manager.ts`、`store.ts`、`components/board/*`、`store/useBoardStore.ts` | taskboard.md |
| 7.2 | 卡片详情与执行配置 | 改提示词/依赖/模型/worktree/预算，手动合并 | 看板卡片抽屉 | `BoardExec`、`attempts`、`result`、worktree 分支 | `BoardDrawer.tsx`、`board/manager.ts`、`board/git.ts` | taskboard.md |
| 7.3 | AI 拆分与卡片提案 | 一句需求拆成草稿卡；运行中也能提新卡 | 看板头部「AI 拆分」；卡片会话 `ProposeCards` | 草稿，不入库；`ProposeCards` 工具 | `board/planner.ts`、`tools/propose-cards.ts` | taskboard.md |
| 7.4 | 看板 v2（评审/冲突/PR） | 卡跑完自动评审、冲突让 agent 解、按序开 PR | 卡片动作 / 看板头部 | `AiReviewRun`、冲突文件列表、集成分支 | `board/review.ts`、`pr.ts`、`MergeConfirmDialog.tsx` | taskboard.md |
| 7.5 | 定时任务 | 按 cron 开会话/更新 Wiki | 设置「定时任务」 | `Schedule`、`ScheduleRunRecord`、`nextRunAt` | `server/src/schedules.ts`、`settings/SchedulesSection.tsx`、`useScheduleStore.ts` | — |
| 7.6 | 评测与轨迹 | 用固定用例量模型/提示词变化 | 设置「评测」、命令面板、右栏 | `EvalCase`、`EvalConfig`、`EvalSnapshot` | `server/src/evals.ts`、`settings/EvalsSection.tsx`、`components/evals/*`、`useEvalStore.ts` | — |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 7.1 | — | 任务看板：侧栏入口、拖动放行、依赖等待、待评审打回与通过；手机任务看板：分组列表、待我处理行内通过与全屏详情 |
| 7.2 | — | 看板合并确认、完成态后续操作与手动压缩确认 |
| 7.3 | — | 无直接用例（v2 提案随「任务看板 v2」覆盖） |
| 7.4 | — | 任务看板 v2（同上） |
| 7.5 | — | 无 UI 用例（`schedules.test.ts` 覆盖 cron 解析） |
| 7.6 | — | 评测：对比表字号 ≥12px、时间中文化、轨迹与并排可开；手机评测结果表可横向滚动并打开轨迹 |

### D8 导航、发现与协作

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 8.1 | 侧栏导航与项目分组 | 找到项目、置顶、收起，不被会话淹没 | 左侧栏 | `collapsedProjects`、`pinnedProjects`、`hostCollapseKey`、`sidebarWidth` | `Sidebar.tsx`、`session/SessionGroups.tsx`、`useUiStore.ts` | design.md P15 |
| 8.2 | 会话列表、筛选与归档 | 只看运行中/待审批/未读；隐藏不用的 | 侧栏筛选菜单、「已归档」 | `sessionFilter`、`showArchived`、`unread` | `Sidebar.tsx`、`sessionListUtils.ts`、`SessionDialogs.tsx` | — |
| 8.3 | 顶栏会话操作 | 切换右栏/改动/更多，不超过 5 个图标 | 会话顶栏 | `panelOpen`、`changesOpen`、更多菜单 | `TopBar.tsx`、`chat/SessionHeaderTools.tsx` | design.md P15 |
| 8.4 | 命令面板与设置搜索 | 键盘找到任何入口/设置项 | Ctrl/Cmd+K | `COMMANDS`、`SETTINGS_ITEMS`、`settingsFocus` | `SearchDialog.tsx`、`lib/commands.ts`、`lib/settingsRegistry.ts` | — |
| 8.5 | 快捷键 | 看现有快捷键并改 | 设置「外观」→ 快捷键 | `shortcut.ts`、localStorage | `settings/ShortcutsTable.tsx`、`lib/shortcut.ts` | — |
| 8.6 | 全文搜索 | 在全部会话里找一句话/一条命令 | 侧栏「搜索」、命令面板 | `SearchHit`、`SearchFilters`、`~/.tandem/index/search.json` | `server/src/search.ts`、`SearchDialog.tsx` | — |
| 8.7 | 收件箱 | 跨会话集中处理审批/回合结束/预算/CI/看板 | 侧栏收件箱 | `InboxEvent`、`InboxSnapshot`、`HostInboxState` | `server/src/inbox.ts`、`components/inbox/*`、`inboxSlice.ts` | — |
| 8.8 | 多会话分屏 | 同时看两个会话/看板 | 命令面板 `split.open` | `sessionViews`、`lib/split.ts`、窗格比例 | `components/split/*`、`session/SessionScope.tsx` | — |
| 8.9 | 会话分享 | 把只读会话链接发给同事 | 会话 ⋯「分享…」；设置「分享」 | `Share`、token（fragment）、`~/.tandem/shares/*.json` | `server/src/share/*`、`share/ShareDialog.tsx`、`PublicSharePage.tsx`、`settings/SharesSection.tsx` | share.md |
| 8.10 | 项目 Wiki | 不用翻代码就有概览/模块/术语表 | 右栏 Wiki 卡「浏览」 | `WikiMeta`、`WikiPage`、`WikiJob`、`~/.tandem/wiki/<hash>/` | `server/src/wiki.ts`、`WikiDialog.tsx`、`useWikiStore.ts` | wiki.md |
| 8.11 | 新功能导览 | 知道这版新增了什么 | 设置「关于」、命令面板、发布后自动出现 | 已读状态（localStorage）、`changelog.ts` | `tour/FeatureTour.tsx`、`lib/changelog.ts` | release.md（导览） |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 8.1 | `sidebar-single-new`、`sidebar-single-settings`、`sidebar-host-groups`、`sidebar-indent`、`sidebar-hover-actions` | 侧栏项目分「固定/最近」两组；侧栏项目 tooltip 显示主机与完整路径；反馈12#08：缩进收紧、标题左对齐；侧栏按主机分组显示全部会话、离线仍可浏览；反馈1601#05：主机与项目文件夹折叠状态会被记住；反馈1323#04：侧栏底部一行账号 + 齿轮 |
| 8.2 | — | 会话筛选：状态筛选与「已筛选 · 清除」；更早会话收起见 D2 |
| 8.3 | `topbar-icon-limit`、`topbar-panel-icon-distinct` | 顶栏图标数 ≤5 且低频入口收进更多菜单；反馈2102#04：顶栏右侧不出现两个同图标按钮；Windows 桌面顶栏 36px 且按钮不溢出（也见 D9） |
| 8.4 | `command-palette` | 命令面板：搜「桌面通知」定位设置项；前缀筛选与拼音首字母；可搜到更多菜单的全部入口；手机顶栏搜索按钮打开命令面板 |
| 8.5 | — | 快捷键：外观页由命令注册表生成、自定义生效、冲突提示 |
| 8.6 | — | 全文搜索：命中片段、打开会话并定位消息 |
| 8.7 | — | 收件箱：同一回合多次审批聚合为一条，展开可见流水；手机收件箱审批卡任务描述默认两行 |
| 8.8 | — | 分屏：双窗格收发、焦点跟随右栏与比例恢复；拖拽分区、Ctrl+1 焦点与 Ctrl+W 关闭；手机分屏：圆点指示与左右滑动切换 |
| 8.9 | — | **无公开页用例**（设置页仅导航） |
| 8.10 | — | 项目 Wiki：浏览、全文搜索与手写段落 |
| 8.11 | `tour-pill-auto-hide` | 新功能导览：出现、跳转并全部标为已读；反馈1323#01：提示条 30 秒未点开自动收起 |

### D9 设置与外观

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 9.1 | 设置框架与分组 | 找得到设置项，页面不跳、不越限 | 侧栏齿轮、命令面板、设置搜索 | `SettingsTab`、`SETTINGS_PAGES`、`SETTINGS_GROUPS`、`settingsFocus` | `settings/SettingsDialog.tsx`、`lib/settingsRegistry.ts` | design.md P14/P15 |
| 9.2 | 外观与主题 | 深浅色、字号、密度符合习惯 | 设置「外观」 | `theme`、`Theme`、CSS tokens | `settings/AppearanceSection.tsx`、`index.css`、`styles/*` | design.md |
| 9.3 | 通知 | 回合完成/待审批时提醒，不打扰 | 设置「通知」；手机本地通知 | `NotificationSettings`、native bridge | `settings/NotificationsSection.tsx`、`packages/mobile/*`、`lib/native.ts` | — |
| 9.4 | 浏览器设置 | 配白名单/无头/截图 | 设置「浏览器」 | `BrowserSettings`、`BrowserStatus` | `settings/BrowserSection.tsx`、`server/src/browser.ts` | — |
| 9.5 | 同步与备份 | 换机/重装能带走配置 | 设置「同步与备份」 | `ConfigBundle`、`ConfigImportResult` | `settings/SyncSection.tsx`、`server/src/migrate.ts`、`routes/config.ts` | — |
| 9.6 | 关于与更新 | 看版本、更新、隐私/许可 | 设置「关于」；侧栏账号菜单 | 版本号、更新源、`latest.yml` | `settings/UpdateSection.tsx`、`routes/updates.ts`、`packages/desktop/*` | release.md |
| 9.7 | 共享 UI 原语与全局视觉规范 | 所有界面同一套按钮/菜单/弹层/字号/颜色 | 全站 | `ui/*`、CSS tokens、`ui-audit` 规则 | `components/ui/*`、`styles/*`、`scripts/ui-audit.mjs` | design.md |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 9.1 | `settings-groups`、`settings-content-width`、`setting-row-icon` | 设置分组：6 组、合并页与高级折叠；反馈15：内容区限宽留白、通知卡图标对齐；手机设置全屏、三列导航且无横向溢出；反馈9：设置行单行、高级展开不位移；反馈11：设置页输入框全局屏蔽、导航滚动条进 gutter；设置弹窗焦点陷阱与关闭后焦点还原 |
| 9.2 | `theme-preview-height` | 无独立主题用例（截图与 ui-audit token 覆盖） |
| 9.3 | — | 无用例 |
| 9.4 | — | 无独立用例（浏览器空态见 D5） |
| 9.5 | — | 同步与备份：空口令时导出按钮禁用；替换导入需二次确认并标注危险 |
| 9.6 | — | 无 UI 用例（`release-flavor`/`scan-release` 覆盖产物） |
| 9.7 | 见下方「跨功能基础层」 | 见下方「跨功能基础层」 |

### D10 反馈与调试

| 编号 | 功能 | 目标 | 入口 | 数据/状态 | 代码位置 | 文档 |
|---|---|---|---|---|---|---|
| 10.1 | 反馈模式 | 点选/框选/标注问题，关窗也不丢 | Ctrl/Cmd+Shift+F（调试版） | `FeedbackItem`、IndexedDB `tandem-feedback`、草稿目录 | `components/feedback/*`、`store/useFeedbackStore.ts`、`lib/feedbackDrafts.ts` | feedback.md |
| 10.2 | 调整工具 | 在冻结副本上直接改 UI 并导出改动清单 | 反馈工具条「调整」 | `adjust` 条目、改动清单、副本 HTML | `feedback/FeedbackAdjust.tsx`、`feedbackAdjust.ts`、`feedbackCapture.ts` | feedback.md |
| 10.3 | 反馈包与回执 | 打包发给维护者，逐条回执复验 | 反馈抽屉「导出」「导入回执」 | `.tfb` zip、`manifest.json`、回执 Markdown | `lib/zipStore.ts`、`scripts/feedback-unpack.mjs`、`feedback-receipt.mjs` | feedback.md |
| 10.4 | 演示工作区 | 没有真实项目也能体验全部功能 | 设置「关于 → 演示工作区」 | 17 个场景、`demo` 标记数据 | `server/src/demo/*`、`demo/DemoDialog.tsx`、`useDemoStore.ts` | feedback.md |
| 10.5 | 体验清单 | 按功能逐项自测，结果随反馈包带上 | 设置「关于 → 体验清单」 | 进度（本机）、`lib/checklist.ts` | `demo/ChecklistDialog.tsx`、`lib/checklist.ts` | feedback.md |
| 10.6 | 手机预览 | 在电脑上看手机布局，不用装 APK | 命令面板、Ctrl/Cmd+Shift+M（调试版） | 预设尺寸、CDP 触摸模拟、`mobilePreview=1` | `dev/MobilePreviewBar.tsx`、`lib/mobilePreview.ts`、`packages/desktop/*` | mobile-preview.md |
| 10.7 | 调试账号 / 演示主机 | 调试版打开即用，不配账号和主机 | 调试版回环地址 | `debug-account.json`、`demo-host/`、`__TANDEM_DEBUG__` | `server/src/debug/*`、`lib/debugAccount.ts`、`lib/debugBootstrap.ts` | workstation.md（调试版） |
| 10.8 | 发布与构建风味 | 出 debug/release 包、签名、更新源、上架材料 | 仓库脚本 | `TANDEM_FLAVOR`、`flavor.txt`、keystore、`latest.yml` | `scripts/release.mjs`、`scripts/write-flavor.mjs`、`scripts/scan-release.mjs`、`packages/mobile`、`packages/desktop` | release.md |

规则归属（表内为摘要；逐条原文名称与归属以附录 A 为准）：

| 功能 | decisions-check 决定 | regression 用例 |
|---|---|---|
| 10.1 | — | 反馈模式点击不穿透，选中底层元素；反馈模式圈选浮层：模型菜单、命令面板、环境条、看板抽屉；反馈草稿实时保存：刷新后条目与截图恢复；手机反馈工具栏移入顶部 |
| 10.2 | — | 调整工具：冻结副本改尺寸吸附 token、换图标/备注/删除/插入/平移并导出；调整说明：同元素连续改动合并、选择器跳过自动 id；调整模式浮层互不遮挡 |
| 10.3 | — | 体验清单「有问题」进入反馈并带功能标签，导出与解包按功能分组 |
| 10.4 | — | 演示工作区可创建、场景可打开、可清除且不污染真实数据；演示设备（见 D6） |
| 10.5 | — | 体验清单（同上） |
| 10.6 | — | 调试版手机预览：弹窗按移动布局渲染并可打开侧栏抽屉 |
| 10.7 | — | 登录门：调试版自动登录带演示主机（已归 D6） |
| 10.8 | — | 无 regression 用例（`e2e/release-flavor.mjs`、`scan-release`、`check-release`） |

---

## 3. 交叉统计

### 3.1 功能文档覆盖

17 份 `docs/features/*.md` + `docs/workstation.md`，覆盖约 52 项功能（多数只写其中一段行为）。**没有专门功能文档的约 43 项**，分布：

| 领域 | 无文档/仅片段覆盖的功能 |
|---|---|
| D1 | 1.1（composer 片段）、1.7、1.11、1.12（design 原则） |
| D3 | 3.3、3.4、3.9、3.10 |
| D4 | 4.9 |
| D5 | 5.1、5.2、5.5–5.9、5.10–5.16（仅沙箱、Secrets 有文档） |
| D6 | 6.8 |
| D7 | 7.5、7.6 |
| D8 | 8.1–8.8、8.11（仅分享、Wiki 有文档） |
| D9 | 9.1–9.7 全部（只有 design 原则，无功能说明） |
| D10 | 10.7 |

这就是"功能到底是什么不明确"的直接来源：**文档按"曾经修过的问题"写，不按功能写**；同一功能可能散落在 3–5 份文档与几十条检查里，而没有文档的功能连"目标一句话"都找不到。

### 3.2 决定与用例归属统计

| 归属 | 决定数 | 用例数 |
|---|---|---|
| 能归到某一具体功能（D1–D10，除 9.7） | 90 | 203 |
| 只能归到 D9-9.7「共享 UI 原语与全局视觉规范」 | 18 | 17 |
| 完全无法归属 | 0 | 0 |

「共享 UI 原语」18 条决定：`color-tokens`、`primary-white`、`font-size-floor`、`focus-ring-neutral`、`ui-button-sizes`、`ui-card`、`ui-badge`、`ui-empty-state`、`overlay-scrollbar`、`native-controls`、`no-native-window-prompt`、`menu-single-line`、`menu-max-width`、`menu-footer-fixed`、`menu-cascade`、`popover-stable`、`popover-no-focus-steal`、`danger-ghost`。

对应 17 条用例（原文名称见附录 A）：警告与状态色；设置窗口固定尺寸；反馈9：滚动条/设置行/右键菜单；反馈11：设置页输入框/导航滚动条；侧栏会话 ⋯ 菜单与 tooltip 不被裁切；反馈2102#03：设置弹窗滚动条；菜单项只有单行标题；tooltip 按内容宽度换行；焦点环只在键盘导航时出现；设置页字号 ≥11px；菜单行文字行高；360 小屏更多菜单 44px；反馈14#01/#02：菜单首次/再次打开稳定；无障碍扫描；360 小屏侧栏触控 44px；360 小屏设置按钮 44px；反馈1603#02：菜单危险项常态 danger 色。

> 说明：D7 与 D10 没有 `decisions-check` 决定（看板、评测、定时、反馈调整的决定只落在回归与文档里）。

---

## 4. 诊断

### 4.1 孤立的小功能（没有明确目标，或只为一次反馈加上）

判据：只有一处展示/交互细则、没有独立状态与文档、理由只写在某条反馈或某次提交里。

| # | 小功能 | 来源 | 现状 |
|---|---|---|---|
| S01 | 新功能提示条 30 秒未点开自动收起 | 反馈1323#01 | 只在 `FeatureTour` 内的一条计时规则 |
| S02 | 金额不足 $0.0001 显示 `<$0.0001` | 反馈1601#03 | `format.ts` 一条分支，5 处展示共用 |
| S03 | 用户消息气泡紧贴内容（不留空白操作行） | 反馈14#05/#06 | `UserMessage` 的宽度/占位规则 |
| S04 | 卡片折叠箭头与拖动手柄放标题右侧 | 反馈16#07/#08 | 右栏卡片头部布局 |
| S05 | 顶栏右侧不出现两个同图标按钮 | 反馈2102#04 | 顶栏图标选择规则 |
| S06 | 环境条主机触发器改用显示器图标 | 反馈2102#08 | 一个图标常量 |
| S07 | 菜单行文字行高不被裁切 | 反馈10#07 | `Menu` 行高 ≥1.4 |
| S08 | 侧栏项目与会话缩进收紧 | 反馈12#08 | `SessionGroups` 内边距 |
| S09 | 每个分组只显示一个 Key（隐藏其余、后端仍支持多 Key） | 反馈1323#02 | 前端只渲染一个 Key 行 |
| S10 | 断点续跑胶囊（倒计时 + 继续） | 迭代 17，无反馈号 | 只在 `resumePaused` 时出现 |
| S11 | 板载串口默认折叠 | 反馈#8-06 | 设备列表分组阈值 |
| S12 | 串口「修复权限」说明与深度检测 | 反馈#8-06 / R29 | 工作站设备弹层内 |
| S13 | 演示画面卡片（安卓模拟屏/串口心跳） | 反馈#7-01 | 演示工作区挂载后出现 |
| S14 | 模型菜单「单价未设置 → 跳到该账号单价覆盖」 | 无反馈号（仅回归） | 模型菜单行尾动作 |
| S15 | 手机消息操作收成一个「更多」按钮 | 反馈/走查（无编号） | 移动端消息操作栏 |

**若合并/删除，影响什么**：S01–S09 都是共享组件里的一两行规则，合并到所属大功能（导览/金额格式/消息气泡/面板/顶栏/环境条/菜单/侧栏/Key 管理）不会减少可发现性，删掉只影响对应反馈的那一屏；S10–S13 是特定条件下才出现的独立小件，删掉会让"断点恢复/设备权限/演示"少一个可见入口，但主流程不受影响；S14/S15 是入口冗余的补丁，合并进模型菜单/消息操作即可。

### 4.2 重叠 / 重复

| # | 重叠 | 证据 | 影响 |
|---|---|---|---|
| O1 | 会话结构的三种可视化：右栏会话图、侧栏悬停拓扑、右栏代理卡 | 前两者共用 `layoutSessionGraph`（有意同图）；代理卡另用 `useRightPanelData` 数分叉/子代理，是第三种表达 | 同一棵树三套读法，改树模型要同步三处；删掉代理卡会丢"按层级列表 + 右键换模型重跑"，合并则需把右键操作并入图节点 |
| O2 | 两套登录界面 | `auth/LoginGate.tsx`（全屏）与 `accounts/LoginDialog.tsx`（账号菜单）并存，字段集不同（TOTP/邀请码/调试账号只在对话框） | 改登录协议要改两处；删对话框会让已登录但掉线的用户少一条恢复路径 |
| O3 | 「定位到某轮/某条消息」的 5 个入口 | 轮次大纲、会话图、全文搜索、收件箱、子代理卡都调 `lib/jump.ts`；实现已统一，入口仍各自一套 | 删任一入口会丢一种发现路径（搜索/收件箱尤其）；合并入口需要先统一"先加载再定位"的交互 |
| O4 | 只读会话的三套外壳 | `ExternalSessionView`、`SubagentSessionView`、`PublicSharePage` 各写一套布局，共用 `Markdown`/`TurnRail` 的一部分 | 设计原则 P20 要求同构，现状靠三处各自维护；合并可减少"预览缺信息面板"类问题，但分享页要维持无写操作/脱敏边界 |
| O5 | 选模型的地方 6 处 | 新会话页、输入框模型菜单、设置账号与模型、模型路由角色绑定、看板卡片默认、评测/Wiki/定时任务各自选模型 | 能力/价格规则一变就要逐处核对；合并成共享选择器会减少不一致，但各处默认值语义不同（会话/角色/一次性任务） |
| O6 | 成本展示 5 处 | 消息用量行、轮次 tooltip、上下文卡、用量页、模型菜单/看板/评测 | 口径已经共用 `resolvePriceForModel`，但展示格式与"估算/实际"标注各自实现；合并格式不影响数据 |
| O7 | worktree 语义 4 处 | 环境条开关、右栏改动审阅、会话合并、看板自动建/合入 | 概念散落，用户不知道"哪个 worktree 属于谁"；合并需要先定义一个 worktree 列表入口 |
| O8 | 设备入口 2 处 + 串口终端 1 处 | 环境条设备胶囊、主机详情「设备」、工作站弹层行尾 | 删任一处会丢"从当前会话挂载/从主机看设备"的上下文；合并成一个设备中心需要保留会话上下文 |
| O9 | 添加主机 6 个触发点 | 空状态、设置主机、环境条、命令面板 ×2、导览卡，都开同一个 `AddHostDialog` | 入口多但目标一致，属 P15 的"快捷方式"；删多余触发点会降低新用户可发现性 |
| O10 | 计划模式 vs 分工「仅规划」（历史） | 「仅规划」已移除，职责交给权限模式 `plan`（routing.md） | 已消除；若再加回会与权限模式冲突，影响工具集与审批语义 |
| O11 | 跨主机派单 vs 新会话选主机（历史） | 提交 `ef1acd3`「删除跨主机派单，开会话统一在新会话页选主机」 | 已消除；但"会话内换主机=迁移"（D3）与"新会话选主机"仍是两套心智，合并需要迁移语义 |
| O12 | 任务看板卡片 vs 普通会话 + 分屏 | 卡片是顶层会话、不进侧栏，用独立抽屉/动作语言；分屏也能并排看多个会话 | 目标部分重叠（并行跑多件事）；删看板会丢依赖/审批门/并发/预算，删分屏会丢自由并排 |

**若合并/删除，影响什么**：O1–O6 是"同一份数据/同一件事的多套表达"，合并主要降低一致性成本，用户可见能力基本不变；O7–O9 合并会改变入口位置，需要迁移文案与回归；O10/O11 已消除，回退会重新引入两套语义；O12 是产品取舍，删任一方都会丢一组调度/查看能力。

### 4.3 跨功能的核心模型（被多处各自读取/计算）

| # | 核心模型 | 谁在用（各自实现/读取） | 现状 |
|---|---|---|---|
| M1 | 会话树（根/分叉/子代理归并） | `lib/sessionTree.ts`（根归并）、`session/sessionListUtils.ts`（归并 + 状态/未读汇总）、`sessionGraph/data.ts` + `layout.ts`（树→行）、`useRightPanelData`（分叉计数）、`server/src/host/graph.ts`（服务端归并）、`ChatView`（分叉来源标题） | 根归并规则在 5 处各自走一遍 `parentId/forkedFrom`；`test` 只覆盖 `sessionListUtils`/`layout` |
| M2 | 「轮」的划分与聚合 | `protocol` 的 `isUserTurnMessage`/`countTurns`（共享口径）、`lib/turnUsage.ts`（按轮汇总）、`MessageList`（按轮分组渲染）、`lib/turnWindow.ts`（可见轮范围）、`server/src/context.ts`（轮估算）、`host/graph.ts`（轮行）、`evals.ts` | 判定口径共享，但"一轮包含什么、算多少"各写一份；注入文本过滤在 protocol/context/external 三处调用 |
| M3 | 会话运行 / 等待状态 | `SessionSummary.status`、`sessionListUtils.isBusy`、`appStore/helpers.isBusy`、`TopBar`、`StatusDot`、`SessionRow`、`SessionGraphCard`、`SessionHeaderTools`、`messagesSlice`、`serverMessages`、`host/graph.ts` | 同一套 running/waiting_permission/retrying 在 10 处各自判空与兜底；新增状态要逐处改 |
| M4 | 未读 | `SessionSummary.unread`（会话）、`HostInboxState.unread`（收件箱）、`markSessionRead`、`summaryOf`（R71） | 两个"未读"概念共用「侧栏红点」语境，用户容易以为是同一件事 |
| M5 | 消息区滚动位置 / 是否贴底 | 15 个写入口（`ChatView` 6、`MessageList` 4、`jump.ts` 2、滚动条拖动 1、`scrollIntoView` 2）、8 处贴底判断（scroll-controller 盘点） | 已有设计稿与 `lib/scroll/chatScroll.ts`（纯函数），**尚未接入**；谁最后写谁赢 |
| M6 | 模型能力（上下文窗口 / 思考档位 / 1M / 价格） | 服务端 `capabilities.ts`（唯一表）、`contextWindowForModel`（4 处服务端调用）、web `Composer` 的 `contextLimit`、`ContextMeter` 的分母、`listModels` 返回的 `contextWindow`、`newSessionPick` 记住的值、分组 `longContext` 默认 | 同一"上限"有 4 个来源（会话快照、模型列表、能力表、1M 开关），最近一次修复正是让分母实时重算 |
| M7 | 价格 / 花费 | `usage.ts` 的 `builtinPriceFor` + `resolvePriceForModel`（服务端 9 处调用）、web `turnUsage`、看板卡片、评测结果、网关日志、模型菜单计算式 | 单价规则集中，但"展示什么、是否标估算"各写；历史花费不重算的规则只写在文档 |
| M8 | 会话执行环境（主机/目录/分支/worktree） | `SessionEnv`（服务端）、`EnvBar`、`NewSessionDialog`、`worktreeIntents`、看板 `BoardExec`、`ChatView` 迁移 | "在哪台机器哪个目录"有会话/草稿/卡片三种承载，切换/迁移逻辑只在 EnvBar |
| M9 | 只读会话渲染 | `ExternalSessionView`、`SubagentSessionView`、`PublicSharePage`、`SessionGraphCard` 只读版 | 组件外壳三套，消息渲染一套 |
| M10 | 文件路径 / 文件引用 | `fileLinks.ts`（识别）、`fileRefExists.ts`（批量存在）、`server/src/util/path.ts`（规范化）、`changes.ts` 的 `gitPath`（仓库相对）、`fs` 路由 | 三种路径口径（展示/存在性/git 相对），跨平台修复过多次（R06） |

**若统一，影响什么**：M1/M2/M3 是最高收益：统一后改一次会话树/轮/状态即可全站生效，但要先定"唯一函数放哪（protocol 或 web/lib）"，否则会与只读视图/服务端重复；M5 已有设计稿，接入会动 3 个文件与大量滚动回归，风险最高但能停掉"修一处坏一处"；M6/M7 收拢会改变上下文分母与花费的展示口径，需要一次性重算历史快照（已有 `withLiveWindow` 先例）；M8/M9/M10 合并主要减少跨端不一致，不改数据。

### 4.4 没有对应测试的功能

| 功能 | 覆盖现状 |
|---|---|
| 8.9 会话分享（公开只读页） | 无单测、无 e2e；regression 只在设置导航里出现「分享」 |
| 5.9 提示词模板 | 无单测；只有手机提示词编辑区滚入视口的交互用例 |
| 5.8 记忆 | 无单测；只有「不暴露内部元数据行」 |
| 5.5 MCP | 无单测；只有「移除需二次确认」 |
| 5.6 Hooks | 无单测；regression 仅 1 处提及 |
| 5.7 Skills / 子代理预设 | 无单测；只有设置页导航/字号 |
| 9.3 通知 | 无单测、无用例 |
| 9.6 关于与更新 | 无用例（只有产物扫描） |
| 5.13 PR / CI | 无用例（只有 test-guide 与看板 PR 聚合的一部分） |
| 5.16 浏览器 | 无单测；只有空态 |
| 4.11 Key 网关 | 无专用测试（共用 upstream-engine 单测） |
| 1.7 断点续跑 | 只有 1 条胶囊用例；恢复语义无端到端 |
| 3.4 发送/中断/斜杠命令 | 无直接用例（靠其他会话用例间接覆盖） |
| 8.2 归档 | 只有 1 处提及，无归档视图用例 |
| 9.5 同步与备份 | 有 2 条 UI 用例，无导入结果/迁移单测（migrate 无 test） |

另有一类"有单测无 UI 回归"：语音输入（`stt.test.ts`）、定时任务（`schedules.test.ts`）、预算规则（`budgets.test.ts`）、余额（`balance.test.ts` + workstation-check）。

**若补测试，影响什么**：这些功能现在只能靠人点；补最小回归（入口可见 + 一个状态变化）即可发现"点了没反应"类问题，不必先做完整自动化。分享页与网关涉及脱敏/鉴权，缺测试的风险高于界面类。

### 4.5 测试 / 决定无法归属的条目

- **决定**：0 条完全无法归属；18 条只能归到"共享 UI 原语与全局视觉规范"（3.2 已列）。
- **用例**：0 条完全无法归属；17 条只能归到"共享 UI 原语与全局视觉规范"（3.2 已列）。
- 另有 10 个字符串是夹具/账号名而非用例（`Task`、`Edit`、`repo`、`preview-reg-app`、各账号名、`--t-warning-soft`、`tandem-config.json`、`第二台主机`、`v2 回归看板`、`确认回归看板`），统计时已剔除。

**影响**：这 35 条（18 决定 + 17 用例）不指向任何单一用户功能，说明"界面统一"已经是一层独立契约；若未来拆包/换皮，它们需要单独一套验收，不能挂在某个功能下。

### 4.6 每个领域近两周返工最多的功能

| 领域 | 返工最多 | 提交数（含反馈号） | 次之 |
|---|---|---|---|
| D1 | 消息区滚动 / 懒加载 / 跳转 | 64（36） | 轮次/用量/耗时 57（18） |
| D2 | 侧栏会话树（分叉/收起/未读） | 65（23） | 会话图 34（17） |
| D3 | 输入框 / Markdown 编辑 | 22（5） | 环境条 11（7） |
| D4 | 账号 / Key / 余额 / 网关 | 52（11） | 模型菜单/思考/路由 42（14） |
| D5 | 审批 / 权限 / 沙箱 | 41（9） | 改动审阅 / worktree 39（10） |
| D6 | 主机 / 工作站 / 登录 / 执行器 | 86（20） | 设备 / 串口 11（2） |
| D7 | 任务看板 | 9（0） | 评测 4（0）、定时 3（0） |
| D8 | 侧栏（与 D2 共用） | 40（23） | 收件箱 7（0）、搜索 5（0）、分屏 3（0） |
| D9 | 设置页 / 外观 | 57（5） | — |
| D10 | 反馈模式 / 调整工具 | 30（19） | 演示/预览/评测 13（2） |

**读法**：返工集中在"状态被多处写/多套表达"的功能（消息滚动、会话树、会话图、主机/登录、设置），而看板、评测、定时、分享、Wiki 几乎没有返工——前者是共享状态的协调问题，后者是需求稳定或使用频率低。

**若把返工热点合并/重构，影响什么**：D1 滚动、D2 会话树、D6 登录/主机是"改一处影响多屏"的区域，重构收益最大；D10 调整工具是调试专用，稳定后再动；D7/D8 低频功能可以先补文档与最小回归，不必重构。

---

## 5. 附录 A：regression 用例 → 功能（原文名称，逐条）

> 下表按 `e2e/regression.mjs` 的注册顺序列出全部 220 条用例；「功能」列对应第 2 节的编号。第 2 节表内为摘要，以此表为准。

| # | 用例名称 | 功能 |
|---|---|---|
| 1 | 长会话打开贴在最新消息 | 1.10 |
| 2 | 大会话首屏只下发尾部消息 | 1.10 |
| 3 | 大会话滚到顶加载更早消息且位置不跳 | 1.10 |
| 4 | 轮次大纲跳到未加载的轮 | 1.4 |
| 5 | 轮次大纲滚轮只预览、点击未加载轮能定位（反馈10#01 R40） | 1.4 |
| 6 | 占位条标注未加载轮次并可分段加载（反馈11#05 R40） | 1.10 |
| 7 | 固定轮次滚到底部仍挂载、中间占位条可加载（反馈11#05 R40） | 1.10 |
| 8 | 大纲标识未加载轮次并可点击跳转（反馈11#05 R40） | 1.4 |
| 9 | 跳转统一：会话图与轮次大纲调用同一个实现（反馈0220#03） | 1.10 |
| 10 | 跳转有动画：点击后 scrollTop 在 ≥3 帧内逐步变化（反馈1110） | 1.10 |
| 11 | 跳转动画结束后不再写 scrollTop、之后滚轮不被拉回（反馈0220#03 R68） | 1.10 |
| 12 | 大纲未加载轮标注、点击只取该片段（反馈0220#03 R40） | 1.10 |
| 13 | 固定轮次初次打开、滚动、跳转后始终挂载（反馈0220#03 R40） | 1.10 |
| 14 | 轮次大纲悬停显示该轮用量、全文可读（#01 R15） | 1.5 |
| 15 | 外部会话预览：轮次大纲、用量 tooltip 与信息面板（反馈9#01 R37） | 1.2 |
| 16 | 反馈16#05：Codex 注入内容不作为用户轮（大纲/会话图） | 1.2 |
| 17 | 轮次大纲固定按上下文占用着色，压缩轮最浅并标已压缩（#01 追加 / 反馈8#07） | 1.4 |
| 18 | 压缩确认与上下文面板按真实用户轮次统计（R16） | 1.8 |
| 19 | 上下文卡：鲜明分类色、自定义 agents、缓存条与阈值刻度（反馈13#05） | 1.8 |
| 20 | 警告与状态色饱和、对比度达标（反馈13#03） | 9.7 |
| 21 | 配额将尽时交接卡可切换备用分组 | 4.10 |
| 22 | 反馈0220#02：额度将尽时可继续使用当前分组跑完本轮 | 4.10 |
| 23 | 反馈0220#02：关闭额度交接后不再出现交接卡 | 4.10 |
| 24 | 反馈0220#05：一轮内只有最后一条回复保留操作行 | 1.5 |
| 25 | Secrets 工具输出显示打码标签 | 5.4 |
| 26 | 轮次条点击第 30 轮精准定位（不跳到相邻轮） | 1.4 |
| 27 | 设置窗口固定尺寸，切换页签不跳动 | 9.7 |
| 28 | 反馈15：设置内容区限宽留白、通知卡图标在卡片内且与标题对齐（R01） | 9.1 |
| 29 | 反馈9：滚动条唯一且不占宽、设置行单行、高级展开不位移、右键菜单接管 | 9.7 |
| 30 | 反馈11：设置页输入框全局屏蔽、设置导航滚动条进 gutter 不压文字（R37/R36） | 9.7 |
| 31 | Host 诊断：面板打开、失败项排在最前、报告不含 Key | 6.8 |
| 32 | 设置弹窗焦点陷阱与关闭后焦点还原 | 9.1 |
| 33 | 侧栏会话 ⋯ 菜单与 tooltip 不被裁切 | 9.7 |
| 34 | 模型菜单级联（账号 → 分组 → 模型）逐级飞出且不越界（#7-04） | 4.1 |
| 35 | 思考强度档位来自模型能力，名称用厂商叫法（#7-05） | 4.2 |
| 36 | 1M 上下文开关按型号能力显示，切换后上下文卡分母变化 | 4.3 |
| 37 | 旧上下文快照的分母按当前型号与 1M 开关实时计算 | 4.3 |
| 38 | 输入框：token 估算、切换确认与分工取向合并（反馈8#01 #03 #05 #08 #09 #11 / 10#02 / 2009#01） | 3.5 |
| 39 | 输入框 Markdown 实时预览：光标外隐藏标记、代码块整块渲染、Enter 续号与原始内容发送（反馈8#02 / 1323#05） | 3.1 |
| 40 | 用户气泡完整渲染 Markdown：标题降级、列表、代码块与源码编辑（Markdown 实时预览） | 3.1 |
| 41 | 输入框 @ 选文件与文件夹：文件夹可进入、路径标记只显示名字、发送仍是完整路径（反馈2102#07） | 3.2 |
| 42 | 模型菜单顶部显示最近使用模型（跨账号分组）并可直接选中（#7-04） | 4.1 |
| 43 | 环境条容器透明、触发器可见且不越界 | 3.6 |
| 44 | 环境条文件夹弹层向上弹出且完整可见 | 3.6 |
| 45 | 环境条文件夹弹层只列最近文件夹与「打开文件夹…」（反馈1323#09） | 3.6 |
| 46 | 非 Git 仓库时不显示 Worktree 开关（反馈1323#07） | 3.6 |
| 47 | 非 Git 仓库时不显示分支触发器（反馈1323#08） | 3.6 |
| 48 | 侧栏项目分「固定 / 最近」两组，固定图标语义与悬停规则（R01） | 8.1 |
| 49 | 侧栏项目 tooltip 显示主机与完整路径（R06） | 8.1 |
| 50 | 后台任务悬停展开列表并跳到对应输出（R01） | 5.10 |
| 51 | 反馈16#02：宽表格与长代码行限制在正文宽度内、块内部横向滚动 | 1.2 |
| 52 | 反馈16#02：代码块有文字且落在可见区域、表格不缺列（真实会话夹具） | 1.2 |
| 53 | 反馈1919#07：流式输出时在底部自动跟随，上滚后停止，回到底部后恢复 | 1.6 |
| 54 | 反馈2102#03：设置弹窗打开时，背景滚动条不压在弹窗之上；弹窗自己的滚动条在弹窗之上 | 9.7 |
| 55 | 反馈2102#06：新会话发送后直接进入会话并显示用户消息，发送请求未返回前不停留在空的新会话页 | 3.8 |
| 56 | 反馈2102#01：切换会话时主区不闪：旧会话画面保留到新会话就绪，不出现空白或骨架屏 | 1.6 |
| 57 | 反馈1601#02：来回切换会话，消息区与右栏从新会话首帧起保持同一画面（R10 复发） | 1.6 |
| 58 | 反馈1601#05：侧栏主机与项目文件夹的折叠状态会被记住，重开仍折叠（R10） | 8.1 |
| 59 | 反馈2102#02：会话图快速连点两个节点，最终停在第二个目标且滚动单调 | 2.3 |
| 60 | 反馈16#10：等首个 token / 工具运行时显示 spinner 与已运行时长 | 1.6 |
| 61 | 反馈16#11：排队消息被读取后按原位置出现在对话流里 | 1.6 |
| 62 | 反馈16#01：用量行默认隐藏、悬停显示、左缘一致、时间用相对格式 | 1.5 |
| 63 | 反馈12#02：自动换行时行号与代码逐行对齐、工具条不压内容 | 1.2 |
| 64 | 消息用量只保留一行小字（#7-03） | 1.5 |
| 65 | 消息耗时显示在用量行末尾，轮次大纲汇总模型与工具耗时（A） | 1.5 |
| 66 | 发送消息后服务端记录耗时、首 token 延迟并显示在消息下方（A） | 1.5 |
| 67 | 用户消息：气泡紧贴内容、时间与输入估算（反馈14#05/#06 · 反馈16#01 悬停显示） | 1.5 |
| 68 | 文件夹弹层列出最近目录；浏览对话框首项为上一级，超长名称单行省略（R15 / 反馈1323#09） | 3.6 |
| 69 | 自动路由偏好点击即时切换且不闪回（R17） | 4.5 |
| 70 | 菜单项只有单行标题，多模型分组下列表可滚动且底部操作可见（#15/#16/#17 R01/R15） | 9.7 |
| 71 | 环境条下拉连续切换保持打开（#04 P0） | 3.6 |
| 72 | 环境条「选择主机」可打开（#11 P0） | 3.6 |
| 73 | 环境条换主机先选文件夹：待定状态、输入禁用、可取消（反馈13#02） | 3.7 |
| 74 | tooltip 按内容宽度换行，不会每行一个字（#01 R15） | 9.7 |
| 75 | 轮次固定：命中区 ≥24px、一个视图两用（Alt/点击只看已固定）、阅读区不重排（#12/反馈6追加/反馈8#04） | 1.4 |
| 76 | 焦点环只在键盘导航时出现（自动聚焦的输入框没有橙色描边） | 9.7 |
| 77 | 粘贴一次同一张图片只生成一个附件 | 3.3 |
| 78 | 反馈模式点击不穿透，选中的是底层元素 | 10.1 |
| 79 | 反馈模式圈选浮层：模型菜单（含子菜单）、命令面板、环境条、看板抽屉 | 10.1 |
| 80 | 菜单：单价未设置时可跳到该账号的单价覆盖 | 4.8 |
| 81 | 模型菜单：内置价格表命中时显示「参考价」（R08） | 4.8 |
| 82 | 账号/分组倍率叠加并在模型菜单显示计算方式（#04） | 4.8 |
| 83 | 新会话页环境条显示当前分支名而不是「分支」占位词 | 3.8 |
| 84 | 反馈0220#04：只为明确的文件引用生成链接（R06） | 1.2 |
| 85 | Windows 盘符路径文件链接可打开预览 | 1.2 |
| 86 | 改动审阅把未跟踪目录展开为文件 | 5.12 |
| 87 | 改动审阅：文件列表贴顶、diff 紧跟、自动换行无横向截断（R14） | 5.12 |
| 88 | 改动审阅行内评论浮窗与行标记 | 5.12 |
| 89 | 提交前 AI 评审挂行、忽略无效行并采纳意见 | 5.12 |
| 90 | 改动审阅提交范围带文件数与二次确认 | 5.12 |
| 91 | 自定义兼容账号显示「自定义接口」而不是 DeepSeek | 4.1 |
| 92 | worktree 会话按原仓库归组而不是目录名 cache | 8.1 |
| 93 | 编辑消息保持气泡宽度并随内容自适应（反馈11#07 R45） | 1.2 |
| 94 | 回退对话框精简为单行引用/单选/一行警告（反馈11#08 R46） | 5.11 |
| 95 | 工具行调高且工具-only 行收紧空白（反馈11#04 R47） | 5.1 |
| 96 | 会话信息面板不再提供删除会话（反馈11#02 R05） | 1.12 |
| 97 | 无检查点的会话仍可只回退对话 | 5.11 |
| 98 | 删除 dirty worktree 的确认列出文件与分支 | 5.14 |
| 99 | 移除 MCP 服务器需要二次确认 | 5.5 |
| 100 | 回退对话框引用目标消息并显示删除范围 | 5.11 |
| 101 | 同步与备份：空口令时导出按钮禁用 | 9.5 |
| 102 | 同步与备份：替换导入需二次确认并标注危险 | 9.5 |
| 103 | 侧栏「新会话」清空草稿并聚焦输入框 | 3.8 |
| 104 | 新会话默认带上工作目录且双击发送只创建一次 | 3.8 |
| 105 | 反馈2102#05：新会话页选的账号/模型按主机记住，开会话后与刷新后仍保留，已不存在的模型回落默认 | 3.8 |
| 106 | 反馈2102#04：顶栏右侧不出现两个同图标的按钮 | 8.3 |
| 107 | 反馈2102#08：环境条主机触发器用显示器图标，与文件夹触发器区分开 | 3.6 |
| 108 | 记忆编辑器不暴露内部元数据行 | 5.8 |
| 109 | 设置页字号不低于 11px（记忆/提示词/Skills） | 9.7 |
| 110 | 会话信息面板左缘拖宽、记住宽度并可双击复位（#03 R01） | 1.12 |
| 111 | 会话信息面板：空分组默认隐藏、⋯ 菜单可显式显示（反馈9#06 / 10#03 R14） | 1.8 |
| 112 | 账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉（反馈10#04 #05 #06 R43/R42/R37） | 4.6 |
| 113 | 菜单行文字行高不被裁切（反馈10#07 R44） | 9.7 |
| 114 | 断点续跑胶囊显示倒计时与操作 | 1.7 |
| 115 | 手机设置全屏、三列导航且无横向溢出 | 9.1 |
| 116 | 手机收件箱审批卡任务描述默认两行，点按展开全文（R15） | 8.7 |
| 117 | 手机反馈工具栏移入顶部，不遮住底部环境条 | 10.1 |
| 118 | 手机环境条不越界、容器透明、触控 44px | 3.6 |
| 119 | 手机重试胶囊独立一行且不压顶栏 | 1.6 |
| 120 | 手机账号卡只有一行编辑/删除操作 | 4.6 |
| 121 | 手机权限规则匹配模式独占一行 | 5.2 |
| 122 | 手机用量柱状图可点按查看每日花费 | 4.8 |
| 123 | 手机提示词点选后编辑区滚入视口 | 5.9 |
| 124 | 手机消息操作只剩一个更多操作按钮且触控 44px | 1.5 |
| 125 | 手机模型菜单与文件夹弹层都在视口内 | 3.6 |
| 126 | 手机嵌套弹窗按 Esc 只关闭最上层 | 9.1 |
| 127 | 360 小屏：会话顶栏标题与状态不重叠、输入框不横向溢出 | 3.4 |
| 128 | 360 小屏：更多菜单项 44px 且弹层不越界 | 9.7 |
| 129 | 360 小屏：内联审批卡的拒绝/允许按钮触控 44px（反馈14#07） | 1.9 |
| 130 | 反馈12#03/#05：子代理卡片定位子会话、层级不用子/孙、可跳转只读视图 | 2.5 |
| 131 | 反馈1603#06：代理卡行尾不再有 ⋯，右键子代理行仍可换模型重跑/交回 | 2.5 |
| 132 | 反馈2108#02：子代理工具行点击直接进入子代理会话，不展开卡片 | 2.5 |
| 133 | 反馈2108#03：点会话图子代理节点进入子代理会话 | 2.5 |
| 134 | 反馈2108#04：分叉会话的「查看」回到来源会话 | 2.6 |
| 135 | 反馈12#06/#07：会话信息无顶栏、分组可收起并记住 | 1.12 |
| 136 | 反馈16#06：会话信息面板与卡片宽度不随展开/折叠变化 | 1.12 |
| 137 | 反馈16#07/#08：卡片折叠箭头与拖动手柄在标题右侧且常显 | 1.12 |
| 138 | 反馈16#03/#09：会话图高度按轮数自适应并封顶 | 2.3 |
| 139 | 反馈12#08：侧栏项目与会话缩进收紧、标题左对齐 | 8.1 |
| 140 | 反馈14#01/#02：所有菜单首次与再次打开，位置与尺寸稳定（15 帧 ≤1px） | 9.7 |
| 141 | 审批策略：同类请求多次批准后审批卡出现项目快捷规则 | 5.2 |
| 142 | 命令沙箱：工作目录外写入在 acceptEdits 下仍出现审批卡 | 5.3 |
| 143 | 沙箱：worktree 会话写 cwd 内文件不弹审批 | 5.3 |
| 144 | 审批策略：危险命令审批卡不出现项目快捷规则 | 5.2 |
| 145 | 审批策略：权限页显示统计与建议，危险命令只建议询问 | 5.2 |
| 146 | 无障碍扫描：主要页面 serious/critical 违规为 0 | 9.7 |
| 147 | 反馈1603#03：审批卡宽度 352、按钮 拒绝/更多/允许一次（主按钮）贴底 | 1.9 |
| 148 | 反馈14#07：审批是对话流里的一条消息，样式参考 Claude Code Desktop | 1.9 |
| 149 | 反馈14#07：Esc 拒绝、发送消息视为拒绝并说明 | 1.9 |
| 150 | 手机长按用户消息打开操作菜单 | 1.5 |
| 151 | 360 小屏：侧栏行与图标触控 44px | 9.7 |
| 152 | 360 小屏：设置页按钮触控 44px | 9.7 |
| 153 | 手机点按文件引用打开预览并可关闭 | 1.2 |
| 154 | 评测：对比表字号 ≥12px、时间中文化、轨迹与并排可开 | 7.6 |
| 155 | 浏览器：工具卡与浏览器面板空态 | 5.16 |
| 156 | 应用预览：自动识别、设备切换、点选元素、Edit 自动刷新与改前对比 | 5.15 |
| 157 | 收件箱：同一回合多次审批聚合为一条，展开可见流水 | 8.7 |
| 158 | 手机评测结果表可横向滚动并打开轨迹 | 7.6 |
| 159 | 命令面板：搜「桌面通知」定位到对应设置项 | 8.4 |
| 160 | 命令面板：前缀筛选与拼音首字母匹配 | 8.4 |
| 161 | 设置分组：6 组、合并页与高级折叠 | 9.1 |
| 162 | 顶栏图标数 ≤5 且低频入口收进更多菜单 | 8.3 |
| 163 | 命令面板可搜到更多菜单的全部入口 | 8.4 |
| 164 | 新功能导览：出现、跳转并全部标为已读 | 8.11 |
| 165 | 反馈1603#01：超过 7 天的会话默认收起，点开才加载，固定/未读始终显示 | 2.2 |
| 166 | 会话筛选：状态筛选与「已筛选 · 清除」 | 8.2 |
| 167 | 反馈1603#02：菜单危险项（删除）文字与图标常态 danger 色 | 9.7 |
| 168 | 反馈2156#02：打开会话后重新加载，未读点不再出现 | 2.1 |
| 169 | 侧栏按主机分组显示全部会话，无主机切换按钮；离线仍可浏览（#02） | 8.1 |
| 170 | 全文搜索：命中片段、打开会话并定位消息 | 8.6 |
| 171 | 快捷键：外观页由命令注册表生成、自定义生效、冲突提示 | 8.5 |
| 172 | 手机顶栏搜索按钮打开命令面板 | 8.4 |
| 173 | 分屏：双窗格收发、焦点跟随右栏与比例恢复 | 8.8 |
| 174 | 分屏：拖拽分区、Ctrl+1 焦点与 Ctrl+W 关闭 | 8.8 |
| 175 | 手机分屏：圆点指示与左右滑动切换 | 8.8 |
| 176 | 任务看板：侧栏入口、拖动放行、依赖等待、待评审打回与通过 | 7.1 |
| 177 | 手机任务看板：分组列表、待我处理行内通过与全屏详情 | 7.1 |
| 178 | 自动模型路由：简单快速、困难强力、失败升级、连续成功回落与节省统计 | 4.5 |
| 179 | 分工路由：原生不注入且 Task 可用、分工关闭零派发、取向省钱整单交执行者、分工积极协作、确认卡与学到的偏好 | 4.4 |
| 180 | 任务看板 v2：运行时提议、AI 评审修复、冲突解决、PR 聚合与分屏 | 7.4 |
| 181 | 看板合并确认、完成态后续操作与手动压缩确认（R11/R12） | 7.2 |
| 182 | 项目 Wiki：浏览、全文搜索与手写段落 | 8.10 |
| 183 | 演示工作区可创建、场景可打开、可清除且不污染真实数据 | 10.4 |
| 184 | 会话图：时间倒序、子代理始终展开、悬停会话线高亮、子代理视图回主会话 | 2.3 |
| 185 | 反馈0220#08：一棵会话树共用一张拓扑，分叉以自己为主线（仿 git 切分支） | 2.3 |
| 186 | 反馈0220#07：悬停浮层名称行高亮左侧拓扑、点节点/线跳转会话；命中区加大 | 2.4 |
| 187 | 反馈0220#06：没有分叉/子代理的会话不弹悬停拓扑卡片；树里有分支才弹 | 2.4 |
| 188 | 反馈0220#06：进入反馈模式后悬停拓扑卡片停住不消失（共享层） | 2.4 |
| 189 | 反馈0220#01：外部会话的会话图节点点击能定位该轮 | 2.3 |
| 190 | 反馈2156#01：会话图跳转只定位，目标消息没有高亮背景 | 2.3 |
| 191 | 反馈2156#03：正在输出的轮次节点有与侧栏一致的呼吸动画 | 2.3 |
| 192 | 反馈1110：会话图悬停的节点额外放大加外圈，同线其他节点不变 | 2.3 |
| 193 | 反馈1110：会话图所有运行中的会话都在最新轮显示运行动画 | 2.3 |
| 194 | 反馈1603#05：会话图悬停只高亮被悬停的那一行标题 | 2.3 |
| 195 | 反馈1603#07：等待输入的会话最新轮有等待标记，运行中/子代理仍有呼吸动画 | 2.3 |
| 196 | 反馈1603#08：分叉/主会话切换后子代理会话每次都能加载 | 2.5 |
| 197 | 会话图泳道线 tooltip 以指针定位并完整显示在视口内（反馈1926#10） | 2.3 |
| 198 | 侧栏分叉并入原会话行、悬停拓扑图、右栏切分支 | 2.1 |
| 199 | 体验清单「有问题」进入反馈并带功能标签，导出与解包按功能分组 | 10.5 |
| 200 | 反馈草稿实时保存：刷新后条目与截图恢复，可手动删除草稿 | 10.1 |
| 201 | 调整工具：冻结副本改尺寸吸附 token、换图标/备注/删除/插入/平移并导出 adjust.md | 10.2 |
| 202 | 调整说明：同元素连续改尺寸/移动合并为一条、选择器跳过 Radix/React 自动 id | 10.2 |
| 203 | 调整模式浮层互不遮挡：面板/预览/选中条/改动清单/提示（1440×900 与 390×844） | 10.2 |
| 204 | 反馈截图：长会话点选/框选/整页不卡且内容非空（R48） | 10.1 |
| 205 | 工作站：跨主机 ADB/串口挂载、审批与终端 | 6.7 |
| 206 | 工作站：主机没装 adb 时显示说明而不报错 | 6.7 |
| 207 | 工作站：设备单行密度、板载串口折叠、无权限修复说明 | 6.7 |
| 208 | 演示设备：演示工作区提供可挂载的安卓/串口设备 | 6.7 |
| 209 | 调试版手机预览：弹窗按移动布局渲染并可打开侧栏抽屉（B） | 10.6 |
| 210 | 登录门：未登录先登录、无主机空状态、添加这台电脑后可开会话 | 6.1 |
| 211 | 主机管理：唯一主机列表与详情抽屉、唯一添加入口、工作站页仅管理员 | 6.2 |
| 212 | 登录门：调试版自动登录带演示主机，一行命令添加主机后显示已连接 | 6.1 |
| 213 | 登录门：工作站重启后本机与演示主机仍在线、能开会话 | 6.1 |
| 214 | 登录门：调试版不带 token 打开回环地址自动进入，且不循环请求 401 | 6.1 |
| 215 | 反馈1323#04：侧栏底部一行账号 + 齿轮，账号菜单只放账号与工作站设置 | 8.1 |
| 216 | 反馈1323#01：新功能提示条 30 秒未点开自动收起，本版本不再弹 | 8.11 |
| 217 | 反馈1323#02：分组只显示一个 Key，无拖动/故障切换/轮询/添加 Key | 4.6 |
| 218 | 反馈1323#03：路由提示行可展开看本轮注入，未注入时说明 | 4.4 |
| 219 | 工作站客户端-服务（注册/添加主机/授权/E2E 流式） | 6.4 |
| 220 | 远端执行器：一行命令安装、主机在线、远端会话写入并读回文件 | 6.5 |

## 6. 一句话结论（事实层面）

1. 现有功能实际是 **10 个领域 / 95 项**，而 `docs/features` 只覆盖约一半，`lib/features.ts` 的 42 项清单只用于反馈归类——三者口径互不对应。
2. 108 条用户决定与 220 条回归用例里，**90 条决定/203 条用例能落到单一功能**，其余 18 条决定 + 17 条用例落在"共享 UI 原语"这一跨功能层；没有完全无主的条目。
3. 最大的结构性问题是 **6 个核心模型各有多份实现**（会话树、轮、运行状态、滚动位置、模型能力、价格），近两周返工几乎都发生在这些模型上。
4. 最该先定"功能是什么"的是 **D5 执行与权限（16 项里 14 项无文档）、D8 导航与协作（11 项里 9 项无文档）、D9 设置与外观（7 项全无功能文档）**：它们不是没做，而是没有一句话目标与测试归属，改动时无法判断"改的是哪个功能"。
5. 重叠多数是"同一件事的多套入口/表达"（会话结构、登录、模型选择、成本、只读会话），不是重复实现业务逻辑；历史重复（跨主机派单、仅规划、旧成员/旧主机列表）已经在 11 月收敛掉。
