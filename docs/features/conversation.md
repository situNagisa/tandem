# 对话区：轮次大纲与上下文占用

> 更新：2026-11-11。设计原则见 [design.md](../design.md)（P11/P12/P13/P18/P20/P22）；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R10/R14/R25/R28/R30/R38/R58/R62/R66。

## 是什么

桌面端对话区右缘的轮次大纲（`components/chat/TurnRail.tsx` + `turnRailScene.ts`）：静止是一列刻度，靠近后弹簧展开成大纲；手机端用顶栏「第 N / M 轮」胶囊打开底部抽屉（`TurnOutlineSheet`）。右侧栏与上下文环弹层的「最占空间」共用 `components/chat/ContextMeter.tsx` 的 `ContextSpaceSection`。

## 怎么用

- 悬停 / 拖动 / Alt+↑↓ / 聚焦后方向键逐轮导航；滚轮只预览式滚动大纲本身，不改变选中轮、不滚动对话区；点某行才跳转。悬停行用标准 Tooltip 显示该轮用量（输入/输出/缓存命中/花费/占本会话 %，有耗时时追加「耗时 …，其中工具 …，首 token …」）。
- 消息下方的时间与用量行**默认隐藏**，鼠标移到该条消息才淡入（`components/chat/UsageLine.tsx` 的 `msg-meta`；行高保留，触屏常显）。assistant 行为「时间 · 输入 · 输出 · 缓存命中 · 花费 · 耗时」，用户行为「时间 · ~x tok · $x」，金额不足 $0.0001 时显示 `<$0.0001`（不显示 $0.0000，反馈1601#03）；时间 6 小时内相对、今天 `HH:mm`、非今天 `MM-DD HH:mm`、非今年带年份，悬停显示完整日期时间。
- 着色固定表示上下文占用：单一中性色按本会话分位分 5 档；压缩轮最浅并标「已压缩」，摘要独立一行。
- 固定轮次：悬停行尾图钉固定/取消；固定不重排、原位小图钉。按住 Alt/Option 或点大纲下方提示可「只看已固定」，没有独立浮层。
- 「最占空间」按用户轮次一行、占用降序；点整行跳转，右侧箭头展开轮内最大几项；区块可折叠，状态记 `localStorage['tandem.contextTopCollapsed.v1']`。
- 宽内容（代码块/表格/长 diff）宽度 = 正文阅读列（≤ 段落 + 2px，左缘一致），超出在块内横向滚动；禁止负外边距向两侧扩张（反馈16#02）。
- 流式跟随：停在底部时随输出持续贴底；用户上滚即停止跟随；滚回底部或点「回到底部」恢复（反馈1919#07 / R66）。切换会话时旧画面保留到目标首屏就绪；贴底状态下后到的行（注入说明、加载占位、content-visibility 展开）在绘制前同步补齐滚动位置，新会话首帧起画面不再上下跳动（反馈1601#02 / R10）；右栏上下文卡片按会话缓存，切换时不消失一帧。
- 运行提示：流式有末尾光标；等首个 token / 等工具返回时消息流末尾显示「⟳ 正在思考… 12s」/「⟳ 正在运行 Bash… 5s」；工具行执行中显示 spinner 与已运行时长（`chat/TurnActivity.tsx`，与侧栏计时同源）。
- 排队消息：运行中发送的消息先显示本地排队气泡，被 agent 读取后原位替换成正式消息；只替换内容一致的排队项，不能消失或跑到末尾（反馈16#11 / R62）。

## 长会话懒加载

- 首屏只下发尾部消息；挂载窗口默认跟随尾部，跳早期轮次时移到目标前后最多 320–400 条，窗口外不挂载。
- 未加载连续段用固定高度 40px 占位条（「⋯ 第 12–48 轮未加载（37 轮）· 加载前 10 轮 / 全部」）；已加载但窗口外的用「⋯ 未显示 · 显示」。加载后原位替换、不改变滚动位置。
- 固定轮一定加载、不参与卸载。搜索、最占空间、收件箱、大纲跳转共用 `ensureMessageLoaded` / `loadTurnRange`：先取段，等 `[data-turn-id]` 挂载后滚动+高亮，失败 toast，不静默。
- 未加载轮刻度为浅色虚线 + 行尾「未加载」，tooltip「未加载 · 点击加载并跳转」；点击先加载再定位。

## 外部会话 / 子代理只读

外部会话复用同一个 `TurnRail`、`Card`、`DetailRow`、`ContextSpaceSection`、`PanelBar`、`ResizeHandle` 与宽度偏好；服务端从 Claude/Codex 日志解析 `model`/`usage`，缺项不渲染，未知价格不显示「花费未知」。只读隐藏固定图钉与输入框，保留「在 Tandem 中继续」。消息区的子代理工具行点击即进入该子代理的只读会话（不展开卡片），会话图的子代理节点同样进入；子代理会话复用 `MessageList` + `TurnRail`，面包屑逐层返回。

## 上下文卡与空分组

分类顺序对齐 Claude Code `/context`：系统提示 → 工具定义 → MCP 工具 → 自定义 agents → 记忆文件 → 对话 → 工具结果 → 剩余；颜色用 `--ctx-*`，阈值刻度按 `autoCompact.threshold`（默认 85%）。缓存命中率只在「用量」卡显示。没有数据的分组默认隐藏，有数据后 180ms 淡入；插入时用 `offsetTop` 补偿 `scrollTop` 保持锚点。⋯「显示分组」逐个勾选，记在 `PanelPrefs`。

## 计量口径

- 一轮 = 用户一次发言 → 下一条用户发言之间的全部内容（用户消息、assistant、工具调用/结果、Task 子代理及孙代理）；纯 `tool_result` 不另起轮。
- 外部会话注入的系统提示（`<tag>`、`You are Codex…`、AGENTS.md、skills、multi_agent_role）不算用户轮：`isSystemInjectionText` / `isUserTurnMessage` 统一口径。
- 轮次用量汇总在 `packages/web/src/lib/turnUsage.ts`；「最占空间」由服务端 `packages/server/src/context.ts` 的 `estimateBreakdown` 生成 `topTurns`，老 Host 回退 `topItems`。

## 关键取舍与限制

- 辅助视图不单开悬停浮层（跨空白会收起）；着色不提供「花费/上下文」切换；占用清单以轮次为基本单位。
- 上下文占用按已加载消息估算，分页只算已加载部分；外部会话缺数据项不显示。

## 验证

单测：`turnUsage.test.ts`、`context.test.ts`、`external.test.ts`、`format.test.ts`、`codeWrapLines.test.ts`。回归：`e2e/regression.mjs` 的轮次大纲/懒加载/最占空间/外部预览/空分组/反馈16#01#02#10#11 用例；全量 `node scripts/check.mjs`。
