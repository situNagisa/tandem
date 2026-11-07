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

## 迭代 19（2026-11-07）反馈模式 v2
- [x] 框选区域：浮条切换「点选 / 框选」，拖拽任意矩形（跨元素）截图；区域截图按页面坐标裁切，条目标记为框选
- [x] 截图标注：Canvas 编辑器（矩形/箭头/画笔/文字/马赛克，橙白红三色，撤销重做）；导出保留原图与标注图
- [x] 参考图：编辑浮窗内 Ctrl+V 粘贴 / 拖入 / 选择图片（≤6 张），条目抽屉显示缩略图，随反馈导出
- [x] 操作轨迹：内存环形缓冲 200 条（点击选择器+可见文本、功能键与快捷键、路由、WS 断连/重连、toast、前端错误），每条附带反馈前 60 秒；不记录输入文字；可选 getDisplayMedia 本地录屏（≤60s、≤8MB）附加到下一条
- [x] 状态快照：路由、会话摘要（id/标题/状态/模型/消息数，可选最近 5 条正文）、UI 偏好、视口、主题、Host 平台版本；白名单采集，绝不含 key/token/配置内容；本地路径默认保留，抽屉可开「隐藏路径」
- [x] 条目抽屉：缩略图、类型、P0/P1/P2、文字、参考图缩略；编辑/删除/拖拽排序/页面定位高亮
- [x] 回执复验闭环：导入 `tandem-feedback-receipt-*.json`、状态与说明、前/后对比滑块；顺序跳转路由+选择器高亮，逐条「通过 / 仍有问题（备注）」，导出 kind=verification 的复验文件
- [x] 脚本：`feedback-unpack.mjs` 支持标注/参考/轨迹/录屏/快照独立文件并在 feedback.md 引用；新增 `feedback-receipt.mjs`（Markdown/JSON 草稿 → 回执）；README 反馈小节更新
- 验证：TANDEM_HOME=/tmp/tandem-fb2v（8191 被占用，改用 8193）+ Vite 5179；Playwright：进入反馈模式 → 点选 + 框选 → Canvas 画框标注 → 剪贴板事件粘贴参考图 → 导出（捕获下载）→ 解包 2 条/8 附件 → 生成并导入回执 → 复验 2 条（通过/仍有问题）→ 导出复验结果 → 退出；截图 /tmp/fbv2-shots/；`npm run build -w @tandem/web`、`ui-audit` 通过

## 迭代 20（2026-11-07）工程治理：架构地图 + 回归测试骨架 + 巨石拆分
- [x] `docs/architecture.md`（167 行）：目录/模块职责、REST/WS/agent 数据流、10 条关键约定、“改 X 去哪里”速查、巨石状态
- [x] 回归测试：server 38 条（node:test + tsx：Windows 路径、外部会话注入/标题、changes 路径与未跟踪目录、多 Key/冷却、预算、GBK 回退、cron）；web 32 条（vitest：fileLinks、模型分组/友好名、格式化、轮次窗口、补全识别）
- [x] `e2e/smoke.mjs`：临时 HOME/TANDEM_HOME + 随机端口 + 本机假 OpenAI 端点；新建会话 → 流式回复 → Bash 审批 → 设置 16 页无 console error；通过（provider 3 请求）
- [x] `scripts/check.mjs`：build → ui-audit → test → smoke 汇总；AGENTS 增加提交前检查（子代理 `--skip-smoke`）
- [x] 纯搬移拆分：MessageList 1073→333（chat/UserMessage、AssistantMessage、MessageNotes）；ProfilesSection 1782→991（settings/profiles/*）；Composer 1603→1021（components/composer/* + lib/modelName）；RightPanel 1172→881（right-panel/*）
- 未拆：`host.ts`、`server.ts`（工作期间持续有他人未提交改动）；`useAppStore.ts` 待协调 slice 拆分，避免与并发状态改动冲突
- 验证：`node scripts/check.mjs` 全量通过（build 8.4s、ui-audit、70 条单测、smoke 23.5s）；每次拆分单独提交，提交信息 `refactor: 拆分 X（纯搬移）`

## 迭代 21（2026-11-07）语音输入（本机 Whisper / 设备识别）
- [x] 协议：`VoiceSettings`（engine/binaryPath/modelPath/language）、`HostSettings.voice`、`SttCapabilities/SttInput/SttResult/SttTestResult`
- [x] Host：新文件 `server/src/stt.ts`，GET `/api/stt/capabilities`、POST `/api/stt`、POST `/api/stt/test`；自动探测 PATH 上的 whisper-cli/whisper-cpp/faster-whisper，不下载模型；whisper.cpp 用 `-otxt`，faster-whisper 用 python 模块；临时目录 `tandem-stt-*` 在 finally 立即删除；非 16k WAV 有 ffmpeg 才兜底转码
- [x] Web：`VoiceButton` 按住说话/点击持续录音、波形+计时、Esc 取消、转写中加载、结果插入 Composer 光标处不自动发送、Ctrl+Shift+Space 按住；`Composer` 底栏最小接入
- [x] 设备识别：安卓 `@capacitor-community/speech-recognition`（系统语音服务，提示离线语音包）；浏览器 Web Speech 默认禁用，设置中显式勾选才启用
- [x] 设置新增「语音」页：识别方式偏好、Host Whisper 路径/语言/保存/测试、自动探测填入、whisper.cpp/faster-whisper 准备说明、数据流向与隐私说明
- [x] 审批卡新增「拒绝并说明」：文字/语音填写原因，`decidePermission(deny, reason)` 作为工具结果返回 agent
- 验证：TANDEM_HOME=/tmp/tandem-voice:8202 + 假 whisper 脚本；Playwright 假麦克风按住录制→上传→转写→插入、点击持续录音、Ctrl+Shift+Space、Esc 取消、设置页测试通过；审批卡语音填原因并拒绝，mock provider 收到原因文本；截图 /tmp/voice-shots/；`npm run apk -w @tandem/mobile` 成功
- 备注：语音识别全部走用户自己的 Host 或设备系统能力，不接云端；Tandem 不自动下载模型

## 迭代 22（2026-11-07）轨迹回放与评测集
- [x] 协议：`EvalCase/EvalSnapshot/EvalConfig/EvalRun/EvalResult` 等；REST `/api/evals/{suites,cases,runs}`；`InboxEventKind` 增加 `eval`；WS `eval_run_updated`；提示词注册表新增 `evalReview`
- [x] 存用例：会话 ⋯「存为评测用例」从任一用户消息截取初始输入；git 仓库记录仓库路径 + commit（运行时临时 worktree 检出，未提交改动不包含），非 git 目录复制快照（跳过 .git/符号链接，50MB 上限）；可选通过标准与自动检查命令
- [x] 运行：设置「评测」页选用例集 + 多个配置（账号/分组/模型/思考强度/委派策略/提示词覆盖）+ 可选评审模型 + 并发数；每个 用例×配置 在独立临时目录以 bypassPermissions 运行（运行前明确警告），记录完成状态、检查命令、轮数、工具数、token、花费、耗时、最终回答与完整轨迹；支持后台运行/取消/重启中断标记
- [x] 对比：表格行=用例、列=配置，单元格显示通过/失败、花费、耗时；点开完整轨迹（复用 MessageList 只读），两个配置并排对比；导出 Markdown；运行进度在收件箱（eval 事件）与右上角后台任务面板（含取消）可见；评测内部会话不出现在侧栏、不产生回合完成通知
- 验证：TANDEM_HOME=/tmp/tandem-evals:8231 + 本地 mock OpenAI SSE（writer 写 done.txt / lazy 不写）；git 用例检查 `test -f done.txt`，两配置结果一过一失败；Playwright 覆盖结果表、轨迹、并排对比、提示词覆盖、UI 启动、导出、存用例、评审模型、非 git 目录快照、后台面板/收件箱进度与取消；截图 /tmp/evals-shots/；`node scripts/check.mjs` 全量通过

## 迭代 23（2026-11-07）回归走查与自动化防线
- [x] `docs/regression-checklist.md`：整理 qa-v6 / bugs-v6 / review-v4/v5/v7a/b/c 中「已修」P0/P1 共 40 条（现象 + 复现步骤 + 对应用例）
- [x] `e2e/regression.mjs`：临时 Host（`TANDEM_HOME=/tmp/tandem-reg-<随机>`、随机端口）+ 假 OpenAI 端点 + 种子仓库/账号/40 轮会话/重试/用量/权限/MCP/记忆；桌面 2552×1274、手机 390×844，38 条断言（弹层越界、点了没反应、设置窗口、轮次条定位、粘贴图片、反馈模式穿透、模型级联、环境条透明、Windows 路径链接、未跟踪目录展开等）
- [x] `scripts/check.mjs` 第 5 步接入 `npm run regression`，支持 `--skip-regression`
- [x] 回归发现并修复：同步「替换导入」缺少二次确认与危险色（review-v4 #8/#23 复发）；Host 只回环时「连接手机」仍渲染二维码/链接（review-v5 #2 复发）；模型菜单三级子菜单在 React 19 下不挂载（SubTrigger open 但 SubContent 为空）→ 分组平铺为二级级联
- 验证：`node scripts/check.mjs` 全量通过（含 regression 38/38）

## 迭代 24（2026-11-07）手机端专项走查
- [x] `docs/review-mobile.md`：Pixel 7（412×915）与 360×780、深/浅色逐页真实触摸走查；首页/收件箱、侧栏抽屉滑动、会话（长按/工具/预览/改动/审批）、输入框更多与模型菜单、环境条、派单、设置、反馈模式
- [x] P0：手机顶栏标题被 6–7 个图标挤到 10px、待审批胶囊与图标重叠 → 顶栏改两行（标题+状态 / 轮次胶囊+工具图标）；360px 输入框卡片横向溢出 18px → 手机隐藏上下文环、模型按钮 36vw
- [x] P1：菜单项/列表行/图标按钮补 44px（菜单、侧栏、改动审阅、设置、代码复制、预览、文件行）；审批卡按钮手机改 2×2 网格；11/11.5px 文本统一 12px（徽标 11、图表刻度 11）；用户消息 480ms 长按打开操作菜单（抬手后弹出，防误触）；文件预览行号槽 44→30px
- [x] 回归：`e2e/regression.mjs` 新增 360×780 context 与 7 条手机用例（顶栏/输入框、菜单、审批、长按、侧栏、设置、文件预览），并新增 Host 启动即恢复的待审批种子会话
- 验证：`node scripts/check.mjs` 全量通过（build / ui-audit / test / smoke / regression 45/45）；`npm run apk -w @tandem/mobile` 成功

## 迭代 25（2026-11-07）内网团队共享 v1
- [x] 协议：`TeamRole/MemberRole/TeamMember/TeamInvite/TeamAuditEntry/TeamIdentity/TeamPresence`；`PermissionRequest.assignedTo/transferredFrom`；WS `presence`、`permission_transferred`、`team_updated`；邀请接受公开接口
- [x] Host：`server/src/team/{store,access,audit}.ts` + `routes/team.ts`；成员 token / 邀请码只存 SHA-256；24h 一次性邀请；成员角色与 `projectDirs` 授权；吊销立即断开 WS；角色/目录变更强制重连
- [x] 鉴权：全局 `onRequest` 解析所有者/成员身份，成员 REST 默认拒绝白名单放行；会话列表与单会话读取按项目目录过滤（未授权 404）；fs 读写/补全限制在授权目录；账号列表对成员清空 Key 掩码；设置/Key/配置/Hooks/MCP/权限规则等仅所有者
- [x] WS：订阅/发送/中断/重试/审批逐条检查角色与项目；审批事件只推给有审批权连接；收件箱同样过滤；`presence` 显示同会话在线成员；审批「转给…」选择在线审批者，目标收件箱标注「由 X 转交」，仅目标与所有者可处理
- [x] 审计：邀请/成员/新建会话/发消息/审批/转交，最近 200 条，设置-成员页查看
- [x] Web：设置「成员」页（角色/项目目录/邀请链接+二维码/成员编辑与吊销/邀请记录/审计）；邀请链接深链入职工弹层；会话顶部在线头像；成员只读时隐藏新建/派单/Composer，设置页只保留客户端项
- [x] `docs/team.md`：角色矩阵、邀请与 token 处理、REST/WS 边界、威胁模型、可信内网限制
- 验证：`TANDEM_HOME=/tmp/tandem-team`、端口 8252；REST 邀请/接受 + 观察者/审批者/协作者边界（观察者发消息被拒、协作者读 Key 接口 403、未授权项目会话 404）；WS 双连接审批请求过滤、转交、审批者收件箱与跨页处理；Playwright 双页面 + 邀请链接入职；截图 `/tmp/team-shots/`
- 备注：v1 无 TLS，仅可信内网/VPN；不接第三方账号与推送；成员读账号列表只保留模型信息

## 迭代 14–21（2026-11-07 下午）
- [x] 功能：手机审批台/收件箱（本地通知）、Skills 兼容、PR/CI（gh/glab）、跨模型子代理 + 委派策略四档、手机派单、项目记忆、提示词注册表与注入展示、断点续跑、反馈模式 v2（框选/标注/回执复验）、内网只读分享、本地语音输入、浏览器操作（本机 Playwright，域名分级授权）、评测集、内网团队共享（角色/邀请/转交/审计）
- [x] 工程治理：architecture.md；server.ts/host.ts/useAppStore 拆分；70 条单测 + smoke + 45 条回归，接入 scripts/check.mjs
- [x] 评审：v7a/b/c、手机专项、回归走查；真实模型 e2e v3 十场景通过
- 待用户实机验证：手机审批（docs 见上轮步骤）、PR/CI（docs/pr-ci-test.md）、Windows 路径/编码
- 下一批候选：自建 Key 网关、iOS 适配评估、性能（大仓库/长会话）专项、无障碍

## 迭代 26（2026-11-07）性能专项 v1
- [x] `docs/perf-v1.md`：大仓库（6 万文件）/ 1000 轮长会话 / 200+3000 多会话 / 10 路并发四组夹具与前后数据；脚本 `scripts/perf-{setup,host,store,v1,ui-focus}.mjs`
- [x] 会话存储改追加写：`<id>.json` 元数据 + `<id>.jsonl` 消息日志，按消息 id 幂等回放、原地更新、8MB/1.5 倍压实；旧 JSON 首次保存自动迁移。30KB 工具输出的长会话 saveNow 129–169ms → 0.4–0.7ms，启动加载 +25ms
- [x] 长会话渲染：首屏 60 条、分批补齐、常驻上限 400 条 +「加载更早」；消息行 memo；block_delta 30ms 合并、O(n) 更新改 O(1)。打开 1811→1015ms、最大长任务 1129→160ms；滚动 p50 30.1→16.6ms；流式最大长任务 908→98ms，DOM 10.5 万→1.35 万节点
- [x] `fs/complete` 异步分批遍历 + 2s 缓存（热 37–42→16–24ms）；`walkFilesAsync`；Glob 异步遍历 + 分片 stat（193–208→139–186ms）；会话 env 并发检测合并 + 2.5s 缓存（首包 296→11.8ms）；外部会话列表 1.5s 缓存（热 123→10.6ms）
- [x] 超大 diff 截断 1MB/2 万行并提示（16MB/278ms→1MB/146ms）；文件浏览器大目录 `content-visibility`
- 未做：会话消息分页（31MB 全量下发仍在）、侧栏/搜索虚拟列表（实测 200+3000 下 10–26ms，无收益）、服务端事件广播合并
- 验证：`node scripts/check.mjs`：build / ui-audit / test / smoke 通过；regression 45/46，唯一失败是并行无障碍任务新增的 a11y 扫描（工具卡对比度/标签，与本轮文件无关）

## 迭代 27（2026-11-07）自建 Key 网关（可选，默认关闭）
- [x] 协议：`GatewaySettings/GatewayModelRoute/GatewayToken/GatewayOverview/GatewayLogEntry/GatewayMemberUsage`；`ProviderKind` 新增 `tandem-gateway`；`UsageStatsRow.memberId/memberName`
- [x] Host：`server/src/gateway/{store,stats,proxy,redact}.ts` + `routes/gateway.ts`；`/gateway/v1/{models,chat/completions,messages}` 网关令牌鉴权（只存 SHA-256）、成员每日/每月美元限额、RPM 滑动窗口、模型白名单、多 Key 轮换/冷却、沿用预算 block；记账写入 `usage.json`（带成员，不重复计数）；日志只记元数据，调试正文自动脱敏 + 24h TTL，关闭即清空
- [x] Web：设置「网关」页（模式开关 + 可信内网提示、模型路由、令牌签发/限额/吊销、每 5 秒成员统计、日志与调试）；用量页新增「按成员」；账号类型「Tandem 网关」（地址 + 网关令牌，自动拉模型）
- [x] `docs/gateway.md`：架构、协议对应、限额/限流、日志与调试、默认值、威胁模型、运维与已知限制
- 验证：双 Host（`/tmp/tandem-gw`:8271 网关、`/tmp/tandem-gwc`:8272 客户端）+ 本地 mock（OpenAI/Anthropic SSE）；客户端用网关账号跑会话经网关落到 mock（上游收到 `sk-up-*`，不含网关令牌）；用量按成员记账；超限额 429、吊销后 401、白名单 403、RPM 429；日志无正文；Playwright 截图 `/tmp/gw-shots/`
- 备注：网关为 HTTP 明文，仅可信内网；OpenAI 入口只路由 OpenAI 兼容分组，Anthropic 入口只路由 Anthropic 分组，不跨协议翻译

## 迭代 27（2026-11-07）体验走查 v8：团队共享 / 浏览器 / 评测
- [x] `docs/review-v8.md`：桌面 2552×1274 深色 + 手机 390×844，真实点击内网团队共享（成员页、邀请二维码、入职、在线头像、审批转交、审计）、浏览器操作（设置页、面板、工具卡）、评测集（存用例、结果表、轨迹、并排）
- [x] 修 P1：审计日志角色/审批决定英文枚举 → 中文；评测结果表 10.5px → 12px；运行时间 zh-CN 格式
- [x] 修 P2：邀请回环警告独立成行；成员页可见时 8s 静默刷新；存用例窗高度自适应并去掉重复用例集 chip；评测/浏览器徽标字号
- [x] 回归：`e2e/regression.mjs` 新增 4 条，50/50 通过；`node scripts/check.mjs --skip-smoke` 通过
- 遗留（P2，见 review-v8）：邀请记录删除无二次确认；Host 重启后工具卡截图永久「加载中」；并排对比宽度偏大；手机设置页签占半屏（与网关同事共用文件）
- 验证：TANDEM_HOME=/tmp/tandem-rv8:8281 + 假 profile/成员/浏览器会话/评测结果；截图 /tmp/rv8/

## 迭代 28（2026-11-08）收尾：跨零点回归 + 评审遗留 P2 清理
- [x] 回归脚本固定时间：`page.clock.setFixedTime(启动时刻)`，造数与界面共用同一「今天」；用量用例按日期定位当天柱子，跨零点稳定
- [x] 修复 18 条：无检查点会话可只回退对话（协议 `RewindInput.messageId`）；dirty worktree 409 带文件名/分支；手机首页页签复用 SegmentedControl；内嵌收件箱不计未读；预算页头统一、进度条可见、非法 cron 中文提示；后台面板可刷新；收件箱空审批小节；派单弹层高度自适应；倒计时 0 秒文案；手机反馈浮条移到底部；邀请记录删除二次确认；截图 8s 失效提示；浏览器空态文案；设置内 Toast 避让；触屏「更多操作」可见性
- [x] 已不复现 4 条：设置-同步与备份可滚动、工具展开贴底、子代理表单、新会话常用横向条
- [x] 不修 14 条（含 4 条建议）：导入预览虚拟化、iOS 应用内扫码、系统提示行宽、并排对比宽度、手机设置页签形态、内联链接/长按/行号字号/真机验证、a11y 建议
- [x] 新增回归 3 条（无检查点回退、dirty worktree 确认、邀请删除确认）；文档状态已回写

## 迭代 29（2026-11-08）统一命令面板 + 设置项搜索
- [x] Ctrl/Cmd+K 面板合并会话、命令、设置项、主机与最近项目目录；`>` 命令、`@` 会话、`#` 设置前缀；中文拼音首字母/全拼匹配；↑↓ 选择、Enter 执行、Tab/Shift+Tab 跨分组；最近使用的命令置顶
- [x] `web/src/lib/settingsRegistry.ts`：22 个设置页、65 个设置项的稳定 id/标题/关键词；各页容器带 `data-setting-id`。设置窗口顶部搜索同一份注册表，选中后切页、滚动并高亮
- [x] `web/src/lib/commands.ts`：12 条命令及默认快捷键；外观页快捷键表由注册表生成，支持本机自定义与冲突提示；反馈热键读取同一份配置
- [x] 手机顶栏新增搜索按钮；`e2e/regression.mjs` 新增 4 条（设置定位、前缀/拼音、自定义快捷键与冲突、手机面板）
- 验证：TANDEM_HOME=/tmp/tandem-cmdk 端口 8291 + Playwright，截图 `/tmp/cmdk-shots/`；新增 4 条回归通过。`node scripts/check.mjs --skip-smoke --skip-regression` 通过；全量 regression 仍有 3 条失败，均来自并行开发中的上下文占用面板/审批策略学习（上下文面板最大项、手机权限规则越界、工具卡 a11y），不在本轮改动文件
