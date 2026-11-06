# Tandem 设计规范 v2（参考 Claude 桌面 app / claude.ai/code）

气质：温暖、安静、克制。大量留白，暖色中性灰，唯一强调色为 Claude 橙；靠细边框、层次背景和微动效体现精致，不靠重阴影和饱和色。

## 色板 v3（2026-11-06 依据用户提供的 Claude Code Desktop 深色截图取色重定）
原则：**几乎无彩色**。层次只靠中性灰的明度差（深色约 4 级：#191919 / #1F1F1F / #2A2A2A / #303030 / 选中 #404040）。
强调色橙只用于：品牌 logo、发送按钮、焦点环、待审批提示。**不再使用绿色/红色表达状态**：
- 在线/空闲/成功 → 不显示或中性灰点；运行中 → 中性色转圈/呼吸点（--text-secondary）；待审批 → 橙点。
- 错误 → 文字用 --danger（低饱和砖红，仅文字，不做色块背景）；离线 → --text-tertiary 灰点。
- diff 增删：深色用极低不透明度底色（+ rgba(255,255,255,.06) 与左侧 2px 竖条 + "+/−" 符号区分；增行竖条 #8A9A7B 灰绿、删行 #A87363 灰砖，饱和度 <25%），文字保持主文字色。不出现鲜绿鲜红。
- "危险操作"按钮：中性按钮 + hover 时文字转 --danger，不要红框红底。

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| --bg | #FAF9F7 | #191919 | 主对话区 |
| --bg-sidebar | #F3F2EE | #1F1F1F | 侧栏 |
| --bg-subtle | #EDECE8 | #2A2A2A | 行内代码、代码块、分段控件底、用户气泡 |
| --bg-elevated | #FFFFFF | #303030 | 输入框卡片、Popover、对话框 |
| --bg-hover | rgba(0,0,0,.04) | rgba(255,255,255,.05) | hover |
| --bg-active | rgba(0,0,0,.07) | #404040 | 侧栏选中项、分段控件选中 |
| --border | rgba(0,0,0,.08) | rgba(255,255,255,.07) | hairline |
| --border-strong | rgba(0,0,0,.14) | rgba(255,255,255,.14) | 聚焦 |
| --text | #1A1A1A | #EFEFEF | 主文字 |
| --text-secondary | #5C5C5C | #B9B9B9 | 次要、侧栏项 |
| --text-tertiary | #737373 | #8A8A8A | 分组标题、时间、占位（≥4.5:1） |
| --accent | #D97757 | #D97757 | 仅见上文用途 |
| --danger | #B4533F | #D08770 | 仅错误文字 |

## 侧栏信息层级（参考 Claude Code Desktop 截图）
- 顶部：主操作列表式（图标+文字，无边框）："新会话"、"搜索"——**全应用只此一个新会话入口**（另保留 Ctrl/Cmd+N 快捷键）。
- 分组标题：12px --text-tertiary，可折叠的小三角；组标题右侧 hover 出现 "+"（在该项目下新建会话）。
- 层级用缩进与字号/字重区分，不用框和底色：Host（仅在 ≥2 个 Host 时显示为一级分组，13px 中字重+服务器图标）→ 项目（13px 常规+文件夹图标，--text-secondary）→ 会话（13.5px，--text-secondary，选中 --text + --bg-active 圆角 8）。
- 底部一行：Host 切换（小字 "本机 · linux"，点击 Popover 向上弹出、不越界）+ 设置齿轮——**全应用唯一设置入口**。账号/模型管理只在设置里，模型选择器底部仅一个"管理账号…"链接。
- 外部会话（Claude Code / Codex）直接列在侧栏对应项目组里，标题前小号来源图标（灰），打开即只读查看；输入框位置替换为"在 Tandem 中继续"按钮。

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
