# 对话区：轮次大纲与上下文占用

> 更新：2026-11-09。用户决定见 [design.md 反馈包 #8 / #9](../design.md)；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R14/R25/R28/R30/R38。

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

## 外部会话只读预览（反馈9#01 / R38）

- 同一个 `TurnRail` 组件：`ExternalSessionView` 把外部消息与虚拟会话 id（`external:<source>:<id>`）传进去，保留上下文着色、Alt/Option 只看已固定、悬停用量/耗时 tooltip；只读时不显示固定图钉。
- 外部日志里的 `model` 与 `usage` 由服务端解析：Claude Code 读 `message.model` / `message.usage`，Codex 读 `turn_context.model` 与 `token_count.last_token_usage`。没有价格时不显示花费，没有耗时不显示耗时。
- 右侧「会话信息」复用 `Card`、`DetailRow`、`ContextSpaceSection`、`PanelBar`、`ResizeHandle` 与正常会话同一个宽度偏好（`tandem.rightPanelWidth.v1`）。只渲染原日志里能拿到的项：模型、来源、工作目录、轮数、消息数、用量、上下文、会话内编辑过的文件；缺的项不渲染。
- 只读限制不变：没有输入框，顶栏信息面板按钮照常可开关面板，底部保留「在 Tandem 中继续」导入入口。

## 会话信息面板的空分组（反馈9#06 / R14）

- 没有数据的分组默认不渲染（待办、用量、记忆、Wiki、改动摘要等），新会话的上下文卡也隐藏；有数据后出现，180ms opacity 淡入。
- 插入/删除分组时保持滚动锚点：面板滚动区关闭浏览器自带锚定（`overflow-anchor: none`），由 `RightPanel` 比较插入前后的卡片 `offsetTop` 补偿 `scrollTop`，用户滚动在下方时看到的内容不被上方新卡片推走。
- 底部「显示空分组」开关记在 `PanelPrefs.showEmpty`（`localStorage['tandem.rightPanel.v1']`），打开后空卡片按原顺序出现，记忆卡仍可从空状态进入编辑。

## 计量口径

- 一轮 = 用户的一次发言 → 下一条用户发言之间的全部内容：用户消息 + 该轮所有 assistant 消息、工具调用与结果，以及该轮派出的 Task 子代理（含孙代理，tooltip 标「含子代理」）。纯 tool_result 的 user 消息不另起一轮（`isUserTurnMessage`）。
- 轮次用量汇总：`packages/web/src/lib/turnUsage.ts` 的 `usageByTurn`。上下文占用按已加载消息估算；分页只算已加载部分。
- 「最占空间」：服务端 `packages/server/src/context.ts` 的 `estimateBreakdown` 生成 `ContextBreakdown.topTurns`（该轮总量 + 轮内 top 5 项），收到真实 usage 后按比例校准。老 Host 没有 `topTurns` 时，前端按 `topItems` 的轮次归并回退。

## 关键取舍

- 辅助视图不单开悬停浮层：浮层与主面板之间隔着空白，指针移过去会收起（反馈8#04）。改为同一视图两用，提示行在 `nav` 内并接管 `pointerleave`。
- 着色不提供「花费 / 上下文」切换（反馈8#07）：始终上下文占用，花销放 tooltip，避免同一深浅表达两种含义。
- 占用清单以轮次为基本单位（反馈8#10）：agent 一轮会有多条消息，按单条列太杂；折叠状态跨面板/重开保留。

## 验证

- 单测：`packages/web/src/lib/turnUsage.test.ts`（轮次边界、子代理、上下文占用口径、分位分档）；`packages/server/test/context.test.ts`（`topTurns` 聚合、纯 tool_result 不另起轮、轮内明细排序）；`packages/server/test/external.test.ts`（外部 usage 字段换算）。
- 回归：`e2e/regression.mjs` 的「轮次大纲」「上下文面板「最占空间」」「外部会话预览：轮次大纲、用量 tooltip 与信息面板」「会话信息面板：空分组默认隐藏…」用例（Alt/点击只看已固定、无独立浮层、tooltip 用量、压缩轮最浅、按轮次列表、二级展开、折叠记忆；外部只读大纲/信息面板；空分组开关与数据到达后出现）。
- 全量：`node scripts/check.mjs`。
