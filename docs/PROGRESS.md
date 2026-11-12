# 进度

## 迭代 79（2026-11-12）反馈1603：会话图悬停粒度、等待输入标记、子代理会话加载
- [x] 原话「悬停在某个选项卡上的时候，不需要把所有同分支的选项卡都高亮，只需要高亮悬停的选项卡即可」：`SessionGraphView` 标题行底色只跟 `data-row-hovered`（指针所在行），同会话其他行保持原背景；整条泳道线与悬停节点突出保持不变（R76）。
- [x] 原话「当正在思考，或者等待输入的时候，需要有呼吸效果和对应的输入标记」：graph 接口对 `waiting_permission` 下发 `waiting`；等待输入的会话最新一轮显示侧栏待审批同色标记（`bg-accent running-dot`）与「等待你的输入/审批」tooltip，主会话/分叉/子代理与悬停浮层同样适用（R77）。
- [x] 原话「子代理会话加载有问题，有时候加载不出来」：会话视图关闭时退订只属于它的子代理快照订阅；空子代理条目重新订阅取首屏；从分叉等视图进入时 `ensureSubagent` 补开树根视图（R78）。
- [x] 检查：regression 新增反馈1603#05/#07/#08 三条并更新反馈1110 悬停行断言；`node scripts/check.mjs --skip-smoke`；截图在 `/tmp/fix-1603b/`。

## 迭代 78（2026-11-12）反馈「调整」修整：小元素/光标/预览、变体·文字·隐藏、重新冻结与继续调整、调试版源码定位
- [x] 原话「新增控件列表悬停时需可预览」：插入面板悬停选项时在面板旁用真实 `ui/*` 组件渲染示例，移开消失，深浅色跟随主题。
- [x] 原话「控件样式太小……无法调整大小，无法选中，鼠标形状不会改变」：小于 16px 元素命中区外扩 8px；Tab/Shift+Tab 切兄弟、Enter 进子级；小元素手柄外置、20px 命中区、方向光标；命中层 grab/move/grabbing。插入的控件（含容器/示意行）同样有手柄、吸附 token、可拖动/删除/备注。
- [x] 「没做的」六项：Button/IconButton/Badge 变体切换、纯文本改文字、隐藏（保留占位）、手机预览/移动布局可用、重新冻结（退出副本操作真实界面→重新克隆并重放改动，挂不上的标红）、调试版源码定位（`debug-source-plugin.mjs` 仅 debug flavor 注入 `data-tandem-src`，清单写 file:line）。
- [x] 原话「完成调整后，想再次进入之前调整过的副本修整之前的改动无法进入」：调整快照保存副本 HTML（≤3MB）与改动清单；抽屉「继续调整」恢复副本、改动与插入控件，保存更新同一条目（截图/清单更新，不新建）；草稿与 `.tfb` 同样带快照。
- 检查：`node scripts/check.mjs --skip-smoke`；regression 的调整用例新增小元素/光标、插入预览、变体/文字/隐藏、重新冻结、继续调整与手机布局；`release-flavor` 断言发布版无调整入口且无 `data-tandem-src`。截图在 `/tmp/fb-adjust-2/`。
> 更新：2026-11-12。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 77（2026-11-12）反馈「调整」：冻结副本上改 UI，导出给 agent 实现（P0–P2）
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
