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
- [ ] 用户体验 v3
- 遗留：深色行内代码/diff 对比、移动端 diff 横滑提示、顶栏控件偏多、账号卡缩进

## 用户反馈记录
- 2026-11-06 v2：彩色徽章廉价；侧栏收起 bug；字看不清/不像按钮；缺过渡动画；右栏太大；粘贴图片重复；换电脑要重配、想读 Claude/Codex 会话；账号要支持多分组；建议内部互评。
- 2026-11-05 v1：整体不够精致（布局/流程/动画/配色僵硬）；添加 Key 后模型要手填；侧栏不能管理会话、不能按环境归类；想要 APK。
