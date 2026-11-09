# 会话图（右侧会话信息面板）

> 更新：2026-11-09。用户决定见 [design.md](../design.md) 末尾「会话图配色与节点形状」。

## 是什么

在右侧「会话信息」面板新增「会话图」卡片，用类似 git graph 的纵向泳道展示一个会话的结构。所有泳道固定 x 竖直向下，分出/合并在节点旁用一段 45° 折线，连线端点落在节点圆心上：

- **主线**：每个用户轮一个节点，自上而下与对话顺序一致。节点右侧是「轮号 + 用户发言摘要（单行省略）+ token/耗时」。
- **子代理分支**：Task 派出的子代理从发起它的那一轮分出新泳道，结束处**合并回主线**（线略细/稍透明 + `data-merge`），表示结果返回。默认收起为一个「子代理 · 名称 · N 步」节点，▸ 可展开成该子代理自己的轮次与结果节点；嵌套子代理继续向右分泳道。
- **分叉分支**：其它会话以本会话为父（`forkedFrom.sessionId`）时，从分叉点分出新泳道，**不合并**，末端是分支名/会话名并带「分叉」小字；点击打开那个会话。

收起卡片时，标题行显示 `12 轮 · 3 子代理 · 1 分叉`。卡片右上角「展开」把会话图全高显示（替换面板内容，顶部「← 返回」）。

## 视觉

- 所有节点是**同一种 8px 实心圆**，颜色 = 泳道色；主线固定 `--graph-lane-0`，其余泳道 `--graph-lane-1..7` 循环，深浅主题各一套。
- 子代理与分叉不再靠节点形状区分：子代理线略细/稍透明并在结束处合并；分叉线不合并，行尾写「分叉」；子代理起点行显示子代理名。
- 当前所在轮用节点外圈 ring 高亮；固定轮带小图钉。
- 图例在卡片底部一行：主线 / 子代理（合并）/ 分叉（不合并）。
- 颜色要求节点与背景 ≥ 3:1，相邻泳道色相拉开（色弱友好）。

## 交互

- 点主线节点：对话区跳到该轮；未加载的轮复用 `focusMessage` 的「先按需加载再定位并高亮」路径。
- 点子代理节点：先跳到父轮（让 Task 卡片挂载），再打开内嵌子代理视图；▸ 只展开/收起泳道。
- 点分叉节点：打开该分叉会话（另一个会话）。
- 悬停标准 tooltip（`data-tip`）显示摘要、用量、耗时；键盘 ↑/↓ 移动选中，Enter 打开。
- 外部会话只读预览、Task 子代理内嵌视图也展示同一渲染组件（只读、不跳转）。

## 数据来源与关联

- **轮次**：当前会话已加载的用户消息；用量用 `usageByTurn`（含子代理）汇总。
- **子代理**：`SessionSummary.parentId` 形成树；优先用新增的可选字段 **`parentToolUseId`（Task 工具的 tool_use id）** 定位到发起它的那一轮。旧数据没有该字段时按 Task description / 子代理标题兜底。`parentToolUseId` 由服务端 `runSubagent` 记录并随摘要下发，纯增量、向后兼容。
- **分叉**：只有显式分叉会持久化（`POST /api/sessions/:id/fork` 写入 `forkedFrom`）。编辑并重发只是新增一条用户消息；回退会截断消息，不保留被替换的旧分支，因此会话图不把这两种情况画成持久分支。分支名取分叉会话标题。

## 演示数据

演示场景「子代理层级」有 8 个主线轮：第 2 轮派 1 个 3 步子代理（内含 2 步嵌套子代理），第 4 轮并行派 2 个子代理，第 5 轮处有一个 3 轮的分叉会话；用于观察多泳道、合并与不合并。

## 性能

- 布局算法 `packages/web/src/components/sessionGraph/layout.ts` 是纯函数：输入会话树 → 每个节点的 `(lane,row)` 与连线段，单测覆盖主线、单子代理合并、嵌套、分叉不合并、混合与 320 轮 < 20ms。
- 渲染固定行高 28px，只挂可见行（虚拟滚动）；连线是一张整高 SVG；数据按会话增量构建。

## 代码位置

- `packages/web/src/components/sessionGraph/layout.ts` + `layout.test.ts`：布局与单测。
- `packages/web/src/components/sessionGraph/data.ts`：把消息/子代理/分叉组装成布局输入。
- `packages/web/src/components/sessionGraph/SessionGraphView.tsx`：渲染（节点、连线、图例、键盘）。
- `packages/web/src/components/sessionGraph/SessionGraphCard.tsx`：右栏卡片与外部只读版本。
- 接入：`RightPanel.tsx`（分组 `graph`、全高展开）、`ExternalSessionPanel.tsx`、`ToolCard.tsx` 的 `SubagentStream`。
- 服务端：`packages/protocol/src/index.ts` 的 `SessionSummary.parentToolUseId`；`packages/server/src/host/subagents.ts` 写入；`demo/seed.ts` 的「子代理层级」演示会话含两层子代理与一个分叉。

## 回归

`e2e/regression.mjs`「会话图：轮次节点、彩色泳道、子代理合并线与分叉标签可区分」：演示会话里断言所有节点同一形状、不同泳道颜色不同、子代理有 `data-merge` 合并线、分叉无合并且带「分叉」标签、点主线节点跳转高亮、全高展开/返回、点分叉打开分叉会话。

```bash
node e2e/regression.mjs --only 会话图
```
