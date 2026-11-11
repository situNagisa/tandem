# 进度

> 更新：2026-11-12。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 74（2026-11-12）会话图整棵树共用拓扑（反馈0220）
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
## 迭代 72（2026-11-11）反馈2156：会话图跳转/运行动画、未读持久化、上下文卡精简
- [x] #01 原话「点击会话图后，并不需要这个高亮」：删除 `msg-jump-hit` 实现与样式；会话图、大纲、搜索、收件箱跳转只滚动定位，回归断言目标无高亮背景（反馈2156#01）。
- [x] #02 原话「右边的这个点没有记忆」：根因是快照摘要 `summaryOf` 丢掉 `unread`，列表点被本地清掉但服务端未写回；补 `unread` 并在聚焦时以列表摘要兜底调用已读接口，重载后不再出现（反馈2156#02）。
- [x] #03 原话「正在输出的轮次加上一个动画」：运行中会话最新轮节点外圈复用侧栏 `running-dot` 呼吸动画，尊重 `prefers-reduced-motion`（反馈2156#03、decisions-check `graph-running-animation`）。
- [x] #04 原话「删掉这个最占空间」：删除上下文卡/弹层/外部预览的「最占空间」区块、折叠记忆与按轮聚合计算，相关旧断言与 decisions 规则删除（反馈2156#04）。
- 验证：`node scripts/check.mjs --skip-smoke`；截图（深/浅）在 `/tmp/fix-2156/`。
