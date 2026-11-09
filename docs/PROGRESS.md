# 进度

> 更新：2026-11-10。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

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

## 迭代 63（2026-11-09）模型账号/Key 归工作站账号（合并账号体系分支）
- [x] R59：模型账号/分组/Key/倍率/模型勾选改为工作站账号级，加密存 `workstation/profiles.json`；设置页跨主机一致。
- [x] 主机签名模型代理：主机只发 profileId/模型/消息，工作站校验签名+访问权+profile 归属，用账号 Key 调上游，NDJSON 流式回传；按账号+主机记账。
- [x] 迁移按用户简化：主机连接时上传本地 profiles 后删除本地文件，同名以工作站为准；旧按主机 API 删除（工作站模式 410）。
- [x] 共享主机用被授权人自己的模型账号；管理员只看掩码；调试账号自带 demo 模型账号；个人模式进程内直连。
- [x] 反馈14#08 R60：账号级余额查询（工作站用 Key，5 分钟缓存，设置/模型菜单显示）。
- 验证：单测 account-profiles/balance；e2e workstation-check；全量 `check.mjs`；产物 0.4.6。

