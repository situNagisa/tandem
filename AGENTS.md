# Tandem 项目手册（给接手的人 / agent）

任何新会话、子代理、或新加入的人，先读这一页再动手。**协调者接手时先读 `docs/HANDOFF.md`**（当前状态、进行中的工作、等用户的事项）。它保证上下文被清空后，工作可以无损接续。文档分三层、每个功能一份说明，见 `docs/README.md`。

## 产品
类 Claude Code Desktop 的 agent 工作台；多端（PC/浏览器/安卓）互联；每会话可选账号/分组/模型/思考强度；可管理远程机器上的任务。产品所有者：徐奥（通过飞书话题沟通）。

## 事实来源（按优先级）
1. `docs/design.md` —— **设计原则**（P01–P22）；单点用户决定在 `scripts/decisions-check.mjs`、`scripts/ui-audit.mjs` 与 `e2e/regression.mjs` 的检查里。用户明确提过的要求不要回退。
2. `docs/PROGRESS.md` —— 每轮做了什么、遗留什么。
3. `packages/protocol/src/index.ts` —— 客户端与 Host 的唯一契约；改接口先改这里。
4. `docs/architecture.md` —— 模块地图、数据流、关键约定、“改 X 去哪里”。
5. `README.md` —— 构建、打包、目录。
6. 功能说明：`docs/features/<功能>.md`（每功能一份，索引见 `docs/README.md`）；代测步骤在 `docs/test-guides/`。
7. 一次性记录（评审、走查、e2e、性能、打分卡、调研）：只读，见 `docs/archive/`，文件名带日期或版本。

## 工作方式
- 用户可随时反馈，不必等他；每轮自己定优先级。视觉方向性选择才发「打分卡」（编号 + 现状/方案对比图）。
- **布置任务只按用户原话**：每条写「原话 → 现在 → 改成 → 不改什么」。理解超出原话、或与 design.md 原则/decisions-check 冲突时先问用户；自己的建议不进任务。
- **删掉的东西不留防回退检查**：删除功能后，现行文档与检查只正面描述现状（"远程连接唯一路径是工作站"），不写"不许加回 X"；删除记录只留在提交信息与 `docs/archive/`。防回退检查只用于"仍存在、容易被改坏"的行为。
- **文档写原则不写流水**：单点决定写成 decisions-check/ui-audit/回归检查，修复记录写提交信息；新增原则必须说明覆盖哪类情况。
- **不依赖会话上下文判断**：判断依据写进文件（HANDOFF、design 原则、decisions-check、根因表），新会话只读这些文件就能接手。每轮结束在 `docs/HANDOFF.md` 的「本轮手工操作 / 出错环节」追加 ≤5 行，作为以后沉淀脚本/Skill 的依据（只留最近 5 轮）。
- 用户的具体问题通过产品内「反馈模式」（Ctrl+Shift+F）导出 `tandem-feedback-*.tfb`（zip 容器，改扩展名可解压）发到飞书；桌面调试版同时把每条实时写进 `<下载>/Tandem 反馈/草稿-*/`（用户在本机时可直接读 `/mnt/c/Users/JDHC/Downloads/Tandem 反馈/`）。用 `lark-cli im +messages-mget --message-ids <id> --download-resources` 下载，`node scripts/feedback-unpack.mjs <tfb|json|草稿目录> <outDir>` 解包（旧 .json 仍兼容）后逐条处理，逐条回报并附修复后截图；包格式见 `docs/features/feedback.md`。
- 处理每条反馈前先查 `docs/feedback-ledger.md` 归到某个根因（R01…）；同一根因第二次出现必须在共享层修并加自动检查（ui-audit/单测/回归），不能只修表面。
- 交付前协调者亲自用 Playwright 点击验收用户反馈的每一条（只截静态图会漏掉"点了没反应、弹层被裁"类问题）。
- **提交前运行 `node scripts/check.mjs`**（docs → build → debug-artifacts → ui-audit → decisions → 单测 → smoke → regression → release）；子代理默认至少跑 `node scripts/check.mjs --skip-smoke`。
- **文档规则**：新写的一次性记录直接放 `docs/archive/`；功能变更只更新对应 `docs/features/<功能>.md`，不另写新文档；同一事实只在一处记录，其他地方链接过去。`scripts/docs-check.mjs` 会检查断链、根目录越界与现行文档更新日期。
- 每轮结束：`npm run build`，`npm run apk -w @tandem/mobile`，`npm run dist:win -w @tandem/desktop`（产物会复制到 Windows「下载」目录），更新 `docs/PROGRESS.md`。

## 约束
- 测试 Host 一律用 `TANDEM_HOME=/tmp/xxx` 与独立端口，不碰 `~/.tandem`。真实 Key 只在复制到 /tmp 的副本里用，测试后删除；Key 与中转 URL 不进日志/文档。
- `~/.claude`、`~/.codex` 只读。
- 杀进程用 `ps -eo pid,args | awk '/<特征>/ && !/awk/ {print $1}' | xargs -r kill`，不要 `pkill -f`（会杀掉执行命令的 shell）。
- 不读 git remote 的值；不 push（除非用户要求）。
- **不部署任何服务到公网、不让 Host/工作站对公网暴露、不接入第三方推送/云服务**（开发环境在公司内网，有安全风险）。工作站、推送等只做代码与本机回环测试；需要对外开放端口或向第三方发送数据的动作先问用户。用户自己的 Windows 环境可以上公网：需要公网验证时，写好测试步骤（命令、预期现象、要回传什么）请他代测。
- worktree 里缺依赖时，只在 worktree 内建软链：worktree 根 `node_modules` 指向主仓 `node_modules`，`<worktree>/packages/*/node_modules/@tandem/*` 指向本 worktree 的包；**不要改主仓 `node_modules/@tandem/*` 的软链**（否则主仓会构建到 worktree 的旧代码）。
- 多个子代理并行时按文件划分所有权；改共享文件前 `git diff <file>`，不覆盖他人未提交改动；每批构建通过即提交。

## 架构速览
- `packages/server`：Fastify REST + WS；agent 循环 `src/agent/loop.ts`；providers（anthropic / openai 兼容）；工具 `src/tools/`；权限、hooks、MCP、worktree、用量、外部会话 `src/external.ts`、工作站隧道 `src/workstation/`。
- `packages/web`：React 19 + Tailwind v4 + zustand；`src/components/ui/*` 是统一组件（Button、Menu、Tooltip…），新 UI 必须复用。
- `packages/desktop`（Electron）、`packages/mobile`（Capacitor）；远程连接统一走工作站。
