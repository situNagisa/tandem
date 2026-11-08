# 性能专项 v2：会话分页加载（2026-11-08）

> 背景：perf v1 后，31MB 级会话打开时仍由 `session_snapshot` 整份下发（12,000 条消息 / 32.9MB），
> 手机和中继场景首屏慢、费流量。本轮把会话改为分页加载，并补充超大工具输出按需展开。
>
> 方法：临时 Host `TANDEM_HOME=/tmp/tandem-page`、端口 8362；夹具为 3,000 轮 / 12,000 条消息 /
> 32.9MB 的会话（每轮一条 10KB Bash 工具结果）。测量脚本见 `/tmp/tandem-page/final.mjs`；
> 前端为 Playwright Chromium 390×844（手机视口），取 JSHeapUsedSize、DOM 节点与首条消息挂载时间。
> 两次测量取同条件稳定值，headless 下 ±10–20% 波动。

## 夹具

| 项 | 值 |
|---|---:|
| 轮数 | 3,000 |
| 消息数 | 12,000 |
| 会话 JSON | 32,874,122 B ≈ 31.4MB |
| 单条工具结果 | 10KB |

## 前后对比

| 指标 | 分页前 | 分页后 | 变化 |
|---|---:|---:|---:|
| WS `session_snapshot` 首屏消息数 | 12,000 | **200** | 1/60 |
| WS 首屏下发字节 | 32,874,192 B（31.4MB） | **548,619 B（0.52MB）** | **−98.3%** |
| WS 首屏服务端耗时 | 435ms | **9.6ms** | 约 45× |
| `GET /api/sessions/:id`（全量 / tail=200） | 350ms / 31.4MB | **23ms / 0.52MB** | −93% 时间 |
| 手机视口首条消息出现 | 1,529ms | **337ms** | 约 4.5× |
| 手机视口 JS 堆 | 78.4MB | **18.8MB** | −76% |
| 手机视口 DOM 节点 | 10,387 | **5,287** | −49% |
| 加载更早一页（200 条） | — | **15ms / 0.52MB** | 按需 |
| 轮次大纲 3,000 轮 | 需先拉全量 | **9ms / 353KB** | 轻量索引 |
| Host RSS（加载夹具后） | 533MB | 462–487MB | 持平（全文仍在 Host 内存） |

首屏 200 条即最近 100 轮；滚动到顶部会自动再取 200 条，实测滚动位置误差 **0.125px**（锚点消息 u2950 的前后视口偏移 191.80 → 191.67px）。

## 做了什么

1. **协议**（`packages/protocol/src/index.ts`）
   - `subscribe` 增加 `tail?: number`；不传时保持全量（旧客户端兼容）。
   - `session_snapshot` 附带 `totalMessages` / `firstMessageId` / `truncated`；`Session` 分页视图也带同名字段。
   - 新接口：`GET /api/sessions/:id/messages?before=&around=&limit=`（`MessagePage`）、
     `GET /api/sessions/:id/turns`（`SessionTurns`，轮号 + 消息 id + 前 80 字）、
     `GET /api/sessions/:id/message-block?toolUseId=`（完整内容块）。
   - `tool_result` 增加 `truncated` 元信息（原始/省略字节数）。
2. **服务端**
   - `host/message-paging.ts`：尾部截取（200 条 / 2MB 上限）、超大工具输出首尾各 8KB（阈值 64KB）、轮次摘要。
   - `SessionStore.readMessagePage`：从 JSONL 末尾按 256KB 块倒序读完整行，按消息 id 幂等合并，取尾部/`before` 页不扫整个文件；
     与内存顺序不一致时回退内存切片（rewind/compact 后安全）。
   - 分页视图不下发全量；`around` 用于大纲/搜索跳到未加载的轮；旧的无 tail 订阅保留全量。
3. **前端**
   - 打开会话订阅 `tail=200`；`ActiveSession` 记录 `totalMessages/firstMessageId/hasEarlier/turns`。
   - 消息列表滚到顶部 240px 内自动加载更早一页；以视口首条消息为锚点，多次校准滚动位置，避免 content-visibility 导致跳位。
   - 轮次大纲优先用 `/turns`（3,000 轮不拉正文），跳到未加载的轮时按 `around` 取该段，段与已加载尾部之间显示缺口占位，可继续补齐。
   - 全文搜索跳转同样走 `ensureMessageLoaded`，未加载的消息加载完成后再定位/高亮。
   - 超大工具输出默认显示首尾片段，点「显示全部」按 `toolUseId` 拉完整内容（100KB 输出默认 17.4KB，按需 100KB）。
4. **回归**（`e2e/regression.mjs`，新增 3 条）
   - 大会话首屏只下发尾部（WS 200 条 / total 640 / firstMessageId / truncated；旧客户端无 tail 仍全量）。
   - 滚到顶自动加载更早消息且锚点位移 <4px。
   - 轮次大纲 Home 跳到未加载的第 1 轮，按需加载后可见、有缺口占位、轮次计数正确。

## 未做 / 取舍

- Host 启动仍会把全部会话消息读入内存（agent 循环需要）；本轮消除的是网络下发与客户端渲染成本，Host RSS 未明显下降。
  后续可做“大日志懒加载 + 按需回放”，但那会牵动搜索索引与 agent 上下文装配。
- `broadcastSnapshot`（自动压缩/回退/交接等中途中止）仍是全量快照；这些事件很少，且多数会缩减历史。
- 用户持续向上翻页时已加载消息和 DOM 会逐步增长（每页 200 条）。浏览到很早历史属于显式行为；如需要可再加“常驻 DOM 上限 + 动态窗口”。
- 中继实测受本机回环限制，未做公网中继验证；协议层只减少了下行字节，中继自身无需改动。
