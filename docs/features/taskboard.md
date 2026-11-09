# 任务看板（v1 + v2）

> 更新：2026-11-10。一句话：**一个项目一块看板，每张卡 = 一个后台运行的会话；卡与卡有依赖、审批门、并发上限与预算；人只在「需要我」的列出手。**

## 是什么

- **看板 Board**：属于一个项目目录（`cwd`），可有多块；持久化 `~/.tandem/boards/<id>.json`（原子写）。字段 `name / cwd / baseBranch / maxParallel / mergePolicy / defaults / cards[]`。
- **卡片 Card**：一张卡运行时 = 一个顶层会话（depth 0，不设 parentId），带 `board:{boardId,cardId}` 标记；不设常驻协调者。字段 `title / prompt / deps[] / status / order / exec / sessionId / attempts / result / error`。
- **状态列**：待办 `todo`（草稿）→ 排队 `queued`（等依赖与并发槽）→ 运行中 `running` → 待审批 `approval`（工具审批，橙点）→ 待评审 `review`（审批门）→ 完成 `done` / 失败 `failed`。
- **依赖**：`deps` 为卡片 id；全部 `done` 才运行；创建/修改做环检测；上游失败时下游保持 `queued` 并标「上游失败」，不自动连坐。
- **执行配置 exec**（卡 > 看板 defaults > 全局）：预设或 `profileId/groupId/model/effort`；`permissionMode` 默认 `acceptEdits`；`worktree` 默认开；`budgetUsd`；`maxRetries` 默认 1；`gate` 默认关；`aiReview` 可选。

## 怎么用

- 入口：侧栏「任务看板」、命令面板；路由 `#/h/<hostId>/b[/<boardId>]`。桌面 7 列可拖动（待办⇄排队、列内排序、失败→排队、待评审→通过/打回、运行中→撤回），所有拖动都有等价按钮。手机无拖动，按「需要我 / 运行中 / 全部」分组，触控 ≥44px。
- 点击卡片打开右侧抽屉（480px）：编辑提示词/依赖/执行配置，查看摘要、改动 `+N −M`、花费、合并状态与动作按钮。
- 看板头部「AI 拆分」：一次性调用看板默认模型生成草稿（`POST /api/boards/:id/plan`），只返回草稿，用户确认后才创建；创建后仍需放行。
- v2：卡片会话可用 `ProposeCards` 追加待办提案；「开 PR」按依赖顺序合成集成分支并调 gh/glab；分屏打开看板与卡片会话；合并冲突可让 agent 在 worktree 解决，仍需用户再点合并。

## 调度与资源

- `BoardManager` 进程内 1s tick + 事件唤醒；`maxParallel` 默认 2（上限 8），Host 全局上限 6；`approval` 不占槽。
- 失败重试：回合 `error` 退避 30s，在同一会话追加「上次出错…请检查现状并继续」，最多 `maxRetries`；手动中断/预算超限/依赖冲突不重试。
- 预算：`exec.budgetUsd` 走 `assertBudget`，超限卡 `failed`；Host 预算规则照常。
- 断点续跑：Host 重启从 JSON 恢复；`running/approval` 交给 `recoverAfterRestart`，会话不存在则回 `queued`。
- Worktree：卡开始前建 `tandem/board-<看板短id>-<卡短id>`，合入依赖分支；回合结束自动 commit；默认手动合并（单卡/按序全部），冲突即失败并记录文件列表。

## 与现有概念的关系

- `parentId/Task` 是同步子任务（父回合 await、中断级联、审批冒泡）；看板卡要跨小时/重启存活、可独立排队，所以用顶层会话。
- 卡片会话复用审批进收件箱、回合结束、Host 重启续跑、检查点、用量、手机通知。
- 卡片会话不进侧栏，避免淹没列表；入口统一在「任务看板」。
- 收件箱新增 `InboxEventKind='board'`：待评审、失败、整块看板跑完；卡片会话不再产生 `turn_end` 收件箱项。

## 数据与代码位置

- 服务端：`packages/server/src/boards/`（`manager.ts` 调度、`store.ts` 落盘、`plan.ts` 拆分、`review.ts` AI 评审、`pr.ts` 聚合）。
- 协议：`packages/protocol/src/index.ts` 的 `Board*` / `BoardCard*` / `BoardExec` / `BoardEvent`。
- 前端：`packages/web/src/components/board/*`、`lib/boardRoute.ts`、`useBoardStore`。

## 限制与取舍

- 同仓库多卡并行可能冲突，v1 选择「冲突即失败、人处理」；`maxParallel` 受账号速率限制，默认保守为 2。
- 不做跨 Host 看板、多人认领、看板级总预算、定时触发（以后）。
- 卡片会话不进侧栏，靠卡详情「打开会话」补偿可发现性。
