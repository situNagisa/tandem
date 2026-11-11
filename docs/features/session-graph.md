# 会话图（右侧会话信息面板）

> 更新：2026-11-11。设计原则见 [design.md](../design.md) 的 P04；信息与交互规范见 [archive/plan/session-graph-2026-11-11.md](../archive/plan/session-graph-2026-11-11.md)；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R14/R05。

## 是什么

右侧「会话信息」面板的「会话图」卡片，用 git graph 式的纵向泳道展示会话结构。主线固定第 0 列；分支占 12px 列距，分出/汇回是正交圆角折线，端点落在列中心：

- **主线**：每个用户轮一个节点，节点文字是用户首行（单行省略）。**时间倒序**：最新一轮在最上，越早越下。不显示轮号、token 或耗时。
- **子代理分支**：始终展开（没有 ▸/└ 与收起节点），一个子代理轮一行；最后一行由一条 `data-merge` 的汇回线接回父会话——父会话有下一轮时落在那一轮节点，是最后一轮时落在主线轨道的下一行。没有「结果已返回」行。
- **分叉分支**：其它会话以本会话为父（`forkedFrom.sessionId`）时，从分叉点分出，**不汇回**，端点是分支名并带「分叉」小字；点击打开那个会话。当前打开的是分叉时，该分叉占主线轨道，来源会话与其他分叉作为分支泳道（来源会话行尾写「原会话」），做法与侧栏会话树、悬停拓扑图一致，见 [session-tree.md](session-tree.md)。

卡片内容直接是会话图，标题行不再显示 `N 轮 · N 子代理 · N 分叉` 汇总，也没有单独的「展开」按钮（用卡片右上角的「全高显示会话图」图标）。卡片内高度按行数自适应：最小 3 行（84px）、最大 12 行（336px），超过后固定高度、内部滚动；全高展开模式不变（反馈16#09）。全高页头只有「← 返回 · 会话图」。

## 视觉

- 所有节点是**同一种 8px 实心圆**，颜色 = 泳道色；主线固定 `--graph-lane-0`，其余泳道 `--graph-lane-1..7` 循环，深浅主题各一套。
- 轨道式（反馈2108#01 打分卡选 B）：所有连线 2px、正交圆角 6px；列复用（`layout.ts` 的 `assignColumns`）：行区间不相交的分支共用一列，同轮并行或嵌套的分支占相邻列，水平线只在转折点相交（单测 `layout.test.ts`）。
- 子代理与分叉靠「是否汇回」区分：子代理有汇回线；分叉不合并且行尾写「分叉」。
- 当前所在轮用节点外圈 ring 高亮；固定轮带小图钉。
- 颜色要求节点与背景 ≥ 3:1，相邻泳道色相拉开（色弱友好）。文字 ≥12px。

## 交互

- 点主线节点：对话区跳到该轮（含懒加载，复用 `focusMessage`；快速连点只定位最后一次，反馈2102#02）。
- **在子代理只读视图里点主线节点**：先退出子代理视图（`closeAgentSession`），再定位该轮（反馈1926#03）。
- 点子代理轮节点：打开该子代理只读会话（面包屑可返回主会话）。
- 点分叉节点：打开该分叉会话（另一个会话）。
- **悬停泳道线**（反馈1926#10）：每条线有 12px 透明命中描边；悬停时该会话的整条轨道（分出 + 汇回）保持全亮，其余线降到 22%，标准 tooltip（`data-tip`）显示归属会话名（主线=当前会话标题、子代理=该子代理标题、分叉=分叉会话标题）。线是细长目标，命中描边带 `data-tip-anchor="pointer"`，tooltip 按指针位置锚定（而不是整条线的包围盒中心），并渲染在 `body` 层按视口夹紧，卡片/窗口边缘悬停时完整可见。
- 键盘 ↑/↓ 按视觉顺序移动选中，Enter 打开。
- 外部会话只读预览、Task 子代理内嵌视图也展示同一渲染组件（只读、不跳转）。

## 数据来源与关联

- **轮次**：当前会话已加载的用户消息；注入内容不算用户轮。
- **子代理**：`SessionSummary.parentId` 形成树；优先用可选字段 **`parentToolUseId`（Task 工具的 tool_use id）** 定位到发起它的那一轮。旧数据没有该字段时按 Task description / 子代理标题兜底。`parentToolUseId` 由服务端 `runSubagent` 记录并随摘要下发，纯增量、向后兼容。
- **分叉**：只有显式分叉会持久化（`POST /api/sessions/:id/fork` 写入 `forkedFrom`）。编辑并重发只是新增一条用户消息；回退会截断消息，不保留被替换的旧分支，因此会话图不把这两种情况画成持久分支。分支名取分叉会话标题。

## 演示数据

演示场景「子代理层级」有 8 个主线轮：第 2 轮派 1 个 3 步子代理（内含 2 步嵌套子代理），第 4 轮并行派 2 个子代理，第 5 轮处有一个 3 轮的分叉会话；用于观察多泳道、汇回与不汇回。倒序后最上面是第 8 轮。

## 性能

- 布局算法 `packages/web/src/components/sessionGraph/layout.ts` 是纯函数：输入会话树 → 每个节点的 `(lane,row)` 与连线段，末尾统一翻转行号实现倒序；单测覆盖倒序、主线、始终展开、嵌套汇回、分叉不汇回、列复用、320 轮 < 20ms。
- 渲染固定行高 28px，只挂可见行（虚拟滚动）；连线是一张整高 SVG，另有一层透明命中描边；数据按会话增量构建。

## 代码位置

- `packages/web/src/components/sessionGraph/layout.ts` + `layout.test.ts`：布局与单测。
- `packages/web/src/components/sessionGraph/data.ts`：把消息/子代理/分叉组装成布局输入。
- `packages/web/src/components/sessionGraph/SessionGraphView.tsx`：渲染（节点、连线、悬停高亮、tooltip、键盘）。
- `packages/web/src/components/sessionGraph/SessionGraphCard.tsx`：右栏卡片与外部只读版本。
- 接入：`RightPanel.tsx`（分组 `graph`、全高展开）、`ExternalSessionPanel.tsx`、`ToolCard.tsx` 的 `SubagentStream`。
- 覆盖滚动条让位：`packages/web/src/components/ui/OverlayScrollbar.tsx`（嵌套滚动容器取最外层祖先留白，反馈1926#07）。
- 服务端：`packages/protocol/src/index.ts` 的 `SessionSummary.parentToolUseId`；`packages/server/src/host/subagents.ts` 写入；`packages/server/src/demo/seed.ts` 的「子代理层级」演示会话含两层子代理与一个分叉。

## 回归

`e2e/regression.mjs`「会话图：时间倒序、子代理始终展开、悬停会话线高亮、子代理视图回主会话」：无汇总行/序号/token/「结果已返回」/展开按钮；最新一轮在最上；悬停线高亮且 tooltip 是会话名；子代理视图点主线节点回主会话并高亮该轮；覆盖滚动条不压卡片头部控件；点分叉打开分叉会话、全高展开/返回。

`e2e/regression.mjs`「会话图泳道线 tooltip 以指针定位并完整显示在视口内」：卡片（约 280px 宽）与全屏两种尺寸下，悬停最左/最右泳道线，tooltip 都在 `body` 直接子树、矩形完全落在视口内并与指针位置对齐。

```bash
node e2e/regression.mjs --only 会话图
```
