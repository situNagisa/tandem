# 反馈根因台账

> 更新：2026-11-12。每条反馈先归到一个根因（R 编号），再决定修法。同一根因第 2 次出现必须在共享层修，并在「防线位置」加自动检查；修复流水写在提交信息，不进本表。

| 编号 | 根因 | 次数 | 防线位置 |
|---|---|---|---|
| R01 | 列表/菜单/下拉/设置行/可拖宽面板各处手写，样式不一致 | 16 | `ui/Menu`/`ListRow`/`SettingRow`/`ResizeHandle`；ui-audit `role-menu`/`role-menuitem`/`menu-multiline`/`menu-handwritten-label`/`menu-handwritten-divider`；decisions-check 共享组件项；regression 菜单/设置/侧栏/面板/文件夹弹层用例 |
| R02 | 文字偏灰、字号过小、对比度不足 | 5 | design P05 字号下限；ui-audit font-size-floor（9/10px）；regression 字号/a11y 扫描 |
| R03 | 弹层被裁切或越界 | 5 | Portal + 碰撞避让；细长目标（SVG 连线等）用 `data-tip-anchor="pointer"` 按指针锚定；regression「tooltip/菜单不越界」多视口用例、regression「会话图泳道线 tooltip 以指针定位并完整显示在视口内」 |
| R04 | 彩色过多、强调色越界、焦点橙环 | 5 | design P02；ui-audit accent/selection 检查；regression 焦点环只随键盘出现 |
| R05 | 重复入口（新会话、设置、删除、派单、缓存率、同图标的两个 ⋯ 等） | 7 | design P15；decisions-check 唯一入口项、`topbar-panel-icon-distinct`；regression 顶栏 ≤5/入口唯一/无重复缓存率/顶栏无同图标按钮 |
| R06 | Windows 路径与编码、安装说明平台化；句中斜杠与「长得像文件」的文字被识别成文件链接 | 9 | 路径规范化单测；`extractInlineRefs` 只收行内代码（纯文本不识别），行内代码经 Host 批量存在性（`POST /api/fs/exist`，只算文件）才成链接，客户端 60s 缓存；regression 反馈0220#04、盘符路径、平台分段安装说明 |
| R07 | 外部会话注入内容外露、被当作用户轮 | 3 | `isSystemInjectionText` 统一口径；单测 turns/external；regression 注入口径用例 |
| R08 | 点了没反应 / 数据未就绪被当异常 | 6 | 加载态与默认值兜底；store `openSession` 同步地址栏（`sessionsSlice`，否则 `navigate` 同址短路吞掉按路由的跳转）；decisions-check `route-follows-session`；regression 新会话环境条/模型价格/手机环境条/反馈2108#04；外部会话图节点点击定位（0220#01） |
| R09 | 反馈模式与浮层交互冲突 | 3 | `lib/overlay` + `data-portal-layer`；HoverCard 与菜单/Popover 同一规则（反馈模式下指针离开不收起）；ui-audit contains/portal；regression 反馈圈选/0220#06 悬停卡片停住 |
| R10 | 提示/动效不符合习惯、尺寸跳动 | 11 | decisions-check `envbar-host-icon`；标准 Tooltip/固定尺寸/动效 token；regression 设置窗口/动画测量/高级分组/运行进度；切换会话保留旧画面（sessionsSlice `pendingFocus`）、新会话乐观占位（`startSession` 草稿）；贴底时后到内容绘制前补齐滚动（ChatView ResizeObserver/MutationObserver）；侧栏分组折叠按主机+项目路径记忆；regression 反馈2102#01/#06、反馈1601#02/#05、反馈2156#01（跳转只定位不加高亮）/#03（运行中节点呼吸动画） |
| R11 | 危险或不可逆操作没有确认/预览 | 2 | `ui/ConfirmAction`；regression 合并/压缩/删除确认 |
| R12 | 完成态缺少后续操作 | 1 | 状态驱动操作清单；regression 看板完成卡 |
| R13 | 事件流水未聚合、聚合行交互错误 | 2 | `ui/AggregateRow`；单测 inbox；regression 收件箱/看板回合 |
| R14 | 面板与对话区争抢空间/焦点、宽度抖动 | 10 | design P12/P13；`ui/Panel`/`ui/Card`/`ResizeHandle`；ui-audit right-panel-*；decisions-check RP-06；regression 宽内容/换行/空分组/收起/宽度稳定；反馈2156#04 上下文卡删除「最占空间」 |
| R15 | 关键文本截断且无全文入口 | 6 | 真实文本 + `aria-label`/`sr-only` + 实际溢出才挂 tooltip；regression 大纲/菜单/手机审批 |
| R16 | 轮次统计把工具结果当用户轮次 | 1 | `countTurns`/`isUserTurnMessage`；单测 turns；regression 压缩确认 |
| R17 | 设置保存被归一化丢弃/旧响应回写闪回 | 1 | 归一化保留偏好 + 序号只认最后响应；单测 model-routing；regression 路由偏好 |
| R20 | 可选组件缺失被当成异常 | 1 | 结构化 `available/missing/hint`；regression 无 adb/串口 |
| R21 | 演示数据覆盖不到设备/外设 | 2 | 演示设备与演示画面；regression 演示设备/挂载 |
| R22 | 语义色/代码高亮饱和度不足、警告像褪色 | 2 | design P03/P04；ui-audit hardcoded-warning-color；regression 对比度/上下文分类色 |
| R23 | 按主机切换割裂会话列表、缩进过大 | 2 | design P15；regression 侧栏按主机分组/缩进 ≤8px |
| R24 | 价格模型不符合中转倍率实际 | 1 | 官方价 × 账号 × 分组倍率；单测 pricing；regression 计算式 |
| R25 | 轮次关键数据缺少就地入口、指标口径不清 | 2 | 轮次 tooltip + 固定上下文着色；单测 turnUsage；regression 大纲用量/无切换 |
| R26 | 思考强度档位硬编码；型号按旧名前缀判定思考协议，新代际被误判为不支持 | 2 | `providers/capabilities.ts` `claudeThinkingMode`/`parseClaudeModel` 按家族+版本；`anthropic.ts` 只接受 adaptive 的 400 改用 adaptive 重试、不计降级；降级通知只在去掉思考参数重试成功后发出，内容为脱敏后的上游原话（`summarizeUpstreamRejection`）；单测 `model-families`、`anthropic-thinking`、`effort-fallback`；regression 厂商档位 |
| R27 | 固定操作重排阅读列表导致乱飞 | 1 | 固定不重排、原位图钉；regression 阅读顺序/滚动位置 |
| R28 | 辅助视图做成独立悬停浮层，跨空白即收起 | 1 | 同一大纲 Alt/点击两用；regression Alt 切换 |
| R29 | 设备权限/占用不可见，用户无处修复 | 1 | 只读探测 + 修复说明 + 深度检测；单测 serial-access；regression 设备行/修复 |
| R31 | 选项文案口语化、术语不统一 | 2 | `lib/routeLabels.ts` + 术语表；regression 执行方式/委派倾向文案 |
| R32 | 发送前看不到输入 token/上下文代价 | 1 | `lib/tokens.ts` + 底栏估算；单测；regression 输入 token/发送后占比 |
| R33 | 缓存失效切换没有成本提示 | 1 | 已由 R41 的确认框取代；regression 切换确认 |
| R34 | 输入框不支持常见 Markdown 编辑 | 1 | `markdownInput.ts` + 着色层；单测/regression |
| R35 | 主标签塞入次要属性导致芯片冗长 | 2 | 芯片只显示模型名，无强度小点；regression 芯片/aria-label |
| R36 | 滚动条两套并存、占宽或压内容 | 3 | `ui/OverlayScrollbar`（z-index 按所在浮层设置）；ui-audit custom-scrollbar；regression 唯一滚动条/gutter；regression 反馈2102#03 滚动条不压弹窗 |
| R37 | 浏览器/系统自带控件与提示外露 | 4 | 根节点 spellcheck + 自定义右键菜单 + 原生控件迁移 + Edge 行为记录；ui-audit native-title/datalist/list/selection；regression 设置页/输入框 |
| R38 | 只读预览另起一套页面，缺少辅助视图 | 1 | 只读复用 TurnRail/Card/ResizeHandle；单测 external；regression 外部预览 |
| R39 | 构建 flavor 只注入 web，调试模块进 asar | 1 | 构建期常量 + 产物扫描；check-debug/flavor 单测 |
| R40 | 辅助视图与懒加载脱节，点了没反应/固定轮被卸载 | 3 | 唯一跳转服务先取目标所在片段再定位 + 固定轮不卸载 + 占位条；regression 大纲未加载轮只取该片段 / 固定轮初次打开、滚动、跳转后仍挂载，及原 4 条懒加载用例 |
| R41 | 破坏缓存的切换只在菜单常驻提示 | 1 | `ui/ConfirmAction` 在选中时确认；regression 确认/取消/落库 |
| R42 | 编辑表单回传空值/掩码覆盖已保存 Key | 1 | 掩码占位 + 服务端保留原值；单测 profile-keys；regression 编辑后 Key |
| R43 | 拉取模型不区分代际 | 1 | `lib/modelSelection.ts`；单测/regression 最新一代 |
| R44 | `leading-none` 裁掉字形上下缘 | 1 | 行高 ≥1.4；ui-audit clipped-line-height；regression 菜单行高 |
| R45 | 就地编辑没有沿用原宽度，尺寸跳变 | 1 | 测原气泡宽 + 自适应高；regression 编辑宽度 |
| R46 | 确认类对话框堆卡片/重复说明 | 1 | 精简引用/单选/一行警告；regression 回退对话框 |
| R47 | 固定小高度控件显得扁 | 1 | 工具行 ≥32px、主题预览 96px；regression 测量 |
| R48 | 长会话反馈截图克隆整页 DOM 卡顿 | 1 | 样式白名单 + 视口外跳过 + 最深容器 + 原生截图；regression 性能断言 |
| R49 | 阅读列 shrink-wrap，切换页面抖动 | 1 | `w-full min-w-0 max-w` + `scrollbar-gutter: stable`；regression Wiki 宽度差 ≤1px |
| R50 | 换主机塞进主机胶囊，语义错位 | 2 | 待定状态 + 自动打开文件夹 + 输入禁用/取消；regression 换主机流程 |
| R52 | 弹层动画覆盖 Radix transform，首帧抖动 | 2 | 动画只在内层 + 触发器不缩放 + 异步固定尺寸；ui-audit content-transform；regression 15 帧 ≤1px |
| R53 | 子代理会话关联不稳、层级用子/孙文字 | 1 | `parentToolUseId`/`tool_result.subagent` + 层级树 + 只读子会话；regression |
| R54 | 审批卡像重框表单/停靠输入框上方 | 2 | 审批改为对话消息 + Claude 样式；regression 内联/Esc/发送即拒绝/小屏 |
| R55 | 登录与添加主机流程缺失 | 2 | LoginGate + 无主机空状态 + 一次性令牌 + 持久连接；调试版回环不带 token 自动补凭据、401 不重试；e2e 登录门/安装/免 token 进入 |
| R56 | Windows 一行命令安装/登记失败被崩溃掩盖 | 3 | 平台裁剪 + 不硬退出 + hostId 校验 + 失败归因 + HKCU 自启；单测/用户实机 |
| R57 | 隐藏操作条参与宽度计算，短气泡被撑宽 | 1 | 气泡 `w-fit max-w-full`；regression 气泡宽度 |
| R58 | 消息缺少发送时间/时间基准；用量行常显占位/极小金额显示 $0.0000 | 3 | `MessageTime` + 用量行悬停显示 + 相对时间；`formatCost` 极小金额显示 `<$0.0001`；单测 format/user-usage；regression 反馈1601#03 |
| R59 | 账号/Key 按主机各存一份 | 1 | 账号级 profiles + Key 只存工作站 + 主机签名代理；单测 account-profiles；e2e workstation |
| R60 | 账号余额只能去各家网站看 | 1 | 工作站用 Key 查询 + 平台解析 + 5 分钟缓存；单测 balance；e2e mock |
| R61 | 用户明确说过/决定过的要求没有落实 | 1 | design 原则 + `scripts/decisions-check.mjs` 逐条检查；接入 `check.mjs` |
| R62 | 本地乐观消息按内容匹配误删排队气泡 | 1 | 只替换内容一致的排队消息 + 唯一排队兜底；regression 排队消息 |
| R64 | 设计 token 拼错/未定义，浏览器静默丢弃声明（弹层背景变透明、边框消失） | 1 | ui-audit `undefined-css-var`：源码里的 `var(--x)` 必须在 CSS 有定义，或属于运行时注入（`setProperty`/style 对象自动识别，`--radix-*` 显式白名单，`--graph-lane-` 等模板前缀按同前缀定义校验）；浮层/对话框截图核对（浅色+深色） |
| R65 | 单价按型号名前缀硬编码，新代际查不到价格（花费显示 —）；未收录型号不按同家族估算 | 1 | `usage.ts` `builtinPriceFor`：前缀表 → Claude 家族+版本 → GPT 基础款最近一代，估算时标 `estimatedFrom`；单价优先级账号自定义 > 内置；单测 `model-families`、`pricing` |
| R66 | 底部跟随失效：ResizeObserver 只在首次挂载时绑定（从首页进入会话后不生效）；打开会话的贴底校准读 scrollHeight 时被 content-visibility 撑高，误判为离开底部 | 1 | `ChatView` 观察者依赖挂载视图（`hasSession`/`agentSession`）；校准写入走 `programmaticUntil` 窗口；regression「反馈1919#07 流式输出时在底部自动跟随」 |
| R67 | 一个菜单混放两个维度（是否派子代理 / 执行者用什么模型）与一次性/记住两种语义，选项互相重叠或矛盾（单代理不屏蔽 Task，低成本仍派执行者，仅规划改变工具集） | 1 | 分工×取向两个维度（`routing.md` 矩阵，`planTurnRoute` 单测）；decisions-check `route-labels`；regression「分工路由」与输入框菜单用例 |
| R68 | 跨视图定位的异步回调（轮询、多次实现各自的滚动定时器）未随新一次跳转/用户滚动取消，旧目标把视口拉回 | 2 | `lib/jump.ts` 是唯一跳转实现：每次跳转一个 token、用户滚轮/触摸/拖动滚动条/按键滚动立即取消剩余定位；不再定时轮询派发；regression 跳转统一（同一函数、只派发一次）/ 滚轮不被拉回 / 反馈2102#02 会话图快速连点 |
| R69 | 新会话页的账号/分组/模型/思考强度只存在组件状态，每次挂载回到默认选择 | 1 | `lib/newSessionPick.ts` 按主机记住 + 失效回落；单测 `newSessionPick`；decisions-check `new-session-pick-memory`；regression 反馈2102#05 |
| R70 | 点击语义不符：子代理入口展开卡片或内嵌定位，而不是进入目标视图 | 2 | 子代理入口统一 `openAgentSession`（`ToolCard` 的 `onOpenAgent`、`SessionGraphCard` 的 `open`）；decisions-check `subagent-row-opens-session`、`graph-subagent-opens-session`；regression 反馈2108#02/#03 |
| R71 | 客户端按字段重建摘要时漏掉 `unread`，快照覆盖列表后本地已读与服务端分叉（点掉了、重启又出现） | 1 | `summaryOf` 保留 `unread`；聚焦时以列表摘要兜底调用已读接口；regression 反馈2156#02 |
| R72 | 额度将尽时只能换分组/等待/暂停，不能继续用当前分组；交接策略不能关闭；预测性提醒也会拦停回合 | 1 | 交接卡首位「继续使用当前分组」→ `chooseHandoff('continue')` 写会话级 `handoffBypass`（同类提醒不再拦截、冷却 Key 直接重试）；`HandoffPolicy` 加 `off`，`triggerHandoff` 服务端不建卡；`forecast` 只写提示；单测 `handoff`/`budgets`；regression 反馈0220#02 |
| R73 | 一轮内每段 assistant 回复都保留下方操作/用量行空白 | 1 | `MessageList` 按轮算 `lastAssistantOfTurn`，只给最后一条渲染 `data-msg-meta` 与 `msg-more`；regression 反馈0220#05 |
| R74 | 会话图按视图各画一套拓扑：分叉视图把来源会话画成单节点支线、主会话上的子代理看不见；悬停拓扑只有会话点，看不出从哪一轮分叉/派出 | 2 | `GET /api/sessions/:id/graph` 下发整棵树的轮次与接入关系；`layoutSessionGraph` 唯一布局（trunk 参数 + compact 参数，紧凑模式保留分叉点/派出点/汇回点）；单测 `layout.test.ts`；decisions-check `graph-trunk-current`/`graph-one-topology-per-tree`/`sidebar-hover-topology`；regression 反馈0220#08/#07 |
