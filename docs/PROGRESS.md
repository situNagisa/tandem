# 进度

> 更新：2026-11-12。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 74（2026-11-12）反馈0220#03：跳转统一为一个实现，用户滚动立即取消
- [x] 原话「会话图的跳转逻辑跟轮次大纲不是同一个逻辑，属于重复造轮子；点完再滚轮就抽搐」：盘点会话图/大纲/搜索/收件箱/上下文面板的全部入口，删掉 `pollJump` 12 秒轮询 + 多次重发、MessageList 的 `jumpTimers`/4 次补正、TurnRail 的 `jumpSeq`/首次 + 二次派发 + 100 次轮询 reveal、ContextMeter 的死代码 `jumpToMessage`，统一为 `lib/jump.ts` 的 `focusMessage`/`focusTool`（R68 复发）。
- [x] 统一实现：目标未加载时只按 `around` 取所在片段；挂载后在当前帧定位，布局未稳定时逐帧收敛（≤0.3s）后收尾；用户滚轮/触摸/拖动滚动条/按键滚动立即取消剩余定位；不再定时轮询派发。
- [x] 大纲按约定：未加载轮瓷砖虚线 + 行尾「未加载」，点击只加载该轮所在片段并定位；轮次大纲索引拉取失败时最多重试 2 次（不再失败即无限重发）。
- [x] 固定轮次始终加载、始终挂载：取回失败/快照重置消息后自动重试（每段最多 3 次、消息变化后清零），初次打开、滚动、跳转后都在 DOM 里。
- [x] 回归新增 4 条：跳转统一（同一函数、只派发一次、token 递增）/跳转后滚轮 3 秒不被拉回（逐帧）/未加载轮标注且只请求该片段/固定轮次初次打开+滚动+跳转后仍挂载。原有 R40/R66/R68/2102#02/1919#07/1601#02、轮次条第 30 轮定位继续通过。
- 验证：`node scripts/check.mjs --skip-smoke`；真实长会话副本（`~/.tandem` 复制到 `/tmp/tdm-long`，`local-host/sessions/c3f2c1a4…` + 2133054a… 的消息拼成长会话）手工复现与截图在 `/tmp/jump-0220/`。

## 迭代 75（2026-11-12）会话图整棵树共用拓扑（反馈0220）
- [x] #08 原话「分叉作为主线，一条线上去，不应该再在这里引出一个蓝色的条，也可以看到主会话上分出的子代理节点；所有节点和主会话应该都是一样的，只是主线不同」：新增 `GET /api/sessions/:id/graph`（协议 `SessionGraphTree`：树内所有会话的轮次 id/标题、父子关系与接入点；服务端去重分叉复制的历史、跨会话解析分叉点、`parentToolUseId → 轮次`）。`layoutSessionGraph` 成为唯一布局：trunk = 当前会话祖先链（第 0 列一条直线），其余会话独有轮次为分支泳道；主会话/分叉视图节点集合与数量相同。
- [x] #01 原话「外部绘画，绘画图没办法点击跳转」：外部会话图节点点击走同一个 `focusMessage` 定位该轮。
- [x] #06 原话「没有分叉或者子代理时右侧不要弹出这个卡片」+「进入反馈模式卡片还是会消失」：单会话树不弹；`ui/HoverCard` 与菜单/Popover 同一规则，反馈模式下指针离开不收起（共享层）。
- [x] #07 原话「悬浮选项卡时左边拓扑图也要高亮，点拓扑图也要跳转」+「拓扑图特别细很难选中」：悬停名称行/连线高亮该会话的线与节点；点线/节点跳转；连线命中带两侧各 6px（列距 14px）、节点命中 20px、名称行整行可点。
- [x] 悬停浮层改为同一张图的紧凑模式（`compact` 参数）：保留每个会话起点/最新轮、分叉点/派出点、子代理汇回点，其余轮次省略；删除 `layoutSessionTopology` 第二套布局。
- 检查：decisions-check 改写 `sidebar-hover-topology`/`graph-trunk-current`/`graph-edge-hover` 并新增 5 条；单测重写 13 条；regression 新增 5 条（0220#01/#06×2/#07/#08）并更新既有会话图用例。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）在 `/tmp/graph-0220/`。
- 详见 [features/session-graph.md](features/session-graph.md)、[session-tree.md](features/session-tree.md)。
## 迭代 73（2026-11-11）侧栏会话树与悬停拓扑图
- [x] 侧栏分叉与原会话共用一行（用户 22:09 原话）：`lib/sessionTree.ts` 归并、`buildGroups` 一行一棵树；标题取根、点击打开树内最近活动的会话、未读/运行/待审批汇总、置顶整树生效；打开分叉时行内小字标出分叉名。
- [x] 悬停会话行在右侧弹出拓扑图（`ui/HoverCard` + `SessionTopology`）：节点 = 会话、无轮次与 token；布局、泳道色、连线、悬停线高亮 + 会话名 tip 复用 `sessionGraph`，点节点切换会话。
- [x] 右栏会话图切分支：分叉视图以当前分叉为主线，来源会话与其他分叉作分支泳道（来源写「原会话」）；主线仍在第 0 列。
- [x] 检查：decisions-check 新增 3 条；单测 layout 拓扑 / sessionListUtils；regression 新增「侧栏分叉并入原会话行…」。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）在 `/tmp/fork-topo/`。
- 详见 [features/session-tree.md](features/session-tree.md)。
