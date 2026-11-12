# 进度

> 更新：2026-11-12。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 76（2026-11-12）反馈1110：跳转恢复轮次大纲的弹簧动画、会话图悬停与运行标识
- [x] 原话「跳转用之前的轮次大纲的跳转代码，不需要滑轮中断跳转，只是统一跳转逻辑，并且不要一直轮询锁视图，现在的跳转没有跳转动画了」：把 c583b93 删掉的 `ScrollFollower` 弹簧跟随放回 `lib/jump.ts`（`createJumpScroller` + `startJumpScroll`），`focusMessage`/`focusTool` 仍是唯一入口；删除滚轮/触摸/按键“立即取消”和逐帧收敛的 `placeElement`；到达后最多复核一次（140ms，`verifies<2`）即停，不轮询（R68 第 3 次）。
- [x] 原话「悬停的会话没有更加高亮，不知道自己悬停在哪了」：`SessionGraphView` 悬停节点 `data-hovered`、圆点 8→10px + 同色外圈，整条线高亮保持；紧凑浮层同样（R75）。
- [x] 原话「最新的正在思考输出的轮次没有对应标识…子代理、分叉、主会话都要有」：graph 接口每个会话下发 `running`，客户端按所属会话在各自最新一轮显示 `running-dot`；运行状态变化（`session_updated`）经 `useSessionGraphTree` 的签名重新拉取拓扑（R75）。
- [x] 检查：decisions-check 新增 `jump-single-spring`/`graph-hover-node`/`graph-running-all-sessions`、更新 `graph-uniform-node`；regression 更新 0220#03 滚轮用例、新增「跳转有动画」与反馈1110 两条。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）`/tmp/fix-1110/`（跳转中间帧、悬停节点、三条线同时运行）。

## 迭代 75（2026-11-12）反馈0220：额度交接可继续/可关闭、文件链接只认明确引用、一轮只留一处操作行
- [x] #02 原话「额度预算它就没有继续功能…我没办法继续，现在就用不掉这个额度」：交接卡首位加「继续使用当前分组」→ 服务端 `chooseHandoff('continue')` 写会话级 `handoffBypass`、继续本轮，同类提醒不再拦截、冷却 Key 直接重试到上游报错；设置「额度交接」新增 `off`（关闭）真正跳过建卡；`forecast` 只提示不拦截；预算规则停用/删除后 `blockingRule` 不再阻止并加单测（反馈0220#02 / R72）。
- [x] #04 原话「不能靠字符串识别，只要长得像文件就当成文件」：删除纯文本启发式（`splitFileRefs`/remarkFileLinker），只保留 Markdown 链接与「行内代码 + Host 批量存在性 `POST /api/fs/exist`」；客户端 60s 缓存、同帧合并请求（反馈0220#04 / R06）。
- [x] #05 原话「只有最后一段需要留空白…中间这些不需要」：`MessageList` 按轮算最后一条 assistant，只有它渲染时间/用量/操作行（反馈0220#05 / R73）。
- [x] 检查：单测 `handoff`/`budgets`/`fileLinks`；regression 新增 0220#02 两条、#04、#05 共 4 条。
- 验证：`node scripts/check.mjs --skip-smoke`；截图在 `/tmp/fix-0220c/`。

## 迭代 75（2026-11-12）会话图整棵树共用拓扑（反馈0220）
- [x] #08 原话「分叉作为主线，一条线上去，不应该再在这里引出一个蓝色的条，也可以看到主会话上分出的子代理节点；所有节点和主会话应该都是一样的，只是主线不同」：新增 `GET /api/sessions/:id/graph`（协议 `SessionGraphTree`：树内所有会话的轮次 id/标题、父子关系与接入点；服务端去重分叉复制的历史、跨会话解析分叉点、`parentToolUseId → 轮次`）。`layoutSessionGraph` 成为唯一布局：trunk = 当前会话祖先链（第 0 列一条直线），其余会话独有轮次为分支泳道；主会话/分叉视图节点集合与数量相同。
- [x] #01 原话「外部绘画，绘画图没办法点击跳转」：外部会话图节点点击走同一个 `focusMessage` 定位该轮。
- [x] #06 原话「没有分叉或者子代理时右侧不要弹出这个卡片」+「进入反馈模式卡片还是会消失」：单会话树不弹；`ui/HoverCard` 与菜单/Popover 同一规则，反馈模式下指针离开不收起（共享层）。
- [x] #07 原话「悬浮选项卡时左边拓扑图也要高亮，点拓扑图也要跳转」+「拓扑图特别细很难选中」：悬停名称行/连线高亮该会话的线与节点；点线/节点跳转；连线命中带两侧各 6px（列距 14px）、节点命中 20px、名称行整行可点。
- [x] 悬停浮层改为同一张图的紧凑模式（`compact` 参数）：保留每个会话起点/最新轮、分叉点/派出点、子代理汇回点，其余轮次省略；删除 `layoutSessionTopology` 第二套布局。
- 检查：decisions-check 改写 `sidebar-hover-topology`/`graph-trunk-current`/`graph-edge-hover` 并新增 5 条；单测重写 13 条；regression 新增 5 条（0220#01/#06×2/#07/#08）并更新既有会话图用例。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）在 `/tmp/graph-0220/`。
- 详见 [features/session-graph.md](features/session-graph.md)、[session-tree.md](features/session-tree.md)。
