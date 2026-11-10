# 进度

> 更新：2026-11-10。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 66（2026-11-10）弹层背景透明（R64）
- [x] 修 `var(--t-bg-elevated)`（全仓未定义）：反馈输入浮层/复验条、功能导览三张卡、语音浮层恢复 `bg-surface`；设置→工作站卡片与代码块「还有内容」提示改用 `--t-surface`；反馈原因标签 `--bg-active` 改 `--t-bg-active`。
- [x] ui-audit 新增 `undefined-css-var`：`var(--x)` 必须在 CSS 有定义或运行时注入；`card-class` 不再误伤 fixed/absolute/sticky 浮层（含 `${POSITION}` 常量）。
- [x] Playwright 截图核对浅色/深色：上手引导、导览胶囊/面板、反馈工具条/编辑浮层、语音浮层、工作站设置、设置对话框、模型菜单，背景均不透明（/tmp/fix-transparent/）。
- 验证：`node scripts/check.mjs` 全量通过。

## 迭代 65（2026-11-10）UI 第二批：按钮/卡片/空状态/设置行（打分卡 U1/U2/U4/U5-A）
- [x] U1：`ui/Button` 收敛控件 32 / 图标 32 / 行内 24，补 pressed 与移动端 44px；手写按钮迁移 36 处，结构性 132 处显式标 `data-raw-button`。
- [x] U2：新增 `ui/Card`（12px 圆角、16/18 内边距、无阴影），替换 57 处；删掉 `index.css` 设置页 10px/12-14 覆盖，右栏卡片同步 12px 无阴影。
- [x] U4：新增 `ui/EmptyState`（虚线框、20px 内边距、30px 图标、13/12 两级文字），替换 30 处；删除 `.settings-empty` 系列 CSS，「先添加一台主机」原文保留。
- [x] U5：19 个设置页改用 `SettingRow`/`SettingNote`，说明收进 ⓘ 或下方说明；文案、设置项、顺序不变。
- [x] 检查：`font-size-floor` 覆盖 `ui/` 全部组件；`ui-audit` 不再跳过 `ui/`，新增 `card-class`/`native-button`；`Controls` 原生 title 改 `data-tip`。
- 验证：`node scripts/check.mjs --skip-smoke` 通过（regression 168/168）。

## 迭代 64（2026-11-10）文档治理：原则与检查分离
- [x] `design.md` 403→88 行：只留 P01–P22 原则（规则+为什么+覆盖范围）与色板/字号/术语表；单点 UI 决定移出，末尾只留 4 条无法自动检查的决定。
- [x] `feedback-ledger.md` 194→65 行：59 个根因各一行（编号 | 根因 | 次数 | 防线位置），删除逐次修复流水。
- [x] `docs/features/*.md` 全部 ≤80 行（18 份，最长 75）；`PROGRESS.md` 只留 63/62/64 三轮，其余归档；`HANDOFF`/`AGENTS` 保持 ≤60/≤50。
- [x] `scripts/decisions-check.mjs` 改为 71 条源码断言（不再依赖 design.md 原文），覆盖布局、颜色、字号、菜单/弹层、审批、侧栏、上下文、会话图、外部会话、消息区等；`ui-audit` 新增字重、触发器缩放、选中色、reduced-motion、会话图泳道 token 规则。
- [x] `scripts/docs-check.mjs` 加行数上限：design ≤150、ledger ≤80、每份 features ≤80、PROGRESS ≤60、HANDOFF ≤60、AGENTS ≤50。
- [x] 修两条测试脆弱：侧栏缩进用例改取标题文本元素；卡片标题控件用例先清 `tandem.rightPanelCollapsed.v1`。
- [x] `AGENTS.md` 补三条：任务只按用户原话（原话→现在→改成→不改什么）、文档写原则不写流水、不依赖会话上下文（判断写进文件 + HANDOFF 每轮 ≤5 行）。
- 验证：`node scripts/check.mjs` 全量通过（docs/build/debug-artifacts/ui-audit/decisions/单测/smoke/regression/release）。

## 迭代 64（2026-11-10）文档治理：原则与检查分离

