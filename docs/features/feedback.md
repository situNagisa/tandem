# 反馈模式

> 更新：2026-11-09。

调试版（`__TANDEM_DEBUG__`）内置的记录工具：Ctrl+Shift+F 进入，点选元素或框选区域，写下问题并附带截图、轨迹、快照与录屏。发布版构建会把本模块整体剔除（`scripts/scan-release.mjs` 有对应禁用词）。

## 实时保存，不丢

每新增/编辑/删除一条反馈（含截图、区域截图、快照、轨迹、标注、参考图、录屏），立即写两份：

1. **IndexedDB**（`tandem-feedback` 库）：条目元数据与图片 Blob 分开存，图片不再转 base64 字符串；localStorage 只镜像文字元数据。刷新/崩溃/关页面后重新打开会从 IndexedDB 恢复。
2. **桌面调试版额外落盘**：通过 IPC 写 `<下载>/Tandem 反馈/草稿-<YYYYMMDD-HHmm>/`，每条一个文件：

```
feedback.md            汇总索引（随记录实时更新）
manifest.json          版本、平台、窗口、条目元数据与文件清单
01-元素截图.png        点选元素截图（框选时是 01-区域截图.png）
01-标注截图.png        标注后的截图（有才写）
01-参考-1.png          参考图
01-快照.json           状态快照
01-轨迹.md             反馈前 60 秒操作轨迹
01-录屏.webm           录屏（有才写）
page-1.png             整页截图
体验清单.md            体验清单进度报告
```

写入用「临时文件 + rename」，删除条目后编号前移产生的旧文件会一并清掉，磁盘上不会出现半截文件（`packages/desktop/feedback-drafts-core.js`，单测在 `packages/server/test/feedback-drafts.test.ts`）。

- 重新打开后提示「已恢复 N 条未导出的反馈」，继续追加写同一个草稿目录。
- 导出成功后草稿标记为已导出（桌面目录里写 `.exported.json`），条目清空；草稿保留 7 天后自动清理，未导出的一直保留。
- 反馈模式里可在条目抽屉底部「删除草稿」手动清掉条目与桌面草稿目录。
- 关闭窗口不弹拦截框——数据已经落盘。

## .tfb 包格式

导出文件名 `tandem-feedback-<YYYYMMDD-HHmm>.tfb`。本质是 zip 容器（零依赖、store 不压缩，实现见 `packages/web/src/lib/zipStore.ts`），里面就是上面那组正常文件；**改扩展名为 .zip 就能用系统解压直接看**。`manifest.json` 头部的 `version`/`format` 用于以后演进；暂不做加密（需要时再加）。

桌面调试版导出默认存到 `<下载>/Tandem 反馈/`，提示条带「打开所在文件夹」；浏览器/安卓走下载或系统分享。

维护者解包（兼容旧的 `.json` 包、`.tfb` 和桌面草稿目录）：

```
node scripts/feedback-unpack.mjs <file.tfb|file.json|草稿目录> [outDir]
node scripts/feedback-receipt.mjs <file.tfb|file.json|草稿目录> <receipt.md|receipt.json> [outDir]
```

解包后生成 `feedback.md`、`by-feature/<功能>.md`、`by-cause/<编号>.md` 与所有附件。Windows 上直接读 `/mnt/c/Users/JDHC/Downloads/Tandem 反馈/` 即可。

## 截图性能（长会话，R48）

- 截图只内联视觉相关的计算样式（约 160 条，`feedbackCapture.ts` 的样式白名单）；不再把每个元素约 350 条样式全写进克隆。
- 克隆前跳过滚动容器视口外的子树（`content-visibility` 本来也不绘制这些行）；长会话 8k 元素降到约 2k。滚到底部时截图内容和用户当前看到的一致，而不是会话开头。
- 区域截图只克隆「包含该区域的最深容器」（优先最近的滚动容器），不再对 `document.body` 做整页渲染再裁切。
- 整页缩略图（≤900px）在输入浮窗出现 **之后** 空闲补拍：点选/框选只等元素/区域截图；保存时若还没拍完会等它一次。
- 桌面调试版走主进程原生截图（`feedback:capture-page` → `webContents.capturePage(rect)`），网页端仍用 DOM 克隆（`getDisplayMedia` 需要授权，不用）。
- 点选/框选先出现「截图」/「截取区域」提示再做重活。每次截图的分阶段耗时记在 `lib/feedbackPerf.ts`，回归用例从 `window.__feedbackPerfCapture` 读取。
- 已知限制：单个超大消息行（近 2000 个元素，如超长代码块）元素截图约 0.6s；网页端单次整页缩略图约 0.5–0.7s（原生桌面端 <100ms）。

## 限制

- 加密、跨设备同步不做。
- 录屏受 8MB / 60 秒限制；超大附件会让草稿同步的 IPC 负载变大（已按 350ms 合并）。
- 桌面草稿目录只在 Windows/macOS/Linux 桌面调试版存在；浏览器与安卓只有 IndexedDB 恢复。打包时 `packages/desktop/feedback-drafts*.js` 必须进 `app.asar`（`electron-builder.yml` 白名单已列出），`scripts/check-debug.mjs` 会检查草稿 IPC 名与 `<下载>/Tandem 反馈` 目录逻辑是否在产物里。
- 自动检查：`e2e/regression.mjs` 的「体验清单…导出与解包」「反馈草稿实时保存」两条用例。
