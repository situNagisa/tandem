# Tandem 产品计划（代号）

目标：类 Claude Code Desktop 的 agent 工作台，支持多端（PC / 浏览器 / 手机）互联、多账号多模型、远程机器任务管理。

## 架构
- **Host（packages/server）**：Node.js 守护进程，跑在每台要干活的机器上（Windows/Linux/macOS）。负责 agent 循环、工具执行（Bash/Read/Write/Edit/Glob/Grep/TodoWrite/WebFetch）、权限审批、会话持久化（~/.tandem）、多 provider 适配。对外 REST + WebSocket，同时托管 web UI 静态文件。
- **Client（packages/web）**：React + Vite + Tailwind 的 SPA，响应式（桌面三栏 / 手机单栏）。可连接多个 Host（本机 + 远程），每个 Host 一个 URL+token。浏览器、手机直接访问；PC 端后续用 Electron/Tauri 打包同一份 UI 并内置本机 Host。
- **Protocol（packages/protocol）**：共享 TS 类型，是两端唯一契约。
- 跨端协同：Host 是会话的唯一事实源，多端订阅同一会话实时同步（PC 发起、手机审批/接着聊）。
- 远程：阶段 1 直连（局域网 / Tailscale / SSH 端口转发）；阶段 3 加中继服务（NAT 穿透、账号体系、推送通知）。

## 里程碑
- **M1 可用 MVP**：单 Host，多 profile/模型，会话 CRUD，流式对话，核心工具，权限审批，@文件，斜杠命令，web UI 桌面+手机布局。
- **M2 多端**：客户端多 Host 管理、配对（扫码/口令）、会话跨端接续、PWA。
- **M3 桌面壳 + 中继**：Electron 打包、托盘、系统通知；中继服务、推送。
- **M4 对齐与扩展**：MCP、子代理、hooks、CLAUDE.md/AGENTS.md、diff 审阅、git worktree、检查点回退、用量统计。
- **M5 上架**：签名、自动更新、应用商店（移动端 Capacitor）。

## 约定
- 开发语言中文（注释、文档、UI 文案）。
- 进度记录在 docs/PROGRESS.md，每次迭代更新。
