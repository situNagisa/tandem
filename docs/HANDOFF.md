# 交接页（任何新会话先读这一页，再读 AGENTS.md）

更新：2026-11-10。目的：协调者的会话很长，随时可能换一个全新会话接手；这一页让接手者 5 分钟内知道"现在在哪、正在做什么、在等谁"。文档分层与索引见 `docs/README.md`。

## 当前版本
- 已发布 v0.4.6（本地标签，未 push）。产物在 Windows「下载」：`Tandem-Setup-0.4.6-x64.exe`（发布版）、`Tandem-Setup-0.4.6-debug-x64.exe`（调试版）、`tandem-release.apk/.aab`、`tandem-debug.apk`、`latest.yml`（指向 0.4.6 发布版）。
- 发布流程：`node scripts/release.mjs <版本>`（先在 `packages/web/src/lib/changelog.ts` 手写导览条目，否则脚本会中止）→ `node scripts/check.mjs` 全过 → `npm run apk:release -w @tandem/mobile`、`npm run apk -w @tandem/mobile`、`npm run dist:win -w @tandem/desktop`（发布版）、`npm run dist:win:debug -w @tandem/desktop`（调试版）。**check 不过不打包。** 先打发布版、最后再跑一次 `dist:win`，否则调试版会覆盖 `latest.yml`。
- **发给用户体验用调试版，正式发布用发布版**：调试版走 `npm run build:debug` + `npm run apk -w @tandem/mobile`（`tandem-debug.apk`）+ `npm run dist:win:debug -w @tandem/desktop`（`Tandem-Setup-<版本>-debug-x64.exe`），带反馈模式、演示工作区、体验清单与调试角标；正式包走 `apk:release` + `dist:win`，不含这些功能。桌面调试版与发布版同一 appId/安装目录，不能同时安装。构建开关与清单见 `docs/features/release.md` 第 0 节。
- 安卓签名密钥：`~/.tandem-release/`（不在仓库；用户需离线备份）。

## 正在进行
- 2026-11-12 启动方式：`npm start` 即工作站（8481，数据 ~/.tandem，本机主机在 ~/.tandem/local-host）。用户真实目录已用 /tmp/tandem-migrate.sh 手工迁移，备份 ~/.tandem.bak-20261111-223921。产品不做启动时旧布局检测（用户明确要求）。
- 2026-11-10 瘦主机（远程架构重做，用户定方向）：agent/会话/工具在工作站，远程机器只跑 Go 单文件执行器（packages/executor，~7MB，出站 WSS，双向认证）。设计与产品决定：`docs/archive/plan/thin-host-2026-11-10.md` 第 9 节。进度：M1 执行器 ✓、M2 只读工具 ✓、M3 写入与执行 ✓、M4 接入产品 ✓（一行命令装执行器、工作站 executor/hub.ts 为每台执行器建远端 Host 上下文）；待做：M6 立即删旧完整 Host 远程路径（内测不留兼容，不做旧会话导入）、设备/浏览器/MCP、断线续跑、远端检查点回退、自更新。等用户 Windows 代测（docs/test-guides/workstation.md）。原则：最小可用（用户问过"需要写这么复杂吗"）。
- 2026-11-10 已合入：执行方式拆为「分工 / 取向」（反馈2009#01）；删除跨主机派单；会话图轨道式画法（保持泳道色，用户选 B）；反馈 1919/2102/2108 全部；一行命令添加主机已改为下载执行器（不需要 Node）。
- 待做：反馈2102#07 @ 选择文件（可选文件夹、选中后蓝字只显示文件名）；「验证策略」维度；任务看板空状态加用途说明；轮次大纲跳转回归在高负载下仍偶发失败、regression 跑完偶尔不退出。
- 2026-11-10 输入框「分工 × 取向」两个维度（反馈2009#01）：已实现，check 通过（见 PROGRESS 67）；等用户实机确认菜单与默认行为（见「等用户决定」）。
- 2026-11-10 新产品经理接手，去冗余：删除旧账号中心、SSH 接入、relay（远程连接只走工作站，工作站支持公网部署、只做本地测试）；UI 第一批收拢（useCopy/format/Spinner/storage）；修复失效检查、删除守护已删事物的检查。累计 −5600 行。UI 第二批已完成 U1/U2/U4/U5-A（按钮/卡片/空状态/设置行，五提交），U3 芯片/徽标等用户选。待做（内部合并，不改行为）：gateway 与工作站 modelProxy 底层合并、凭据/路由开关收敛、拆 >1000 行组件。
- 0.4.6 已发布：模型账号/分组/Key/倍率归工作站账号（Key 只加密存工作站，主机经签名代理调用模型，旧主机 profiles 上传后删除本地文件，旧按主机 API 返回 410）；账号余额查询（已知平台/自定义 URL，5 分钟缓存，设置与模型菜单显示）；审批作为对话消息内联；所有下拉/弹层不再抖；换主机待定状态（当前/待切换、输入框锁定）；消息时间与用户输入 token 悬停显示；用户气泡紧贴内容；设置页限宽留白与图标对齐；Windows 一行命令添加主机修复（端口自动避让、准确报错与 install.log、HKCU 免管理员自启）；模型芯片去掉思考强度圆点。说明见 `docs/features/model-accounts.md`。
- 0.4.5 已发布：工作站登录门（桌面/网页/手机先登录，调试版回环自动登录调试账号）、一行命令添加主机（15 分钟一次性令牌、install.sh/ps1、systemd/launchd/计划任务持久连接）、无主机空状态、会话图（灰色主线/彩色泳道/子代理合并/分叉）、子代理会话可进入与面包屑、Claude Code 式权限询问、会话信息面板卡片可收起、上下文卡新配色与分类、长会话占位条与大纲未加载标识、换主机先选文件夹；另含反馈截图提速、警告色校准、下拉抖动与代码块换行对齐修复。说明见 `docs/features/session-graph.md`、`docs/features/workstation.md`。

## 等用户实机验证（我这边只能模拟）
按价值排序：
1. Windows 一行命令添加主机：`docs/test-guides/workstation.md` 五之二（重新生成令牌后复制命令到 PowerShell 执行；窗口停在"已连接工作站"即成功；失败请把窗口输出发回）
2. 账号级模型账号与旧主机 profiles 迁移：登录工作站后设置 → 账号与模型应显示账号级数据；加入工作站的主机本地 `profiles.json` 应在上传后删除，主机目录搜不到 Key 明文
3. 余额查询：给账号选自动/平台/自定义查询，设置列表与模型菜单应显示余额；失败显示「—」，点刷新强制重查
4. 审批内联：需要授权时审批应作为对话里的一条消息出现在工具之后，处理完原位留结果，输入框保持可用
5. 桌面与 Edge 网页端的调试账号自动登录（回环地址打开即进，不闪登录页）
6. 桌面调试版反馈草稿目录实时写入与关窗后恢复（WSL 无法启动 Electron，未实测）：进反馈模式写 2 条 → 看「下载/Tandem 反馈/草稿-…」有文件 → 关窗重开提示已恢复 → 导出 .tfb 改 .zip 能解压
7. 手机预览与真机调试触摸：`docs/features/mobile-preview.md`、`docs/test-guides/mobile-debugging.md`（Windows 调试版打开预览、触摸滑动、旋转；调试 APK 的 chrome://inspect）
8. 工作站服务模式：`docs/test-guides/workstation.md`（注册/登录、添加主机、绑定码、授权）
9. 工作站与设备共享：`docs/test-guides/devices.md`（安卓手机 + USB 串口板，两台机器）
10. 账号制：`docs/test-guides/workstation.md`
11. 手机审批（局域网本地通知）、PR/CI（`docs/test-guides/pr-ci.md`）、Windows 路径与中文编码
用户可以先用「设置 → 关于 → 演示工作区 / 体验清单」体验，反馈用反馈模式导出 `.tfb` 发飞书（旧 `.json` 仍可解包）。

## 等用户决定
- 分工默认「适度」后，主会话只在明显独立的多步任务上开放 Task（以前模型随时可派），接受吗？「验证策略」何时做？命令面板「切换委派倾向」标题未改（`lib/commands.ts` 被其他子代理占用），现在统一改名吗？
- UI 打分卡 U3（芯片/徽标，推荐 B）、反馈1919#01 完成提示（推荐 C 完成勾）——图已发飞书，用户未选
- 是否准备上架（需补隐私政策页、权限说明；软著与商店账号由用户办）——见 docs/features/release.md
- 桌面代码签名是否购买证书——见 docs/features/release.md

## 用户已定的方向（不要回退）
`docs/design.md` 的 P01–P22 是原则；具体决定在 `scripts/decisions-check.mjs`、`ui-audit` 与回归「用户决定」检查里。最近的：暂不做 iOS；做任务看板；工作站与设备共享；账号制；分工路由（不在同会话切模型、简单任务不能变复杂、要能人工选择）；输入框「分工 × 取向」（2026-11-10 用户原话，见 decisions-check route-labels）；宽内容与正文同宽；消息时间/用量悬停显示；添加远程主机统一通过工作站一行命令。

## 没有用户时怎么推进
- 自用测试闭环：代理用户用真实账号副本走 5 个真实任务 → 用反馈模式记录 → 按 docs/feedback-ledger.md 根因修（复发必须共享层修 + 自动检查）→ 下一轮复验。记录在 `docs/archive/dogfood/`。
- 候选功能池：docs/archive/research/explore-v2-2026-11-08.md 剩余（双向语音、OTel 导出、auto-merge 等，优先级低）；新功能优先来自用户提议与自用测试发现。
- 巡检：低频巡检 cron（每天 09:23/13:23/17:23/21:23），一切正常不打扰用户。

## 协调者工作习惯（踩过的坑）
- 子代理会卡在"等一个问题的回复"上：prompt 里写明"不要提问、不要等待回复，拿不准选最保守的做法并在回复中列出"；卡住时先 interrupt 再 send_message 唤醒，二次卡住就换新子代理接手（把它留下的改动交代清楚）。
- heavy 档子代理多次长时间只读不写；优先 midheavy/standard，任务拆小、写明第一步命令。
- 多个子代理并行时按文件划分；各自只 add 自己的文件；验证已提交状态用干净 worktree。
- 不读 git remote 的值、不 push；不连公网；测试 Host 一律 TANDEM_HOME=/tmp/…；不用 pkill -f。

## 本轮手工操作 / 出错环节（只留最近 5 轮，每轮 ≤5 行）
- 2026-11-11 主机 IA：T1–T5/T7 全在 `packages/web`；删掉 Host 侧 join/enable 前端调用（`addLocalHost.ts`、LoginGate 启动本机工作站）；旧「连接手机」入口与 `PairDialog` 一并删除；调试版自动登录仍读 `<Host>/api/workstation/local/status`（只读探测，待 server 删除该路由时去掉）。
- 2026-11-11 反馈1601：用自建临时 Host + CDP screencast/绘制后逐帧采样定位切换闪屏（注入说明行晚到 + 贴底补偿下一帧）；反馈包里的整页截图为 DOM 克隆，content-visibility 行会是空白，不能当作“主区空白”的证据；每次 Playwright 复现都要 `npm run build -w @tandem/web` 后新起 Host。
- 2026-11-11 输入框改 contenteditable：回归里 60+ 处 `textarea[aria-label=消息输入框]` 换成 `[aria-label=消息输入框]`，`inputValue`→`data-value`、`isDisabled`→`aria-disabled`；批量替换误改到「记忆 Markdown」用例（已回退）。Playwright 的 fill 会把文本直接挂根节点，光标映射需带兜底。
- 2026-11-11 侧栏会话树/悬停拓扑：分叉归并在 `buildGroups`（`lib/sessionTree.ts`）；悬停浮层用 Radix Popover 的 Anchor（无 Trigger）+ 500/300ms 延迟；截图用临时 Playwright 脚本（复用 smoke 的启动与调试登录方式）。
