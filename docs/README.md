# 文档地图（先读这一页）

> 更新：2026-11-09。文档分三层；同一事实只在一处记录，其他地方链接过去。

## 1. 现行文档（living）——始终代表当前事实
- [HANDOFF.md](HANDOFF.md)：入口。当前版本、进行中的工作、等用户的事。
- [design.md](design.md)：设计规范 + 各轮用户决定（明确提过的要求以这里为准，不要回退）。
- [architecture.md](architecture.md)：模块地图、数据流、关键约定、“改 X 去哪里”。
- [feedback-ledger.md](feedback-ledger.md)：反馈根因台账（R01…）；复发必须共享层修 + 自动检查。
- [PROGRESS.md](PROGRESS.md)：只保留最近 5 轮；更早见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。
- `features/<功能>.md`：每个功能一份——是什么、怎么用、关键设计取舍、限制、代测步骤链接。**功能变更只改这里，不另写新文档。**

| 功能 | 说明 |
|---|---|
| [任务看板](features/taskboard.md) | 卡片=后台会话，依赖/审批门/并发/预算 |
| [设备共享](features/devices.md) | 跨 Host 的 ADB/串口（UI 里的「工作站」视图）；代测见 [test-guides/devices.md](test-guides/devices.md) |
| [Key 网关](features/gateway.md) | 团队模型请求统一转发、限流、记账 |
| [中继](features/relay.md) | 出站隧道 + 端到端加密 |
| [远程主机（SSH）](features/remote-ssh.md) | 一键部署远端 Host 并建隧道 |
| [命令沙箱](features/sandbox.md) | 写入保护、Bash 静态分析、网络白名单 |
| [项目 Secrets](features/secrets.md) | 加密注入进程环境 + 输出脱敏 |
| [会话分享](features/share.md) | 内网只读链接 |
| [团队共享](features/team.md) | 成员/邀请/角色/审计 |
| [模型路由](features/routing.md) | 自动路由 + 分工路由；同会话按轮切模型已废弃 |
| [发布](features/release.md) | 版本、签名、更新源、上架材料 |
| 工作站（账号与主机） | [workstation.md](workstation.md)；[accounts.md](accounts.md) 是被替代的旧模型，仅作迁移参考。iOS：用户已决定暂不做，评估归档于 [archive/research/](archive/research/)。 |

## 2. 一次性记录（records）
评审、走查、自用测试、e2e、性能、打分卡、调研、探索：写完即冻结，放 `archive/<类别>/`，文件名带日期或版本。类别：`reviews/`（评审/走查/无障碍/IA）、`e2e/`、`perf/`、`dogfood/`、`research/`、`qa/`、`scorecards/`、`plan/`、`progress/`。

## 3. 代测步骤（test guides）
给产品所有者的真机测试步骤放 [test-guides/](test-guides/)：设备共享、PR/CI、[工作站](test-guides/workstation.md)（个人模式 + 团队模式）。

## 4. 防膨胀规则
- 新写的一次性记录直接放 `archive/`；功能变更只更新对应 `features/<功能>.md`，不另写新文档；同一事实只在一处记录，其他地方链接过去。
- `docs/` 根目录只放本页与现行文件；新文件必须放进 `features/`、`archive/`、`test-guides/` 之一。
- `node scripts/docs-check.mjs`（`check.mjs` 的快速步骤）检查相对链接、根目录白名单，并对超过 30 天未更新的现行文档给出警告。
