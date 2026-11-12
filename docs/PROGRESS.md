# 进度

> 更新：2026-11-12。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 76（2026-11-12）反馈「调整」：冻结副本上改 UI，导出给 agent 实现（P0–P2）
- [x] 原话「反馈模式下，我自主去小小的调整下 ui……我调整后不会立即生效，只是给你一个参考的结构」+「冻结副本我觉得就挺好的」「还想要备注行为……要注意复用现有控件和设定好的高度、宽度值」：反馈工具条新增「调整」，进入即冻结当前视口为静态副本；悬停/点击/Alt 选父级、8 手柄吸 token（24/28/32/36/44、4px 栅格，非标准值标注）、换项目在用的 lucide 图标、删除、换序（默认）与 Alt 自由拖动（吸附线 + translate）、撤销/重做/单条回退；插入 `ui/*` 控件与容器示意行、元素/改动/行行为备注。
- [x] 产出：完成即生成一条 `mode: adjust` 反馈条目（前后截图、`NN-调整.json` 改动清单与结构快照、`NN-调整说明.md`），随 `.tfb` 导出；`scripts/feedback-unpack.mjs` 生成 agent 可逐条照做的说明，`feedback.md`/`by-feature` 链接过去；草稿实时落盘。图标集由 `scripts/feedback-adjust-icons.mjs` 扫描导入生成，调试版保留组件名（keepNames），拿不到时退回标签名 + `data-*` 锚点 + 选择器。
- [x] 检查：regression 新增「调整工具」用例（冻结后真实 DOM 不变、尺寸吸附 token、清单字段、unpack 说明、发布版无入口）；`e2e/release-flavor.mjs` 断言无调整入口；`scan-release` 禁用 `FeedbackAdjust`/`feedbackAdjust`/`data-adjust-`。详见 [features/feedback.md](features/feedback.md)。
- 验证：`node scripts/check.mjs --skip-smoke`；Playwright 全流程截图在 `/tmp/fb-adjust-impl/`。
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
