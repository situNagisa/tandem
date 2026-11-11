# 进度

> 更新：2026-11-11。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 68（2026-11-11）反馈1601：切换闪屏 / 文件夹弹层 / 金额 / 折叠记忆
- [x] #02 P0 切换会话闪屏（R10 复发）：帧采样定位到消息区在切换后 1 帧内下移 132px——注入说明行在首屏快照之后才挂载，ResizeObserver 的贴底补偿排到了下一帧。ChatView 改在 ResizeObserver/MutationObserver 回调里绘制前同步补 scrollTop；右栏上下文按会话缓存，切换时卡片不再消失一帧；regression 反馈1601#02 逐帧断言贴底、可见首行不动、右栏分组/会话图稳定。
- [x] #01 文件夹弹层改 ui/Menu（R01 复发）：Menu.Label / Menu.Separator / Menu.Item，去掉手写标题与 border-t 分隔；ui-audit 新增 role-menuitem 与手写菜单标题/分隔线规则。
- [x] #03 用户消息金额：`formatCost` 对 0<usd<0.00005 显示 `<$0.0001`，0 显示 `$0`；单测 + regression。
- [x] #05 侧栏折叠记忆：折叠键改为 hostId + 仓库根路径（旧键兼容），重开恢复；regression 反馈1601#05。
- 验证：`node scripts/check.mjs --skip-smoke --skip-regression` 全绿；本包新增/涉及的 regression 用例（1601#02/#05、文件夹弹层 4 条、用户消息金额、最占空间）单跑全过。全量 regression 剩余的「反馈2102#02 会话图快速连点」「反馈1919#07 回到底部恢复跟随」在干净基线 2bfbb1b 上同样失败（已逐一回退 ChatView 复测），属既有问题。截图（深/浅）在 `/tmp/fix-1601a/`。

## 迭代 67（2026-11-10）输入框分工/取向两个维度（反馈2009#01）
- [x] 用户原话（反馈2009#01）：上面四个选项与委派倾向重复，应分两个维度（积不积极派子代理 / 质量优先还是成本优先）。菜单改为「分工」（关闭 / 适度 / 积极）与「取向」（省钱 / 均衡 / 质量优先）两组单选；「仅规划」移除（计划模式权限已覆盖）。
- [x] 数据：会话 `delegation` + `routeBias` 取代 `routePreference`；旧数据读取时一次迁移并写回；protocol 与服务端同步。
- [x] 运行时按矩阵实现（`features/routing.md`）：Task 只在多代理协作回合开放；成本上限只对积极生效；取向决定未绑定执行者的档位；分工关闭不规划、不出提示行；学到的偏好改由分工前确认卡累计。
- [ ] 第三个维度「验证策略」未做（用户提出，另做）。
- 验证：`node scripts/check.mjs` 全量通过（regression 171/171）；菜单截图（浅色 / 深色、两个子菜单）在 `/tmp/route-menu/`。

## 迭代 66（2026-11-10）弹层背景透明（R64）
- [x] 修 `var(--t-bg-elevated)`（全仓未定义）：反馈输入浮层/复验条、功能导览三张卡、语音浮层恢复 `bg-surface`；设置→工作站卡片与代码块「还有内容」提示改用 `--t-surface`；反馈原因标签 `--bg-active` 改 `--t-bg-active`。
- [x] ui-audit 新增 `undefined-css-var`：`var(--x)` 必须在 CSS 有定义或运行时注入；`card-class` 不再误伤 fixed/absolute/sticky 浮层（含 `${POSITION}` 常量）。
- [x] Playwright 截图核对浅色/深色：上手引导、导览胶囊/面板、反馈工具条/编辑浮层、语音浮层、工作站设置、设置对话框、模型菜单，背景均不透明（/tmp/fix-transparent/）。
- 验证：`node scripts/check.mjs` 全量通过。
