# 进度

> 更新：2026-11-10。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 64（2026-11-10）文档治理：原则与检查分离
- [x] `design.md` 403→88 行：只留 P01–P22 原则（规则+为什么+覆盖范围）与色板/字号/术语表；单点 UI 决定移出，末尾只留 4 条无法自动检查的决定。
- [x] `feedback-ledger.md` 194→65 行：59 个根因各一行（编号 | 根因 | 次数 | 防线位置），删除逐次修复流水。
- [x] `docs/features/*.md` 全部 ≤80 行（18 份，最长 75）；`PROGRESS.md` 只留 63/62/64 三轮，其余归档；`HANDOFF`/`AGENTS` 保持 ≤60/≤50。
- [x] `scripts/decisions-check.mjs` 改为 71 条源码断言（不再依赖 design.md 原文），覆盖布局、颜色、字号、菜单/弹层、审批、侧栏、上下文、会话图、外部会话、消息区等；`ui-audit` 新增字重、触发器缩放、选中色、reduced-motion、会话图泳道 token 规则。
- [x] `scripts/docs-check.mjs` 加行数上限：design ≤150、ledger ≤80、每份 features ≤80、PROGRESS ≤60、HANDOFF ≤60、AGENTS ≤50。
- [x] 修两条测试脆弱：侧栏缩进用例改取标题文本元素；卡片标题控件用例先清 `tandem.rightPanelCollapsed.v1`。
- [x] `AGENTS.md` 补三条：任务只按用户原话（原话→现在→改成→不改什么）、文档写原则不写流水、不依赖会话上下文（判断写进文件 + HANDOFF 每轮 ≤5 行）。
- 验证：`node scripts/check.mjs` 全量通过（build/docs-check/ui-audit/单测/smoke/regression/release）。

## 迭代 63（2026-11-09）模型账号/Key 归工作站账号（合并账号体系分支）
- [x] R59：模型账号/分组/Key/倍率/模型勾选改为工作站账号级，加密存 `workstation/profiles.json`；设置页跨主机一致。
- [x] 主机签名模型代理：主机只发 profileId/模型/消息，工作站校验签名+访问权+profile 归属，用账号 Key 调上游，NDJSON 流式回传；按账号+主机记账。
- [x] 迁移按用户简化：主机连接时上传本地 profiles 后删除本地文件，同名以工作站为准；旧按主机 API 删除（工作站模式 410）。
- [x] 共享主机用被授权人自己的模型账号；管理员只看掩码；调试账号自带 demo 模型账号；个人模式进程内直连。
- [x] 反馈14#08 R60：账号级余额查询（工作站用 Key，5 分钟缓存，设置/模型菜单显示）。
- 验证：单测 account-profiles/balance；e2e workstation-check；全量 `check.mjs`；产物 0.4.6。

## 迭代 62（2026-11-09）工作站安装：Windows 一行命令登记崩溃（R56 复发）
- [x] `join` 失败路径不再 `process.exit`，只设 `process.exitCode`，避免 Windows + Node 26 硬退出撞 libuv 断言。
- [x] `join` 比对 `/api/host` 的 hostId，不同数据目录自动换空闲端口；失败归因分崩溃/绑定码/连不上，写 `install.log` 并 UTF-8。
- [x] Windows 登录自启改 `HKCU\…\CurrentVersion\Run`；`pack-host` 按平台裁剪原生模块并断言无混平台。
- 验证：用户 Windows 11 + Node v26.4.0 实机跑通一行命令；乱填令牌退出码 1 并提示正确；单测覆盖三类错误分支。
