# 文档地图（先读这一页）

> 更新：2026-11-11。文档分三层；同一事实只在一处记录，其他地方链接过去。

## 1. 现行文档（living）——始终代表当前事实
- [HANDOFF.md](HANDOFF.md)：入口。当前版本、进行中的工作、等用户的事。
- [design.md](design.md)：**设计原则**（P01–P22，规则+为什么+覆盖范围）；单点决定见 `scripts/decisions-check.mjs`、`scripts/ui-audit.mjs` 与回归检查。
- [architecture.md](architecture.md)：模块地图、数据流、关键约定、“改 X 去哪里”。
- [feedback-ledger.md](feedback-ledger.md)：反馈根因表（R01…）；复发必须共享层修 + 自动检查。
- [PROGRESS.md](PROGRESS.md)：只保留最近 3 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。
- `features/<功能>.md`：每个功能一份——是什么、怎么用、关键设计取舍、限制、代测步骤链接。**功能变更只改这里，不另写新文档。**

| 功能 | 说明 |
|---|---|
| [任务看板](features/taskboard.md) | 卡片=后台会话，依赖/审批门/并发/预算 |
| [设备共享](features/devices.md) | 跨 Host 的 ADB/串口（UI 里的「工作站」视图）；代测见 [test-guides/devices.md](test-guides/devices.md) |
| [Key 网关](features/gateway.md) | 模型请求统一转发、限流、记账 |
| [远端执行器](features/executor.md) | 瘦执行器 tandem-exec（Go 单文件，出站连接工作站，v1 操作与加密握手）；M1 未接入产品 |

| [命令沙箱](features/sandbox.md) | 写入保护、Bash 静态分析、网络白名单 |
| [项目 Secrets](features/secrets.md) | 加密注入进程环境 + 输出脱敏 |
| [会话分享](features/share.md) | 内网只读链接 |
| [模型路由](features/routing.md) | 自动路由 + 分工路由；主会话模型恒定，执行交给子代理 |
| [输入框](features/composer.md) | Markdown 编辑与着色、输入 token 估算、切换模型/账号时的缓存失效确认 |
| [账号与模型](features/model-accounts.md) | 分组 Key 保护、拉取模型只选最新、下拉统一共享组件 |
| [对话区](features/conversation.md) | 轮次大纲（用量着色、固定、Alt 只看已固定）与「最占空间」按轮次聚合；消息耗时与轮次耗时汇总；上下文卡分类与缓存命中 |
| [项目 Wiki](features/wiki.md) | 概览/模块/术语表阅读区；固定阅读列宽度、宽内容内部滚动 |
| [会话图](features/session-graph.md) | 右栏 git graph：轮次主线、子代理合并分支、分叉不合并分支；彩色泳道、同形节点 |
| [手机预览](features/mobile-preview.md) | 调试版在电脑上模拟手机尺寸/触摸；真机调试见 [test-guides/mobile-debugging.md](test-guides/mobile-debugging.md) |
| [发布](features/release.md) | 版本、签名、更新源、上架材料 |
| [反馈模式](features/feedback.md) | 调试版实时落盘草稿、.tfb 包结构与解包命令 |
| 工作站（账号与主机） | [workstation.md](workstation.md)；[archive/accounts.md](archive/accounts.md) 是被替代的旧模型，仅作迁移参考。iOS：用户已决定暂不做，评估归档于 [archive/research/](archive/research/)。 |

## 2. 一次性记录（records）
评审、走查、自用测试、e2e、性能、打分卡、调研、探索：写完即冻结，放 `archive/<类别>/`，文件名带日期或版本。类别：`reviews/`（评审/走查/无障碍/IA）、`e2e/`、`perf/`、`dogfood/`、`research/`、`qa/`、`scorecards/`、`plan/`、`progress/`。

## 3. 代测步骤（test guides）
给产品所有者的真机测试步骤放 [test-guides/](test-guides/)：设备共享、PR/CI、[工作站](test-guides/workstation.md)（服务器模式 + 本机主机）。

## 4. 防膨胀规则
- 新写的一次性记录直接放 `archive/`；功能变更只更新对应 `features/<功能>.md`，不另写新文档；同一事实只在一处记录，其他地方链接过去。
- `docs/` 根目录只放本页与现行文件；新文件必须放进 `features/`、`archive/`、`test-guides/` 之一。
- `node scripts/docs-check.mjs`（`check.mjs` 的快速步骤）检查相对链接、根目录白名单、现行文档更新日期，并强制行数上限（design ≤150、ledger ≤80、每份 features ≤80、PROGRESS ≤60、HANDOFF ≤60、AGENTS ≤50）。
