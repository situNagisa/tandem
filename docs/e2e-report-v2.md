# Tandem 真实模型端到端测试报告（第二轮）

日期：2026-11-07
范围：`packages/server`（Host，REST + WebSocket）、`packages/protocol`；使用真实第三方中转账号 "muze" 的两个分组：
- **codex 分组**：OpenAI 兼容协议，实测 `gpt-6-luna`（另抽查 `codex-auto-review`、`gpt-6-sol` 能力列表）
- **claude 分组**：Anthropic 协议，配置模型 `claude-sonnet-5-5`（模型列表还返回 opus/haiku 等，但分组只配置了 sonnet）

测试方式：`npm run build` 后用 `TANDEM_HOME=/tmp/tandem-e2e2` 启动 Host（8051），Node 26 内置 WebSocket 驱动；测试仓库为 `/tmp/tandem-e2e2/work`（git，含 `src/`、`README.md`）与 `work2`（切换 cwd 用）。未修改 `~/.tandem`，未打印/记录任何 key 或中转 URL。

## 结论

- **codex / OpenAI 兼容路径：核心场景全部通过**，包括流式、多轮、全部工具、并行工具、中断、排队、effort、子代理/孙代理、审批冒泡、中断级联、计划模式、Hooks、MCP、/compact、自动标题、切换 cwd/分支、图片、WebFetch。
- **claude / Anthropic 真实路径：被中转侧阻断，无法完成真实模型验证。** 该分组对所有非 Claude Code 客户端的 `/v1/messages` 请求返回 `503 No available accounts: this group only allows Claude Code clients`；对 `/v1/chat/completions` 直接返回 `403 This group is restricted to Claude Code clients (/v1/messages only)`。多次重试（间隔约 20 分钟）结果一致。这是账号/中转的访问策略（或该分组没有可用的 Claude Code 上游账号），不是 Tandem 代码错误；本报告没有通过伪造 Claude Code 客户端身份绕过该限制。
- 为验证 Anthropic 适配层，使用本地 mock 的 Anthropic SSE 服务对请求参数、缓存、thinking、tool use、图片、400 降级做了协议级验证；**以下 Anthropic 项标注为"mock 验证"，不代表真实模型通过**。
- 本轮发现并修复 5 个服务端问题（见下），修复后重跑了对应 mock/真实场景确认。

## 场景结果

图例：✅ 真实模型通过；🟡 本地 mock 协议验证通过（真实中转不可用）；⛔ 外部阻断；➖ 未测。

| 场景 | codex 分组（OpenAI 兼容，真实） | claude 分组（Anthropic） | 现象 / 证据 |
|---|---|---|---|
| 基础流式 | ✅ | ⛔ 真实阻断；🟡 mock | OpenAI：两轮 2+2→4、7，SSE block_start/text 增量正常；Anthropic mock：SSE thinking/text 解析正常 |
| 多轮上下文 | ✅ | ⛔ / 🟡 | OpenAI 第二轮正确回答 7；mock 第二轮带历史 |
| 工具全套 | ✅ | ⛔ / 🟡 | OpenAI 连续 10 次工具调用：Glob、Read、Grep、Edit、Write、TodoWrite、Bash、并行 Read；文件确实改为 `Hi, ...`；mock Anthropic 验证 tool_use/tool_result 往返 |
| 并行工具 | ✅ | ⛔ / 🟡 | 同一轮两次 Read 均执行并回填，无串行错误；只读工具按批并行 |
| interrupt | ✅ | ⛔ | `turn_end.reason=interrupted`，Bash 长命令被告中断，tool_result=`用户中断` |
| 排队 | ✅ | ⛔ | 运行中再发一条：先 queued-A 后 queued-B，两次 turn_end，顺序正确 |
| effort off/low/high | ✅ | ⛔ 真实；🟡 mock | 见下节 |
| 400 降级重试 | ✅（mock 上游） | 🟡 mock | OpenAI mock 首次 400 `reasoning_effort unsupported` 后去掉参数重试成功；Anthropic mock 首次 400 thinking 不支持后重试成功；两者均生成灰色 notice |
| 缓存 3 轮 | ⚠️ 真实 cacheRead 恒 0 | 🟡 mock | OpenAI 中转不返回 `prompt_tokens_details.cached_tokens`（直连探测 3k token 前缀两次也无该字段），非 Tandem 解析问题；Anthropic mock 第 2/3 轮 cacheRead=700、cacheWrite=100 |
| Message.usage / 会话累计 / costUsd | ✅ | 🟡 mock | 每条 assistant 消息单独 usage；会话 usage=各消息之和；账号单价覆盖后 cost 精确（见下） |
| GET context usedTokens | ✅ | 🟡 mock | 与最近一次真实 input 一致；含缓存时为 input+cacheRead+cacheWrite |
| 子代理 Task | ✅ | ⛔ / 🟡 | 创建 depth=1 子会话，parentId 指向主会话，最后文本回填为 tool_result |
| 孙代理 depth≤3 | ✅ | ⛔ | depth=2 孙代理读取 README，逐级回填；主/子/孙 title、usage 独立 |
| 审批冒泡 | ✅ | ⛔ | 子代理 Bash 请求以 depth=1、sourceTitle=子会话标题冒泡到主会话，自动批准后子代理继续 |
| 中断级联 | ✅ | ⛔ | 主会话 interrupt 后子代理 turn_end=interrupted，主 tool_result=`子代理已被中断` |
| 计划模式 ExitPlanMode | ✅ | ⛔ / 🟡 | plan→pending→approved(acceptEdits)，随后同轮 Write 创建 `plan-out.txt`；session.permissionMode 变为 acceptEdits |
| Hooks（PreToolUse 阻止 rm） | ✅ | ⛔ | hook_event blocked=true、ok=false；tool_result 带回 hook stderr；文件未被删除 |
| /compact | ✅ | 🟡 mock | 4 条消息压缩为 1 条摘要；压缩后继续追问仍答出 ZEBRA-42 |
| 自动标题 | ✅ | ⛔ | 首轮后从截断正文变为"记住暗号 ZEBRA-42" |
| 切换 cwd | ✅ | ⛔ | PATCH 后下一轮 `pwd`=`/tmp/tandem-e2e2/work2`，Read marker.txt 成功 |
| 切换分支 | ✅ | ⛔ | 有未提交改动时 409；提交后 checkout `feature-e2e`，`git branch --show-current` 返回 feature-e2e |
| MCP | ✅ | ⛔ | stdio mock MCP 连接成功，`mcp__echo__echo` 返回 `MCP_ECHO:hello-mcp`，审批卡片正常 |
| 图片输入 | ✅（OpenAI 补充） | 🟡 mock | OpenAI 1x1 红图回答"红色"；Anthropic mock 记录到 `{type:image, source:{type:base64,...}}` |
| WebFetch | ✅ | ⛔ | 本地 HTML 页面提取出 TANDEM_WEBFETCH_MARKER |
| 模型列表 | ✅ | ✅ | 两组均能通过 POST /api/models 拉到模型与 efforts/contextWindow |

## effort 参数验证

| 路径 | off | low | high | max |
|---|---|---|---|---|
| OpenAI（mock 捕获请求） | 不发送 `reasoning_effort` | `low` | `high` | 映射为 `high` |
| OpenAI（真实 gpt-6-luna） | 无 thinking 块 | 无 thinking 块 | 出现 thinking 块（reasoningTokens=25） | 未单独跑 |
| Anthropic（mock 捕获请求） | 不发送 thinking | budget=2048，max_tokens=8192 | budget=16384，max_tokens=20480 | 预算表 32000（未跑） |
| Anthropic（真实） | ⛔ 中转 503 | ⛔ | ⛔ | ⛔ |

- 真实 OpenAI 高 effort 的 SSE 中出现 `thinking` block 并随消息持久化，界面可显示；低 effort 模型未产出推理文本，但请求参数正确。
- **修复前 Anthropic 对 claude-sonnet-5-5 完全不会发送 thinking**（旧正则只识别 claude-3-7 / `claude-*-4`），effort 被静默忽略；已修复并复测。
- 400 降级：真实中转对本次可用模型都接受 reasoning_effort / thinking，无法触发真实 400；用本地 mock 上游确认 OpenAI 与 Anthropic 两条降级路径均生效，并写入 notice「当前模型不支持思考强度，本轮已自动忽略。」

## 缓存、用量与上下文

Anthropic mock 三轮同一会话（每轮 usage 固定为 input=1000、cacheRead=700、cacheWrite=100、output=20）：

- 每轮 assistant `Message.usage`：`{inputTokens:1000, cacheReadTokens:700, cacheWriteTokens:100, outputTokens:20, costUsd:0.003885}`（单价覆盖 3/15 美元每百万 token）
- 会话累计：`{input:3000, output:60, cacheRead:2100, cacheWrite:300, costUsd:0.011655}`
- `GET /context`：`usedTokens=1800`（1000+700+100），`cacheHitRate≈0.389`（700/1800），与真实 input 总量一致
- 请求体中的 `cache_control`：system 块、最后一个 tool、最后两条消息的最后内容块均带 `{type:"ephemeral"}`；第 2/3 轮缓存断点位置正确
- OpenAI 真实三轮：`inputTokens` 1773→1801→1832，`cacheReadTokens` 全 0；直连中转两次 3017 token 相同前缀的请求，返回 usage 只有 `prompt_tokens/completion_tokens`，没有 `cached_tokens` 字段，因此这是中转侧未暴露缓存命中，不是解析 bug
- OpenAI 账号单价覆盖 1/4 后：1773*1+7*4=1801 → costUsd=0.001801，逐条与会话累计一致
- `GET /context` 的 `usedTokens` 在真实工具会话（10 次请求）中为 2566，等于最后一次请求 input 2566；子代理各会话也各自一致
- `parts` 是按字符估算后按真实总量等比校准的构成（system/tools/mcp/memory/messages/tool_results/free），总量精确、分项为近似值

## 子代理与中断

- Task 创建的会话：主 depth=0、子 depth=1、孙 depth=2；`parentId` 链正确；侧栏过滤依据可用。
- 子代理结果取最后一条 assistant 文本，回填为 Task 的 tool_result；孙代理结果同样逐级回填。
- 审批冒泡：子代理 Bash 请求在主会话收到，字段 `depth=1`、`sourceTitle=Run requested echo`；批准后子代理执行成功。
- 中断级联：主会话 interrupt 后，子会话 turn_end=`interrupted`、tool_result=`用户中断`；主会话收到 `子代理已被中断` 并结束为 interrupted。
- depth=3 时子会话不再暴露 Task 工具，代码另有 depth>3 拒绝兜底；本轮测到 depth=2。

## 发现的 bug 与修复

1. **Anthropic thinking 能力判断过窄（严重）**
   `providers/anthropic.ts` 的 `supportsThinking` 只匹配 `claude-3-7` / `claude-*-4`，对 claude-sonnet-5-5、haiku-5-5、opus-5 全部不发送 `thinking`，effort 静默失效。
   修复：改为查 `modelCapabilities` 覆盖 > `builtinCapabilities` 的 efforts，明确包含当前档位才发送；未知能力保守关闭。

2. **Anthropic 流式 usage 被 message_delta 覆盖（计费/上下文偏小）**
   `message_start` 已带回 `cache_creation_input_tokens` / `cache_read_input_tokens`，`message_delta` 若带 0 会把它们覆盖为 0，导致 cacheWrite 丢失、cost/context 偏小。
   修复：流式 usage 按累计值取 max，不再被后续 0 覆盖。mock 复测 cacheWrite 从 0 恢复为 100，cost 从 0.00351 变为 0.003885。

3. **/compact 未计缓存用量与费用**
   `compactSession` 只累加 input/output，用 `costOf` 忽略 cacheRead/cacheWrite；与主循环口径不一致。
   修复：改用 `costOfUsage`，累计 cacheRead/cacheWrite，并让日统计输入包含缓存读写。mock 复测 /compact 后会话 usage 正确翻倍。

4. **gpt-6 系列未使用 max_completion_tokens**
   原逻辑只对 o 系列 / gpt-5 使用新参数，gpt-6 仍发 `max_tokens`。按 OpenAI 对新一代推理模型的参数约定（代码注释也如此说明），gpt-6 应使用 `max_completion_tokens`，否则换到官方端点有被 400 拒绝的风险。
   修复：`streamOpenAI`、`completeText`、`testOpenAI` 的匹配加入 `gpt-6`；本中转与本地 mock 均验证通过（mock 捕获到 `max_completion_tokens:8192`，未再发送 `max_tokens`）。

5. **首个流式请求偶发 fetch failed（空轮）**
   连接池空闲连接被对端关闭时，整轮直接以 `fetch failed` 失败（本轮真实测试出现 5 次，重发即成功）。
   修复：新增 `fetchSse`，在拿到响应前网络失败重试一次；中断/超时不重试。本地 flaky mock（首次 destroy socket）验证重试后成功。

6. **redacted_thinking 未原样回传（潜在工具循环 400）**
   Anthropic 安全加密块此前只显示为文本，未保存 `data`，工具循环下一请求会丢失该块。
   修复：内部 block 保存 `redacted` 字段并在 `toAnthropicMessages` 还原为 `redacted_thinking`；mock 验证第二轮请求携带 `{type:"redacted_thinking", data:"..."}`。

提交：`9365495`（Anthropic 能力/缓存/网络重试）、`2268a91`（compact 计费、gpt-6 token 参数）。

## 遗留 / 未解决

1. **claude 分组真实 Anthropic 路径不可用**：中转对该分组强制 Claude Code 客户端，返回 503/403；本轮无法用真实 key 验证 Anthropic 的实际模型行为。需要换一个允许普通 API 客户端的分组/key，或由账号侧恢复可用上游账号后重跑本报告中标 🟡 的 Anthropic 场景。未做客户端身份伪装。
2. **OpenAI 缓存命中不可观测**：中转不返回 `cached_tokens`，无法验证真实缓存收益；Tandem 的解析与计费已由 mock 验证。若换官方 OpenAI 端点应可复测。
3. **未知模型单价**：内置单价表不含 gpt-6 / claude-5 等中转模型名，`costUsd` 默认为空；本轮通过账号 price 覆盖验证了计费公式。是否补充新模型参考价需要产品确认（避免臆造价格）。
4. **自动标题请求未计入会话/日用量与费用**：标题调用是真实模型请求但不产生消息；本轮未改，属口径选择。/compact 已改为计入。
5. **上下文分项为近似估算**：`usedTokens` 已按真实 usage 校准且精确，但 system/tools/messages 等分项是按字符比例缩放，非 tokenizer 精确值。
6. 本轮未写单元测试（按任务要求关闭验证）；测试脚本与临时数据在 `/tmp`，结束后已删除。

## 请求与花费

真实中转侧成功计费的模型请求约 **95 次**（65 次流式 + 约 30 次自动标题），低于 120 次上限；另有若干被中转 503 拒绝的探测与网络失败重试，不产生 token 费用。测试中以上单价为本地覆盖，用于校验计费公式，非中转实际账单。
