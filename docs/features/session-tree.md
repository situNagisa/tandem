# 会话树（侧栏会话行、悬停拓扑图、切分支）

> 更新：2026-11-11。用户 2026-11-11 22:09 原话决定了三件事，单点断言在 `scripts/decisions-check.mjs` 的 `sidebar-fork-same-row`、`sidebar-hover-topology`、`graph-trunk-current`。绘制规范、颜色与高度见 [session-graph.md](session-graph.md)。

## 一行一棵会话树

- 分叉不新增侧栏行，与根会话共用一行；行标题始终是根会话标题（用户原话「以后分叉就不要新增一个会话选项卡了，跟原来的会话共用一个选项卡」）。
- 点击该行打开树内**最近活动**的会话（主会话或某个分叉）；当前打开的是分叉时，行内标题后用 12px 次要文字标出所在分叉名（`data-session-branch`）。
- 未读、运行中、待审批按树内任一会话汇总；汇总优先级：待审批 → 运行中 → 等待网络 → 错误 → 空闲。
- 置顶按整棵树生效：行出现在置顶区时，取消置顶会取消树内所有会话的置顶，避免分叉留在置顶区。
- 子代理/孙代理仍不进侧栏；根会话已归档而分叉未归档时，分叉退回独立一行，不会消失。会话树的归并口径在 `lib/sessionTree.ts`（分叉跟 `forkedFrom`、子代理跟 `parentId` 向上找根）。

## 悬停拓扑图

- 悬停任一会话行，在行右侧弹出浮层；悬停延迟与标准 tooltip 相同（500ms 弹出、300ms 收起，常量共用 `Tip` 的 `TIP_SHOW_DELAY`/`TIP_SKIP_DELAY`），移入浮层不消失，`Esc`、点击、移出后收起。
- 浮层里是**拓扑图**：节点 = 会话（主会话、分叉、子代理、孙代理），不是轮次；不显示轮次文字、token、耗时。节点标签只有简短会话名（单行截断），节点 tooltip 显示全名。
- 布局、正交圆角连线、泳道色、8px 同形圆节点、悬停整条轨道高亮 + 会话名 tooltip、当前会话外圈高亮，全部复用右栏会话图的 `layout.ts` / `SessionGraphView`（拓扑模式 `layoutSessionTopology`）。
- 根会话在主线第 0 列第一行，分支从新到旧向下铺开；同一会话的多个分支各占一列，嵌套子代理继续向右。
- 点节点切换：分叉 → 打开该会话；子代理 → 打开只读子会话；主线 → 打开根会话。行标题的标准 tooltip 保留（截断标题看全文），浮层内的节点/连线 tooltip 与它共用同一套样式。

## 切分支（右栏会话图）

- 右栏会话图的主线永远是**当前打开的会话**：在分叉里时，当前分叉的轮次在主线轨道，来源会话与其他分叉作为分支泳道，来源会话行尾写「原会话」，其余分叉写「分叉」；点击仍可切换。
- 子代理只读视图不切换主线：右栏仍是其父会话的会话图，点主线节点先退出子代理视图再定位（沿用反馈1926#03）。
- 用户原话说「最右边的主线要换成对应的会话」；现行画法主线固定在第 0 列（最左），按产品经理的要求保持轨道位置不变，只替换主线代表的会话。

## 代码位置

- `packages/web/src/lib/sessionTree.ts`：会话树根归并（侧栏与拓扑图共用）。
- `packages/web/src/components/session/sessionListUtils.ts`：分叉归并成一行、状态/未读汇总、点击目标与分叉名。
- `packages/web/src/components/session/SessionRow.tsx`：行内分叉名、整树置顶、悬停浮层入口。
- `packages/web/src/components/session/SessionTopology.tsx`：悬停浮层的拓扑图内容与节点点击。
- `packages/web/src/components/ui/HoverCard.tsx`：悬停浮层原语（Portal + 碰撞避让 + 延迟）。
- `packages/web/src/components/sessionGraph/layout.ts` 的 `layoutSessionTopology`；`data.ts` 的 `buildSessionTopology` 与分叉视图的来源/兄弟分支。

## 回归

- `e2e/regression.mjs`「侧栏分叉并入原会话行、悬停拓扑图、右栏切分支」：分叉前后侧栏行数不变；悬停出现拓扑浮层且节点数 = 树内会话数、无轮次文字；点分叉节点跳转、行内出现分叉名；在分叉里右栏主线归属仍是该分叉（`data-edge-owner`）。
- 单测：`layout.test.ts`（拓扑布局）、`sessionListUtils.test.ts`（归并与汇总）。
