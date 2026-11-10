# 进度

> 更新：2026-11-10。只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 67（2026-11-10）输入框分工/取向两个维度（反馈2009#01）
- [x] 用户原话（反馈2009#01）：上面四个选项与委派倾向重复，应分两个维度（积不积极派子代理 / 质量优先还是成本优先）。菜单改为「分工」（关闭 / 适度 / 积极）与「取向」（省钱 / 均衡 / 质量优先）两组单选；「仅规划」移除（计划模式权限已覆盖）。
- [x] 数据：会话 `delegation` + `routeBias` 取代 `routePreference`；旧数据读取时一次迁移并写回；protocol 与服务端同步。
- [x] 运行时按矩阵实现（`features/routing.md`）：Task 只在多代理协作回合开放；成本上限只对积极生效；取向决定未绑定执行者的档位；分工关闭不规划、不出提示行；学到的偏好改由分工前确认卡累计。
- [ ] 第三个维度「验证策略」未做（用户提出，另做）。
- 验证：`node scripts/check.mjs` 全量通过（regression 171/171）；菜单截图（浅色 / 深色、两个子菜单）在 `/tmp/route-menu/`。

## 迭代 66（2026-11-10）弹层背景透明（R64）
- [x] 修 `var(--t-bg-elevated)`（全仓未定义）：反馈输入浮层/复验条、功能导览三张卡、语音浮层恢复 `bg-surface`；设置→工作站卡片与代码块「还有内容」提示改用 `--t-surface`；反馈原因标签 `--bg-active` 改 `--t-bg-active`。
- [x] ui-audit 新增 `undefined-css-var`：`var(--x)` 必须在 CSS 有定义或运行时注入；`card-class` 不再误伤 fixed/absolute/sticky 浮层（含 `${POSITION}` 常量）。
- [x] Playwright 截图核对浅色/深色：上手引导、导览胶囊/面板、反馈工具条/编辑浮层、语音浮层、工作站设置、设置对话框、模型菜单，背景均不透明（/tmp/fix-transparent/）。
- 验证：`node scripts/check.mjs` 全量通过。

## 迭代 65（2026-11-10）UI 第二批：按钮/卡片/空状态/设置行（打分卡 U1/U2/U4/U5-A）
- [x] U1：`ui/Button` 收敛控件 32 / 图标 32 / 行内 24，补 pressed 与移动端 44px；手写按钮迁移 36 处，结构性 132 处显式标 `data-raw-button`。
- [x] U2：新增 `ui/Card`（12px 圆角、16/18 内边距、无阴影），替换 57 处；删掉 `index.css` 设置页 10px/12-14 覆盖，右栏卡片同步 12px 无阴影。
- [x] U4：新增 `ui/EmptyState`（虚线框、20px 内边距、30px 图标、13/12 两级文字），替换 30 处；删除 `.settings-empty` 系列 CSS，「先添加一台主机」原文保留。
- [x] U5：19 个设置页改用 `SettingRow`/`SettingNote`，说明收进 ⓘ 或下方说明；文案、设置项、顺序不变。
- [x] 检查：`font-size-floor` 覆盖 `ui/` 全部组件；`ui-audit` 不再跳过 `ui/`，新增 `card-class`/`native-button`；`Controls` 原生 title 改 `data-tip`。
- 验证：`node scripts/check.mjs --skip-smoke` 通过（regression 168/168）。
