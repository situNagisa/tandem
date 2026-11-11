# 进度

> 更新：2026-11-11。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 70（2026-11-11）工作站 / 主机信息架构（T1–T5、T7）
- [x] T1 术语：设备面板改「设备」（标题与描述不再写死 ADB/串口）；账号菜单去掉设备入口，改由环境条已挂载 chip 与主机详情「设备」进入；「工作站管理」→「工作站设置」且仅 admin/owner 显示，新增「账号设置」。
- [x] T2/T3 主机唯一列表 + 详情：`HostsSection` 合并工作站归属（我的/获授权）、本机标、版本不一致；行只留状态，点行开 `HostDetailDrawer`（改名、设备、诊断、重连、授权、移除，移除确认写明影响）；授权弹层抽成 `HostGrantDialog`。设置→工作站不再列主机。
- [x] T4 添加主机唯一化：`AddHostDialog` 删除本机 join 副本与手填表单；空状态、设置、环境条菜单、命令面板、导览卡全部打开同一对话框；命令面板同名项只剩一条。
- [x] T5 设置→工作站：独立页，仅管理员；保留名称、注册方式、邀请码、成员列表（停用「待接入」服务端接口）；旧「成员与分享」页删除，分享独立成页。
- [x] T7 环境条主机菜单只留名称+状态，底部「管理主机…」「添加主机…」；侧栏筛选改「按主机筛选」；命令面板新增「打开主机设置」。
- [x] 检查：decisions-check 新增 hosts-single-entry 与 add-host-single-dialog；regression 新增「唯一主机列表/详情/添加入口/工作站仅管理员」，登录门与设备用例改到新入口。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）在 `/tmp/ia-hosts-after/`，对比图 `compare.png`。

## 迭代 69（2026-11-11）反馈1601：切换闪屏 / 文件夹弹层 / 金额 / 折叠记忆
- [x] #02 P0 切换会话闪屏（R10 复发）：帧采样定位到消息区在切换后 1 帧内下移 132px——注入说明行在首屏快照之后才挂载，ResizeObserver 的贴底补偿排到了下一帧。ChatView 改在 ResizeObserver/MutationObserver 回调里绘制前同步补 scrollTop；右栏上下文按会话缓存，切换时卡片不再消失一帧；regression 反馈1601#02 逐帧断言贴底、可见首行不动、右栏分组/会话图稳定。
- [x] #01 文件夹弹层改 ui/Menu（R01 复发）：Menu.Label / Menu.Separator / Menu.Item，去掉手写标题与 border-t 分隔；ui-audit 新增 role-menuitem 与手写菜单标题/分隔线规则。
- [x] #03 用户消息金额：`formatCost` 对 0<usd<0.00005 显示 `<$0.0001`，0 显示 `$0`；单测 + regression。
- [x] #05 侧栏折叠记忆：折叠键改为 hostId + 仓库根路径（旧键兼容），重开恢复；regression 反馈1601#05。
- 验证：`node scripts/check.mjs --skip-smoke --skip-regression` 全绿；本包新增/涉及的 regression 用例（1601#02/#05、文件夹弹层 4 条、用户消息金额、最占空间）单跑全过。全量 regression 剩余的「反馈2102#02 会话图快速连点」「反馈1919#07 回到底部恢复跟随」在干净基线 2bfbb1b 上同样失败（已逐一回退 ChatView 复测），属既有问题。截图（深/浅）在 `/tmp/fix-1601a/`。
## 迭代 68（2026-11-11）UI 第三批：芯片/徽标统一（打分卡 U3-B，用户原话「徽標用方案B」）
- [x] 新增 `ui/Badge`：透明底 + 1px 边、4px 圆角、20px 高、11px 字；tone = neutral / success / warn / danger / annotation。
- [x] 替换 34 处徽标（调试、反馈、体验清单、演示、评测、工作站、浏览器/预览、分享），状态/演示用中性描边（P02），反馈标注用新 token `--t-annotation`（沿用原 #F97316，深浅各一）。
- [x] 9.5–10.5px 文本全部提到 11px（tsx 59 处、CSS 6 处；侧栏 kbd、ToolCard、DiffView、Composer 一并）；ui-audit 新增 `hardcoded-annotation-orange` 与 `tiny-font`（白名单为空，演示设备缩略画面注明原因）。
- [x] decisions-check 新增 `ui-badge`（2026-11-11 用户决定）；截图 `/tmp/u3b-after/compare.png`（现状 vs B 实装，浅/深）。
- 验证：`node scripts/check.mjs --skip-smoke` 通过。

## 迭代 66（2026-11-10）弹层背景透明（R64）
- [x] 修 `var(--t-bg-elevated)`（全仓未定义）：反馈输入浮层/复验条、功能导览三张卡、语音浮层恢复 `bg-surface`；设置→工作站卡片与代码块「还有内容」提示改用 `--t-surface`；反馈原因标签 `--bg-active` 改 `--t-bg-active`。
- [x] ui-audit 新增 `undefined-css-var`：`var(--x)` 必须在 CSS 有定义或运行时注入；`card-class` 不再误伤 fixed/absolute/sticky 浮层（含 `${POSITION}` 常量）。
- [x] Playwright 截图核对浅色/深色：上手引导、导览胶囊/面板、反馈工具条/编辑浮层、语音浮层、工作站设置、设置对话框、模型菜单，背景均不透明（/tmp/fix-transparent/）。
- 验证：`node scripts/check.mjs` 全量通过。
