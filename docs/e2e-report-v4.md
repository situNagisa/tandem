# Tandem 真实模型端到端测试报告（第四轮）

日期：2026-11-08
范围：`packages/server`（Host，REST + WebSocket）、`packages/protocol`；覆盖第三轮之后新增、此前主要用 mock 验证的功能。
账号：用户本机 "muze" 账号的 codex 分组（OpenAI 兼容），模型 `gpt-6-luna` 与 `gpt-6-sol`；按任务要求未测试 claude 分组。
方式：复制 profiles 到 `/tmp/tandem-e2e4`（600），`TANDEM_HOME=/tmp/tandem-e2e4` 启动 Host（8352），测试仓库 `/tmp/tandem-e2e4/work`；Node 内置 WebSocket 驱动，脚本放 `/tmp/tandem-e2e4-scripts`。为检查请求体脱敏与模拟 429，本轮在本机回环加了一个仅转发、不落盘的代理；真实模型调用仍走原账号的 codex 分组。未修改 `~/.tandem`，未打印/记录任何 Key 或中转 URL。真实模型对话请求约 43 次（含标题、压缩、评审），未超过 80 次上限。

## 结论

- 10 个场景全部跑通：任务看板（AI 拆分/依赖/worktree/合并/ProposeCards）、自动模型路由、上下文自动压缩、审批策略学习、项目 Secrets、命令沙箱、提交前 AI 评审、配额交接、Host 诊断、全文搜索。
- 发现并修复 1 个真实模型下才暴露的问题：**自动压缩只参考字符数估算，忽略上一次请求按真实 usage 校准的占用，中文长会话可能永远不触发**。修复后同会话真实触发：节省 3807 tokens、保留 1 轮、压缩后回答仍保留早期事实，模型请求中出现 `[此前对话摘要]`。
- `node scripts/check.mjs --skip-regression`：build / ui-audit / test / smoke 全部通过（server 49、web 37）。
- 全量 `node scripts/check.mjs`：build / ui-audit / test / smoke 通过；regression 71/80，9 条失败全部来自工作区里**他人未提交**的设置导航/同步/移动端 Web 改动（例如设置 nav 中已没有「MCP」「提示词」「浏览器」按钮、手机设置改为 1 列），与本轮服务端改动无关；未修改、未提交这些 Web 文件。

## 场景结果

| 场景 | 结果 | 证据 / 备注 |
|---|---|---|
| 任务看板 | ✅ | `POST /plan` 用真实模型拆出 2 张卡（实现 → 测试，deps 正确）；两张同时放行后测试卡 `queued` + `blocked=waiting`，实现卡完成后才启动。两卡各有独立 worktree 分支（`tandem/board-…`，`git worktree list` 可见）；测试卡在 own worktree 里读到了实现卡的 `CARD_A_MARK`，证明依赖分支已合入。`merge-all` 合并 2 张，主仓库同时出现 `src/greeting.js` 与 `tests/greeting.test.js`。实现卡调用 `ProposeCards` 提议「补充 greeting 的单元测试说明」，以 `todo` 草稿落库并带 `proposedBy`。 |
| 自动模型路由 | ✅ | 候选池放 `gpt-6-luna`（fast）与 `gpt-6-sol`（power）。简单消息 → `gpt-6-luna`，理由「常规任务」，complexity 20；困难消息（重构/并发/死锁/性能/安全）→ `gpt-6-sol`，理由「偏难：重构、设计」，complexity 70。两条均出现「自动：本轮使用 …（理由：…）」提示，会话 `route` 记录最终选择。 |
| 上下文自动压缩 | ✅（修复后） | 前两次尝试暴露问题：面板显示 11844/18000（65%）已超过 50% 阈值，但未出现 `compaction`。修复后同会话自动触发：`auto=true`、`keptTurns=1`、`savedTokens=3807`，摘要消息入库，压缩后的回答仍给出「蓝鲸-77 / 海燕-2」，模型请求体含 `[此前对话摘要]`。 |
| 审批策略学习 | ✅ | default 权限下对 `printf tandem-approval` 批准 3 次，`/api/permissions/insights` 出现建议 `Bash printf tandem-approval* → allow`（allows=3、denies=0）；采纳后规则带项目范围 `/tmp/tandem-e2e4/work`。第 4 次执行同命令不再弹审批，工具结果为 `tandem-approval`，`autoHandled` 0→1。 |
| 项目 Secrets | ✅ | 设置 `E2E4_DB_PASSWORD`（bash 范围、项目 work）。真实模型执行 `echo` + 写文件后：磁盘文件内容与真值完全一致；会话 JSON、工具结果、发给模型的请求体均只有 `[secret:E2E4_DB_PASSWORD]`，没有明文；REST 只返回名称/范围，不返回值；系统提示只注入名称与说明。 |
| 命令沙箱 | ✅ | `bypassPermissions` 下让模型 `Write` 到 `~/.ssh/tandem-e2e4-test.txt`，仍产生审批请求（路径被展开识别）；脚本拒绝后工具结果为「用户拒绝了该操作」，磁盘上文件不存在。 |
| 提交前 AI 评审 | ✅ | 工作区一处明显缺陷（空数组求平均返回 NaN）。AI 评审返回 `verdict=suggest`，意见挂到 `src/discount.js:5`（warn「空数组返回 NaN」），`ignored=0`，行号在文件范围内。 |
| 配额交接 | ✅ | 主分组（假 Key，回环代理返回 429 + rate-limit 头）首轮失败后出现 pending 交接卡，目标为同账号备用分组；点「切换」后会话分组改为备用、模型不变、检查点已保存，提示「已从 … 交接到 … · 已保存检查点」，回合继续并回复 `HANDOFF_OK`。 |
| Host 诊断 | ✅ | `/api/doctor` 执行 17 项检查、0 fail；node/dataDir/disk/git/gh/rg/browser/hooks/external/clock 均 ok；listen 给 warn（测试 Host 只绑回环，符合项目约束），glab warn（未安装）。报告无 Key/token/中转地址（对副本里的 4 个敏感值逐一比对，0 命中），结果按失败→警告→跳过→正常排序。 |
| 全文搜索 | ✅ | 本轮中文内容可检索：`蓝鲸-42` 4 条、`海燕` 6 条、`审批学习` 9 条、`配额交接` 2 条，包含标题/正文片段，耗时 0–1ms。 |

## 问题与修复

### 1. 自动压缩在中文字符估算偏低时永不触发（已修复）

- 现象：在 18k 上下文窗口、50% 阈值的真实会话中，上下文面板显示已用 11844 tokens（65%），且 `autoCompact.enabled=true`，但连续多轮都没有出现自动压缩提示；模型请求也没有摘要。此时只能靠 provider 的 `context_length_exceeded` 兜底，长会话会先撞上游上限。
- 根因：`packages/server/src/agent/loop.ts` 的请求前判断只看 `contextEstimate.usedTokens`。`estimateTokens` 按约 3.5 字符/token 估算，中文会低估数倍；而每次请求后 `calibrateContext` 已把真实 usage 校准到 `rec.context.usedTokens`，这个值没有被压缩判断使用。于是「面板显示 65%」与「触发判断认为约 30%」不一致。
- 修复：`packages/server/src/context.ts` 新增纯函数 `autoCompactDue(estimateUsedTokens, lastActualUsedTokens, contextWindow, settings)`，取本轮估算与上一次真实校准占用的较大值；`loop.ts` 在每轮第一次压缩判断时传入 `rec.context?.usedTokens`，同一轮压缩后不再使用旧基线，避免重复触发。新增 `packages/server/test/context.test.ts` 覆盖「估算 5k、上次真实 11.7k → 触发」「压缩后无旧基线 → 不触发」「估算本身达标 → 触发」。
- 验证：重启 Host 后用原会话重跑，自动压缩触发（`auto=true`、保留 1 轮、节省 3807 tokens），压缩后回答保留「蓝鲸-77 / 海燕-2」，请求体出现摘要；`node scripts/check.mjs --skip-regression` 全部通过。

## 验证与回归

- `npm run build`（含 web）通过；`node scripts/check.mjs --skip-regression`：build / ui-audit / test / smoke 全部通过。
- 全量 `node scripts/check.mjs` 的 regression 为 71/80；9 条失败均来自并行未提交的 Web 改动（设置导航重构、同步导入确认文案、手机设置 1 列、移动端按钮触控、浏览器入口等）。本轮只改了 `packages/server/src/context.ts`、`packages/server/src/agent/loop.ts`、`packages/server/test/context.test.ts`，未触碰上述 Web 文件。

## 遗留 / 受限

- **claude 分组未测**：按任务要求不触碰。
- **10% 阈值不可配置**：协议与设置把自动压缩阈值限制在 50%–95%（避免每轮压缩或永不压缩）；本轮用测试分组把模型上下文窗口临时覆盖为 18k、阈值取 50% 来等价制造低阈值场景，没有修改产品默认值。
- **配额交接的 429 为本地模拟**：假 Key + 回环代理返回 429 与 rate-limit 头；真实供应商的 429 响应头未覆盖。备用分组为同账号分组的副本，指向同一真实 Key。
- **诊断未跑账号连通性**：`profiles` 检查会向模型服务商发最小请求，本轮保持默认跳过，避免额外费用；报告脱敏与其余检查均已验证。
- **AI 评审只覆盖单文件单条意见**：未测误报标记写项目记忆、多文件多块、blocker 禁止提交。
- **看板未覆盖 PR 聚合/CI**：本轮按任务只验证 AI 拆分、依赖、worktree、合并与 ProposeCards；PR 聚合仍只有 v2 mock 验证。
- **价格未配置**：本轮模型未在账号上配单价，看板/会话的 `costUsd` 为空，只比较 token、轮数与耗时。
- **回归失败为并行工作区状态**：非本轮改动；需对应负责人合并设置导航/移动端改动后重跑全量 check。
- 测试 Host、代理、`/tmp/tandem-e2e4`（含 Key 副本）与脚本目录已在结束后删除；`~/.tandem` 未修改。
