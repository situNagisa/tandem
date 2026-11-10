# 反馈根因台账

> 更新：2026-11-10。每条反馈先归到一个根因（R 编号），再决定修法。同一根因第 2 次出现必须在共享层修，并在「防线位置」加自动检查；修复流水写在提交信息，不进本表。

| 编号 | 根因 | 次数 | 防线位置 |
|---|---|---|---|
| R01 | 列表/菜单/下拉/设置行/可拖宽面板各处手写，样式不一致 | 15 | `ui/Menu`/`ListRow`/`SettingRow`/`ResizeHandle`；ui-audit `role-menu`/`menu-multiline`；decisions-check 共享组件项；regression 菜单/设置/侧栏/面板用例 |
| R02 | 文字偏灰、字号过小、对比度不足 | 5 | design P05 字号下限；ui-audit font-size-floor（9/10px）；regression 字号/a11y 扫描 |
| R03 | 弹层被裁切或越界 | 5 | Portal + 碰撞避让；regression「tooltip/菜单不越界」多视口用例 |
| R04 | 彩色过多、强调色越界、焦点橙环 | 5 | design P02；ui-audit accent/selection 检查；regression 焦点环只随键盘出现 |
| R05 | 重复入口（新会话、设置、删除、派单、缓存率等） | 6 | design P15；decisions-check 唯一入口项；regression 顶栏 ≤5/入口唯一/无重复缓存率 |
| R06 | Windows 路径与编码、安装说明平台化；句中斜杠被识别成文件路径 | 8 | 路径规范化单测；`fileLinks` 路径形状单测（句中斜杠反例）；regression 盘符路径/平台分段安装说明 |
| R07 | 外部会话注入内容外露、被当作用户轮 | 3 | `isSystemInjectionText` 统一口径；单测 turns/external；regression 注入口径用例 |
| R08 | 点了没反应 / 数据未就绪被当异常 | 4 | 加载态与默认值兜底；regression 新会话环境条/模型价格/手机环境条 |
| R09 | 反馈模式与浮层交互冲突 | 2 | `lib/overlay` + `data-portal-layer`；ui-audit contains/portal；regression 反馈圈选 |
| R10 | 提示/动效不符合习惯、尺寸跳动 | 6 | 标准 Tooltip/固定尺寸/动效 token；regression 设置窗口/动画测量/高级分组/运行进度 |
| R11 | 危险或不可逆操作没有确认/预览 | 2 | `ui/ConfirmAction`；regression 合并/压缩/删除确认 |
| R12 | 完成态缺少后续操作 | 1 | 状态驱动操作清单；regression 看板完成卡 |
| R13 | 事件流水未聚合、聚合行交互错误 | 2 | `ui/AggregateRow`；单测 inbox；regression 收件箱/看板回合 |
| R14 | 面板与对话区争抢空间/焦点、宽度抖动 | 10 | design P12/P13；`ui/Panel`/`ui/Card`/`ResizeHandle`；ui-audit right-panel-*；decisions-check RP-06；regression 宽内容/换行/空分组/收起/宽度稳定 |
| R15 | 关键文本截断且无全文入口 | 6 | 真实文本 + `aria-label`/`sr-only` + 实际溢出才挂 tooltip；regression 大纲/菜单/手机审批 |
| R16 | 轮次统计把工具结果当用户轮次 | 1 | `countTurns`/`isUserTurnMessage`；单测 turns；regression 压缩确认 |
| R17 | 设置保存被归一化丢弃/旧响应回写闪回 | 1 | 归一化保留偏好 + 序号只认最后响应；单测 model-routing；regression 路由偏好 |
| R20 | 可选组件缺失被当成异常 | 1 | 结构化 `available/missing/hint`；regression 无 adb/串口 |
| R21 | 演示数据覆盖不到设备/外设 | 2 | 演示设备与演示画面；regression 演示设备/挂载 |
| R22 | 语义色/代码高亮饱和度不足、警告像褪色 | 2 | design P03/P04；ui-audit hardcoded-warning-color；regression 对比度/上下文分类色 |
| R23 | 按主机切换割裂会话列表、缩进过大 | 2 | design P15；regression 侧栏按主机分组/缩进 ≤8px |
| R24 | 价格模型不符合中转倍率实际 | 1 | 官方价 × 账号 × 分组倍率；单测 pricing；regression 计算式 |
| R25 | 轮次关键数据缺少就地入口、指标口径不清 | 2 | 轮次 tooltip + 固定上下文着色；单测 turnUsage；regression 大纲用量/无切换 |
| R26 | 思考强度档位硬编码 | 1 | `providers/capabilities.ts`；单测 capabilities；regression 厂商档位 |
| R27 | 固定操作重排阅读列表导致乱飞 | 1 | 固定不重排、原位图钉；regression 阅读顺序/滚动位置 |
| R28 | 辅助视图做成独立悬停浮层，跨空白即收起 | 1 | 同一大纲 Alt/点击两用；regression Alt 切换 |
| R29 | 设备权限/占用不可见，用户无处修复 | 1 | 只读探测 + 修复说明 + 深度检测；单测 serial-access；regression 设备行/修复 |
| R30 | 占用清单按单条消息聚合，与轮次心智不符 | 2 | `topTurns` + `ContextSpaceSection`；单测 context；regression 按轮次/折叠 |
| R31 | 选项文案口语化、术语不统一 | 2 | `lib/routeLabels.ts` + 术语表；regression 执行方式/委派倾向文案 |
| R32 | 发送前看不到输入 token/上下文代价 | 1 | `lib/tokens.ts` + 底栏估算；单测；regression 输入 token/发送后占比 |
| R33 | 缓存失效切换没有成本提示 | 1 | 已由 R41 的确认框取代；regression 切换确认 |
| R34 | 输入框不支持常见 Markdown 编辑 | 1 | `markdownInput.ts` + 着色层；单测/regression |
| R35 | 主标签塞入次要属性导致芯片冗长 | 2 | 芯片只显示模型名，无强度小点；regression 芯片/aria-label |
| R36 | 滚动条两套并存、占宽或压内容 | 2 | `ui/OverlayScrollbar`；ui-audit custom-scrollbar；regression 唯一滚动条/gutter |
| R37 | 浏览器/系统自带控件与提示外露 | 4 | 根节点 spellcheck + 自定义右键菜单 + 原生控件迁移 + Edge 行为记录；ui-audit native-title/datalist/list/selection；regression 设置页/输入框 |
| R38 | 只读预览另起一套页面，缺少辅助视图 | 1 | 只读复用 TurnRail/Card/ResizeHandle；单测 external；regression 外部预览 |
| R39 | 构建 flavor 只注入 web，调试模块进 asar | 1 | 构建期常量 + 产物扫描；check-debug/flavor 单测 |
| R40 | 辅助视图与懒加载脱节，点了没反应/固定轮被卸载 | 2 | 先加载再定位 + 固定轮不卸载 + 占位条；regression 4 条懒加载用例 |
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
| R58 | 消息缺少发送时间/时间基准；用量行常显占位 | 2 | `MessageTime` + 用量行悬停显示 + 相对时间；单测 format/user-usage；regression |
| R59 | 账号/Key 按主机各存一份 | 1 | 账号级 profiles + Key 只存工作站 + 主机签名代理；单测 account-profiles；e2e workstation |
| R60 | 账号余额只能去各家网站看 | 1 | 工作站用 Key 查询 + 平台解析 + 5 分钟缓存；单测 balance；e2e mock |
| R61 | 用户明确说过/决定过的要求没有落实 | 1 | design 原则 + `scripts/decisions-check.mjs` 逐条检查；接入 `check.mjs` |
| R62 | 本地乐观消息按内容匹配误删排队气泡 | 1 | 只替换内容一致的排队消息 + 唯一排队兜底；regression 排队消息 |
| R63 | 内嵌工作站避让端口后，主机隧道仍连保存的旧地址（可能是别的进程），前端无限重连 | 1 | 实际端口回写加入地址 + 公钥校验 + 日志打印真实目标 + 调试目录随机端口；regression 端口占用重启 |
| R64 | 设计 token 拼错/未定义，浏览器静默丢弃声明（弹层背景变透明、边框消失） | 1 | ui-audit `undefined-css-var`：源码里的 `var(--x)` 必须在 CSS 有定义，或属于运行时注入（`setProperty`/style 对象自动识别，`--radix-*` 显式白名单，`--graph-lane-` 等模板前缀按同前缀定义校验）；浮层/对话框截图核对（浅色+深色） |
