# 反馈模式「调整」：冻结副本上改 UI，导出给 agent 实现

> 更新：2026-11-12。一次性设计记录，写完即冻结。状态：设计 + 原型验证（未合入产品代码）。
> 产品依据：
> - 用户 2026-11-12 原话：「反馈模式下，我自主去小小的调整下 ui……换一下按钮样式，调整一下大小，替换某个图标，去掉某个控件，调整一下位置，添加一些控件。我调整后不会立即生效，只是给你一个参考的结构，去按这个结构实现，并不实际上修改运行中的控件，修改后的控件只在反馈模式下生效。」
> - 用户 2026-11-12 11:24 补充：「冻结副本我觉得就挺好的」；「一些按钮控件，我可以备注它的行为……我增加了一个列表控件，我展开后我可以备注它的列表有上面行为，要显示哪些内容」；「还要注意要复用现有的控件，以及一些设定好的高度，宽度值」。
> - 产品经理方向：反馈模式第三种工具「调整」；冻结视口 DOM 成静态副本；所有编辑只发生在副本；v1 操作与产出见下。
> - 原型：`/tmp/fb-adjust/`（截图、`exported-adjust.json`、`measurements.json`、`run.mjs`）；产品代码未合入，原型改动只留在 worktree 分支。

## 0. 摘要

- 反馈模式顶部工具从「点选 / 框选」扩展为「点选 / 框选 / 调整」。进入调整时把当前视口 DOM 克隆成一份静态副本覆盖在应用上；副本与应用代码零耦合，React 重渲染、WS 更新、路由都不会冲掉编辑，也不会影响真实控件。
- 调整结果不是补丁，而是**给 agent 的实现说明**：每次调整成为一条反馈条目，带前后截图、改动清单（目标选择器、组件名/源码位置、样式差值、换序、图标/变体名、插入控件与位置）、行为备注、副本结构快照。`feedback-unpack` 输出成一份 agent 可直接按条实现的 Markdown。
- 用户已定：冻结副本（不再比较「直接改真实 DOM 并还原」）。仍有两个方向分歧点，见第 11 节打分卡：位置调整自由度、插入容器控件的呈现方式。
- 原型已跑通最小链路：冻结克隆 → 选中 → 拖手柄改宽高（吸附 token）→ 换图标 → 删除 → 行为备注 → 插入列表并展开加两行与行备注 → 撤销/重做/单项回退 → 导出 JSON。普通会话页冻结 18ms；320 轮大会话（601 行、7.2 万 DOM 节点）冻结 390–517ms。控制台无错误。

## 1. 目标与非目标

**目标**

1. 让用户用「摆一下」代替「描述」，尤其是按钮样式、尺寸、图标、控件增删与位置这类语言难描述的操作。
2. 编辑过程绝不改变运行中的应用；退出调整即恢复原状。
3. 产出一份足够具体的实现说明，agent 能一次改到位，不需要来回猜。
4. 复用 `components/ui/*` 的组件、变体与尺寸档位；插入内容与尺寸改动都受 token 约束（自由值允许，但标注非标准）。

**非目标**

- 不做可视化 CSS 编辑器（不开放任意属性、颜色拾取、渐变/阴影面板）。只做用户明确列出的操作。
- 不把副本 DOM 当作最终实现；agent 必须按 `ui/*` 重写，不得直接搬克隆 HTML。
- 不在发布版出现。反馈模式整体已由调试版构建剔除，调整作为其子模块沿用同一开关。
- 不做实时协作、跨设备同步、在线预览；调整条目仍走 `.tfb` 反馈包。
- v1 不保证副本可交互（菜单、下拉、对话框等需要先在真实界面打开再进入调整）。

## 2. 推荐方案总览

```
反馈模式（Ctrl+Shift+F）
  └─ 顶部工具：点选 | 框选 | 调整
       └─ 进入调整：冻结当前视口
            ├─ 选中：悬停描边 / 点击选中 / Alt 选父级（复用点选命中）
            ├─ 改：手柄改宽高（吸附 token）/ 方向键偏移 / 删除或隐藏 / 改文字
            │      换图标（项目在用 lucide）/ 换 Button·Badge 变体
            │      插入控件（ui/* 白名单）/ 容器展开示意行
            ├─ 备注：选中元素写行为备注；每条改动可单独补备注
            ├─ 历史：撤销 / 重做 / 每项单独回退
            └─ 完成：生成一条「调整」反馈条目（前后截图 + 改动清单 + 快照）
                 └─ .tfb → feedback-unpack → adjust/<n>.md + <n>-调整.json
```

### 2.1 冻结副本

- 进入调整时，先让「正在冻结当前画面…」提示绘制一帧，再同步克隆 `document.body` 的子节点（跳过 `script/style/meta`、反馈自身 `[data-feedback-ui]`、toast 层）。
- 副本 stage 固定定位、`inset: 0`、`z-index: 100`、`isolation: isolate`、`overflow: hidden`、`contain: paint`：
  - `isolation` 让应用里再高的 z-index（Radix Portal、Modal）也只在本层内生效，不会盖住反馈 UI；
  - `contain/overflow` 让副本内容不会溢出到视口外；
  - stage 与所有子节点 `pointer-events` 由上层命中层接管，副本本身不响应点击。
- 克隆保留 class 与内联样式，图标是内联 SVG，字体沿用当前文档，因此**不需要逐节点内联计算样式**（截图克隆需要，因为 foreignObject 在隔离文档里渲染；同文档克隆不需要）。这使冻结从「几秒」降到「十几毫秒 / 几百毫秒」。
- 滚动容器在克隆后恢复 `scrollTop/scrollLeft`；`canvas` 用 `toDataURL()` 固化成图片；`iframe` 替换成等尺寸占位（避免重新加载页面）；输入框/文本域复制当前值并设为只读；`contenteditable` 不再可编辑。
- 进入时冻结动画与过渡（`animation/transition: none`），避免副本继续动。
- 退出调整即 `stage.remove()`，原应用从未被修改。

### 2.2 与应用零耦合，以及必要的准备

- 副本不挂 React 事件，React 重渲染不会碰到它；路由、WS 消息、流式 token 都只会更新被遮住的真实 DOM。
- 需要调整「打开菜单后的弹层」时：先在真实界面打开菜单/Popover/对话框，再进入调整。副本会连同 Portal 弹层一起克隆。
- 副本不可交互是明确的代价：hover 才出现的行尾按钮、需要展开的级联菜单，必须在进入前把状态摆好。产品文案要说明这一点（进入调整时提示一次）。

## 3. 用户任务流程

1. **进入**：在任意会话页按 `Ctrl+Shift+F` 进入反馈模式，点工具条「调整」。画面冻结，顶部出现「已冻结 · N 个节点 · Xms」，底部出现调整状态条。
2. **选中**：鼠标移到元素上出现橙色描边与组件/标签名；点击选中；`Alt+点击` 选父级。选中后出现 8 个手柄、尺寸与 token 标签、快捷操作条（行为备注 / 换图标 / 删除）。
3. **改**：
   - 拖手柄改宽高；高度吸附到 24/28/32/36/44 档位（±2px），宽度吸附到 4px 栅格；命中时面板显示 token 名（如「Button md / ListRow md 32」），否则显示「非标准值」。
   - 方向键偏移 1px，`Shift` 8px；`Delete/Backspace` 删除；`Ctrl+Z` 撤销、`Ctrl+Shift+Z` 重做。
   - 「换图标」打开图标面板，只列项目在用的 lucide 图标（原型内置 87 个常用图标，正式版由构建脚本从源码导入中生成全集）。
   - 「换变体」从 `ui/Button` 的 `ButtonVariant` 与 `ui/Badge` 的 `BadgeTone` 读取；原型阶段先做图标与尺寸，变体切换列入 P3。
   - 「插入控件」从 `ui/*` 白名单插入；列表类容器可「展开编辑」：加示意行（每行可选 ListRow/Button/Badge）、写行标题与行备注。
4. **备注**：选中元素点「行为备注」，写点击/悬停/展开后的行为；改动清单里每条也可补备注。列表整体备注写排序、字段、空状态，行备注写每行显示什么、点击去哪里。
5. **记录**：每项改动立即进入左侧改动清单，可单条「回退」；底部显示「N 项改动 · 未导出」。
6. **完成**：点「完成并导出」，生成调整条目并返回反馈模式；可继续在条目抽屉里编辑文字、优先级、功能标签，或继续调整第二条。也可「复制说明」直接得到 Markdown。
7. **导出与实现**：导出 `.tfb` → `node scripts/feedback-unpack.mjs <tfb>` → `adjust/<n>.md` 与 `<n>-调整.json`；agent 按条目逐项实现，不改运行中的控件。

## 4. 交互细则与快捷键

### 4.1 选中与命中

- 命中逻辑复用点选：跳过反馈 UI 与 stage 根；点在图标的 `path`/文字上时落到最近的 `button/a[href]/[role=button]/menuitem`，避免把整颗调整变成改 16px 图标。
- `Alt+点击` 选父级；点击空白清除选择。
- 悬停框只描边，不改元素样式；选中框多一圈淡橙。
- 容器类元素（列表、卡片、对话框）选中后额外提供「展开编辑」；普通元素只有备注/换图标/删除。

### 4.2 尺寸与位置

- 8 个手柄：`n/nw/ne/w/e/sw/s/se`。`w/n` 方向改尺寸时用独立的 `translate` 补偏移，保证对边不动；不覆盖元素原有 `transform`。
- 尺寸以设计稿像素记录，同时记 `tokens` 与 `standard`。
  - 高度档位：24（Button inline）、28（Input sm / ListRow sm）、32（Button md / ListRow md）、36（Button lg / Input lg）、44（触控目标）。
  - 宽度：4px 栅格；命中 24/32/44 时标 `IconButton 24/32`、`触控目标 44`。
  - 吸附阈值 ±2px；自由值保留，但清单写「非标准值：实现时就近取 ui 档位」。
- 位置：
  - 方向键自由偏移（1px / Shift 8px），连续按键合并为一条改动。
  - 拖动位置 v1 见打分卡：推荐默认同容器换序，按住 `Alt` 自由拖动并显示对齐吸附线；改动清单优先写「在第 N 个兄弟之后」，无法换序才写 `translate(dx,dy)`。
- 插入控件默认放在视口中部，按插入顺序轻微错开；插入位置记录为固定坐标与目标容器，实现时按布局语义落位。

### 4.3 删除、隐藏、改文字

- 删除：从副本移除，记录目标、原 `outerHTML` 摘要与结构快照；可单项回退。
- 隐藏：保留布局占位，设 `visibility: hidden`；记录为「隐藏，但保留占位」。
- 改文字：v1 只允许纯文本节点，内联编辑后记录改前/改后；富文本与代码块不开放。

### 4.4 换图标与换变体

- 图标：替换选中元素内最近的 `<svg>`；保留原 `width/height/stroke/class` 中的尺寸属性，class 改成 `lucide lucide-<name>`；记录改前/改后的 lucide 名。只能从项目在用的 lucide 集中选。
- 变体：仅对识别为 `Button`/`IconButton`/`Badge` 的元素开放，选项来自 `ui/Button.tsx` 的 `ButtonVariant`、`ui/Badge.tsx` 的 `BadgeTone` 与 `ControlSize`；记录 `variant` 名，不记录 class 字符串。

### 4.5 行为备注

- 备注是自由文本，不是脚本。示例：「点击后打开设置 → 主机」「悬停显示完整路径」「列表按最近使用排序；空状态显示『还没有会话』」「行点击打开会话」。
- 备注挂在目标元素或改动上；导出时紧跟在对应改动后面。
- 插入的容器类控件（列表、菜单、下拉、卡片、对话框）可展开「示意区域」：
  - 整体备注：排序、显示哪些字段、空状态、点击/悬停行为；
  - 示意行：每行选 `ui/ListRow`、`ui/Button`、`ui/Badge` 之一，填标题与行备注；
  - 示意行只表达信息结构，明确标「示意草稿，实现时按 ui/* 复刻」，不能直接搬 DOM。

### 4.6 历史

- 撤销/重做覆盖尺寸、位置、图标、变体、删除、隐藏、文字、插入、备注。
- 每条改动可「单独回退」；回退不影响其他改动。
- 退出调整时若未导出，提示「有 N 项未导出的调整」，可留在调整里或放弃。

### 4.7 快捷键

| 键 | 行为 |
|---|---|
| `Ctrl+Shift+F` | 进入/退出反馈模式（已有） |
| `点击` | 选中元素 |
| `Alt+点击` | 选中父级 |
| `Delete` / `Backspace` | 删除选中元素 |
| `方向键` / `Shift+方向键` | 偏移 1px / 8px |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Esc` | 退出调整（先回点选，再按一次退出反馈模式） |
| `Enter`（输入框内） | 保存备注/行标题；`Esc` 关闭面板（不退出调整） |

## 5. 数据格式：.tfb 中新增 adjust 条目

调整作为普通反馈条目进入现有包结构。`manifest.json` 的 item 增加 `adjust` 摘要与文件引用；`feedback.md` 新增「调整」段并链接说明文件。

### 5.1 条目与文件

```
01-元素截图.png             # 调整前（进入调整时截取）
01-调整后.png               # 完成后截取（关闭反馈 UI，仅 stage）
01-调整说明.md              # agent 可直接执行的 Markdown
01-调整.json                # 结构化改动清单 + 副本结构快照
01-调整-1.png ...           # 需要时：每条改动的局部前后对比
```

`manifest.items[]`：

```jsonc
{
  "id": "fb-...",
  "mode": "adjust",
  "text": "调整导出按钮的样式与位置",
  "files": {
    "screenshot": "01-元素截图.png",
    "afterImage": "01-调整后.png",
    "adjust": "01-调整.json",
    "adjustMarkdown": "01-调整说明.md"
  },
  "adjust": {
    "changeCount": 5,
    "freezeMs": 18,
    "tokens": ["Button md 32", "4px 栅格"],
    "nonStandard": 1,
    "sourceAvailable": false
  }
}
```

### 5.2 `调整.json`

```jsonc
{
  "version": 1,
  "kind": "adjust",
  "id": "adj-...",
  "route": "#/h/<host>/s/<session>",
  "theme": "dark",
  "viewport": { "width": 1440, "height": 900, "dpr": 1 },
  "createdAt": 1794454420824,
  "freeze": {
    "durationMs": 390,
    "sourceNodes": 35938,
    "clonedNodes": 54930,
    "scrollContainers": 1,
    "skipped": 0
  },
  "changes": [
    {
      "id": "chg-...",
      "kind": "resize", // resize | icon | delete | hide | text | move | reorder | insert | note
      "at": 1794454416124,
      "target": {
        "selector": "#root > div.app-root.flex > aside... > button.inline-flex:nth-of-type(2)",
        "component": "Button",
        "tag": "button",
        "classes": ["inline-flex", "shrink-0"],
        "textSnippet": "设置",
        "ariaLabel": "设置",
        "testId": null,
        "source": null, // 调试版拿到时写 { fileName, lineNumber }，拿不到就保持 null
        "rect": { "x": 231, "y": 862, "width": 32, "height": 32, "pageX": 231, "pageY": 862 }
      },
      "before": { "width": 32, "height": 32, "offsetX": 0, "offsetY": 0 },
      "after":  { "width": 40, "height": 39, "offsetX": 0, "offsetY": 0 },
      "tokens": { "width": "4px 栅格", "height": "4px 栅格" },
      "standard": false,
      "note": "非标准值：未命中尺寸档位，实现时请就近取 ui 档位。",
      "behavior": "点击后打开设置 → 主机；长按显示快捷入口。"
    },
    {
      "id": "chg-...",
      "kind": "icon",
      "target": { "selector": "...", "component": "Button", "tag": "button", "ariaLabel": "设置" },
      "before": { "icon": "settings" },
      "after": { "icon": "search" },
      "behavior": null
    },
    {
      "id": "chg-...",
      "kind": "note",
      "target": { "selector": "...", "component": "Button", "tag": "button", "ariaLabel": "设置" },
      "after": { "behavior": "悬停 600ms 显示完整路径" },
      "behavior": "悬停 600ms 显示完整路径"
    },
    {
      "id": "chg-...",
      "kind": "insert",
      "target": { "selector": "[data-adjust-inserted=\"ins-...\"]", "component": "Card + ListRow", "tag": "div", "testId": "ins-..." },
      "after": {
        "itemId": "ins-...",
        "component": "列表（Card + ListRow）",
        "variant": "组合",
        "rows": [
          { "component": "ListRow", "title": "会话标题", "note": "显示标题 + 项目名；悬停显示完整路径" },
          { "component": "ListRow", "title": "最后活动时间", "note": "按 5 分钟粒度显示；点击切换到该会话" }
        ],
        "note": "按最近使用排序；点击行打开会话；空状态显示「还没有会话」。"
      },
      "behavior": "按最近使用排序；点击行打开会话；空状态显示「还没有会话」。",
      "note": "只用 ui/* 现有组件与变体；尺寸与间距取设计 token。"
    }
  ],
  "structure": [
    {
      "changeId": "chg-...",
      "selector": "...",
      "html": "<button class=\"...\" style=\"width:40px;height:39px\">…</button>",
      "styles": { "display": "inline-flex", "height": "39px", "border-radius": "8px", "font-size": "13px" }
    }
  ]
}
```

字段约定：

- `target.selector` 是进入调整时真实元素的选择器（用副本到原元素的映射取），不是副本里的临时路径；`target.component/ariaLabel/testId` 用于人读与 agent 定位。
- `source` 只在调试版能拿到时写；拿不到就不写，不要伪造。
- 尺寸只记 CSS px 的差值；`tokens` 记吸附到的档位名；`standard:false` 明确标非标准值。
- `behavior` 是行为说明；`note` 是实现提示（非标准值、示意草稿等）。两者分开，便于 unpack 排版。
- `structure` 只保留被改动子树的 `outerHTML`（单条 ≤12KB）与关键计算样式，不导出整页 HTML。

### 5.3 草稿目录

沿用现有实时保存：新增/修改/回退每条调整都写 IndexedDB；桌面调试版额外写 `<下载>/Tandem 反馈/草稿-*/`：

```
01-调整.json
01-调整说明.md
01-调整前.png
01-调整后.png
```

冻结副本本身不持久化：退出即丢，重新进入需重新冻结。恢复草稿时只恢复改动清单与说明，并提示「调整参考已恢复，需要重新冻结画面才能继续编辑」。

## 6. feedback-unpack 输出示例

新增 `adjust/` 目录（或按现有编号规则平铺 `<n>-调整说明.md`）：

```markdown
# 调整 01 · 导出按钮样式与位置

- 路由：`#/h/.../s/...`
- 主题：深色 · 视口 1440×900 @1x
- 冻结：克隆 54,930 个节点，耗时 390ms（源 35,938 个元素）
- 改动：4 项（1 项非标准值）

## 按顺序实现

1. **改尺寸**：把 `Button`（选择器 `#root ... > button:nth-of-type(2)`；aria-label=设置）的宽度 32→40、高度 32→39。
   - 尺寸 token：宽 4px 栅格、高 4px 栅格
   - **非标准值**：高度 39px 未命中档位，实现时就近取 36 或 40，并保持现有间距。
   - 行为备注：点击后打开设置 → 主机；长按显示快捷入口。
2. **换图标**：把同一按钮的图标从 `settings` 换成 `search`（lucide）。
3. **行为备注**：给同一按钮补「悬停 600ms 显示完整路径」。
4. **插入控件**：在页面中部插入「列表（Card + ListRow）」。
   - 容器备注：按最近使用排序；点击行打开会话；空状态显示「还没有会话」。
   - 示意内容（草稿，按备注实现）：
     1. ListRow：会话标题 — 备注：显示标题 + 项目名；悬停显示完整路径
     2. ListRow：最后活动时间 — 备注：按 5 分钟粒度显示；点击切换到该会话

实现注意：只用 `packages/web/src/components/ui/*` 现有组件与变体；图标只从项目在用的 lucide 集中选；尺寸优先取组件既有档位；不要直接复制 `调整.json` 里的 HTML。
```

`feedback-unpack.mjs` 的改动点（实施阶段 P1）：

- `dataFromManifest` 透传 `files.adjust`、`adjust` 摘要；
- 写出 `01-调整.json`、`01-调整说明.md`、`01-调整后.png`；
- `feedback.md` 的条目段增加「调整：N 项 · 说明 `01-调整说明.md`」；
- `by-feature/<功能>.md` 里保留同样的链接（相对路径 `../`）。

## 7. 复用与约束

### 7.1 插入控件白名单

面板只列 `packages/web/src/components/ui/*` 的导出与变体，不手写同类控件：

| 控件 | 来源 | 变体/尺寸 |
|---|---|---|
| Button | `ui/Button` | `primary / accent / secondary / ghost / danger-ghost`，`size: inline/sm/md/lg`（渲染高度 24/32/36） |
| IconButton | `ui/Button` | 同上变体，`inline/sm/md/lg` |
| Badge | `ui/Badge` | `neutral / success / warn / danger / annotation` |
| ListRow | `ui/ListRow` | `sm/md`，`as="button"|"div"` |
| Card | `ui/Card` | `section/div/article` |
| Input | `ui/Controls` | `inline/sm/md/lg` |
| 列表（组合） | `Card + ListRow` | 组合控件，需展开编辑示意行 |
| 菜单/下拉/对话框（P3） | `ui/Menu`、`ui/Modal`、`ui/Popover` | 只允许插入空壳，内容用行备注描述 |

- 不能插入原生产 `<select>`、手写按钮、自定义滚动条、带 `title` 的原生控件（P08）。
- 组合控件在清单里写清组合关系（如「Card + ListRow ×2」），不要伪装成一个不存在的组件。

### 7.2 尺寸吸附

```ts
高度档位: [24 Button inline] [28 Input sm / ListRow sm] [32 Button md / ListRow md] [36 Button lg / Input lg] [44 触控]
宽度: 4px 栅格；命中 24/32/44 时标 IconButton / 触控目标
吸附阈值: ±2px
```

- 拖动时实时吸附，面板显示「当前吸附到的 token」或「非标准值」。
- 清单同时记录数值与 token；`standard:false` 时写明「实现时就近取值」。
- 插入控件默认使用组件自身尺寸，参与吸附但不改组件默认 class。

### 7.3 图标集

- 只列项目在用的 lucide 图标，不引入新图标库。
- 正式版由构建脚本扫描 `from 'lucide-react'` 的导入，生成 `adjust-icons.json`（名称 + 中文关键词）；原型内置 87 个常用图标并带中文搜索词。
- 换图标记录 `before.icon` 与 `after.icon`（lucide 名），不记录路径 `d`。

## 8. 兼容与耦合风险

| # | 风险 | 现象/原因 | 对策 | 原型状态 |
|---|---|---|---|---|
| R1 | 副本样式完整性 | 担心内联样式缺失导致错位 | 同文档克隆保留 class，CSS 变量/字体/伪元素样式仍在；无需逐节点内联计算样式 | 深色演示页与 320 轮会话页视觉一致 |
| R2 | 滚动容器 | 副本停在顶部或空白 | 克隆后恢复每个滚动容器的 `scrollTop/scrollLeft`；克隆前不剪枝 | 已验证（普通页 1 个、长会话 1 个滚动容器） |
| R3 | Portal 弹层 | 菜单/对话框不在 `#root` 里，漏克隆 | 克隆 `body` 的直接子节点（跳过反馈 UI）；进入前把需要的弹层打开 | 已验证菜单类 Portal 可被克隆（未逐一截图） |
| R4 | `canvas` / `iframe` | 克隆后空白或重新加载页面 | canvas 转图片；iframe 替换等尺寸占位 | canvas 已验证；iframe 仅设计 |
| R5 | CodeMirror / 富文本编辑器 | 克隆只剩可见行，交互失效 | 静态克隆可读；不改动内容。需改文字时先退出调整在真实编辑器改，或 v2 做纯文本覆盖层 | 未验证，列入 P4 |
| R6 | 性能（大会话） | 克隆 7 万节点耗时 | 实测 390–517ms；>2 万节点时进入前提示，>5 万节点启用视口剪枝/骨架；不缩短用户操作路径 | 已量（见第 9 节） |
| R7 | 与捕获层/快捷键冲突 | 点选层拦截调整操作；Esc 直接退出反馈模式 | 调整层 `data-feedback-ui` + `z-index` 高于捕获层；捕获 hook 在 adjust 模式直接返回；Esc 先退出调整；Delete/方向键/Ctrl+Z 放行给调整 | 已验证点击不穿透、Esc 行为 |
| R8 | 调试版专属 | 发布版不应出现调整入口 | 调整组件由 `FeedbackMode` 引用，`__TANDEM_DEBUG__` 已控制反馈模式；发布构建 `strip-debug-dist` + `scan-release` 增加「调整」「adjust」禁用词检查 | 未接入检查，P4 |
| R9 | React 19 源码位置 | 生产构建拿不到 `_debugSource`/`__source`，组件名被压成 `$c` | 原型回退 `aria-label`/`data-testid`/tag；调试版可启用 React 开发运行时并解析 `fiber.type._debugStack`，或加 debug-only Babel 插件注入 `data-tandem-src` | 已验证回退；源码定位待研究 |
| R10 | 插入控件被误当实现 | agent 直接搬副本 HTML | 清单明确「示意草稿，按 ui/* 复刻」；insert 条目的 `structure` 只作参考；实现时按组件/变体名 | 已写入原型说明 |
| R11 | 行为备注歧义 | 自由文本可能仍然说不清 | 备注模板提示「点击/悬停/展开 + 显示哪些字段 + 空状态」；列表行按字段逐行备注 | 原型有占位提示 |
| R12 | 移动端 | 无 hover、手柄太小、调整复杂 | v1 仅桌面调试版开放；移动端先只读查看调整条目；P4 再做 44px 手柄与长按菜单 | 未做 |
| R13 | 主题/跨端渲染 | 深浅色 token 不同 | 副本在同一文档内，主题直接继承；清单记录 theme | 深色已验证，浅色同源 |
| R14 | 数据体积 | 结构快照过大 | 单条 `outerHTML` ≤12KB，最多保留被改动子树；页面截图沿用现有 1600px 限制 | 原型已限制 |
| R15 | 状态持久化 | 刷新后副本丢失，用户以为改动还在 | 明确提示「参考已恢复，需重新冻结」；草稿只存清单与截图 | 设计 |

## 9. 原型验证结论

环境：调试版构建（`__TANDEM_DEBUG__`）、演示工作区 `chat-tools` 会话、Playwright Chromium 1440×900、深色、DPR 1。

### 9.1 已跑通

- 第三种工具「调整」进入；冻结提示与统计（节点数、耗时）可见。
- 悬停描边、点击选中、选中框 + 8 手柄；点图标时选到最近的按钮（与点选一致）。
- 拖 `e` 手柄宽度 32→40（吸附 4px 栅格）；拖 `s` 手柄高度 32→39（非标准值，面板与清单均标注）。
- 换图标面板搜索与替换（`settings → search`），记录 lucide 名。
- 删除、单项回退、撤销/重做。
- 行为备注：选中按钮写备注，进入清单并在 Markdown 中紧跟改动。
- 插入「列表（Card + ListRow）」，展开编辑加两行、填行标题/行备注、写列表备注；预览使用真实 `ui/*` 组件。
- 导出 `tandem-adjust-*.json`（5 项改动 + 结构快照 + Markdown），Playwright 捕获下载文件。
- 320 轮大会话：加载 601 行（DOM 71,762 节点）后冻结成功，截图保存。
- 控制台 `pageerror` 与 `console.error` 均为 0。

### 9.2 冻结耗时

| 页面 | 行数 | 冻结前 DOM 节点 | 克隆节点（含文本） | 耗时 |
|---|---|---|---|---|
| 普通演示会话 | 14 | 3,423（含反馈 UI） | 1,979 | 18ms |
| 320 轮大会话 | 601 | 71,762（含反馈 UI） | 54,930 | 390–517ms（多次 390/430/517） |

- 耗时随节点数近似线性；普通页面可以做到无感，大会话需要「冻结中」提示（原型已有）。
- 冻结阶段没有内联计算样式；若改为像截图那样逐节点内联，按现有反馈截图经验会变成数秒，不建议。
- 长会话的 601 行不是 640 条消息全在 DOM：消息列表有挂载窗口（上限 400 条），所以这是「用户实际能看到的 DOM」，与截图剪枝口径一致。

### 9.3 截图

| 文件 | 内容 |
|---|---|
| `/tmp/fb-adjust/01-enter-adjust.png` | 进入调整：冻结统计、调整工具选中、底部状态条 |
| `/tmp/fb-adjust/02-selected-handles.png` | 选中设置按钮：8 手柄、组件名、尺寸、token |
| `/tmp/fb-adjust/03-resized-token.png` | 改尺寸后：40×39、非标准值、左侧改动清单两项 |
| `/tmp/fb-adjust/04-behavior-note.png` | 行为备注面板 |
| `/tmp/fb-adjust/05-icon-picker.png` | 图标选择器（项目在用 lucide、中文搜索） |
| `/tmp/fb-adjust/06-insert-list.png` | 插入列表并展开：两行示意、行备注、列表备注、右侧展开编辑 |
| `/tmp/fb-adjust/07-exported.png` | 完成并导出：5 项改动、导出提示 |
| `/tmp/fb-adjust/08-long-freeze.png` | 320 轮大会话冻结（54,930 节点 / 390ms） |
| `/tmp/fb-adjust/scorecard.png` | 方向打分卡（第 11 节） |
| `/tmp/fb-adjust/exported-adjust.json` | 导出的调整 JSON（可直接看 schema） |
| `/tmp/fb-adjust/measurements.json` | 两次冻结的原始测量 |

### 9.4 遇到的坑

1. **生产构建组件名是压缩名**（如 `$c`），不能直接展示；回退 `aria-label`/tag，并在清单里不写不可信的组件名。
2. **命中要回到最近的可交互祖先**：直接取 `elementsFromPoint` 顶层会选到 `svg`，拖尺寸变成改 16px 图标；复用点选的 `closest(button/a/[role=button])` 后正确。
3. **选择条遮挡手柄**：放在元素下方时挡住 `s` 手柄，改为靠近底部时放上方。
4. **toast 噪声**：连续操作时右上角堆叠多条提示，截图与阅读都受影响；正式版调整模式应把非关键提示合并或只保留一条。
5. **插入控件尺寸不是整数**：`Card` 宽度 300px 但子元素 `ListRow` 的 `getBoundingClientRect` 有小数；展示时取整，插入控件不参与「非标准值」判断。
6. **React 19 无 `_debugSource`**：`jsxDEV` 把调试信息变成 `_debugStack`（在开发运行时），生产运行时完全没有；源码定位需要单独方案（R9）。

## 10. 分阶段实施

每阶段可独立交付与验收；后面阶段不阻塞前面上线。

### P0 · 冻结与单元素编辑（原型已跑通）

- 工具「调整」、冻结副本、选中/父级、8 手柄改尺寸、图标替换、删除、撤销/重做/单项回退、导出 JSON。
- 验收：普通会话进入 ≤50ms；调整后退出，原页面 DOM 与截图完全一致；导出的 JSON 含目标选择器、改前/改后、图标名。
- 风险关闭：R1、R2、R7。

### P1 · 进入反馈包与 unpack

- 调整条目接入 `useFeedbackStore` / 草稿实时保存 / `.tfb` 文件（前后截图、说明、JSON）。
- `feedback-unpack.mjs` 输出 `adjust/<n>.md`；`feedback.md` 链接；`docs/features/feedback.md` 更新。
- 验收：导出 `.tfb` → 解包得到可执行 Markdown；agent 按说明改一处按钮并复验通过。
- 风险关闭：R10、R14、R15。

### P2 · 插入控件、行为备注、token 吸附

- `ui/*` 白名单面板、列表展开与行备注、行为备注（元素/改动）、尺寸 token 与「非标准值」标注。
- 验收：插入 2 行列表并备注，unpack 输出每行备注；把按钮高度改成 39px，清单标「非标准值」；行为备注紧跟对应改动。
- 风险关闭：R11。

### P3 · 位置、变体、文字

- 同容器换序（默认）+ Alt 自由拖动 + 吸附线；Button/Badge 变体切换；纯文本改文字；隐藏（保留占位）。
- 验收：拖动列表行换序，清单写「在第 N 个兄弟之后」；换 Button 变体只记变体名；改文字后清单含改前/改后。
- 风险关闭：R3（菜单弹层场景的完整走查）。

### P4 · 调试版打磨

- 源码位置：调试版启用 React 开发运行时解析 `_debugStack`，或 debug-only Babel 注入 `data-tandem-src`；拿不到才回退。
- 性能剪枝（>2 万节点）、CodeMirror/富文本限制提示、移动端 44px 手柄、发布版剔除检查（`scan-release` / `strip-debug-dist`）。
- 验收：任意选择元素能给出 `file:line` 或明确的回退标记；8 万节点会话冻结 ≤800ms；发布包搜不到调整模块。
- 风险关闭：R5、R6、R8、R9、R12。

## 11. 打分卡

文件：`/tmp/fb-adjust/scorecard.png`（深色，两行方案对比，推荐项带橙色边框）。

1. **位置调整**：A 自由拖动 + 对齐吸附线（推荐）vs B 只允许同容器换序。推荐 A+B 并存：默认换序，按住 Alt 自由拖动；无法换序时才用偏移。
2. **插入容器控件的呈现**：A 用真实 `ui/*` 组件搭示意（推荐，原型已跑通）vs B 线框占位 + 纯文字备注。推荐 A；清单必须标「示意草稿，实现时按 ui/* 复刻」。

冻结副本 vs 直接改真实 DOM 一点已由用户 2026-11-12 11:24 定为冻结副本，不再比较。

## 12. 未决问题

1. 位置调整是否采纳「默认换序 + Alt 自由拖动」？若只要换序，P3 可省掉吸附线与偏移记录。
2. 插入容器控件的示意是否用真实组件（A）？若担心被误当实现，可改成「真实组件 + 明显的草稿描边」。
3. 行为备注是否必填？建议：有插入控件或改文字时必须至少一条备注，纯尺寸/图标改动可空。
4. 是否投入调试版源码定位（P4）？收益是清单直接给 `file:line`；成本是 debug 构建启用 React 开发运行时或 Babel 注入，体积与性能有代价。
5. 移动端是否开放调整？建议 v1 不开放，只读查看与反馈。
6. 插入控件是否包含 Menu/Popover/Modal 空壳？建议 P3 先做 Menu，Modal 更复杂，等实际需求。
7. 尺寸吸附阈值 ±2px 是否合适？可在 P2 收集实际调整值再调。

## 13. 产品决定（2026-11-12）

- 冻结副本：用户定（"冻结副本我觉得就挺好的"）。
- 行为备注、展开容器编辑内容、复用 ui/* 与既定尺寸：用户 11:24 原话要求，已并入第 4–7 节。
- 位置调整：A+B 并存（默认同容器换序；按住 Alt 自由拖动并显示吸附线，清单记 translate 偏移）。理由：用户要的"调整一下位置"既有换序也有微移。
- 插入容器：用真实 ui/* 组件搭示意（A）。理由：用户要求复用现有控件，线框表达不了每行用什么组件。
- 实施顺序：P0→P1→P2 一次交付（用户能用起来的最小闭环），P3、P4 随后。
