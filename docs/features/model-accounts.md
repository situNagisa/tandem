# 账号与模型（设置）

> 更新：2026-11-11。设计原则见 [design.md](../design.md) 的 P21；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R59/R60/R42/R43/R37。协议字段见 `packages/protocol/src/index.ts`。

## 归属：工作站账号级（反馈12#01 · R59）

- 模型账号（provider 账号、分组、Key、倍率、模型勾选）属于**登录的工作站账号**，与具体主机无关。设置 → 账号与模型在所有主机上显示同一份数据，不随「当前主机」变化。
- Key **只加密保存在工作站**：`workstation/profiles.json`（AES-256-GCM，0600），密钥单独放 `workstation/profiles.key`（0600）。主机只同步元数据与 `apiKeyMasked`，任何主机本地文件都没有 Key 明文。
- 主机上的 agent 发起模型请求时，直接调用工作站进程内的模型账号入口（`workstation/bridge.ts`：`profileId/分组/模型/消息/工具` → 真实 Key 调上游 → `block_start/text/tool_input/rate_limit/effort_dropped/done/error`），不签名、不转发。主机回放为原有 provider 回调，所以 UI、工具循环、用量显示都不变。
- 同组多 Key 的故障切换、冷却、额度头解析都在工作站完成；`done` 事件带 `keyId/costUsd`，工作站按账号 + 主机记账到 `workstation/model-usage.json`。
- 不做旧数据搬迁：主机上下文都是工作站进程内新建的，模型账号只在工作站账号级存储里。主机上下文的 `/api/profiles` 返回 410，客户端直接调用 `/api/workstation/profiles`。
- 共享主机：被授权人在该主机上开会话时使用**自己的**账号级模型账号；会话记录 `workspaceAccountId`，模型请求按发起人账号取 Key。管理员也看不到他人 Key 明文（只有掩码）。
- 调试版调试账号自动带一个 `demo` 演示模型账号（不需要 Key）。

设置页实现：登录后 `ProfilesSection` / `KeysPanel` 直接调用 `/api/workstation/profiles*`；`appStore.refreshProfiles` 也从工作站拉取并同步到所有主机运行时缓存。

账号对应一个 Base URL，下面可有多个分组（各自协议与 Key），会话按所选分组运行。

## 账号余额查询（反馈14#08 · R60）

- 每个模型账号可选余额查询：`auto` 只按 baseUrl 自动识别已知平台（OpenRouter / DeepSeek / Moonshot / New API·One API / OpenAI Billing），识别不了就关闭；也可显式选平台或填自定义 GET URL + 金额 JSON 路径（如 `data.balance`），可选币种与低余额阈值。
- 查询由**工作站用该账号的 Key** 发起（Key 不出工作站），结果缓存 5 分钟；打开账号设置或模型菜单时读取缓存/触发查询，点设置页刷新按钮强制重查；不后台轮询。
- 账号设置列表显示「余额 $12.34」（查询失败显示「—」并用 tooltip 说明原因）；模型菜单账号行小字显示余额；低于阈值标警告色。
- 解析：OpenRouter `/api/v1/credits`（credits−usage）、DeepSeek `/user/balance`（`balance_infos[0].total_balance`）、Moonshot `/v1/users/me/balance`（`data.available_balance`）、New API `/api/user/self`（quota/500000）、OpenAI `/dashboard/billing/subscription` 或 `/dashboard/billing/credit_grants`。单测 `packages/server/test/balance.test.ts`（mock fetch）；e2e `workstation-check.mjs` 用 mock 平台验证显示/缓存/刷新。

## 编辑时保护 Key（反馈10#05 / R42）

- 已有 Key 的分组只显示掩码占位「已保存 · ••••abcd」和「更换 Key」按钮；点「更换 Key」才出现输入框（可取消）。
- 保存时 Key 未修改就不发送 `apiKey`；客户端也永远不会把掩码当明文回传。服务端 `ProfileStore.update` / `buildKeys` 对缺省、空字符串、看起来像掩码（含 `****` / `••••`）的 key 一律保留原值；删除 Key 走分组里的 Key 行。
- Key 按 `id` 保留未重传的 `apiKey`，改分组其余字段不会丢 Key。Secrets 编辑的值默认为空、留空不改；MCP 的环境变量由 Host 原样返回，编辑不会丢。
- 每个分组只显示一个 Key（反馈1323#02）：一行是分组名、协议、Key 掩码与状态，行尾测试 / 更换 / 删除，没有拖动、故障切换、轮询、添加 Key 与 Key 数量。协议与存储仍支持同组多 Key，旧数据里多余的 Key 只在有掩码的那一个之外保留、不显示也不删除，服务端照旧可用于故障切换。

## 拉取模型默认只勾选最新一代（反馈10#04 / R43）

- 「自动拉取模型」后按厂商/系列解析模型名：去掉日期快照（`YYYYMMDD` / `YYYY-MM-DD`），把字母部分作为系列、数字部分作为版本。同系列取版本号最大的一代；同版本同时有别名与日期快照时取别名，两个快照取日期更新的；完全判断不出系列/版本（如 `deepseek-chat`）的默认不勾选。
- 用户手动勾选/取消过之后再次拉取：保留原来的选择，只对本次新出现的模型应用「最新一代」规则。没手动改过时，再次拉取会按规则重新收敛。
- 实现：`packages/web/src/lib/modelSelection.ts`（`identifyModel` / `isNewerModel` / `selectLatestModels` / `mergeFetchedSelection`），单测 `modelSelection.test.ts` 覆盖截图里的 claude 系列、别名优先、快照排序与合并规则。

## 下拉与候选列表（反馈10#06 / R37、R01）

- 所有下拉都走 `ui/MenuSelect`（设置里的 `Controls.Select` 也是它的包装）；可输入 + 候选的模型 ID 输入走 `ui/Combobox`（单价覆盖、预算按模型）。
- `scripts/ui-audit.mjs` 新增 `native-datalist`、`native-input-list`，与既有的 `native-select` 一样在 `ui/` 以外直接失败，不设白名单例外。

## 验证

- 单测：`packages/server/test/account-profiles.test.ts`（Key 加密落盘/只回掩码、流式转发/中断/按账号记账）、`profile-keys.test.ts`、`packages/web/src/lib/modelSelection.test.ts`。
- 回归：`e2e/workstation-check.mjs`（工作站 + 本机主机上下文：账号级 Key 只回掩码、主机目录搜不到 Key、会话成功、bob 在共享主机用自己的 Key、旧 `/api/profiles` 返回 410）；`e2e/regression.mjs`「账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉」；「菜单行文字行高不被裁切」。
- 全量：`node scripts/check.mjs`。

## 下拉/弹层首次打开不抖（反馈12#10 · R52）

- 共享 `ui/Menu`、`ui/Popover` 等所有 `.popover-panel` 的入场动画只做透明度（`chat-pop-in/out`），**不再写 `transform`**：Radix 用内联 `transform: translate(...)` 做定位，CSS 动画里的 transform 优先级更高、会把它覆盖掉，导致首帧渲染在错误位置再跳回（首次打开、切换控件后再次打开都会复现）。
- 定位从第一帧起保持稳定，不需要额外的 `visibility` 占位。
- 回归：「反馈12#10：下拉首次打开位置稳定（前 10 帧 ≤1px）」对「更多」菜单与模型下拉各测首次/再次打开，rAF 采样前 10 帧 `getBoundingClientRect` 变化 ≤1px。
