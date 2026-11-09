# 对话区：轮次大纲与上下文占用

> 更新：2026-11-09。用户决定见 [design.md 反馈包 #8](../design.md)；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R25/R28/R30。

## 是什么

桌面端对话区右缘的轮次大纲（`components/chat/TurnRail.tsx` + `turnRailScene.ts`）。静止是一列刻度，靠近后同一批元素以弹簧动画展开成大纲。手机端没有这条：顶栏「第 N / M 轮」胶囊打开底部抽屉（`TurnOutlineSheet`）。

右侧栏与上下文环弹层里的「最占空间」共用 `components/chat/ContextMeter.tsx` 的 `ContextSpaceSection`。

## 怎么用

- 悬停 / 拖动 / 滚轮 / Alt+↑↓ / 聚焦后方向键逐轮导航；悬停某一行用标准小号 Tooltip 显示该轮用量：输入、输出、缓存命中、花费、占本会话 %；有耗时数据时追加「耗时 1m 05s，其中工具 40s，首 token 1.2s」。
- 每条 assistant 消息的用量小字末尾显示该次请求耗时（如 `· 12.3s`），流式进行中显示实时计时；旧消息没有 `durationMs` 不显示。耗时口径与字段见 `@tandem/protocol` 的 `Message.durationMs / ttftMs / toolDurationMs`。
- **着色固定表示上下文占用**：单一中性色按本会话分位分 5 档，展开行背景与收起刻度条同深浅。压缩掉的轮占用为 0、显示最浅并标「已压缩」；摘要独立一行。
- **固定轮次**：悬停行尾图钉固定/取消固定；固定不重排、原位只保留小图钉。
- **只看已固定**：按住 Alt（Mac 为 Option）时大纲只显示已固定的轮次，松开恢复全部；点大纲下方的小字提示也能切换（鼠标/触屏）。不再有独立的「已固定」浮层。
- **「最占空间」**：按用户发言（轮次）一行，按占用降序；点整行跳到该轮，右侧箭头展开该轮内最大的几项（工具输出/消息）作为二级明细。整个区块可折叠，状态记在 `localStorage`（`tandem.contextTopCollapsed.v1`）。

## 计量口径

- 一轮 = 用户的一次发言 → 下一条用户发言之间的全部内容：用户消息 + 该轮所有 assistant 消息、工具调用与结果，以及该轮派出的 Task 子代理（含孙代理，tooltip 标「含子代理」）。纯 tool_result 的 user 消息不另起一轮（`isUserTurnMessage`）。
- 轮次用量汇总：`packages/web/src/lib/turnUsage.ts` 的 `usageByTurn`。上下文占用按已加载消息估算；分页只算已加载部分。
- 「最占空间」：服务端 `packages/server/src/context.ts` 的 `estimateBreakdown` 生成 `ContextBreakdown.topTurns`（该轮总量 + 轮内 top 5 项），收到真实 usage 后按比例校准。老 Host 没有 `topTurns` 时，前端按 `topItems` 的轮次归并回退。

## 关键取舍

- 辅助视图不单开悬停浮层：浮层与主面板之间隔着空白，指针移过去会收起（反馈8#04）。改为同一视图两用，提示行在 `nav` 内并接管 `pointerleave`。
- 着色不提供「花费 / 上下文」切换（反馈8#07）：始终上下文占用，花销放 tooltip，避免同一深浅表达两种含义。
- 占用清单以轮次为基本单位（反馈8#10）：agent 一轮会有多条消息，按单条列太杂；折叠状态跨面板/重开保留。

## 验证

- 单测：`packages/web/src/lib/turnUsage.test.ts`（轮次边界、子代理、上下文占用口径、分位分档）；`packages/server/test/context.test.ts`（`topTurns` 聚合、纯 tool_result 不另起轮、轮内明细排序）。
- 回归：`e2e/regression.mjs` 的「轮次大纲」与「上下文面板「最占空间」」用例（Alt/点击只看已固定、无独立浮层、tooltip 用量、压缩轮最浅、按轮次列表、二级展开、折叠记忆）。
- 全量：`node scripts/check.mjs`。
