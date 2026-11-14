# 消息区滚动控制器收拢方案（2026-11-14）

> 现状：消息区有 15 个写入口（13 处写 `scrollTop`/`scrollTo` + 2 处 `scrollIntoView`）、3 个 scroll 监听、8 处「是否贴底」判断；最近两周每修一处就坏另一处。本文只做盘点与设计，不改产品代码。
> 依据：[feedback-ledger.md](../../feedback-ledger.md) R10 / R27 / R36 / R40 / R66 / R68、[conversation.md](../../features/conversation.md)「长会话懒加载」、提交 `66550b8`（跳转被贴底校准拉回）、`f9b41a8`（落点补正 + 贴底意图）、`c50333f`/`14b68ea`/`68e699d`（1601#02 贴底补偿）、`c583b93`/`c570c20`（跳转统一与弹簧）。

## 0. 为什么越修越乱

六次修复各自解决一个可复现现象，但都往同一块共享状态（`pinnedRef` / `bottomIntentRef` / `programmaticUntil` / `jumpUntil` / `lastScrollRef`）上追加一个时间窗或一个 ref，而写滚动位置的代码仍在三个文件、五个生命周期里各写各的：

| 日期 | 提交 | 修了什么 | 引入的耦合 |
|---|---|---|---|
| 11-09 | 反馈1919#07 / R66 | 流式贴底、上滚停止、回到底部恢复 | 「程序滚动」用 600ms 时间窗表示 |
| 11-10 | `66550b8` | 跳转后不被贴底校准拉回 | 跳转时清校准 + `jumpUntil` 1200ms |
| 11-11 | `f9b41a8` | 落点按稳定布局补正；`bottomIntent` 不被平滑中间帧取消 | 贴底意图与平滑滚动时长绑定 |
| 11-12 | 1601#02 / R10 | 绘制前同步补 `scrollTop`（RO+MO） | 第五个贴底写点，和 rAF 贴底、校准定时器并存 |
| 11-12 | `c583b93` | 跳转统一、用户滚动立即取消 | 弹簧实现留在 `jump.ts`，锚点补偿留在 `MessageList` |
| 11-12 | 反馈1110 | 恢复弹簧、不做轮询 | 弹簧每帧把锚点补偿「并入当前位置」，两套补偿互相拉扯 |

根因不是某一条逻辑错，而是**没有单一所有者**：谁最后写谁赢，而「最后写」由 React 挂载顺序、`setTimeout` 余量、浏览器 scroll 事件派发时机共同决定，无法靠读代码判断。

---

## 1. 现状盘点

### 1.1 写消息区滚动位置（`.chat-scroll`）

「时机」列写的是相对绘制的位置；`W` = 一次实际赋值。

| # | 位置 | 触发条件 | 时机 / 前置 | 备注 |
|---|---|---|---|---|
| W1 | `ChatView.tsx:167-180`（`stickToBottom`，写 `:177`） | `messageCount` / `loading` / `pending.length` 变化 | 下一帧 rAF；仅 `pinnedRef` | 排到 rAF 会先画一帧旧位置 |
| W2 | `ChatView.tsx:182-191`（`scrollToBottom`，写 `:189`、`:190`） | 点「回到底部」、新本地消息（`:238-241`） | 同步；置 `pinned`+`bottomIntent`+600ms 窗口 | 平滑分支 `scrollTo({behavior:'smooth'})`，无法记账 |
| W3 | `ChatView.tsx:193-203`（打开/切会话，写 `:201`） | `sessionId` 变化 | `useLayoutEffect`，绘制前 | 内容未就绪，`scrollHeight` 是 content-visibility 的估算值 |
| W4 | `ChatView.tsx:206-220`（校准，写 `:214`） | 挂载后 `0/80/240/600ms`，依赖含 `messageCount` | 定时器；`pinned` | 四发；窗口内再来消息会重排整组定时器 |
| W5 | `ChatView.tsx:245-287`（`pinBeforePaint`，写 `:273`） | `ResizeObserver(content/box)` + `MutationObserver(content 子树)` | RO 回调/MO 微任务，绘制前 | 用 `lastScrollRef`（增高前快照）判断贴底；`jumpUntil` 1200ms 内跳过 |
| W6 | `MessageList.tsx:521-536`（`restoreAnchor`，写 `:531`、`:535`） | 取回更早消息 / 补缺口后 | `useLayoutEffect(:585-596)` + RO + `0/120/320/700/1200ms` 定时器（`:599-619`） | 两发写点：按行 offset 补偿，找不到行才按 scrollHeight 差 |
| W7 | `MessageList.tsx:829-846`（审批露出，写 `:840`/`:842`） | 新审批出现且卡片不在视口 | 120ms 后 `scrollTo smooth` | 与跳转、贴底无关的第三条平滑滚动 |
| W8 | `MessageList.tsx:1039-1053`（`showUnmounted`，写 `:1051`） | 点占位条「显示」 | 60ms 后 `scrollIntoView({block:'start'})` | 会滚动所有祖先；不经 token，可与跳转互相覆盖 |
| W9 | `lib/jump.ts:199`（弹簧每帧） | 每次跳转 | rAF；未到达前 | 每帧重取目标；读 `root.scrollTop` 把外部写入当位置 |
| W10 | `lib/jump.ts:231`（reduced-motion） | 跳转 + 系统减少动效 | 同步 | 跳转的两套写法 |
| W11 | `ToolCard.tsx:177-183`（写 `:180`） | 进入子代理视图时定位 Task 卡 | 60ms 后 `scrollIntoView smooth center` | 消息区内的间接写点，不受任何状态保护 |
| W12 | `ui/OverlayScrollbar.tsx:267-278`（写 `:277`） | 用户拖动覆盖式滚动条 | 指针移动每帧 | 用户意图，但 `ChatView` 的 `onWheel/onTouchMove/onPointerDown` 收不到，落入 600ms 程序窗口 |

合计 12 处直接赋值/`scrollTo`（ChatView 6 处：W1–W5；MessageList 4 处：W6–W7；`jump.ts` 2 处：W9–W10）+ 1 处跨组件写 `scrollTop`（W12 滚动条拖动）+ 2 处 `scrollIntoView`（W8、W11）= **15 个写入口**。另有 `SubagentStream.tsx:20-25` 对自己的子会话小滚动框贴底，属于独立容器，不在本次范围但应复用同一控制器（见 5.9）。

### 1.2 改渲染窗口（挂载哪些消息）

| 位置 | 触发 | 改什么 | 与滚动的关系 |
|---|---|---|---|
| `MessageList.tsx:461-494` | 会话 ≤400 条一次全挂；否则先 60 条，30ms 一步 +150 | `windowSize` / `windowCap` | 无锚点；向下补历史会在上方插入 |
| `MessageList.tsx:474-484, 781-815` | `windowAnchorId` | 窗口起点 + 固定轮 | 跳早期轮时窗口挪走，内容收缩 → 浏览器夹紧 `scrollTop`（`66550b8` 的事故点） |
| `MessageList.tsx:537-549` | 顶部 240px 内 | `windowCap/Size += MESSAGE_PAGE_SIZE`，`loadEarlierMessages` | 依赖自己的 scroll 监听（见 1.4） |
| `MessageList.tsx:621-627` | 点占位条「加载前 10 轮 / 全部」 | `windowCap/Size +=`，`fillMessageGap`/`loadTurnRange` | 同上 |
| `MessageList.tsx:551-570`（scroll 监听） | `scrollTop < 240` 且 `hasEarlier` | `requestOlder()` | 第二条 scroll 监听；`windowAnchorId && !jumpingRef && distance<100` 时回尾 |
| `MessageList.tsx:655-737`（跳转领取） | `subscribeJump` + `jumpTick` | 未加载 → `ensureMessageLoaded`；已加载但被裁 → `windowAnchorId = 目标前 60 条` | `jumpingRef` 仅在这一处保护窗口 |
| `MessageList.tsx:739-779` | `pinnedTurns` 有未加载项 | `loadTurnRange`，最多 3 次 | **不捕获锚点**，插入上方时视口被推走 |
| `MessageList.tsx:798-815` | 计算挂载集合 | 顶部 `hasEarlier` 占位条、段间占位条 | 占位条固定 40px，替换时高度变化 |
| `pagingSlice.ts:36-65 / 85-135 / 137-173 / 180-220` | 翻页 / 跳转 / 补缺口 / 固定轮 | 合并消息区间 | `loadingSegment` 是单一会话级锁；后来者 100ms×25 轮询等待（`:94-104`） |
| `sessionsSlice.ts:163-201` | 切换会话 | `pendingFocus`：目标就绪前保留旧画面 | 旧画面与新 DOM 共用同一个滚动节点 |

### 1.3 判定「是否贴底 / 是否程序滚动」

| 位置 | 判据 | 问题 |
|---|---|---|
| `ChatView.tsx:324-339`（`onScroll`） | `programmaticUntil > now` → 无条件 `pinned=true`；否则 `distance < 80` | 只认时间，不认「这次写入是不是我做的」；W12 被吞 |
| `ChatView.tsx:254-275`（`pinBeforePaint`） | `lastScrollRef`（增高前 top/height）判断；`bottomIntent` 时放行 | 快照只在 `onScroll` 更新，被动滚动不更新 |
| `ChatView.tsx:333-337` | `bottomIntent` + `userScrolled` 组合改写 | 两个 ref 定义重叠，`userScrolled` 跨会话不重置 |
| `ChatView.tsx:227-233`（`JUMP_EVENT`） | 事件即跳转 | 跨路由首次挂载时事件已经发过，监听器收不到 |
| `jump.ts:154, 196-208` | 落点差 ≤3px、最多复核 2 次 | 复核定时器与锚点定时器同窗口 |
| `TurnRail.tsx:550-557` | `distance < 40` → 当前轮 = 末轮；`scrollTop < 40` → 第 1 轮 | 第三条 scroll 监听，与 `sticky` 配合 |
| `MessageList.tsx:555-569` | `distance < 100` 回尾；`scrollTop < 240` 取更早 | 第四条（DOM 原生）监听 |
| `MessageList.tsx:585-593` | 取回后 `scrollTop < 240` → 一次挂全 | 与窗口、锚点三处耦合 |

### 1.4 只读观察者（不改位置，但会产生竞争信号）

- `TurnRail.tsx:527-562`：`IntersectionObserver`（`rootMargin: -85%`）+ scroll 监听改当前轮；`sticky`（`:359-360`）在跳转后挡住观察器。
- `TurnRail.tsx:400-415`：wheel/touchstart/pointerdown 清 `sticky`。
- `OverlayScrollbar.tsx:147-180`：rAF 轮询读 `scrollTop` 画滑块（只读）。
- `ChatView.tsx:342-349`：wheel / touchmove / 滚动区 pointerdown / 滚动按键 → `markUserScroll`。

### 1.5 相邻但**不在**本次改动的滚动区（同一模式，后续可复用）

`RightPanel.tsx:213-249`（上下文卡插入锚点）、`TurnOutlineSheet.tsx:48-56`（大纲抽屉虚拟列表）、`SessionGraphView.tsx:201/245`（会话图）、`SearchDialog.tsx:436`、`ui/Menu.tsx:602`、`CodeBlock.tsx:188`、`PreviewPanel.tsx:119`、`BackgroundTasksPanel.tsx:108`、`settings/*`、`ComposerEditor`。它们各自是独立容器，没有与消息区竞争；控制器建好后可按需接入，不属于第一阶段。

---

## 2. 滚动意图

用字母代表，后文矩阵引用。

| 代号 | 意图 | 期望语义 |
|---|---|---|
| A | 打开会话贴底 | 首帧起就在底部，内容陆续撑高也不离开；切换会话同理 |
| B | 流式输出跟随 | 在底部时每个 token 都贴底（含工具行、活动行、占位条插入） |
| C | 用户上滚停止跟随 | 任何真实用户滚动立即生效，不被任何补偿拉回 |
| D | 回到底部恢复 | 「回到底部」按钮 / 发消息 / 本地排队气泡 → 平滑贴底并恢复 B |
| E | 跳转到某轮 | 含未加载轮按需取段；大纲贴顶、其他入口居中；一次跳转只派发一次，新跳转替换旧的；结束后视口归用户 |
| F | 滚到顶加载更早 + 保持锚点 | 加载前后视口内同一行、同一偏移不动 |
| G | 固定轮常驻 | 固定轮始终在 DOM；其加载/插入不得移动视口 |
| H | 切换会话保持画面不闪 | 目标首屏就绪前保留旧画面；切换瞬间不得出现旧内容下移一帧再回弹 |
| I | content-visibility / 异步排版撑高 | 被动的高度变化：贴底时补底，阅读时保持锚点，不得被误判为用户滚动 |
| J | 窗口尺寸变化 | 贴底时保持贴底；阅读时保持视口首行；跳转中重算落点 |

补充意图（现有实现里存在，但设计上归入上面的状态）：审批到达自动露出（→ `reveal`，不改跟随意图）、点占位条「显示」（→ E）、子代理卡定位（→ `reveal`）、多窗格各自跳转（→ 每实例独立 E）。

---

## 3. 两两组合：现在谁赢 / 应该谁赢

「现在」按代码推断（后写者 / 时间窗 / React 生命周期顺序）；「应该」是本文推荐语义。`—` 表示同向，无实质冲突。

| 组合 | 现在谁赢 | 应该谁赢 | 说明 |
|---|---|---|---|
| A×B | 后写者：W1/W3/W4/W5 轮流 | B（A 只是 B 的初始态） | 四点贴底写入同帧竞争，以「最后调度到的」为准 |
| A×C | 时间窗（600ms 内上滚被吞，仍贴底） | C | 打开后立即上滚必须停住 |
| A×D | D | D | 同向，D 覆盖 |
| A×E | 校准定时器可能把跳转拉回（跨路由首次挂载收不到 `JUMP_EVENT`） | E（A 让位） | 有跳转时 A 不启动校准 |
| A×F | A（贴底覆盖锚点） | A（阅读意图不存在） | 打开即底部，无锚点 |
| A×G | A | A，G 只保证挂载 | 固定轮插入上方时仍应回到底部 |
| A×H | H 先保旧画面，提交后 A 的 W3/W4 接管 | H→A 顺序执行（`settling`） | 现在无显式顺序，靠 `initialScrollFor` 守卫 |
| A×I | A（`bottomIntent` 放行所有增高） | A | 一致 |
| A×J | 无处理（窗口尺寸变化不触发任何写点） | A | 目前可能打开后立刻离开底部 |
| B×C | C 延迟生效：600ms 程序窗口内 C 败 | C | 用户意图优先 |
| B×D | D | D | 同向 |
| B×E | E（`JUMP_EVENT` 清 `pinned`） | E；但用户发消息（D）可打断 E | 跳转中发消息应回底部 |
| B×F | 增速在下方时无位移；上方增高时 B 补底 | B（若仍贴底）/ F（若已离开） | 取决于当前状态，控制器应按状态而非位置猜 |
| B×G | B（补底） | B | 固定轮插入上方后补底 |
| B×H | H（旧画面保留） | H 到提交，之后 B | 旧会话流式增长不得写新画面 |
| B×I | W5（RO/MO 补底），但 W1 的 rAF 可能先画一帧 | B（绘制前同步） | 保留 1601#02 的绘制前语义 |
| B×J | 宽度变化 → 行重排 → RO → B | B | 一致 |
| C×D | D | D | 显式意图 |
| C×E | E（弹簧），但 `jumpingRef` 结束后 `distance<100` 可能把窗口回尾 → 视口被拉走 | E，且 C 在跳转结束后有效 | 最危险之一（见 4.E×F 同理） |
| C×F | F（锚点回写），但 C 的「停跟随」未与锚点共享状态 | C + F（阅读态 + 锚点） | 两者都应成立：离开底部且保持锚点 |
| C×G | G（插入推走视口） | C（视口不动） | **现在固定轮加载没有锚点捕获** |
| C×H | H，但 `userScrolledRef` 跨会话不重置 | H，且切换后重置为 A | 新会话从底部开始 |
| C×I | `pinBeforePaint` 用增高前快照判断，基本放行 | C | 依赖快照恰好正确 |
| C×J | 无处理 → 行重排改变可视内容 | C（保持视口首行） | 缺口 |
| D×E | 后派发者 | 后派发者（D 通常后点） | 用户动作直接覆盖 |
| D×F | 位移互斥（一个到底、一个到顶） | 后派发者 | 无共存 |
| D×G | D | D | — |
| D×H | W3 的 `scrollTop = scrollHeight` 会取消平滑 | H 提交瞬间取消动画并贴底 | 平滑动画跨会话无意义 |
| D×I | D（`bottomIntent` 放行） | D | 一致 |
| D×J | 无处理 | D | 缺口 |
| E×F | 弹簧每帧读到 W6 的补偿写入，把它并入当前位置；跳完 W6 的 700/1200ms 定时器仍可写 | E（跳转期间禁止锚点写；F 只加载数据，跳完再恢复锚点） | **最危险**：两套写点同帧抢 `scrollTop` |
| E×G | E（每帧重取目标） | E，G 只保证挂载 | 一致 |
| E×H | E 可能先于内容挂载，`ensureMessageLoaded` 在新视图上跑；15s 过期 | H 提交后 E 才生效，token 不清 | 跨视图跳转无显式顺序 |
| E×I | E（逐帧重取 + ≤2 次复核） | E | 保留现有语义 |
| E×J | 跳转中每帧重算 → E；跳完 resize 不再补正 | E（结束后 J 以锚点保持） | 缺口 |
| F×G | 先到者；`loadingSegment` 单锁让后者等待 | 两者都按锚点补偿 | 现在 G 路径不捕获锚点 |
| F×H | H（组件重挂，锚点丢失） | H 重置，F 不跨会话 | 一致 |
| F×I | W6 的 RO + 定时器 | F（RO 稳定 2 帧后释放，不用墙钟） | 定时器是抖动来源 |
| F×J | 无处理（只观察 content，不观察 box） | F（以首行锚点补偿） | 缺口 |
| G×H | H | H | 固定轮按会话存 |
| G×I | G（插入后行高估算变化，多次 reflow） | G + I（不移动视口） | 需要锚点 |
| G×J | 无处理 | G | 无重排（R27） |
| H×I | H 旧画面，提交后 W3/W4 | H→A/I 顺序 | 现在靠 `initialScrollFor` 守卫 |
| H×J | 无处理 | H（旧画面保持比例） | 缺口 |
| I×J | W5（两个 RO 都触发） | 贴底时 I，阅读时 J | 需按状态分派 |

**最危险的三个组合**（修复优先级）：

1. **E×F（跳到早期轮 × 顶部取段锚点）**：跳到第 1 轮会让 `scrollTop` 落到 240px 以下，触发 `requestOlder`，`captureAnchor` 拿到的是动画中间位置，随后 `restoreAnchor` 与弹簧每帧互写；跳转结束后 `pendingAnchor` 的 700/1200ms 定时器仍可能补写，`jumpingRef` 只保护窗口、不保护锚点。
2. **A/H×I（五种贴底写入 × content-visibility 撑高）**：W1 的 rAF、W3 的布局效应、W4 的四发定时器、W5 的 RO/MO、W2 的原生平滑滚动，都靠 600ms 时间窗判断「这次滚动是不是自己的」；原生平滑滚动的中间帧无法记账，被 `bottomIntent` 特判放行，又会被 `lastScrollRef` 当成用户滚动。最终画面取决于调度顺序，回归只能碰运气通过。
3. **G×C（固定轮按需加载 × 用户正在上翻阅读）**：`loadTurnRange` 完成后直接把固定轮插进列表上方，路径不调用 `captureAnchor`；`overflow-anchor: none` 又关掉了浏览器补偿，视口随插入高度整体下移，用户以为「自己点了一下就跳走了」。

---

## 4. 单一滚动控制器

### 4.1 位置与职责

新模块 `packages/web/src/lib/scroll/`：

```
chatScroll.ts          纯函数（分类、贴底、锚点、落点、弹簧、状态迁移）—— 无 DOM，可直接单测
chatScrollController.ts  每个 .chat-scroll 一个实例：DOM 事件、RO/MO、rAF、状态机
ChatScrollScope.tsx     React Context + useChatScrollController(boxRef, contentRef, key)
```

- **唯一写者**：控制器是消息区 `scrollTop` / `scrollTo` 的唯一调用者。组件不再直接赋值，也不再调用 `scrollIntoView`（用 `reveal`/`jump`）。
- **唯一判定者**：贴底、程序滚动、用户滚动、锚点、落点全在控制器内一次算清；组件订阅结论，不各自读 `scrollTop` 猜。
- **不接管数据**：分页、取段、窗口挂载仍归 store 与 `MessageList`；控制器只发「需要挂载目标」事件、接收「窗口变了」。
- **不接管动画外观**：`TurnRail` 自己的弹簧场景（`turnRailScene`）不动；只把「当前轮」从读 DOM 改成订阅。

### 4.2 状态

```ts
type ScrollState =
  | { kind: 'idle' }
  | { kind: 'following' }                        // 跟随底部（含 A/B/D 完成态）
  | { kind: 'detached' }                         // 用户离开底部（C/F 阅读态）
  | { kind: 'jumping'; token: number; target: ScrollTarget; align: 'start' | 'center' }
  | { kind: 'anchoring'; anchor: Anchor; resume: 'following' | 'detached' }
  | { kind: 'settling'; untilStable: boolean }   // 打开会话/平滑回到底部的过渡，仍算“想贴底”
```

`settling` 只是 `following` 的“动画中”变体：**没有墙钟期限**，由「已到达底部且内容稳定 2 帧」结束；用户任何真实输入立即转为 `detached`。

### 4.3 接口

```ts
export interface ScrollTarget { messageId?: string; toolUseId?: string }
export interface Anchor { messageId?: string; offset: number; height: number; top: number }

export interface ChatScrollController {
  readonly state: ScrollState
  /** 状态或贴底结论变化时通知（组件用它渲染按钮/大纲）。 */
  subscribe(listener: (s: ScrollState) => void): () => void

  // 生命周期（由 useChatScrollController 绑定 DOM）
  attach(box: HTMLElement, content: HTMLElement): void
  destroy(): void

  // 意图入口
  open(key: string): void                                   // A/H：重置并进入 settling
  follow(opts?: { smooth?: boolean }): void                 // D：回到底部（平滑由控制器自绘，不用原生 smooth）
  jump(target: ScrollTarget, opts: { token: number; align?: 'start' | 'center' }): void
  cancelJump(): void                                        // 新 token/列表卸载
  beginAnchor(): AnchorToken                                // F/G：插入内容前
  endAnchor(token: AnchorToken): void                       // 数据挂载后；内部也按“稳定 2 帧”自动收尾
  reveal(el: HTMLElement, margin?: number): void            // 审批卡/子代理卡：最小滚动，不改变跟随意图

  // 结论 / 事件（替代各处 scroll 监听）
  onReachTop(fn: () => void): () => void                    // 替代 scrollTop < 240
  onFollowExit(fn: () => void): () => void                  // 替代 showJump 判定
  onUserScroll(fn: (cause: UserCause) => void): () => void  // 替代 TurnRail 的 sticky 清除
  onVisibleTurn(fn: (turnId: string | null) => void): () => void // 替代 TurnRail 的 IO + scroll
  onNeedMount(fn: (target: ScrollTarget) => void): () => void    // 未挂载目标
  snapshot(): { top: number; height: number; client: number; atBottom: boolean }
  /** 覆盖式滚动条拖动开始时调用，声明“这是用户滚动”。 */
  notifyUserScroll(cause: UserCause): void
}
```

平滑回到底部由控制器用同一套弹簧积分完成（`behavior:'smooth'` 无法逐帧记账，是当前误判的源头）。

### 4.4 判定规则（替代时间窗）

控制器只维护一个**写入记账**：

```ts
let mark = { top: 0, height: 0, writtenAt: 0 }
function write(top: number) {
  box.scrollTop = top
  mark = { top: box.scrollTop, height: box.scrollHeight, writtenAt: performance.now() }
}

function onScroll() {
  const next = { top: box.scrollTop, height: box.scrollHeight, client: box.clientHeight }
  const cause = classifyScroll(prev, next, mark)
  switch (cause) {
    case 'programmatic': return              // 与我们最后一次写入一致（±1px）
    case 'clamp':        return              // 内容收缩被浏览器夹到底/到顶，不改意图
    case 'user':         leaveFollow()       // 唯一能改写跟随状态的来源
  }
}
```

- **programmatic**：`next.top ≈ mark.top`，或 `mark.top > maxTop && next.top === maxTop`（写入被夹）。
- **clamp**：`next.height < prev.height` 且 `next.top === maxTop(next)`，或 `next.top === 0` 且 `mark.top` 为底、内容整体收缩。**这是 `66550b8` 的事故类，必须与用户滚动区分。**
- **user**：其余情况；同时用 `wheel/touchstart/pointerdown/keydown` 做提前量（`mark` 之前就判定），保证上滚立即生效。
- 所有写入（包括 `write(top)` 被夹后的真实值）都更新 `mark`，所以下一帧的分类永远基于事实，而不是「600ms 内都算我的」。

其他规则：

- **贴底**：`height - top - client <= 2`（严格 2px，不再用 80px 判断「是否离开」——80px 只作为按钮显示阈值）。
- **内容增高**：RO/MO 回调里比较 `height` 与上次：`following` → 绘制前 `write(bottom)`；`anchoring` → 按 `anchor.messageId` 定位行、按 `offset` 补偿；`detached` → 不动。没有 `jumpUntil`。
- **窗口尺寸变化**：`box` 的 RO 单独处理：`following` → 补底；`detached` → 用视口首行 + 偏移补偿（等价于一次临时 anchor）；`jumping` → 重算落点。
- **跳转**：`targetTop` 用目标行真实 rect，与现有 `jump.ts:95-104` 相同；长距离先瞬移到目标前 1 屏；到达后最多复核 2 次，**复核期间状态仍是 `jumping`**，结束后转 `detached` 并发一次 `onUserScroll('jump-end')` 之前不给任何补偿。未挂载 → `onNeedMount`，15s 过期（保留现状）。
- **锚点**：`beginAnchor` 记录视口内第一个完整可见行的 `id + offset`；`endAnchor` 与自动收尾都在「内容高度连续 2 帧不变」后解除，不用定时器；`anchoring` 期间忽略 `jumpUntil`/贴底。

### 4.5 状态转移表

| 当前 | 事件 / 条件 | 新状态 | 动作 |
|---|---|---|---|
| idle | `open(key)` | settling | 同步写底；重置 detached 标记；取消 jump/anchor |
| idle | `follow()` | settling | 写底（smooth 时逐帧） |
| idle | `jump()` 目标已挂载 | jumping | 取消 anchor；from 当前位置 |
| idle | `jump()` 目标未挂载 | jumping | `onNeedMount`；15s 过期 |
| following | 内容增高 | following | 绘制前补底 |
| following | 真实用户滚动（离开） | detached | 发 `onFollowExit` |
| following | 尺寸变化 | following | 补底 |
| following | `beginAnchor()` | following（记录但不用） | 只有 `detached` 时才需要锚点 |
| following | `jump()` | jumping | — |
| detached | 真实用户滚动回到底部（≤2px） | following | 恢复贴底 |
| detached | `follow()` | settling | 逐帧弹簧到底；`settling` 中用户滚动 → detached |
| detached | 内容增高（上方） | detached | 有 anchor 则补偿；否则保持 `top` |
| detached | 尺寸变化 | detached | 临时锚点补偿 |
| detached | `jump()` | jumping | — |
| jumping | 内容增高 / 重新渲染 | jumping | 逐帧重取目标（≤2 次复核） |
| jumping | 新 `jump()` | jumping（新 token） | 位置连续，不回到起点 |
| jumping | 用户滚动 | jumping | **不打断**（R68），只记录 |
| jumping | 到达 | detached | 结算；之后视口归用户 |
| jumping | 尺寸变化 | jumping | 重算目标 |
| jumping | `needMount` 失败/15s | detached | 结算，发一跳转结束 |
| anchoring | 内容增高 | anchoring | 按 anchor 补偿 |
| anchoring | 稳定 2 帧 / `endAnchor` | 恢复 `resume` | 释放锚点 |
| anchoring | `jump()` | jumping | 丢弃锚点 |
| settling | 到达底部且稳定 2 帧 | following | — |
| settling | 真实用户滚动 | detached | 用户优先（含打开后立即上滚） |
| settling | `jump()` | jumping | — |
| 任意 | `open(新 key)` | settling | 取消 jump/anchor/平滑；窗口与意图一起重置 |
| 任意 | `destroy()` | — | 取消 rAF/RO/MO，解锁 token |

### 4.6 组件改造

**ChatView**
- 删除 7 个 ref（`pinnedRef`、`bottomIntentRef`、`programmaticUntil`、`userScrolledRef`、`jumpUntil`、`lastScrollRef`、`initialScrollFor`）以及 `frameRef`。
- 删除 `stickToBottom`、`scrollToBottom`、`useLayoutEffect [sessionId]`、校准定时器、`pinBeforePaint` 的 RO/MO、`onScroll`、`markUserScroll`、`onScrollKeyDown`、`JUMP_EVENT` 监听、`TurnRail.onBeforeJump` 里的一整串赋值。
- 改为 `const scroll = useChatScrollController(scrollRef, contentRef, sessionId)`；`showJump` 由 `scroll.onFollowExit` 驱动；按钮调 `scroll.follow({ smooth: true })`；`lastIsLocal` 调 `scroll.follow()`；会话切换由 `sessionId` 变化触发 `scroll.open(sessionId)`。
- 滚动容器只留 class 和 ref，不再挂 `onScroll/onWheel/onTouchMove/onPointerDown/onKeyDown`（控制器在 `attach` 时统一绑定，含 capture）。

**MessageList**
- 删除 `pendingAnchor`/`captureAnchor`/`restoreAnchor`/`requestOlder` 的自有 scroll 监听/`jumpingRef`/`showUnmounted` 的 `scrollIntoView`/审批露出的 `scrollTo`。
- `requestOlder`：由 `controller.onReachTop` 触发；先 `beginAnchor()` 再取页。
- `fillGap` / `loadGapBand` / 固定轮 `loadTurnRange`：插入前一律 `beginAnchor()`；数据到达后的 `useLayoutEffect` 里 `endAnchor()`。固定轮路径补上这一对，修复 G×C。
- 跳转领取保留（数据依赖），但滚动交给 `controller.jump`；`controller.onNeedMount` 里做 `ensureMessageLoaded` / 挪窗口；跳转期间窗口只在 `jumping` 状态内变化，不再用 `distance<100` 猜。
- `windowAnchorId` 的回尾只由 `onReachBottom`（控制器事件）触发，不再读距离。

**TurnRail**
- `go()` 只发 `focusMessage(id, 'start')`（意图总线不动），删除 `sticky`（由 `controller.onUserScroll` 重置当前轮）、`sticky` 的 wheel/touch/pointer 三个监听、`scroll` 监听与 `IntersectionObserver`。
- 当前轮改为 `controller.onVisibleTurn` + `onFollowExit`（贴底时取末轮）。
- `onBeforeJump` prop 删除。

**其它**
- `ToolCard`：`scrollIntoView` → `useChatScrollController` 拿到的 `reveal(card)`；无 scope 时不滚动。
- `OverlayScrollbar`：`startDrag` 时对 `scroller` 派发一次 `tandem-user-scroll`（或调用注册在元素上的 `dataset` 回调），控制器视为用户滚动。
- `SubagentSessionView` / `ExternalSessionPanel` 的预览列表：绑定各自控制器（只 `open` + `jump`，无可写操作），补上打开即底部的语义。
- `lib/jump.ts` 保留 `jumpTo/subscribeJump/isJumpCurrent/settleJump`（token 总线、15s 过期），删除 `createJumpScroller/targetScrollTop/startJumpScroll/reducedMotion`（迁入控制器纯函数）。

## 5. 纯函数单测清单

文件建议 `packages/web/src/lib/scroll/chatScroll.test.ts`，只喂数字/矩形，不建 DOM。

**分类**
1. `classifyScroll`：写入后滚动事件（`next.top == mark.top`）→ `programmatic`。
2. 写入被夹（`mark.top > maxTop`，`next.top === maxTop`）→ `programmatic`。
3. 内容收缩导致的 `top` 下降（`next.height < prev.height`，`next.top === maxTop`）→ `clamp`（66550b8 回归）。
4. 用户上滚（`next.top < mark.top - 1`，高度不变）→ `user`。
5. 原生平滑滚动不被当作 user（若仍存在）→ 现在的分类会判 `user`，断言这条规则**只能**由自绘动画满足（防止有人加回 `behavior:'smooth'`）。
6. 同一帧内先 clamp 再 user（连续两次 scroll 事件）→ 第二次为 `user`。

**贴底与离开**
7. `atBottom` 边界：`height-top-client = 2` → true；`3` → false；空内容（`height <= client`）→ true。
8. `distance` 从 80 变 81 只切按钮显示，不切跟随。
9. `settling` 下 `atBottom` 不结束（需连续 2 帧稳定）。

**落点**
10. `targetTop(start)`：目标高 > 视口 → 贴顶、gap 16。
11. `targetTop(center)`：目标居中；`scrollTop` 被夹在 `0..max`。
12. 长距离 `planTeleport`：目标在 2 屏外 → 瞬移到目标前 1.1 屏；2 屏内不瞬移。
13. 弹簧 1 帧大 `dt`（0.033）与多帧小 `dt` 的总位移接近（子步积分稳定）。
14. 到点判定：`|goal-pos| < 0.5 && |vel| < 6`；否则继续。
15. 跳转期间内容增高目标下移 → 下一帧仍朝新目标前进（单调，不回弹）。

**锚点**
16. 锚点行在 `top` 上方增高 120px → `scrollTop + 120`。
17. 锚点行本身高度变化 → 保持行的 `top` 偏移，不按 `scrollHeight` 差补偿。
18. 锚点行被卸载 → 退化为 `height` 差补偿，且只补偿一次。
19. 两帧内高度不变 → 自动释放；高度继续变 → 保持 `anchoring`。
20. `anchoring` 期间 `jump()` → 锚点丢弃，不产生写点。

**状态迁移**
21. `open` 时处于 `jumping` → `settling`，旧 token 失效。
22. `following` + 用户上滚 → `detached`；用户滚回底部 → `following`。
23. `jumping` + 用户上滚 → 仍 `jumping`（R68），结束后 `detached`，不再回底。
24. `settling` + 用户上滚 → `detached`（不被吸回）。
25. `detached` + 内容增高 → 位置不变（无 anchor）。
26. 尺寸变化：`following` → 补底；`detached` → 首行偏移不变；`jumping` → 目标重算。
27. `onReachTop` 只在 `detached`/`following` 且 `top <= 240` 时发一次（同一次停留不重复触发）。

---

## 6. 回归覆盖与缺口

现有（`e2e/regression.mjs`）与意图对应：

| 用例名 | 意图 |
|---|---|
| 「反馈1919#07：流式输出时在底部自动跟随，上滚后停止，回到底部后恢复」（:5908） | A/B/C/D |
| 「反馈1601#02：来回切换会话，消息区与右栏从新会话首帧起保持同一画面」（:6122） | A/H/I |
| 「大会话滚到顶加载更早消息且位置不跳」（:3191） | F |
| 「轮次大纲跳到未加载的轮」（:3250） | E |
| 「大纲未加载轮标注、点击只取该片段（反馈0220#03 R40）」（:3663） | E |
| 「轮次大纲滚轮只预览、点击未加载轮能定位（反馈10#01 R40）」（:3280） | E |
| 「占位条标注未加载轮次并可分段加载（反馈11#05 R40）」（:3342） | F/G |
| 「固定轮次滚到底部仍挂载、中间占位条可加载（反馈11#05 R40）」（:3368） | G |
| 「固定轮次初次打开、滚动、跳转后始终挂载（反馈0220#03 R40）」（:3739） | G/E |
| 「大纲标识未加载轮次并可点击跳转（反馈11#05 R40）」（:3434） | E |
| 「跳转统一：会话图与轮次大纲调用同一个实现（反馈0220#03）」（:3508） | E |
| 「跳转有动画：点击后 scrollTop 在 ≥3 帧内逐步变化（反馈1110）」（:3569） | E |
| 「跳转动画结束后不再写 scrollTop、之后滚轮不被拉回（反馈0220#03 R68）」（:3617） | E/C |
| 「反馈2102#02：会话图快速连点两个节点，最终停在第二个目标且滚动单调」（:6333） | E |
| 「反馈2156#01：会话图跳转只定位，目标消息没有高亮背景」（:12483） | E |
| 「反馈0220#01：外部会话的会话图节点点击能定位该轮」（:12460） | E |

缺口（控制器落地时应补）：

1. **J 窗口尺寸变化**：改窗口宽高 / 拖右栏 / 手机旋转后，贴底仍贴底、阅读位置首行不动。现无任何用例。
2. **A×C**：打开会话 200ms 内立即上滚，视口不得被校准定时器吸回底部。
3. **W12**：拖动覆盖式滚动条必须算用户滚动（当前会被 600ms 程序窗口吞掉）。
4. **G×C**：固定轮按需加载时，视口内首行与偏移不变（现在只断言 DOM 挂载）。
5. **E×F**：从底部跳到第 1 轮，触发顶部取段后仍停在目标轮，且结束后 2s 内 `scrollTop` 不再变。
6. **E 长耗时**：取段重试（>1.2s）期间不触发贴底补偿（现 `jumpUntil` 1200ms 会失效）。
7. **I×B**：流式期间 content-visibility 行展开，距底部始终 ≤4px（不只比较帧间画面）。
8. **多窗格**：两个窗格各自跳转，互不取消、互不把对方拉底。
9. **子代理只读视图**：打开时位于底部、点大纲能定位（当前两条路径都补）。
10. **审批露出**：用户上翻时新审批自动露出，但不得打断正在进行的跳转。

---

## 7. 实施拆分

每一步都可独立提交、独立回滚；每步跑 `node scripts/check.mjs --skip-smoke`。

1. **纯函数 + 单测**（`lib/scroll/chatScroll.ts` + `chatScroll.test.ts`）：不改任何调用方。用「分类/落点/锚点/迁移」四组用例把现有语义固定下来（尤其 `clamp` 与 `programmatic` 的区分）。
2. **控制器骨架接入 ChatView**：删 W1–W5 与 7 个 ref，改 `open/follow`；保留 `jump.ts` 现状（`startJumpScroll` 暂由控制器调）。验收：1919#07、1601#02、打开后立即上滚（新补用例）。
3. **跳转迁入控制器**：`jump.ts` 只留 token 总线；`MessageList` 用 `onNeedMount` + `controller.jump`。验收：1110、0220#03（统一/动画/结束后不写）、2102#02、E 长耗时。
4. **锚点与挂载窗口收拢**：`beginAnchor/endAnchor` 替换 `captureAnchor/restoreAnchor` 与 5 个定时器；固定轮补锚点；`showUnmounted` 改 `jump`。验收：加载更早不跳、占位条、固定轮三条、G×C 新用例。
5. **第三条监听与大结论收拢**：`TurnRail` 订阅 `onVisibleTurn/onUserScroll`，删 IO + scroll 监听 + `sticky`；审批与 ToolCard 改 `reveal`；`OverlayScrollbar` 通知用户滚动。验收：大纲当前轮、审批露出、滚动条拖动。
6. **尺寸变化、多窗格与只读视图**：box RO 分派、每实例独立、子代理/外部预览接入；补 J 与多窗格用例，跑全量 `node scripts/check.mjs`。

## 8. 不做的事

- 不恢复浏览器 `overflow-anchor`：`.chat-scroll` 的 `overflow-anchor: none`（`chat.css:91-94`）保留，控制器是唯一补偿者。
- 不改 `content-visibility: auto` 与 `contain-intrinsic-size: auto 96px`（性能取舍）；只保证估算高度变化被记账。
- 不把右栏、会话图、大纲抽屉的滚动并进同一实例（各自容器、各自实例；`chatScroll.ts` 可复用）。
- 不改跳转的 token 语义、动画时长与落点规则（start / center、长距离瞬移、≤2 次复核）——这些是用户已确认的行为（R68 / 反馈1110 / 2102#02）。
- 不为「删掉的旧写法」加防回退检查；新检查只覆盖仍需要的行为（第 6 节缺口）。
