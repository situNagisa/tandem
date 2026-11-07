# 进度

## 2026-11-05 迭代 1（M1）
- [x] monorepo + 协议定义（packages/protocol）
- [x] server M1（a68f820）
- [x] web M1（12c04a5）
- [x] 竞品调研 docs/research.md
- [x] 集成冒烟：host 托管 web、REST 正常
- [ ] 真实 key 端到端（待用户体验）

## 已知缺口（下一迭代候选，按 research.md P0）
- 断线事件重放（seq 号）、检查点回退、diff 按文件审阅/批量提交、git worktree
- 会话重命名、长列表虚拟化、图片压缩
- 手机推送、HTTPS（PWA 需要）、配对扫码
- Bash 后台运行；权限规则 allow/ask/deny 配置化

## 迭代 2（进行中）
- [x] web v2 视觉与交互精修（design.md 设计规范、侧栏按项目分组+会话管理、添加账号自动拉模型、新会话页、无 Host 引导页）
- [x] server v2：/api/models、会话 env/置顶/归档/fork、自动标题
- [x] Android APK（Capacitor，npm run apk -w @tandem/mobile）
- [x] 用户体验 v2

## 迭代 3（2026-11-06）
- [x] 视觉：去彩色徽章、对比度 AA、可点 affordance、全局过渡动画、右栏紧凑
- [x] bug：粘贴图片重复（items+files 重复计入）、侧栏收起残留（外层未裁剪）
- [x] 账号分组；导入 Claude Code/Codex 会话（只读+复制继续）；配置加密导出/导入
- [x] 内部评审 docs/review-v3.md（P1 6 条全修，P2 18 条修 4）
- [x] （用户：继续迭代，差不多再体验）

## 迭代 4（2026-11-06）
- [x] server：seq 断线重放、检查点回退、git 改动审阅、权限规则、/cost、空闲超时、标题时机
- [x] web：审阅面板/行内评论/提交、回退对话框、权限规则页、重连条、消息操作、草稿、粘贴折叠、通知、快捷键、长会话性能
- [x] 真实模型 e2e（docs/e2e-report.md）：修复工具乱序、悬空 tool_calls
- [x] 内部评审 v4（docs/review-v4.md）：P1 10 条全修，P2 修 13，遗留 3

## 迭代 5（2026-11-06）
- [x] server：MCP、子代理 Task、worktree 会话、用量统计、配对
- [x] 桌面端 Electron（Windows NSIS 安装包、托盘、内置 Host）——未在 Windows 实机启动验证
- [x] web：上述功能界面 + 扫码配对 + 桌面标题栏适配
- [x] 内部评审 v5（docs/review-v5.md）：P1 6 全修，P2 21 修 17
- [x] 用户体验 v5

## 迭代 6（2026-11-06）——主题：质量优先，先修 bug 和配色，不加新功能
- 协调者亲自用 Playwright 点击验收用户每条反馈；新增 E（外部会话注入标签清理、侧栏折叠、错误色）、F（错误重复展示、Toast）、server 错误文案可读化
- [x] A 配色按 Claude Code Desktop 取色重做、去红绿；侧栏三层层级重构；Popover 越界；去重复入口
- [x] B 对话区卡顿定位；思考过程显示/折叠/隐藏；工具默认折叠；轮次导航条
- [x] C 外部会话直接在侧栏只读打开、导入后才能发消息；分组独立协议类型
- [x] D 新会话页按钮无反应；设置窗口尺寸固定；全应用 bug 扫雷
- 下一步候选：Windows 实机验证桌面端；Anthropic provider 真实 key 测试；中继服务（NAT 穿透、不在同一局域网也能连）；hooks；计划模式面板；PR 集成；定时任务
- 遗留：深色行内代码/diff 对比、移动端 diff 横滑提示、顶栏控件偏多、账号卡缩进

## 用户反馈记录
- 2026-11-06 v5：bug 多不好用；导入应直接在侧栏只读显示；新会话按钮无反应；会话卡顿；要隐藏思考、轮次导航；分组要独立协议；工具默认折叠；红绿配色廉价（给了 CCD 截图）；Host 弹层被遮；设置窗口尺寸跳；侧栏层级平淡；重复入口多。
- 2026-11-06 v2：彩色徽章廉价；侧栏收起 bug；字看不清/不像按钮；缺过渡动画；右栏太大；粘贴图片重复；换电脑要重配、想读 Claude/Codex 会话；账号要支持多分组；建议内部互评。
- 2026-11-05 v1：整体不够精致（布局/流程/动画/配色僵硬）；添加 Key 后模型要手填；侧栏不能管理会话、不能按环境归类；想要 APK。

## 迭代 7–9（2026-11-06）
- 协作方式：自主连续迭代；UI 用打分卡（docs/scorecard-v7、v8）让用户选方案，结论记在 design.md 末尾
- [x] 会话内文件链接 → 文件预览面板（行号定位、MD 预览、本机打开）
- [x] 中继服务 packages/relay（E2E 加密、hostId 公钥绑定）+ 客户端接入 + Docker/Caddy 一键部署（未在公网实测）
- [x] Hooks（兼容 Claude 配置）、计划模式 ExitPlanMode 面板
- [x] 按钮/控件体系（ui/*，主按钮白底黑字）；scorecard-v7 九项与 v8 十项全部落地并亲自验收
- [x] 手机端发送按钮出屏 P0；README（构建/打包说明）
- 待：中继公网部署（需用户提供服务器/域名）；Anthropic 真实 key 测试；Windows 实机验证桌面端

## 迭代 10–11（2026-11-06 ~ 11-07）
- [x] 侧栏醒目化、筛选/主机移到"会话"行、外部会话灰字、tooltip Portal
- [x] 外部会话：标题/注入清理（105 个 0 注入），只读页与普通会话一致；Codex .zst 与索引标题
- [x] 统一紧凑 MenuList；模型选择器 账号›分组 Tab + 按模型能力的思考强度；服务端 effort 映射与降级
- [x] 输入框上方环境条（主机/文件夹/分支/Worktree，可中途切换，跨 Host 迁移）
- [x] 轮次条移到滚动条左侧并放大；diff 照 Claude Code 配色；设置窗口 1120×760；Hook 出错内联
- [x] 上下文环 + /context 分段面板、缓存命中率、每条消息与会话花费
- [x] 子/孙代理：侧栏隐藏、会话内层级树、代理卡、审批来源
- 待复验：轮次条新位置、审阅 diff 新配色、设置大窗口

## 迭代 12（2026-11-07）全局文字提亮
- [x] 深色 --t-text #EFEFEF→#F5F5F5、secondary #B9B9B9→#D2D2D2、tertiary #8A8A8A→#A3A3A3；浅色 #111/#3F3F3F/#5C5C5C；hairline/strong 与选中态同步提对比
- [x] 字号批量：正文/控件 13px、辅助 12px、kbd/徽标 11px；设置页正文 13；344 处 class + 153 处设置页 + CSS 规则
- [x] docs/design.md 新增「字号与对比度」，标注新旧值；2588/1280 深/浅截图自查
- 说明：Sidebar/ToolCard/EnvBar/Menu/TurnRail/FeedbackMode 由并行同事负责，未覆盖其未提交改动

## 迭代 12（2026-11-07）——反馈模式驱动
- [x] 反馈模式 v1：圈选导出 json → 飞书 → scripts/feedback-unpack.mjs；修复点击穿透、快捷键/选中导致弹层消失、hover 冻结
- [x] 反馈包 #1（7 条）、#2（8 条）、#3（5 条）全部处理
- [x] 轮次条重新设计：刻度 → 轮次大纲形变面板（弹簧动画、拖动预览、边缘加速、手机底部抽屉）
- [x] Tooltip 重做为标准行为（500ms 延迟、跳过延迟、小号无箭头）
- [x] 全局提亮文字 token、字号下限（正文≥13、辅助≥12，375 处）
- [x] 真实模型 e2e v2（docs/e2e-report-v2.md）：codex 分组全通过，修 6 个 bug；claude 分组被中转限制为仅 Claude Code 客户端，未能真测
- [x] 交互走查 v6（docs/qa-v6.md）；AGENTS.md 项目手册

## 迭代 13（2026-11-07）后台任务 + 定时任务
- [x] Bash `run_in_background` + `BashOutput` / `KillBash`（Claude Code 同名同参）；Host 内 BackgroundTaskManager：1MB 环形缓冲 + ~/.tandem/tasks/<id>.log，REST `/api/tasks`，WS `task_updated` 节流；重启后运行中标记 lost、已结束保留
- [x] Host 内 cron 调度（5 段，测试可 6 段带秒）：~/.tandem/schedules.json、新建/追加会话、账号/分组/模型/effort/权限、catchUp、`/api/schedules` CRUD + 立即运行；会话带 scheduledBy，侧栏小时钟
- [x] web：顶栏后台任务面板（实时输出/跟随/终止）、Bash 卡「后台运行 · 查看输出」、设置「定时任务」页（预设 cron/下次时间/最近结果）、`/schedule` 打开新建表单
- 验证：本地 8111 实测 BashOutput 取到 sleep 输出、KillBash 终止长任务、10 秒 cron 触发建会话；Playwright 截图与点击（面板、设置、立即运行、开关、/schedule）

## 迭代 13（2026-11-07）
- [x] 反馈包 #4（28 条）全部处理，分 4 路（选择器/会话页/设置页/审阅与文件）
- [x] 新功能（来自 docs/explore-v1.md）：同组多 Key 故障切换/轮询 + 预算提醒/阻止；后台任务（run_in_background、BashOutput、KillBash、面板）；定时任务（cron、设置页、/schedule）
- [x] 会话分叉（按消息）、轮次固定、文件浏览器、overlay 滚动条、Hook/Bash 输出 GBK 回退解码
- 约束更新：开发环境禁止公网部署/暴露；需公网验证时写步骤请用户代测
- 待用户在 Windows 实机确认：D:\ 路径文件预览/在本机打开、未跟踪文件 diff、子目录 cwd 的 diff、Hook 中文输出
- 下一批候选：局域网手机审批台（本地通知）、skills 兼容、PR/CI 集成

## 迭代 13（2026-11-07）UI 原语收口
- [x] ui/Menu 改为 @radix-ui/react-dropdown-menu 唯一实现：Item/CheckItem/RadioItem/Separator/Label/Sub，键盘、Portal、碰撞避让、disabledReason→Tooltip、26px 行统一
- [x] ui/ListRow + 统一 Select（原生 option 写法也走 Menu）、菜单/Popover 表面样式只留在 ui/
- [x] 全量迁移：输入框权限/思考/更多/模型、补全行、环境条主机/分支/Worktree、侧栏筛选/主机/会话 ⋯、右栏自定义、审阅 ⋯、消息操作、设置全部下拉
- [x] 模型选择器按参考图重做：模型列表 → 思考强度子菜单 / 切换账号→分组级联子菜单；选中分组主列表即时切换；按钮文字「模型短名 + 强度」
- [x] `#/dev/ui` 组件画廊（设置-外观底部入口），展示原语全部状态，支持反馈模式圈选
- [x] `scripts/ui-audit.mjs` 防回退检查：ui/ 外 role=menu/listbox、popover-panel、硬编码菜单行高、原生 select；当前 0 问题
- 截图：/tmp/ui-lib/{gallery,model-main,model-effort,model-account-group}.png

## 迭代 14（2026-11-07）局域网手机审批台
- [x] 协议/服务端：`subscribe_inbox` 全局订阅（Host 内单调 seq + 400 条环形缓冲 + 未处理审批表）；摘要事件覆盖 permission_request / permission_resolved / turn_end(error) / budget / ExitPlanMode 计划审批，`inbox_snapshot` 冷启动与断线补齐；子代理审批只记一条并带来源标题
- [x] 客户端：收件箱 store、多 Host 汇总；侧栏顶部收件箱图标 + 未读数徽标、收件箱弹层（允许/拒绝/打开会话，手机全屏）；手机首页「新会话 / 收件箱」Tab，打开 App 有待审批时直接落在收件箱；审批一次点击即可完成
- [x] 通知：浏览器沿用 Notification；安卓 `@capacitor/local-notifications` 纯本地通知，审批带「允许 / 拒绝」action types，点击打开会话；设置「通知」页（桌面通知 / App 本地通知 / 后台保持连接 / 事件类型开关）
- [x] 后台保持：`@capawesome-team/capacitor-android-foreground-service` 前台服务（dataSync，常驻通知「Tandem 正在保持连接」），默认关闭、设置内说明耗电；回前台 `checkAlive` + inbox/session sinceSeq 重放补拉
- [x] 修复既有 bug：`permission_request` 缺顶层 sessionId 导致客户端 seq 出现空洞，后续 `permission_resolved` 被永久暂存、跨端审批卡不消失
- 验证：TANDEM_HOME=/tmp/tandem-inbox:8133；Playwright 1440×900 + 390×844 双页，手机收件箱允许后桌面审批卡消失、服务端 pending 归零、手机收件箱转「已允许」；回合完成入列表；设置通知页可开合；`npm run apk` 打包成功
- 待真机确认：APK 安装、同局域网连接、锁屏/后台通知与操作按钮、前台服务耗电

## 迭代 15（2026-11-07）PR / CI 集成
- [x] 协议：VcsCapability / PullRequestInfo / PrCheck / VcsState、创建/合并/修复 REST、WS `vcs_updated`、收件箱 `ci` 事件
- [x] Host：`vcs.ts` 仅用本机 git + `gh`/`glab`（execFile 参数数组，不保存令牌）；能力检测（仓库/分支/上游/ahead-behind/托管类型/CLI 安装与登录）、创建 PR 前 `git push -u origin HEAD`、合并（squash/merge/rebase）、`gh run view <id> --log-failed` 截断后作为用户消息发当前会话；每 60s 轮询有 PR 且被订阅的会话，变化广播并写收件箱
- [x] Web：顶栏 PR 按钮（#号 + 开放/草稿/已合并/CI 失败状态点），PR 面板（状态、检查列表/耗时/链接、打开、合并二次确认、失败检查「让 agent 修复」、未安装/未登录 gh/glab 指引），创建表单与「让 agent 起草」，审阅面板 ⋯「提交并创建 PR」（预填标题）
- 验证：/tmp 假 gh + 本地 bare 仓库 + TANDEM_HOME=/tmp/tandem-pr:8141；Playwright 点击完成创建 PR、CI 失败展示、让 agent 修复消息、合并；截图 /tmp/pr-shots/
- 待产品所有者按 docs/pr-ci-test.md 在 Windows 实机用真实 GitHub 代测

## 迭代 16（2026-11-07）项目记忆
- [x] 存储：`~/.tandem/memory/<sha1(项目根)[:16]>.md`（首行元数据记录项目路径与名称）+ `_global.md`；git 仓库根或 cwd 为键；与仓库内只读注入的 AGENTS.md / CLAUDE.md 明确区分
- [x] 工具 `Memory {action: view|add|replace|remove, text?, old?, scope?}`：只记长期项目事实/约定/偏好；默认权限下按 Edit 类审批，acceptEdits 自动；系统提示注入全局 + 项目记忆（每段 6000 字截断提示），无记忆时提示模型可记录
- [x] 用户入口：`#记住 …` 直接追加并回执；`/memory` 客户端打开编辑器、其它客户端显示当前内容；`/compact` 同一调用额外产出「项目记忆」事实并写入（无额外请求）
- [x] 迁移：配置包载荷携带全部记忆（解密后 merge 追加，标注来源 Host）；跨 Host 迁移会话时客户端附带源项目记忆，目标已有则 `<!-- 来自 <Host> -->` 合并
- [x] REST：GET/PUT/DELETE `/api/memory`、GET `/api/memory/list`、POST `/api/memory/import`；协议 MemoryScope/MemoryFile/MemoryListItem
- [x] Web：右侧「记忆」卡片（前 3 条 + 条数，纳入拖拽排序/显隐）、Markdown 编辑对话框（左编辑右预览、全局入口）、设置「记忆」页（Host 切换、项目名/路径 tooltip/大小/最后修改、编辑/删除）、Memory 工具卡「记住 · 摘要」
- 验证：TANDEM_HOME=/tmp/tandem-mem:8151；Memory 工具 add/replace/remove/view 文件变化、系统提示含记忆段、`#记住` 回执、编辑器保存落盘、配置包导入第二 Host（memoriesImported=1）、`/memory` 两路径；截图 /tmp/mem-shots/{right-panel,editor,editor-global,settings-memory,slash-memory}.png
- 备注：并行处理中顺手修复 `profileModelGroups({})` 空账号崩溃（派单弹层导致整页白屏）与 `Switch.label` 改为可选（子代理页构建错误）

## 迭代 17（2026-11-07）常驻会话 / 断点续跑
- [x] runState 持久化：会话 running 时写当前轮用户消息 id、已完成消息、排队消息、进行中工具、待审批请求与权限模式；模型响应/工具结果后 `store.saveNow()` 原子写 + fsync（版本号防止旧异步写覆盖新快照）
- [x] 启动恢复：扫描有 runState 的会话；只读工具重放，有副作用工具补 isError「Host 重启，此工具调用未确认是否完成」；tool_result/用户消息直接续跑；等待审批用原 requestId 恢复并重新广播 + 进收件箱；会话插入 notice「Host 重启后已恢复运行」
- [x] 恢复策略：`config.json` 的 `resumeOnRestart: auto|pause`（设置-通用可切换，默认自动）；pause 时会话显示「重启后已暂停」，POST `/api/sessions/:id/resume` 继续
- [x] 网络断线续跑：provider 网络错误/超时（含已有重试）全部失败后进入 `retrying`，指数退避 2s→2min、总计 30min；`SessionSummary.retryInfo {attempt,nextAt,lastError}`；重试前清空该 assistant 流式内容避免重复，已执行工具不重放；WS `retry_now` 立即重试，`interrupt` 停止
- [x] Web：顶栏 retrying 胶囊（网络中断，X 秒后重试 · 立即重试 · 停止）、重启暂停「继续运行」；设置新增「通用」页
- [x] 后台任务 lost 提示：重启后在该会话插入 notice，模型可决定是否重跑
- 验证：本地 mock OpenAI SSE（第 N 次请求断流）+ TANDEM_HOME=/tmp/tandem-resume:8161；A 工具执行中 kill -9 → 补 isError 并继续完成；B 流式中断 3 次 → retrying → 最终完整回复无重复；C 等待审批时重启 → 快照/收件箱恢复审批，允许后完成；`npm run build -w @tandem/server`、`web`、`ui-audit` 通过

## 迭代 18（2026-11-07）跨模型子代理 + 手机派单 + 委派策略
- [x] 子代理预设：`~/.tandem/subagent-presets.json`；Task 的 `subagent_type` 可用预设名，支持账号/分组/模型/effort/权限/工具白名单/附加提示/自身委派策略；只读兼容 `~/.claude/agents/*.md` 与项目 `.claude/agents/*.md`（name/description/tools/model，sonnet/opus/haiku 映射到用户模型）；Task 增加可选 `model`；工具说明与系统提示列出预设
- [x] 子代理模型可见：Task 卡片（折叠/展开）、右侧代理树显示实际模型；用量按子代理模型单价计费，右侧用量卡单列「子代理（n）」小计与按模型拆分，并给合计
- [x] 委派策略（会话级）：`orchestrate|more|less|none`，新会话默认在设置-子代理；环境条可切换；服务端决定 Task 是否提供、编排模式主会话工具收窄、注入对应策略提示词；子代理预设可覆盖（如探索强制不派孙代理）
- [x] 提示词模板：`~/.tandem/prompts.json`（{values:{taskDescription,delegationOrchestrate,delegationMore,delegationLess,delegationNone,subagentDefault}}），空值跟随内置默认，支持 {{presets}}/{{cwd}}/{{delegation}}；后续并入全局提示词注册表
- [x] 手机派单：新会话页/顶栏/侧栏/手机首页「收件箱」旁「派单」入口；选 Host（在线/离线）、项目（最近+浏览）、账号/模型（该 Host 上次使用）、权限、任务 → 目标 Host 建会话并运行，停留在原页 Toast「已派单到 <Host> · 查看」；收件箱照常收到审批/完成事件
- 验证：两个 Host（/tmp/tandem-xa:8171、/tmp/tandem-xb:8172）+ 本地 mock OpenAI SSE；主模型 strong-model → Task 探索预设 → 子代理请求 model=cheap-model 且工具白名单 Read/Glob/Grep；Claude agent 文件 sonnet → claude-sonnet-4-5；四档 tools 与系统提示（mock 日志 strategy/定制标记）不同；Playwright 390×844 向 B 派单成功、停留首页、Toast 查看跳转、收件箱出现回合完成；截图 /tmp/xagent-shots/
