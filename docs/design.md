# Tandem 设计规范 v2（参考 Claude 桌面 app / claude.ai/code）

气质：温暖、安静、克制。大量留白，暖色中性灰，唯一强调色为 Claude 橙；靠细边框、层次背景和微动效体现精致，不靠重阴影和饱和色。

## 色板（CSS 变量，定义在 packages/web/src/index.css，组件只用变量）
| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| --bg | #FAF9F5 | #262624 | 主背景（对话区） |
| --bg-sidebar | #F5F4ED | #1F1E1D | 侧栏 |
| --bg-elevated | #FFFFFF | #30302E | 输入框卡片、Popover、对话框 |
| --bg-hover | rgba(31,30,29,.05) | rgba(255,255,255,.05) | hover |
| --bg-active | rgba(31,30,29,.08) | rgba(255,255,255,.09) | 选中项 |
| --bg-subtle | #F0EEE6 | #2B2A27 | 代码块、工具详情、用户气泡 |
| --border | rgba(31,30,29,.10) | rgba(255,255,255,.08) | hairline 边框（1px / 0.5px 高分屏） |
| --border-strong | rgba(31,30,29,.18) | rgba(255,255,255,.16) | 聚焦、分隔 |
| --text | #1F1E1D | #F5F4EE | 主文字 |
| --text-secondary | #5E5D59 | #C2C0B6 | 次要 |
| --text-tertiary | #8F8D86 | #8A8880 | 工具行、时间、占位 |
| --accent | #D97757 | #D97757 | 强调（发送按钮、焦点、待审批） |
| --accent-hover | #C6613F | #E08868 | |
| --accent-soft | rgba(217,119,87,.12) | rgba(217,119,87,.16) | 强调背景 |
| --success | #5A8F5A | #7DB87D | |
| --danger | #BF4D43 | #E07A70 | |
| --diff-add-bg / --diff-del-bg | rgba(90,143,90,.12) / rgba(191,77,67,.12) | rgba(125,184,125,.14) / rgba(224,122,112,.14) | |

## 字体
- 正文：`-apple-system, "Segoe UI Variable", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif`
- 标题/问候：衬线 `"Iowan Old Style", "Palatino Linotype", Georgia, "Songti SC", "Noto Serif SC", serif`（只用于新会话问候、空态大标题）
- 等宽：`ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace`
- 字号阶梯：12 / 13 / 14 / 15（正文 15，行高 1.65）/ 17 / 22 / 30（问候）。侧栏 13–14。工具行 13。

## 间距 / 圆角 / 阴影
- 间距基数 4：4 8 12 16 20 24 32 48。
- 圆角：小控件 6，按钮/菜单项 8，卡片/Popover 12，输入框卡片 18–20，发送按钮圆形。
- 阴影：`--shadow-sm: 0 1px 2px rgba(0,0,0,.04)`；`--shadow-md: 0 4px 16px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.04)`（Popover/输入框）；`--shadow-lg: 0 12px 40px rgba(0,0,0,.12)`（对话框）。深色模式阴影加深、边框承担层次。

## 动效
- 时长：微交互 120ms，Popover/菜单 160ms，抽屉/对话框 220ms。
- 缓动：`--ease-out: cubic-bezier(.16,1,.3,1)`；退出用 `cubic-bezier(.4,0,1,1)` 且更快（100ms）。
- Popover/菜单：opacity 0→1 + scale .97→1，transform-origin 指向触发点。
- 消息进入：opacity + translateY(4px→0)，仅新消息。工具展开：高度过渡（grid-rows 0fr→1fr）。
- `prefers-reduced-motion: reduce` 时关闭位移动画。

## 布局
- 侧栏默认 272px，可拖拽 220–400，记住宽度；Ctrl/Cmd+B 收起。
- 对话内容列最大宽 760px 居中；输入框同宽，贴底，底部留 16–20px。
- 顶栏 48px，无边框背景与对话区一致，滚动后出现 hairline 下边框。
- 移动端 <768px：侧栏为左滑抽屉（遮罩 + 跟手），输入框贴底含安全区，触控目标 ≥44px。

## 组件要点
- **侧栏**：顶部「新会话」按钮 + 搜索；会话按 Host → 项目（env.repoName 或 cwd basename）分组，组头小号次要色 + 分支名，可折叠；会话项单行标题 + 右侧相对时间，hover 显示 ⋯；状态：运行中 = 橙色呼吸点，待审批 = 实心橙点；置顶区在最上。底部：设置、主题。
- **用户消息**：右对齐，--bg-subtle 圆角 16 气泡，最大宽 85%。
- **Assistant**：无气泡纯排版。
- **工具行**：13px --text-tertiary，图标 14px + 动词 + 目标（"读取 src/a.ts"、"运行 npm test"、"编辑 src/b.ts +3 −1"），右侧 chevron；连续 ≥3 个工具折叠为"使用了 N 个工具"。运行中图标转圈；错误为 --danger。
- **输入框**：--bg-elevated、--border、--shadow-md、圆角 20；聚焦 border 变 --border-strong；底行左：附件、权限模式胶囊；右：模型选择器（文字按钮）、发送圆钮（空内容时淡化，运行中变为停止方块）。
- **审批卡**：位于输入框上方，--bg-elevated + 左侧 3px 橙色条，按钮"允许(1) / 总是允许(2) / 拒绝(3)"。
