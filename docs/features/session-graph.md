# 会话图（右侧会话信息面板）

> 更新：2026-11-12。设计原则见 [design.md](../design.md) 的 P04；交互规范见 [archive/plan/session-graph-2026-11-11.md](../archive/plan/session-graph-2026-11-11.md)（历史决定）；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R14/R72。

## 是什么

右侧「会话信息」面板的「会话图」卡片，用 git graph 式的纵向泳道展示会话结构。**一棵会话树只有一张图**：根会话 + 它的所有分叉（递归）+ 这些会话派生的所有子代理，全部轮次都是图里的节点；树内任何会话打开时看到的节点与连线完全相同，只有「主线」随当前会话切换（用户 2026-11-12 原话：仿照 Git 的图，拓扑结构完全一样，只是主线不同）。

- **节点 = 轮次**：每个会话每一轮一个节点，文字是用户首行（单行省略）。**时间倒序**：最新一轮在最上。不显示轮号、token 或耗时。
- **主线（trunk）**：当前会话的祖先链——当前会话的轮次 + 它来源会话在分叉点之前的轮次（递归到根）——画在第 0 列，一条直线上去（对应 git 当前分支）。打开主会话时主线就是主会话；打开分叉时主线是「根轮次 … 分叉轮次」。
- **分支泳道**：其余会话的独有轮次从它们与主线的分叉点分出去。分叉不汇回；子代理泳道始终展开、最后一行汇回父会话的下一轮（或轨道下一行）。主会话上派出的子代理在分叉视图里同样可见。
- **分叉会话的「独有轮次」**：分叉复制来的祖先轮次不重复画，接入点指向祖先会话的那一轮。

卡片内容直接是会话图，标题行不再显示 `N 轮 · N 子代理 · N 分叉` 汇总，也没有单独的「展开」按钮（用卡片右上角的「全高显示会话图」图标）。卡片内高度按行数自适应：最小 3 行（84px）、最大 12 行（336px），超过后固定高度、内部滚动；全高展开模式不变（反馈16#09）。全高页头只有「← 返回 · 会话图」。

## 视觉

- 所有节点是**同一种 8px 实心圆**，颜色 = 泳道色；主线固定 `--graph-lane-0`，其余泳道 `--graph-lane-1..7` 循环，深浅主题各一套。
- 轨道式（反馈2108#01 打分卡选 B）：所有连线 2px、正交圆角 6px；列复用（`layout.ts` 的 `assignColumns`）：行区间不相交的分支共用一列，同轮并行或嵌套的分支占相邻列，水平线只在转折点相交（单测 `layout.test.ts`）。列距 14px（给连线命中带留空间，反馈0220#07）。
- 子代理与分叉靠「是否汇回」区分：子代理有 `data-merge` 汇回线；分叉不合并且会话起点节点行尾写「分叉」。
- 当前所在轮用节点外圈 ring 高亮；固定轮带小图钉。会话运行中时，当前会话最新一轮节点外圈用与侧栏「运行中」相同的 `running-dot` 呼吸动画（反馈2156#03，尊重 `prefers-reduced-motion`）。
- 颜色要求节点与背景 ≥ 3:1，相邻泳道色相拉开（色弱友好）。文字 ≥12px。

## 交互

- 点主线节点：对话区跳到该轮（含懒加载，复用 `focusMessage`；快速连点只定位最后一次，反馈2102#02）。只滚动定位，不再给目标消息加高亮背景（反馈2156#01，行为同轮次大纲）。
- 点其他会话的轮节点或它的泳道线：打开那个会话（分叉 → `openSession`；子代理 → `openAgentSession`，反馈0220#07）。在子代理只读视图里点主线节点：先退出子代理视图，再定位该轮（反馈1926#03）。
- **悬停泳道线或名称行**（反馈1926#10 / 0220#07）：该会话的整条轨道保持全亮、其余线降到 22%，节点行一起高亮；标准 tooltip（`data-tip`）显示会话名（分叉/派出点节点显示所在轮标题）。线有两侧各 6px 的透明命中描边（`EDGE_HIT_WIDTH`），节点圆点另有 20px 命中区，名称行整行可点。
- 键盘 ↑/↓ 按视觉顺序移动选中，Enter 打开。
- 外部会话只读预览、Task 子代理内嵌视图也展示同一渲染组件；外部会话的节点点击同样 `focusMessage` 定位该轮（反馈0220#01）。

## 数据来源与关联

- **`GET /api/sessions/:id/graph` → `SessionGraphTree`**（协议在 `packages/protocol`）：只回树内所有会话的轮次 id / 首行摘要、会话父子关系（分叉 `forkedFrom`、子代理 `parentId`）与**接入点**（分叉点轮次 / 派发子代理的轮次，可能属于祖先会话），不下发消息体。分叉复制历史（消息 id 保留）的去重、跨会话分叉点解析、`parentToolUseId → 轮次` 的映射都在服务端做。
- 客户端 `useSessionGraphTree` 按树的根缓存：同一棵树里切主会话/分叉不重新请求，树内会话更新时间变化（新轮、新分叉、子代理结束）时重新拉取。
- **子代理**：`SessionSummary.parentId` 形成树；服务端优先用 `parentToolUseId`（Task 工具的 tool_use id）定位到发起它的那一轮，旧数据按 Task description / 子代理标题兜底。
- **分叉**：只有显式分叉会持久化（`POST /api/sessions/:id/fork` 写入 `forkedFrom`）。编辑并重发只是新增一条用户消息；回退会截断消息，不保留被替换的旧分支，因此会话图不把这两种情况画成持久分支。分支名取分叉会话标题。

## 演示数据

演示场景「子代理层级」有 8 个主线轮：第 2 轮派 1 个 3 步子代理（内含 2 步嵌套子代理），第 4 轮并行派 2 个子代理，第 5 轮处有一个 3 轮的分叉会话；用于观察多泳道、汇回与不汇回，以及「打开主会话 / 打开分叉」两视图节点相同、主线不同。倒序后最上面是第 8 轮。

## 性能

- 布局算法 `packages/web/src/components/sessionGraph/layout.ts` 是纯函数：输入整棵树的会话与轮次 → 每个节点的 `(lane,row)` 与连线段，末尾统一翻转行号实现倒序；单测覆盖倒序、主线、始终展开、嵌套汇回、分叉不汇回、列复用、紧凑模式、320 轮 < 20ms。
- 渲染固定行高 28px，只挂可见行（虚拟滚动）；连线是一张整高 SVG，另有一层透明命中描边；树数据一次轻量拉取后按引用使用。

## 代码位置

- `packages/web/src/components/sessionGraph/layout.ts` + `layout.test.ts`：唯一布局（`layoutSessionGraph(input, { compact })`）与单测。
- `packages/web/src/components/sessionGraph/data.ts`：服务端树 / 只读消息流 → 布局输入。
- `packages/web/src/components/sessionGraph/useGraphTree.ts`：按树拉取并缓存 `SessionGraphTree`。
- `packages/web/src/components/sessionGraph/SessionGraphView.tsx`：渲染（节点、连线、悬停高亮、tooltip、命中区、键盘）。
- `packages/web/src/components/sessionGraph/SessionGraphCard.tsx`：右栏卡片与只读版本。
- `packages/web/src/components/session/SessionTopology.tsx`：侧栏悬停浮层（同一张图的紧凑模式，不显示轮次标题、只在会话起点显示会话名，保留分叉点/派出点）。
- 接入：`RightPanel.tsx`（分组 `graph`、全高展开）、`ExternalSessionPanel.tsx`、`ToolCard.tsx` 的 `SubagentStream`、`SessionRow.tsx`（悬停浮层；树里只有当前会话时不弹，反馈0220#06）。
- 覆盖滚动条让位：`packages/web/src/components/ui/OverlayScrollbar.tsx`（嵌套滚动容器取最外层祖先留白，反馈1926#07）。
- 服务端：`packages/server/src/host/graph.ts`（`sessionGraph`）、`packages/server/src/routes/sessions.ts`（`GET /api/sessions/:id/graph`）；`packages/server/src/host/subagents.ts` 写入 `parentToolUseId`；`packages/server/src/demo/seed.ts` 的「子代理层级」演示会话含两层子代理与一个分叉。

## 回归

`e2e/regression.mjs`「会话图：时间倒序、子代理始终展开、悬停会话线高亮、子代理视图回主会话」：无汇总行/序号/token/「结果已返回」/展开按钮；最新一轮在最上；悬停线高亮且 tooltip 是会话名；子代理视图点主线节点回主会话并定位该轮；覆盖滚动条不压卡片头部控件；点分叉打开分叉会话、全高展开/返回。

「反馈0220#08」：同一棵树里主会话视图与分叉视图节点集合、节点数相同；分叉视图主线 = 分叉点前来源轮次 + 分叉轮次（第 0 列、一条直线）；来源会话在分叉点之后是完整分支泳道（没有「原会话」单节点支线）；主会话上的子代理节点可见。
「反馈0220#07」：浮层拓扑保留分叉点/派出点节点且泳道起点连在对应轮次；悬停名称行高亮该会话线与节点；点名称行/泳道线跳转；线外 5px 悬停仍命中并 tip 出会话名。
「反馈0220#06」：单会话树不弹悬停卡片；进入反馈模式后卡片停住不消失。
「反馈0220#01」：外部会话图节点点击定位该轮。

另见 `反馈2156#01`（会话图跳转后目标消息无高亮背景）与 `反馈2156#03`（运行中轮次节点复用 `running-dot` 呼吸动画）。

`e2e/regression.mjs`「会话图泳道线 tooltip 以指针定位并完整显示在视口内」：卡片（约 280px 宽）与全屏两种尺寸下，悬停最左/最右泳道线，tooltip 都在 `body` 直接子树、矩形完全落在视口内并与指针位置对齐。

```bash
node e2e/regression.mjs --only 会话图
```
