# Tandem 交互走查 v6（2026-11-07）

本轮按"真实点击每一个可交互控件"执行，不再只截静态图。标准参照 Claude Code Desktop 与 `docs/design.md` 末尾数轮用户反馈。

## 范围与方法

- 构建：`npm run build` 通过；Host 使用 `TANDEM_HOME=/tmp/tandem-qa6`，端口 8061，未使用 `~/.tandem`。
- 数据：1 个账号（OpenAI / Anthropic 两组假 Key）、120 轮长会话（工具调用、thinking、usage、计划、待办）、子代理会话（parentId/depth）、置顶/归档/外部 Claude Code 会话；`/tmp/tandem-qa6/repo` 含 M/A/D/U 改动。
- 视口 × 主题：1280×800、2560×1392、390×844；深色、浅色。
- Playwright 枚举 `button / [role=button] / [role=menuitem] / [role=tab] / a / input / textarea / [tabindex]`，逐个点击或聚焦，检查 DOM 变化、路由、console、弹层越界、Esc、横向滚动、焦点与尺寸跳动。
- 覆盖：侧栏筛选/主机/⋯菜单全部项/重命名/置顶/归档入口/外部只读页；新会话；环境条；输入框底栏（附件、思考、权限、模型 Tab/强度、上下文环、`/` 与 `@`）；消息操作条；轮次条（滚轮、拖动、首尾、点击）；工具卡/子代理卡；文件链接预览；改动审阅（选行评论、提交区、丢弃）；右侧栏（分组拖动、显隐、计划全文）；设置全部 8 页；搜索 Ctrl+K；反馈模式 Ctrl+Shift+F。
- 写入/危险操作只走到确认层，不实际删除 Host/账号或丢弃改动。截图中的文件预览 404 是造数据里刻意不存在的 `src/module9.ts`，不是应用故障。

## 结论

- **P0：0**
- **P1：1，已修 1**
- **P2：5，已修 2，遗留 3**

## 重点复验

1. **轮次条**
   - 1280×800：rail 位于滚动区右缘内侧 18px；刻度视觉 18×2px，命中区 26×16px，间距 16px；当前窗口显示 26 个刻度，首尾 `1/120` 按钮常驻。
   - 2560×1392：rail 18px 宽、距滚动区右缘 18px，显示 63 个刻度，`第 117/120 轮`。
   - 滚轮在刻度条上可逐轮移动；拖动可连续跳转；首/尾按钮正常。
   - 修复前：点击第 75/76/80 轮分别跳到 76/55/38 轮。修复后：点击第 108 轮稳定落到第 108 轮，悬停 tooltip 与刻度一致；键盘 Enter 也可跳转。
2. **改动审阅 diff 配色（照抄 Claude Code）**
   - 增行 `rgba(46, 160, 67, 0.15)`，删行 `rgba(248, 81, 73, 0.15)`；`+` 绿色、`−` 红色；文件行 A/M/U/D 与 `+N/−M` 分色。计算样式实测与用户给定值一致。
   - 选行直接弹输入浮窗，不再插入行；保存后行右侧出现评论标记，底部出现"1 条评论 · 发给 agent"。
3. **设置窗口 2560×1392**
   - 实际 1320×920，占视口 51.6%×66.1%，四边留白均衡；左侧导航 176px，内容列 max 880px 左对齐。比例协调，未改。
   - 8 个页签在 1280/2560/390 下均可切换；390 下全屏、两列导航，无横向滚动。

## 问题清单

| ID | 位置 | 现象 | 严重度 | 根因 | 状态 |
|---|---|---|---|---|---|
| P1-1 | 轮次条 `chat/TurnRail.tsx`、`styles/chat.css` | 点击某个刻度跳到相邻/更远轮次（75→76、76→55、80→38） | P1 | 刻度 `::before` 命中区高 32px、相邻互相覆盖；pointerdown 取 event.target 的下一个刻度，松手后窗口重排又触发 click 二次跳转 | **已修**：刻度 16px 高、命中区不再重叠；pointerdown 按指针 Y 取最近刻度；鼠标 click 不再二次跳转，键盘 click 保留 |
| P2-1 | 设置 → 账号卡片（390） | 同一张卡同时出现图标操作行和整宽"测试/编辑/删除"行，编辑与删除重复 | P2 | `.settings-actions { display:flex }` 覆盖了 `hidden`，`sm:flex` 的隐藏断点失效 | **已修**：桌面图标行加 `data-desktop-only`，<640px 隐藏 |
| P2-2 | 输入框 `@` 空查询 | 刚输入 `@` 显示"没有匹配的文件"，看起来像空菜单/无响应 | P2 | Host `/api/fs/complete` 对空 q 直接返回 `[]`；客户端统一用"没有匹配的文件" | **已修**文案为"输入文件名或目录以搜索"（仍需输入字符后出候选；不做全量首屏文件列表） |
| P2-3 | 新会话页（390） | "常用"横向提示条裁切第三张卡，无滚动条/渐隐，首次使用像内容溢出 | P2 | 用户选定方案 B 横向提示条 + `no-scrollbar`，未加边缘渐变 | 遗留（设计取向；建议加右侧渐隐或分页指示） |
| P2-4 | 设置 → 同步与备份 | 导出成功 toast 出现在右上角，短暂遮住设置弹窗关闭按钮附近 | P2 | Toast 固定右上、层级高于 Modal | 遗留（约 3 秒自动消失，不阻断；建议 Modal 打开时下移 toast） |
| P2-5 | 会话消息操作（390） | 触屏下消息下方常显一个孤立"…"，可发现性弱、像装饰符号 | P2 | `@media (hover:none)` 用纯 IconButton 替代桌面操作条 | 遗留（功能可用；建议给 44px 触控底/边框） |

## 已修改文件

- `packages/web/src/components/chat/TurnRail.tsx`
- `packages/web/src/styles/chat.css`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/components/settings/ProfilesSection.tsx`
- `packages/web/src/components/settings/HostsSection.tsx`
- `packages/web/src/index.css`
- `docs/qa-v6.md`

未修改 `packages/server`（走查期间该目录已出现同事的 providers/agent 改动，未触碰、未提交）。

## 证据

- 截图（修复前/后，三视口 × 深浅色）：`/tmp/qa6-artifacts/shots/`
- Playwright 脚本：`/tmp/qa6-artifacts/scripts/`
- 构建日志：`/tmp/qa6-artifacts/build.log`
- 原始探针结果：`/tmp/qa6-artifacts/shots/desk1280-dark/probe.json`

## 2026-11-08 P2 复核

- P2-3 新会话（390）常用横向条裁切：**已不复现**——新会话页已无「常用」横向卡片条。
- P2-4 导出 Toast 遮设置关闭按钮：**已修**——设置打开时 Toast 移到弹窗标题下方（桌面顶部、手机导航上沿）。
- P2-5 触屏消息操作孤立「…」：**已修**——触屏下「更多操作」按钮补 44px 边框与浅底，不再像装饰符号。

