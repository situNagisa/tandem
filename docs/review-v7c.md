# 体验走查 v7c（反馈模式 v2 / 分享 / 语音 / PR / 断点续跑）

日期：2026-11-07。范围只覆盖以下 5 项，其余功能未动：

- 反馈模式 v2：Ctrl+Shift+F、点选 / 框选、标注、条目抽屉
- 分享链接：会话 ⋯ → 分享对话框、设置 → 分享、`/s/` 分享页
- 语音输入：输入框麦克风、设置 → 语音
- PR 面板：会话右上角 PR 按钮（Host 未安装 gh 的指引）
- 断点续跑：retrying 胶囊（在会话 JSON 写入 `retryInfo` 模拟）

## 环境与方式

- Host：`TANDEM_HOME=/tmp/tandem-rvc node packages/server/dist/cli.js --port 8223`；会话 JSON 预置 4 条消息与 `retryInfo`。
- 语音：Chromium `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` + Host 假 `whisper-cli`（`/tmp/rvc/fakebin`）。
- PR：`TANDEM_GH_PATH=/nonexistent/gh` 模拟未安装 gh；测试仓库配置 GitHub origin。
- 视口：2552×1274 深色、390×844；全部通过真实点击 / 拖拽操作。
- 截图：`/tmp/rvc/`（关键图见下）；控制台无 error / pageerror（分享页、设置页、反馈模式均 0 条）。

## 发现与处理

| 级别 | 问题 | 处理 |
|---|---|---|
| P1 | **retrying 胶囊完全不显示**：打开会话后 WS `session_snapshot` 用 `summaryOf()` 重建 active summary，该函数漏掉 `retryInfo`（以及 `resumePaused`），顶栏条件永不成立。 | 已修：`packages/web/src/store/appStore/helpers.ts` 补 `retryInfo` / `resumePaused`。 |
| P1 | **手机端 retrying 胶囊与标题、轮次、PR、改动、面板按钮重叠**（390×844）：胶囊按整行宽内联渲染，文字互相压住。 | 已修：手机端改到顶栏下方独立一行（`网络中断，X 秒后重试 · 立即重试 · 停止`），不再挤压顶栏。 |
| P1 | **手机端环境条右侧被裁**：390 宽下环境条 `scrollWidth` 408 / `clientWidth` 358，Worktree 开关被切掉；首页无 git 时更宽。 | 已修：手机隐藏 “Worktree” 文字、压缩间距；首页非仓库时隐藏分支触发项。修复后 358/358 恰好放下。 |
| P1 | **手机端设置导航占 445px**（16 个页签 2 列），语音 / 分享页内容从 y≈500 才开始，首屏几乎看不到设置项。 | 已修：手机端 3 列，导航高 301px，语音页首屏可见识别方式与 Host Whisper 卡片。 |
| P2 | 胶囊倒计时到 0 时仍显示「0 秒后重试」。 | 未改（真实流程到 0 会立即发起下一次请求，仅模拟静态 `nextAt` 时可见）。 |
| P2 | 手机端反馈浮条盖住侧栏顶部「新会话」的一部分。 | 未改：浮条为固定居中工具条，目标元素下半部仍可点选；如需可后续改为可折叠。 |

## 逐项结果

- **反馈模式 v2**：进入 / 退出、点选元素、框选区域、Canvas 画框标注、保存、条目抽屉（编辑后保存、定位高亮、删除 2→1、拖拽换序）全部通过；导出触发下载并弹出清空确认。桌面与手机均可完成一轮记录。
- **分享链接**：⋯ → 分享… → 生成链接（二维码、token 一次性展示、复制、回环监听警告）正常；设置 → 分享能看到访问次数并进入撤销二次确认；`/s/` 分享页桌面与 390 宽均正常渲染消息、代码块与「每 3 秒自动刷新」。
- **语音输入**：桌面与手机点麦克风进入持续录音、再点停止，Host 假 Whisper 返回文本并插入光标处（不自动发送）；设置 → 语音显示「可用」、保存与「测试」通过（65ms）。
- **PR 面板**：未安装 gh 时展示「未安装 gh」指引（brew / winget、`gh auth login`、官网链接）；仓库与分支行正常，桌面 / 手机弹层均在视口内。
- **断点续跑胶囊**：修复后桌面与手机均显示重试倒计时与「立即重试 / 停止」；手机为独立一行，不再遮挡其它按钮。

## 修改文件

- `packages/web/src/store/appStore/helpers.ts`
- `packages/web/src/components/TopBar.tsx`
- `packages/web/src/components/EnvBar.tsx`
- `packages/web/src/components/settings/SettingsDialog.tsx`
- `docs/review-v7c.md`

## 验证

- `node scripts/check.mjs --skip-smoke`：全部通过（build 8.3s、ui-audit、32 条前端单测）。
- 关键截图：`/tmp/rvc/v-mobile-session.png`（重试行 + 环境条）、`/tmp/rvc/v-mobile-settings-voice3.png`（3 列设置）、`/tmp/rvc/v-share-dialog.png`、`/tmp/rvc/v-settings-shares.png`、`/tmp/rvc/v-settings-voice.png`、`/tmp/rvc/v-mobile-pr.png`、`/tmp/rvc/v-mobile-share.png`、`/tmp/rvc/v-feedback-locate.png`、`/tmp/rvc/v-feedback-drag.png`。

## 遗留

- 以上 P2 两条未改。
- 手机设置页 3 列后仍需要滚动查看完整语音说明（内容本身较长，属预期）。

## 2026-11-08 遗留复核

- P2「倒计时到 0 仍显示 0 秒后重试」：**已修**——剩余秒数 ≤0 时改为「网络中断，正在重试…」（桌面胶囊与手机重试行同）。
- P2「手机反馈浮条盖住侧栏顶部新会话」：**已修**——手机端反馈工具栏移到底部安全区上方，桌面仍在顶部居中。
- 「手机设置 3 列后仍需滚动」：**不修**——语音说明等内容本身较长，导航已压到 301px，属预期滚动。

