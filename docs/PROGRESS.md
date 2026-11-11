# 进度

> 更新：2026-11-11。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 70（2026-11-11）会话图重设计（反馈1926，10 条）
- [x] 历史决定与本包 10 条原话汇总为设计：[archive/plan/session-graph-2026-11-11.md](archive/plan/session-graph-2026-11-11.md)。轨道式 + 泳道色保持（2108 打分卡 B）。
- [x] 显示：#01 去掉汇总行；#05 去掉轮号；#09 去掉 token/耗时；#08 去掉「结果已返回」行，子代理最后一行直接汇回父会话（落在父轮节点或主线轨道）。
- [x] 布局：#06 时间倒序（布局末尾统一翻转行号）；#02/#04 子代理始终展开，删除展开状态与 ▸/└。
- [x] 交互：#10 每条轨道线 12px 透明命中描边，悬停高亮整条会话轨道、其余降亮，tooltip 显示会话名；#03 子代理视图点主线节点先退出子代理再定位该轮。
- [x] #07 覆盖滚动条（共享层）取最外层祖先留白，让到卡片外的面板内边距，不压卡片头部控件。
- 验证：`node scripts/check.mjs --skip-smoke` 通过；截图与对比图 `/tmp/graph-1926/`。

## 迭代 69（2026-11-11）反馈1601：切换闪屏 / 文件夹弹层 / 金额 / 折叠记忆
- [x] #02 P0 切换会话闪屏（R10 复发）：帧采样定位到消息区在切换后 1 帧内下移 132px——注入说明行在首屏快照之后才挂载，ResizeObserver 的贴底补偿排到了下一帧。ChatView 改在 ResizeObserver/MutationObserver 回调里绘制前同步补 scrollTop；右栏上下文按会话缓存，切换时卡片不再消失一帧；regression 反馈1601#02 逐帧断言贴底、可见首行不动、右栏分组/会话图稳定。
- [x] #01 文件夹弹层改 ui/Menu（R01 复发）：Menu.Label / Menu.Separator / Menu.Item，去掉手写标题与 border-t 分隔；ui-audit 新增 role-menuitem 与手写菜单标题/分隔线规则。
- [x] #03 用户消息金额：`formatCost` 对 0<usd<0.00005 显示 `<$0.0001`，0 显示 `$0`；单测 + regression。
- [x] #05 侧栏折叠记忆：折叠键改为 hostId + 仓库根路径（旧键兼容），重开恢复；regression 反馈1601#05。
- 验证：`node scripts/check.mjs --skip-smoke --skip-regression` 全绿；本包新增/涉及的 regression 用例（1601#02/#05、文件夹弹层 4 条、用户消息金额、最占空间）单跑全过。全量 regression 剩余的「反馈2102#02 会话图快速连点」「反馈1919#07 回到底部恢复跟随」在干净基线 2bfbb1b 上同样失败（已逐一回退 ChatView 复测），属既有问题。截图（深/浅）在 `/tmp/fix-1601a/`。
## 迭代 68（2026-11-11）UI 第三批：芯片/徽标统一（打分卡 U3-B，用户原话「徽標用方案B」）
- [x] 新增 `ui/Badge`：透明底 + 1px 边、4px 圆角、20px 高、11px 字；tone = neutral / success / warn / danger / annotation。
- [x] 替换 34 处徽标（调试、反馈、体验清单、演示、评测、工作站、浏览器/预览、分享），状态/演示用中性描边（P02），反馈标注用新 token `--t-annotation`（沿用原 #F97316，深浅各一）。
- [x] 9.5–10.5px 文本全部提到 11px（tsx 59 处、CSS 6 处；侧栏 kbd、ToolCard、DiffView、Composer 一并）；ui-audit 新增 `hardcoded-annotation-orange` 与 `tiny-font`（白名单为空，演示设备缩略画面注明原因）。
- [x] decisions-check 新增 `ui-badge`（2026-11-11 用户决定）；截图 `/tmp/u3b-after/compare.png`（现状 vs B 实装，浅/深）。
- 验证：`node scripts/check.mjs --skip-smoke` 通过。

## 迭代 67（2026-11-10）输入框分工/取向两个维度（反馈2009#01）
- [x] 用户原话（反馈2009#01）：上面四个选项与委派倾向重复，应分两个维度（积不积极派子代理 / 质量优先还是成本优先）。菜单改为「分工」（关闭 / 适度 / 积极）与「取向」（省钱 / 均衡 / 质量优先）两组单选；「仅规划」移除（计划模式权限已覆盖）。
- [x] 数据：会话 `delegation` + `routeBias` 取代 `routePreference`；旧数据读取时一次迁移并写回；protocol 与服务端同步。
- [x] 运行时按矩阵实现（`features/routing.md`）：Task 只在多代理协作回合开放；成本上限只对积极生效；取向决定未绑定执行者的档位；分工关闭不规划、不出提示行；学到的偏好改由分工前确认卡累计。
- [ ] 第三个维度「验证策略」未做（用户提出，另做）。
- 验证：`node scripts/check.mjs` 全量通过（regression 171/171）；菜单截图（浅色 / 深色、两个子菜单）在 `/tmp/route-menu/`。
