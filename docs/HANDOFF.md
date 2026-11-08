# 交接页（任何新会话先读这一页，再读 AGENTS.md）

更新：2026-11-08 23:15。目的：协调者的会话很长，随时可能换一个全新会话接手；这一页让接手者 5 分钟内知道"现在在哪、正在做什么、在等谁"。文档分层与索引见 `docs/README.md`。

## 当前版本
- 已发布 v0.3.1（本地标签，未 push）。产物在 Windows「下载」：`Tandem-Setup-0.3.1-x64.exe`、`tandem-release.apk/.aab`、`tandem-debug.apk`。
- 发布流程：`node scripts/release.mjs <版本>`（先在 `packages/web/src/lib/changelog.ts` 手写导览条目，否则脚本会中止）→ `node scripts/check.mjs` 全过 → `npm run apk:release -w @tandem/mobile`、`npm run apk -w @tandem/mobile`、`npm run dist:win -w @tandem/desktop`。**check 不过不打包。**
- 安卓签名密钥：`~/.tandem-release/`（不在仓库；用户需离线备份）。

## 正在进行
- 无。分工路由 v2 已完成并随 0.3.1 发布（docs/features/routing.md）：主会话模型与缓存不变，Task 子代理执行；默认直接做、机械任务便宜直做、多步或专长匹配才分工；发送前选执行方式、分工前确认卡、子代理换模型重跑/交回主会话、偏好学习、按角色用量均已实现并有回归覆盖。保守取舍：达到每轮成本上限后停止派发，不自动换模型（交由用户决定）。

## 等用户实机验证（我这边只能模拟）
按价值排序：
1. 工作站与设备共享：`docs/test-guides/devices.md`（安卓手机 + USB 串口板，两台机器）
2. 账号制：`docs/accounts-test.md`
3. SSH 远程接入：`docs/features/remote-ssh.md`
4. 手机审批（局域网本地通知）、PR/CI（`docs/test-guides/pr-ci.md`）、Windows 路径与中文编码
用户可以先用「设置 → 关于 → 演示工作区 / 体验清单」体验，反馈用反馈模式导出 json 发飞书。

## 等用户决定
- 是否准备上架（需补隐私政策页、权限说明；软著与商店账号由用户办）——见 docs/features/release.md
- 桌面代码签名是否购买证书——见 docs/features/release.md

## 用户已定的方向（不要回退）
docs/design.md 末尾按日期记录；最近的：暂不做 iOS；做任务看板；工作站与设备共享；账号制；分工路由（不在同会话切模型、简单任务不能变复杂、要能人工选择）。

## 没有用户时怎么推进
- 自用测试闭环：代理用户用真实账号副本走 5 个真实任务 → 用反馈模式记录 → 按 docs/feedback-ledger.md 根因修（复发必须共享层修 + 自动检查）→ 下一轮复验。记录在 `docs/archive/dogfood/`。
- 候选功能池：docs/archive/research/explore-v2-2026-11-08.md 剩余（双向语音、OTel 导出、auto-merge 等，优先级低）；新功能优先来自用户提议与自用测试发现。
- 巡检：低频巡检 cron（每天 09:23/13:23/17:23/21:23），一切正常不打扰用户。

## 协调者工作习惯（踩过的坑）
- 子代理会卡在"等一个问题的回复"上：prompt 里写明"不要提问、不要等待回复，拿不准选最保守的做法并在回复中列出"；卡住时先 interrupt 再 send_message 唤醒，二次卡住就换新子代理接手（把它留下的改动交代清楚）。
- heavy 档子代理多次长时间只读不写；优先 midheavy/standard，任务拆小、写明第一步命令。
- 多个子代理并行时按文件划分；各自只 add 自己的文件；验证已提交状态用干净 worktree。
- 不读 git remote 的值、不 push；不连公网；测试 Host 一律 TANDEM_HOME=/tmp/…；不用 pkill -f。
