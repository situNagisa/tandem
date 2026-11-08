# Tandem 真实模型端到端测试报告（第三轮）

日期：2026-11-07
范围：`packages/server`（Host，REST + WebSocket）、`packages/protocol`；使用真实账号 "muze" 的 codex 分组（OpenAI 兼容），模型 `gpt-6-luna` 与 `gpt-6-sol`。按任务要求未测试 claude 分组。
方式：复制 profiles 到 `/tmp/tandem-e2e3`，`TANDEM_HOME=/tmp/tandem-e2e3` 启动 Host（8241），Node 内置 WebSocket 驱动；测试仓库为 `/tmp/tandem-e2e3/work` 与 `/tmp/tandem-e2e3/evalwork`。未修改 `~/.tandem`，未打印/记录任何 key 或中转 URL。真实模型调用约 75 次（按落盘 assistant 消息 + 自动标题估算），未超过 80 次。

## 结论

- 本轮 10 个场景全部跑通：后台任务、委派策略三档、跨模型子代理、项目记忆、Skills、提示词覆盖、浏览器工具、断点续跑、评测集、多 Key。
- 发现并修复 2 个服务端问题：浏览器快照丢失单字符文本与输入框当前值；SSE 注释心跳会不断重置模型请求的空闲超时。修复提交 `00aed77`。
- `node scripts/check.mjs --skip-smoke`：build / ui-audit / 单测通过；regression 43/45，两条失败来自工作区里**他人未提交**的 `PermissionCard.tsx` / `ChatView.tsx` 改动（审批卡新增转交按钮，按钮数 5≠4；长按消息菜单用例超时）。本次未修改、未提交这些 Web 文件。
- 修复后重跑了浏览器与断点续跑相关场景，结果见下。

## 场景结果

| 场景 | 结果 | 证据 / 备注 |
|---|---|---|
| 后台任务 | ✅ | `Bash(run_in_background)` 启动 `sleep 5; echo done`，随后 `BashOutput` 取到 `已结束（退出码 0）\ndone`；`GET /api/tasks` 中任务 exited。首次连续两次读取都在 5 秒内，返回「运行中 / 没有新输出」，模型因此误判仍在运行；等待 6 秒后读取正常。属非阻塞工具的模型节奏问题，未改产品语义。 |
| 委派策略三档 | ✅ | 同一测试提示下：`none` 工具 1728 tokens、无 Task；`less` 1961 tokens、含 Task；`orchestrate` 1402 tokens，主会话收窄为 BashOutput/Read/Glob/Grep/TodoWrite/WebFetch/Task 等，无 Write/Edit/Memory。orchestrate 实际调用 Task 派 general-purpose 子代理，子代理写入 `delegate.txt`，内容为 `ORCHESTRATED`。子代理 Bash 需审批，测试端自动批准。 |
| 跨模型子代理 | ✅ | `PUT /api/subagent-presets` 创建预设 `e2e-sol`（`gpt-6-sol`，仅 Read/Glob/Grep，带预设系统提示标记）。父会话按预设名调用 Task：子会话 `model=gpt-6-sol`，每条 assistant `usage` 独立记在 gpt-6-sol 下，回复出现 `[PRESET=e2e-sol]`，父会话 Task 参数正确。 |
| 项目记忆 | ✅ | Memory 工具写入「本项目使用 pnpm。」；新会话问「这个项目用哪个包管理器」回答 `pnpm`；`GET /api/sessions/:id/injections` 的 `memory` 段包含该条。 |
| Skills | ✅ | 项目级 `.claude/skills/hello-tandem/SKILL.md` 被扫描为 `source=project`；模型调用 `Skill` 工具加载正文，最终回答以 `SKILL_MARKER_42` 开头；系统提示 `skills` 段列出该技能。 |
| 提示词覆盖 | ✅ | 修改 `baseBehavior` 追加标记后，`injections` 的 `baseBehavior` 段立即包含标记；非冲突提问的回答末尾出现 `[E2E_PROMPT_MARKER_7F]`。首次用「只回复 OK」测试时模型遵守了用户更具体的指令、未输出标记，符合优先级；随后恢复默认并确认 `modified=false`。 |
| 浏览器工具 | ✅（修复后） | 本机静态页完成 navigate → snapshot → click×2 → type → click → snapshot → screenshot：计数 2、问候语 `Hello, Tandem`，截图 1280×800 可下载，`browser_state` 推送正常。**发现快照丢失计数器单字符值与输入框当前值**；修复后重跑，快照出现 `count: 1` 与 `textbox "Name" [ref=e2] value="Tandem"`，最终回答 `1 / Tandem`。 |
| 断点续跑 | ✅ | 模型执行 `sleep 40; echo RESUME_DONE` 期间 `kill -9` Host；重启后自动恢复：会话出现「Host 重启后已恢复运行」提示，悬空 Bash 的 tool_result 为 isError「Host 重启，此工具调用未确认是否完成，请检查后再继续」，模型如实回答无法确认，会话回到 idle；随后追加一轮成功返回 `RESUME_OK`。 |
| 评测集 | ✅ | 将「创建 answer.txt 内容为 42」会话存为用例（git commit 快照 + 检查命令）。两个配置并发运行：luna 默认提示词 3 turns / 2 tools / input 5491 + cache 2432 / output 89 / 7.8s；sol + 提示词覆盖 3 turns / 2 tools / input 7195 / output 90 / 7.2s。两格均 `completed=true`、`passed=true`、检查退出码 0。 |
| 多 Key | ✅ | 在 codex 分组 keys 首位插入假 Key（仅 `/tmp` 副本）：请求先命中假 Key，401 后该 Key 自动 `disabled=true` 并记录错误，同轮透明切换到真 Key，回答 `MULTIKEY_OK`，assistant usage 的 keyId 指向真 Key；测试后恢复原单 Key 配置。 |

## 问题与修复

### 1. 浏览器快照丢失单字符文本与输入框值

- 现象：页面上 `<p>count: <span>2</span></p>` 的快照只输出 `count:`，丢掉了 `2`；已填写的输入框只显示标签 `Name`，看不到 `value`。模型只能靠截图猜动态值。
- 原因：`packages/server/src/browser.ts` 的文本节点过滤条件为 `value.length > 1`，单字符被丢弃；textbox/combobox 的 `emit` 只输出名称，不输出当前值。
- 修复：允许长度为 1 的文本；textbox/searchbox/combobox 在非密码场景追加 `value="..."`（`browser.ts:492`、`browser.ts:508`）。
- 验证：修复后重跑浏览器场景，快照与最终回答均正确读到 `1` 和 `Tandem`。

### 2. SSE 注释心跳会重置模型请求的空闲超时

- 现象（代码审查发现，未在本轮稳定复现）：`readSse` 原先在每个网络 chunk 到达时调用 `onData`，SSE 注释/心跳虽然不产生模型数据，也会重置空闲计时器；若上游只发心跳不发内容，请求可能永久等待，而不是在 `idleTimeoutSec` 后中止。
- 修复：`packages/server/src/providers/sse.ts:39` 改为仅当解析出真正的 SSE 数据事件时才调用 `onData` 并 yield；注释/空事件不再续命。
- 验证：build 与单测通过；修复后真实模型的多轮流式请求正常完成。未构造出稳定的“只发心跳”上游，故此项标记为代码修复，未做真实心跳复现。

## 遗留 / 受限

- **claude 分组未测**：按任务要求不触碰该分组（中转只允许 Claude Code 客户端）。
- **评测成本未显示**：本次 `gpt-6-luna` / `gpt-6-sol` 未配置单价，评测结果 `costUsd` 为空；只能比较 token、轮数、工具数与耗时。补账号价格后即可显示。
- **BashOutput 非阻塞语义**：模型容易在命令结束前连续轮询并提前下结论。本轮按现有 Claude Code 风格保留非阻塞，未加等待参数；建议后续评估可选的短等待/提示。
- **浏览器覆盖面**：只测本机静态页的 navigate/snapshot/click/type/screenshot；远程域名白名单、file://、多标签/下载未测。
- **SSE 心跳修复**：缺少真实“只发心跳”的上游复现，仅有代码路径与构建/单测保障。
- **regression 两条失败**：来自他人未提交的 Web 改动，不是本轮服务端改动；需由对应负责人修复后再跑全量 check。
- 测试环境的长驻 Host 进程曾被运行器回收，后期改为在单条命令内启动/回收 Host，不影响上述场景结论。
