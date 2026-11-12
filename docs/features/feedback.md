# 反馈模式

> 更新：2026-11-12。

调试版（`__TANDEM_DEBUG__`）内置的记录工具：Ctrl+Shift+F 进入，工具条有「点选 / 框选 / 调整」。发布版整体剔除（`scripts/scan-release.mjs` 有禁用词）。

## 实时保存，不丢

- 每新增/编辑/删除一条反馈立即写 IndexedDB（`tandem-feedback`，图片存 Blob）并把文字镜像到 localStorage；桌面调试版额外通过 IPC 写 `<下载>/Tandem 反馈/草稿-<YYYYMMDD-HHmm>/`。
- 草稿目录：`feedback.md`、`manifest.json`、`NN-元素截图.png`、`NN-标注截图.png`、`NN-参考-*.png`、`NN-快照.json`、`NN-轨迹.md`、`NN-录屏.webm`；调整条目另有 `NN-调整前.png`、`NN-调整后.png`、`NN-调整.json`、`NN-调整说明.md`。
- 写入用「临时文件 + rename」，删条目后旧编号文件一并清掉；重开提示「已恢复 N 条未导出的反馈」并继续写同一目录；导出后草稿保留 7 天，未导出的一直保留；关窗不拦截。
- 实现：`lib/feedbackDrafts.ts` + `packages/desktop/feedback-drafts-core.js`（单测 `feedback-drafts.test.ts`）。

## .tfb 包格式

- 导出 `tandem-feedback-<YYYYMMDD-HHmm>.tfb`：零依赖 zip（store 不压缩，`lib/zipStore.ts`），改扩展名即可解压；桌面调试版默认存 `<下载>/Tandem 反馈/`。
- `manifest.json` 头部 `version`/`format` 供演进；条目 `files` 列附件，调整条目另有 `adjust` 摘要（改动数、冻结耗时、token、非标准值数、是否有源码位置）。
- 解包（兼容旧 `.json` 包与草稿目录）：`node scripts/feedback-unpack.mjs <tfb|json|草稿目录> [outDir]`，回执用 `scripts/feedback-receipt.mjs`。输出 `feedback.md`、`by-feature/<功能>.md`、`by-cause/<编号>.md` 与附件；调整条目同时给出可直接照做的 `NN-调整说明.md`。

## 调整：冻结副本上改 UI（2026-11-12 用户决定）

- 进入：工具条「调整」→ 先截调整前画面，再同步克隆当前视口为静态 stage（fixed、`isolation`、`contain`，跳过 script/style/反馈 UI/toast）；canvas 固化、iframe 换占位、输入框只读、滚动位置恢复。真实界面全程不动，退出 `stage.remove()`。
- 选中：悬停描边 / 点击选中 / Alt+点击选父级 / Tab·Shift+Tab 在兄弟间切换 / Enter 进子级；点图标落到最近的可交互控件。小于 16px 的元素把命中区外扩 8px（指针擦边 6px 也能选中），操作条避开外侧手柄。
- 手柄：8 个方向改宽高；元素小于 28px 时手柄放到元素外侧，每个手柄 20px 命中区（视觉 10px）；悬停手柄显示 nwse/nesw/ew/ns 光标，悬停可拖动元素显示 grab、按住 Alt 显示 move、拖动中 grabbing（`index.css` 的调整模式规则覆盖反馈模式 pointer）。
- 尺寸：高度吸附 24/28/32/36/44（±2px），宽度吸附 4px 栅格；面板显示 token 名，未命中标「非标准值」并写进清单。
- 编辑：换图标只从项目在用的 lucide 集选（`scripts/feedback-adjust-icons.mjs` 扫描导入生成 `adjustIcons.generated.ts`，`check-debug` 校验未过期）；Button/IconButton 换 `ButtonVariant`、Badge 换 `BadgeTone`（只记变体名，class 来自 `ui/*` 导出的映射）；纯文本改文字（记改前/改后）；隐藏只设 `visibility:hidden` 并保留布局占位（与删除区分）；Delete 删除；Ctrl+Z / Ctrl+Shift+Z 撤销重做；改动清单每条可单独回退。
- 位置：默认拖动是同容器换序（清单写「第 N 个位置 / 在某项之后」）；按住 Alt 自由拖动并显示对齐吸附线，清单记 `translate(dx,dy)`；方向键 1px、Shift 8px。
- 清单合并（反馈1603）：同一元素上**连续**的改尺寸 / 移动只留一条改动，改前取第一次拖动前、改后取最后一次，实现时不跟逐次拖动过程（如「宽度 758→352」「translate 最终值」）；撤销回到第一次拖动前，重做落到最后一次。
- 选择器（反馈1603）：生成时跳过 Radix / React useId 的运行时自动 id（`radix-_r_x_`、`_r_x_`、`:r x:`），退回 `data-*`/`aria-label`/class + 结构路径，避免恢复副本或重新挂载后挂不上。
- 插入：面板只列 `ui/*` 现有导出与变体（Button/IconButton/Badge/ListRow/Input/Card/列表 Card+ListRow/菜单示意），点按或拖入；悬停选项时在面板旁用真实 `ui/*` 组件渲染预览（深浅色跟随当前主题）。插入的控件同样有手柄、吸附 token、可拖动/删除/备注；容器可「展开编辑」加示意行、每行选 ListRow/Button/Badge 并写行备注；清单标明「示意草稿，按 ui/* 复刻」。
- 备注：元素、单条改动、容器、示意行都可写行为备注，导出时紧跟对应改动。
- 重新冻结：副本不可交互（菜单/弹层要先打开再进入），选择器不含自动 id，恢复后按结构路径挂回。工具条「重新冻结」先退出副本、让用户操作真实界面，随后重新克隆并按选择器把已有改动挂回新副本；挂不上的改动在清单标红并在 Markdown 注明「恢复副本后未挂上」。
- 完成与继续调整：完成生成一条普通反馈条目（`mode: adjust`，前后截图 + 结构化清单 + 结构快照 + Markdown），快照同时保存副本 HTML（`adjustSnapshot.copy`，上限 3MB；含内联样式与 `data-tandem-src`）与尺寸；每条改动仍带 `structure[].styles` 计算样式快照。抽屉里「继续调整」恢复当时的副本、改动与插入控件，在其上增删改后保存更新同一条目（不新建，文本/优先级/标签保留，截图与清单更新）；旧条目没有副本 HTML 时退回「重新冻结 + 重放改动」。草稿落盘与 `.tfb` 里的调整 JSON 同样带副本快照。
- 组件与源码定位：调试版构建保留函数名（`build.rolldownOptions.output.keepNames`）；`packages/web/debug-source-plugin.mjs` 仅在 debug flavor 给原生 DOM 注 `data-tandem-src="packages/web/src/…:行号"`，清单写该元素自身的 `file:line`；拿不到时退回标签名 + 最近 `data-testid`/`aria-label`/`data-*` 锚点 + 选择器。发布版不加载插件（`scan-release` 禁用 `data-tandem-src`）。
- 手机：调试版手机预览/移动布局（412×915、触屏）下工具栏、插入面板与悬停预览不越界，触屏点选、拖手柄改大小、完成与继续调整均可用；手柄不再对触摸事件直接返回。
- 浮层避让：插入面板、悬停预览、选中工具条、改动清单都走 Radix 碰撞（与 `ui/Popover` 同一套 flip/shift）；桌面上面板居右、清单居左、预览在面板左侧，窄视口面板改底部抽屉、预览在其上方；选中工具条放到选中元素上/下方并避开这些浮层。调整期间收起已有 toast，新提示显示在底部工具条状态区。
- 限制：不搬副本 HTML，agent 必须按 `ui/*` 重写；发布版无入口（`scan-release` 禁用 `FeedbackAdjust`、`feedbackAdjust`、`data-adjust-`、`data-tandem-src`）。

## 截图性能（长会话，R48）

- 只内联视觉相关计算样式（约 160 条白名单）；长会话跳过视口外行，8k 元素降到约 2k；区域截图只克隆包含区域的最深容器。
- 整页缩略图 ≤900px 空闲补拍；桌面调试版走主进程原生截图（`feedback:capture-page`），网页端用 DOM 克隆。
- 点选/框选先出「截图」提示再做重活；分阶段耗时记在 `lib/feedbackPerf.ts`，回归从 `window.__feedbackPerfCapture` 读。调整前后截图走 `captureSnapshotShot`（≤1600px、不补白）。
- 已知限制：超大消息行元素截图约 0.6s；网页端整页缩略图约 0.5–0.7s。

## 演示工作区、体验清单与回执

- 设置 → 关于 →「演示工作区」在 `~/.tandem/demo/` 建独立仓库与脚本化模型，预置 17 个场景，可重放/一键清除。
- 设置 → 关于 →「体验清单」按功能列测试要点，可「在演示中打开」并标通过/有问题/跳过；进度存本机，导出反馈包时附带报告。
- 维护者按条目写 `## fb-xxx` 与 `- status:`、`- note:`、可选 `- after:`，用 `scripts/feedback-receipt.mjs` 生成回执；用户在抽屉「导入回执」逐条前后对比并复验。

## 限制

- 加密与跨设备同步不做；录屏 8MB / 60 秒。
- 桌面草稿目录只在桌面调试版存在；打包时 `feedback-drafts*.js` 必须进 `app.asar`，`scripts/check-debug.mjs` 会检查。
- 自动检查：`e2e/regression.mjs` 的体验清单导出、草稿恢复与「调整工具」用例（含小元素、光标、插入预览、变体/文字/隐藏、重新冻结、继续调整、手机布局、面板/预览/选中条/改动清单/toast 互不遮挡的 1440×900 与 390×844 两档视口），以及「调整说明：同元素连续改尺寸/移动合并为一条、选择器跳过 Radix/React 自动 id」；`e2e/release-flavor.mjs` 检查发布版没有调整入口且没有 `data-tandem-src`。
