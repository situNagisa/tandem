# 自建 Key 网关（可选，默认关闭）

> 团队里所有人的模型请求经过某一台 Tandem Host 统一转发：网关替换真实 Key、限流、记账、写脱敏日志；成员手里只有网关令牌。
> **只在可信内网使用。** 网关是 HTTP 明文接口；禁止端口映射、公网反向代理或任何形式的公网暴露。

## 1. 它解决什么

- 成员不需要拿到上游真实 Key，离职/换机时吊销网关令牌即可。
- 团队共享同一批账号与多 Key 分组，网关复用现有的 failover / round-robin 与冷却逻辑。
- 成本按「成员 × 模型 × 天」记账，直接进入现有「用量」页（多一个「按成员」维度），并参与现有预算规则。
- 请求日志只保留元数据；需要排查时临时开启调试正文，自动脱敏且 24 小时后删除。

## 2. 架构

```
成员客户端（账号类型：Tandem 网关）
  │  地址 = 网关 Host；Key = tgw_… 网关令牌
  │  OpenAI 兼容：POST /gateway/v1/chat/completions
  │  Anthropic 兼容：POST /gateway/v1/messages
  ▼
网关 Host（设置 → 网关，默认关闭）
  ├─ 网关令牌鉴权（team.json 里的成员；gateway.json 只存令牌哈希）
  ├─ 成员限额（今日/本月花费）、RPM 滑动窗口、模型白名单
  ├─ 模型路由：model → 本机 Profile › Group
  ├─ Key 轮换：复用 key-rotation / 冷却 / 失败分类
  ├─ 预算：复用 budgets.json 的 block 规则（账号/分组/模型/全局）
  ├─ 转发：替换 Authorization / x-api-key，透传 SSE 与 JSON
  └─ 记账：usage.json（带 memberId）+ gateway.json（元数据日志）
        │
        ▼
上游模型服务商（OpenAI 兼容 / Anthropic）
```

### 协议对应

| 入口 | 上游分组协议 | 说明 |
|---|---|---|
| `POST /gateway/v1/chat/completions` | `openai` / `openai-compatible` / `gemini` | 原样透传；流式时自动补 `stream_options.include_usage`，上游不支持则去掉重试 |
| `POST /gateway/v1/messages` | `anthropic` | 原样透传 Anthropic SSE（`message_start` / `message_delta` 的 usage 用于记账） |
| `GET /gateway/v1/models` | — | 返回路由里配置且令牌白名单允许的模型，OpenAI 列表格式 |

协议必须匹配：OpenAI 入口不会把请求翻译成 Anthropic 格式（反之亦然）。模型对应的分组协议不匹配时返回 409 和可读说明；需要跨协议时请在网关上给该模型配置对应协议的账号/分组。

## 3. 快速使用

1. 在网关 Host 的「设置 → 账号与模型」添加上游账号（可带多个 Key 分组）。
2. 「设置 → 网关」开启网关模式；添加模型路由（模型名 → 账号 › 分组）。
3. 「设置 → 成员」邀请同事；回到「网关」签发令牌，设置每日/每月限额、RPM、模型白名单。明文令牌只显示一次。
4. 成员在自己 Host 的「账号与模型 → 新建账号」选择「Tandem 网关」：
   - Base URL：`http://网关主机:端口`（也可带 `/gateway/v1`）
   - Key：`tgw_…`
   - 点「自动拉取模型」，选择模型后保存。
5. 其余会话、子代理、评测照常使用；客户端只要求网关 OpenAI 兼容入口。

示例：

```bash
curl http://gateway-host:8271/gateway/v1/models \
  -H "Authorization: Bearer tgw_xxx"

curl http://gateway-host:8271/gateway/v1/chat/completions \
  -H "Authorization: Bearer tgw_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}'

curl http://gateway-host:8271/gateway/v1/messages \
  -H "x-api-key: tgw_xxx" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## 4. 鉴权、限额与限流

- 网关令牌格式 `tgw_` + 64 位十六进制；Host 只保存 SHA-256（`gateway.json`，600 权限、原子写）。明文只在签发响应出现一次。
- 每个成员只保留一个有效令牌：重新签发会轮换，旧令牌立即失效。吊销后所有使用该令牌的请求立即 401。
- 成员被吊销（成员页）后，其网关令牌同时失效（每次请求都会校验成员状态）。
- 每日/每月限额单位为美元，按网关记账的参考价累计（与「用量」页一致）；达到上限返回 429，并带上已用/上限。
- RPM 使用内存滑动窗口（每令牌每分钟），重启后清空；超限返回 429 + `Retry-After`。
- 模型白名单为空表示路由里的所有模型都可用；否则只能请求白名单内的模型（大小写不敏感）。
- 记账在响应完成后写入：并发请求在结算前可能短暂超过限额（最多一个请求的额度）。
- 网关请求同时写入现有预算体系，账号/分组/模型/全局 `block` 预算会直接拦截网关转发。

## 5. 日志与调试正文

### 默认（调试关闭）

`gateway.json` 的 `logs` 环形数组（最近 1000 条）只含：

`时间、成员、模型、协议、输入/输出 token、花费、耗时、状态码、是否流式、路由名、错误摘要`

**不记录请求/响应正文，不记录 Header、Key、IP。** 「设置 → 网关」只展示最近 12 条。

### 调试正文（默认关闭）

- 开启后额外写 `gateway-debug.json`（600 权限），每条含请求/响应正文，最多 200 条、单条截断 200KB。
- 自动脱敏：`authorization`、`api_key`、`token`、`secret`、`password`、`cookie` 等字段整体替换；字符串中的 `Bearer …`、`sk-…`、`tgw_…`、`tmm_…` 形态替换为 `[REDACTED]`。
- 24 小时 TTL：加载与每次写入都会清理过期条目；关闭调试模式的瞬间清空全部调试正文。
- 调试正文不通过 REST 暴露，只在 Host 本机文件里，便于管理员排查。

## 6. 默认值

| 项 | 默认 |
|---|---|
| 网关模式 | 关闭 |
| 模型路由 | 空 |
| 调试正文 | 关闭，TTL 24h |
| 令牌 RPM | 60 |
| 每日/每月限额 | 不限 |
| 模型白名单 | 空 = 全部路由模型 |
| 日志保留 | 最近 1000 条元数据 |
| 端口 | 与 Host 相同（默认 8270 / 自定义 `--port`） |

## 7. 威胁模型

| 场景 | 结果 / 缓解 |
|---|---|
| 成员网关令牌泄露 | 可冒用该成员额度与白名单；立即在「网关」页吊销，或重新签发轮换。令牌不含上游 Key，无法直连上游。 |
| 成员设备丢失 | 吊销成员 + 吊销网关令牌；现有 WS 立即断开，网关请求立即 401。 |
| 恶意成员滥用 | 受 RPM、每日/每月限额、模型白名单约束；每次请求都记账并留元数据日志。不能改路由、账号、Key 或查看其他成员额度。 |
| 成员尝试读取真实 Key | 网关令牌只在本机哈希表匹配；REST 账号接口对成员隐藏掩码，网关请求替换后才发往上游。 |
| 内网窃听 / 中间人 | 明文 HTTP，令牌与正文可能被同网段截获。只在可信内网/VPN 使用，防火墙限制来源；不要把端口映射到公网。 |
| 网关 Host 被公网暴露 | 不在支持范围内。禁止端口映射、反向代理、第三方隧道。 |
| 日志隐私 | 默认只有元数据；调试正文需显式开启、自动脱敏、24 小时后删除，关闭即清空。 |
| 上游 Key 出现在日志 | 请求侧 Header 不落盘；调试正文的 `authorization`/`x-api-key` 字段与 `sk-` 形态均被脱敏。 |
| 上游错误信息回传给调用者 | 只回传截断后的可读错误；不会包含 Key。所有 Key 失败时返回 502 与分组不可用摘要。 |
| 网关配置指回自身 | 路由校验拒绝 `tandem-gateway` 账号，避免请求环路。 |
| 重放/盗用请求 | 令牌即权限；无请求签名。防重放依赖内网边界与 HTTPS（后续版本），当前不要把网关放到不可信网络。 |

## 8. 运维

- 网关 Host 监听局域网时，用系统防火墙只允许公司网段访问端口；不确定时保持 `127.0.0.1`。
- 定期检查「设置 → 网关」的成员统计与日志；异常成员先吊销令牌再排查。
- 上游账号 Key 轮换/停用由现有「账号与模型」页管理；网关会自动跳过冷却/停用的 Key。
- `gateway.json` 含成员令牌哈希与元数据日志，按敏感配置对待；`gateway-debug.json` 在调试期间按敏感数据对待。
- 网关不部署任何公网服务、不接第三方推送/云服务；所有数据留在 Host 本地。

## 9. 已知限制

- 无 TLS / 请求签名 / 细粒度按小时限流。
- 协议不跨转：OpenAI 入口只路由到 OpenAI 兼容分组，Anthropic 入口只路由到 Anthropic 分组。
- 限额以美元计，依赖账号 `price` 覆盖或内置参考价；未知模型记 0 花费，只统计 token。
- 调试正文仅本机文件，不做 UI 查看/导出。
- 网关令牌不区分「只读/只调用某模型」之外的权限；令牌即模型调用权限。
