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
- [ ] web v2 视觉与交互精修（design.md 设计规范、侧栏按项目分组+会话管理、添加账号自动拉模型）
- [ ] server v2：/api/models、会话 env/置顶/归档/fork、自动标题
- [ ] Android APK（Capacitor）

## 用户反馈记录
- 2026-11-05 v1：整体不够精致（布局/流程/动画/配色僵硬）；添加 Key 后模型要手填；侧栏不能管理会话、不能按环境归类；想要 APK。
