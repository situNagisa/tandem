# 项目 Wiki

> 更新：2026-11-10。设计原则见 [design.md](../design.md) 的 P13；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R49。

## 是什么

项目 Wiki 视图（`components/wiki/WikiDialog.tsx`）：左侧页面树 + 全文搜索，右侧 Markdown 阅读区；页面由后台只读 agent 生成概览、模块页与术语表，用户可补手写段落。右栏 Wiki 卡的「浏览」打开该视图。

## 阅读区布局（反馈13#01 / R49）

- 阅读列是**固定宽度**：`w-full max-w-[780px] mx-auto`。不要只写 `mx-auto max-w-[780px]`——在 `flex-col` 容器里，自动外边距会取消 `align-items: stretch`，让 `max-width` 变成 shrink-to-fit，切换页面时宽度随最长行/代码块变化，看起来一直在抖。
- 滚动容器带 `scrollbar-gutter: stable`，原生滚动条已全局隐藏，只保留覆盖式指示条，宽度不随是否需要滚动而变化。
- 宽内容（表格、代码块、长 diff）不撑开阅读列：表格在 `md-table-scroll` 内横向滚动，代码块在 `pre` 内横向滚动（保留「自动换行」开关）。
- 切换页面只替换正文，容器宽度、左右位置与滚动条槽保持不变。

## 验证

- 回归（`e2e/regression.mjs`）「项目 Wiki：浏览、全文搜索与手写段落」：依次切换概览 / 模块 / 术语表，阅读列宽度差 ≤1px；再连续采样 1 秒，宽度不再抖动。
- 全量：`node scripts/check.mjs`。
