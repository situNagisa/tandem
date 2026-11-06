# 进度

## 2026-11-05 迭代 1（M1）
- [x] monorepo + 协议定义（packages/protocol）
- [x] server M1（a68f820）
- [x] web M1（12c04a5）
- [x] 竞品调研 docs/research.md
- [x] 集成冒烟：host 托管 web、REST 正常
- [ ] 真实 key 端到端（待用户体验）

## 已知缺口（下一迭代候选，按 research.md P0）
- 断线事件重放（seq 号）、检查点回退、diff 按文件审阅/批量提交、git worktree
- 会话重命名、长列表虚拟化、图片压缩
- 手机推送、HTTPS（PWA 需要）、配对扫码
- Bash 后台运行；权限规则 allow/ask/deny 配置化

## 迭代 2（进行中）
- [x] web v2 视觉与交互精修（design.md 设计规范、侧栏按项目分组+会话管理、添加账号自动拉模型、新会话页、无 Host 引导页）
- [x] server v2：/api/models、会话 env/置顶/归档/fork、自动标题
- [x] Android APK（Capacitor，npm run apk -w @tandem/mobile）
- [x] 用户体验 v2

## 迭代 3（2026-11-06）
- [x] 视觉：去彩色徽章、对比度 AA、可点 affordance、全局过渡动画、右栏紧凑
- [x] bug：粘贴图片重复（items+files 重复计入）、侧栏收起残留（外层未裁剪）
- [x] 账号分组；导入 Claude Code/Codex 会话（只读+复制继续）；配置加密导出/导入
- [x] 内部评审 docs/review-v3.md（P1 6 条全修，P2 18 条修 4）
- [x] （用户：继续迭代，差不多再体验）

## 迭代 4（2026-11-06）
- [x] server：seq 断线重放、检查点回退、git 改动审阅、权限规则、/cost、空闲超时、标题时机
- [x] web：审阅面板/行内评论/提交、回退对话框、权限规则页、重连条、消息操作、草稿、粘贴折叠、通知、快捷键、长会话性能
- [x] 真实模型 e2e（docs/e2e-report.md）：修复工具乱序、悬空 tool_calls
- [x] 内部评审 v4（docs/review-v4.md）：P1 10 条全修，P2 修 13，遗留 3

## 迭代 5（2026-11-06）
- [x] server：MCP、子代理 Task、worktree 会话、用量统计、配对
- [x] 桌面端 Electron（Windows NSIS 安装包、托盘、内置 Host）——未在 Windows 实机启动验证
- [x] web：上述功能界面 + 扫码配对 + 桌面标题栏适配
- [x] 内部评审 v5（docs/review-v5.md）：P1 6 全修，P2 21 修 17
- [x] 用户体验 v5

## 迭代 6（2026-11-06）——主题：质量优先，先修 bug 和配色，不加新功能
- 协调者亲自用 Playwright 点击验收用户每条反馈；新增 E（外部会话注入标签清理、侧栏折叠、错误色）、F（错误重复展示、Toast）、server 错误文案可读化
- [x] A 配色按 Claude Code Desktop 取色重做、去红绿；侧栏三层层级重构；Popover 越界；去重复入口
- [x] B 对话区卡顿定位；思考过程显示/折叠/隐藏；工具默认折叠；轮次导航条
- [x] C 外部会话直接在侧栏只读打开、导入后才能发消息；分组独立协议类型
- [x] D 新会话页按钮无反应；设置窗口尺寸固定；全应用 bug 扫雷
- 下一步候选：Windows 实机验证桌面端；Anthropic provider 真实 key 测试；中继服务（NAT 穿透、不在同一局域网也能连）；hooks；计划模式面板；PR 集成；定时任务
- 遗留：深色行内代码/diff 对比、移动端 diff 横滑提示、顶栏控件偏多、账号卡缩进

## 用户反馈记录
- 2026-11-06 v5：bug 多不好用；导入应直接在侧栏只读显示；新会话按钮无反应；会话卡顿；要隐藏思考、轮次导航；分组要独立协议；工具默认折叠；红绿配色廉价（给了 CCD 截图）；Host 弹层被遮；设置窗口尺寸跳；侧栏层级平淡；重复入口多。
- 2026-11-06 v2：彩色徽章廉价；侧栏收起 bug；字看不清/不像按钮；缺过渡动画；右栏太大；粘贴图片重复；换电脑要重配、想读 Claude/Codex 会话；账号要支持多分组；建议内部互评。
- 2026-11-05 v1：整体不够精致（布局/流程/动画/配色僵硬）；添加 Key 后模型要手填；侧栏不能管理会话、不能按环境归类；想要 APK。

## 迭代 7–9（2026-11-06）
- 协作方式：自主连续迭代；UI 用打分卡（docs/scorecard-v7、v8）让用户选方案，结论记在 design.md 末尾
- [x] 会话内文件链接 → 文件预览面板（行号定位、MD 预览、本机打开）
- [x] 中继服务 packages/relay（E2E 加密、hostId 公钥绑定）+ 客户端接入 + Docker/Caddy 一键部署（未在公网实测）
- [x] Hooks（兼容 Claude 配置）、计划模式 ExitPlanMode 面板
- [x] 按钮/控件体系（ui/*，主按钮白底黑字）；scorecard-v7 九项与 v8 十项全部落地并亲自验收
- [x] 手机端发送按钮出屏 P0；README（构建/打包说明）
- 待：中继公网部署（需用户提供服务器/域名）；Anthropic 真实 key 测试；Windows 实机验证桌面端
