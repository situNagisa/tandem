# Tandem 真实模型端到端测试报告

- 日期：2026-11-06
- 环境：WSL Linux，Node.js 26，Tandem Host（REST + WebSocket）
- 账号：本机已有账号 `muze`，`kind: openai`，指向第三方 OpenAI 兼容中转
- 可用模型：`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`codex-auto-review`
- 测试方式：复制账号到临时 `TANDEM_HOME`，用 Node 26 内置 WebSocket 编写脚本驱动会话；示例项目放在临时目录（`a.js` / `b.js` / `notes.md`，另生成红色 PNG）。脚本只用于本次测试，未提交。
- 请求量：约 58 次真实模型请求（含自动标题、标题探测等辅助请求），以 `gpt-5.6-luna` 为主，默认模型 `gpt-6-luna` 单独验证；推理模型只做 1–2 次探测。
- 说明：测试期间服务端代码以当时 main（已包含同事的 seq/检查点/权限规则/`/cost` 提交）重新构建；以下结果均基于该构建。未测试 Anthropic provider（账号只有 OpenAI 兼容路径）。

## 场景结果

| 场景 | 结果 | 现象 |
| --- | --- | --- |
| 纯文本流式 | 通过 | 23 个 `block_delta` 文本增量，`message_end` 内容完整，无重复/丢字 |
| 多轮上下文 | 通过 | 能原样复述第一轮用户消息 |
| 工具全套：Read/Glob/Grep/Write/Edit/Bash/TodoWrite | 通过 | 一轮任务内 9 次模型往返，7 类工具均执行成功；改名后 `node a.js`、`node c.js` 输出正常，TodoWrite 状态同步 |
| 并行多个工具调用（3 个 Read） | 通过 | 同一条 assistant 消息内 3 个 `tool_calls`，`index` 拼接正确；tool_use id 与 tool_result id 一一对应 |
| 同一批 Write 后立即 Read | **修复前失败，修复后通过** | 修复前 Read 返回 `OLD`、落盘为 `NEW`（只读工具被提前执行）；修复后 Read 返回 `NEW` |
| interrupt 打断文本流 | 通过 | 首个增量后 interrupt，`turn_end.reason=interrupted`，状态回到 idle；继续发消息正常回答 |
| Bash 执行中 interrupt | 通过 | `sleep 20` 被终止，tool_result 为“用户中断”，后续消息可继续 |
| 等待权限时 interrupt | 通过 | 权限请求被拒绝，`turn_end` 为 interrupted，后续消息可继续 |
| interrupt 后立即 send | 通过 | 不等 `turn_end` 直接发下一条，消息排队并在中断收尾后执行成功 |
| 运行中 send 排队 | 通过 | 第二条消息在本轮 `turn_end` 之后才出现，两轮回答完整，未丢失 |
| default 模式权限 allow | 通过 | Write、Bash 各弹一次 permission_request；状态出现 `waiting_permission`，允许后执行成功 |
| default 模式权限 deny | 通过 | tool_result 为“用户拒绝了该操作”，模型如实告知被拒绝 |
| `/compact` | 通过 | 历史 5 条压缩为 1 条“[此前对话摘要]”，摘要保留目标/文件/未完成事项，usage 累加 |
| `/cost` | 通过（新构建） | 旧构建中尚未实现，按普通消息发给模型，回答无法获取费用；拉取最新代码重建后为本地命令，返回输入/输出 token、花费（未配置单价时明确说明）与当前模型，无模型请求、无 `turn_end` |
| 自动标题 | 部分通过 | 多个会话生成成功（如“幂等性与重试机制解释”“撰写分布式系统一致性短文”）；2 个会话 30 秒内仍是兜底标题。按设计保留兜底标题，不阻塞对话 |
| 图片输入（user 消息 image 块） | 通过 | 32×32 纯红 PNG，模型只回答“红色” |
| Read 工具返回图片 | 通过 | tool_result 后附 image 块，模型能读出“红色” |
| reasoning 内容映射 | 通过 | `gpt-5.6-luna` 多次返回 `reasoning_content`，被映射为 thinking block（单轮 35–62 字符），正文不受污染；`gpt-5.6-terra` 本次探测未返回 reasoning，无法确认该模型是否推理模型 |
| 默认模型 `gpt-6-luna` 工具调用 | 通过 | Read 读取 `notes.md` 后正确总结，说明默认模型路径可用 |
| provider 中途报错后的恢复 | 通过（修复后） | 构造中转在发出 tool_call 后报错：修复前历史会留下悬空 tool_calls（中转直接 400 `No tool output found for function call ...`）；修复后自动补一条错误 tool_result，下一轮正常恢复 |
| 模型列表接口 | 通过 | `POST /api/models` 返回上述 9 个模型 |

## 发现的问题与修复

### 1. 同一批工具调用被重排，Write 后 Read 读到旧内容（真实模型复现）

**现象**：让模型在一条 assistant 消息里同时发出 `Write order.txt=NEW` 和 `Read order.txt`。实际 tool_result 顺序是 Write 成功、Read 返回 `OLD`，而文件最终为 `NEW`。模型因此向用户报告“Read 返回 OLD”。

**原因**：`executeToolUses` 把所有只读工具（Read/Glob/Grep）集中到最前并行执行，再把写类工具串行执行，破坏了模型给出的调用顺序。只读工具之间可以并行，但不能跨越写类工具提前执行。

**修复**：`packages/server/src/agent/loop.ts:233` 改为按调用顺序分批：相邻的只读工具并行，遇到写类工具或 Bash 时先结束当前只读批，再执行写类工具；结果仍按原始下标回填。既保留并行读性能，又保证 `Write → Read` 等顺序语义。

**复验**：同一提示词、同一模型，修复后 Read 返回 `NEW`，模型回答 `NEW`。

### 2. provider 中途报错后残留悬空 tool_calls，会话被永久卡死（错误路径）

**现象**：若中转在已经下发 tool_call、但尚未完成响应时返回错误（网络中断、限流、内容过滤等），assistant 消息里会留下 tool_use，但循环直接 `break`，不补 tool_result。下一轮把该历史发给 OpenAI 兼容接口时，服务端返回 400：`No tool output found for function call ...`，之后每一轮都会失败，只能清空会话。

**验证**：直接向该中转构造“assistant tool_calls + 无 tool 消息”的历史，确认返回 400；用本地 mock 中转在 tool_call 后注入 `error` 事件，复现该历史。

**修复**：`packages/server/src/agent/loop.ts:118` 在请求失败/中断且 assistant 已解析出 tool_use 时，补一条 user 消息，为每个 tool_call 生成 `isError` 的 tool_result（中断为“用户中断”，其余为“模型请求失败，工具未执行”），并正常广播、落盘。mock 复验：错误轮之后的历史包含配对的 tool_result，下一轮恢复成功。

## 遗留与建议

1. **自动标题偶发不更新**：标题请求与首轮对话并发，使用 20 秒超时、64 输出 token；慢中转或推理 token 占用时可能超时，保留兜底标题。功能上可接受，建议后续把超时放宽或改到本轮结束后再生成。
2. **provider 请求没有空闲超时**：偶发一次很小的请求耗时约 97 秒才返回；若中转彻底挂起，会话会一直处于 running，只能手动中断。建议为流式请求增加“长时间无数据”超时（需大于推理模型的最长静默期）。
3. **`max_tokens` / `max_completion_tokens` 判断偏保守**：当前只对 `o*` 和 `gpt-5*` 使用 `max_completion_tokens`。本中转接受 `gpt-6-luna` + `max_tokens`，但官方 OpenAI 的新模型可能拒绝；如后续接入官方端点，建议按模型能力表判断。
4. **`/cost` 等本地命令不产生 `turn_end`**：客户端不能把 `turn_end` 当作所有命令的结束信号；本次测试按 `message_end` 处理。属既有协议行为，未改动。
5. **未覆盖**：Anthropic provider、WebFetch、acceptEdits/plan 模式、长上下文压缩后的工具历史、多客户端同时订阅、断线 seq 重放（同事功能，未在本次范围内做真实模型验证）。
