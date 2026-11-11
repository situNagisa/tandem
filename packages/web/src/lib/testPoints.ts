import type { SettingsTab } from './types'

/** 体验清单的测试要点：每条一句话说明做什么，以及在哪里能打开对应场景。 */
export type ChecklistAction = 'split' | 'search' | 'command' | 'clear-demo' | 'feedback' | 'workstation'

export interface TestPoint {
  id: string
  feature: string
  text: string
  /** 演示场景 id（server/src/demo/scenarios.ts）。 */
  demo?: string
  /** 没有演示场景时打开对应设置页。 */
  settingsTab?: SettingsTab
  /** 命令面板/分屏/搜索等直接动作。 */
  action?: ChecklistAction
}

export const TEST_POINTS: TestPoint[] = [
  // 对话与自动化
  { id: 'chat-1', feature: 'chat', text: '发一条消息，确认思考过程、正文与工具卡按顺序流式出现。', demo: 'chat-tools' },
  { id: 'chat-2', feature: 'chat', text: '展开工具卡，确认输入、输出与错误状态可读；复制按钮可用。', demo: 'chat-tools' },
  { id: 'chat-3', feature: 'chat', text: '发送带附件的消息，确认图片预览与取消附件正常。', demo: 'chat-tools' },
  { id: 'permissions-1', feature: 'permissions', text: '触发 Bash 审批，分别测试允许、总是允许与拒绝。', demo: 'permission' },
  { id: 'permissions-2', feature: 'permissions', text: '在设置里添加一条 allow/deny 规则，确认命中与优先级（deny 最高）。', settingsTab: 'permissions' },
  { id: 'permissions-3', feature: 'permissions', text: '批准同类请求三次后出现规则建议；危险命令不应出现建议。', settingsTab: 'permissions' },
  { id: 'plan-1', feature: 'plan', text: '在计划模式下提交计划，确认计划卡内容与批准/继续完善按钮。', demo: 'plan' },
  { id: 'plan-2', feature: 'plan', text: '批准计划后确认权限模式切换，计划可随时在右栏回看。', demo: 'plan' },
  { id: 'subagents-1', feature: 'subagents', text: '打开主会话，确认右栏代理卡显示子代理/孙代理层级与结论。', demo: 'subagents' },
  { id: 'subagents-2', feature: 'subagents', text: '点击子代理条目，确认能定位到对应消息或打开会话。', demo: 'subagents' },
  { id: 'background-1', feature: 'background', text: '启动后台命令，确认面板显示运行中、增量输出与结束状态。', demo: 'background' },
  { id: 'background-2', feature: 'background', text: '终止一个后台任务，确认输出保留且状态变为已终止。', demo: 'background' },
  { id: 'delegation-1', feature: 'delegation', text: '在模型菜单里切换分工（关闭/适度/积极）与取向，确认选择立即写入会话、系统提示与 Task 可见性随之变化。', demo: 'delegation' },
  { id: 'delegation-2', feature: 'delegation', text: '把分工切到「积极」后派发多个子任务，确认主会话只做计划与汇总。', demo: 'delegation' },
  { id: 'auto-compact-1', feature: 'auto-compact', text: '长会话接近上限时自动压缩，确认压缩提示可展开摘要。', demo: 'auto-compact' },
  { id: 'auto-compact-2', feature: 'auto-compact', text: '在设置里调整压缩阈值，确认生效且可手动压缩。', settingsTab: 'general' },
  { id: 'handoff-1', feature: 'handoff', text: '模拟 429 后出现交接卡，切换到备用分组并完成下一回合。', demo: 'handoff' },
  { id: 'handoff-2', feature: 'handoff', text: '选择等待额度重置，确认到点自动继续且只留一条提示。', demo: 'handoff' },
  { id: 'resume-1', feature: 'resume', text: 'Host 重启后打开暂停会话，确认可继续或只恢复对话。', demo: 'resume' },
  { id: 'resume-2', feature: 'resume', text: '确认排队消息、检查点与悬空审批在恢复后仍可见。', demo: 'resume' },
  { id: 'hooks-1', feature: 'hooks', text: '打开演示场景，确认失败的 Hook 以内联灰字显示在消息附近。', demo: 'hooks' },
  { id: 'hooks-2', feature: 'hooks', text: '在设置里新增/禁用一条 Hook，确认只读来源不可编辑。', settingsTab: 'hooks' },
  { id: 'inbox-1', feature: 'inbox', text: '打开收件箱，确认审批、回合结束、预算、CI、评测、看板、交接事件可区分。', demo: 'inbox' },
  { id: 'inbox-2', feature: 'inbox', text: '从收件箱点一条事件，确认跳到对应会话/看板并清除未读。', demo: 'inbox' },
  { id: 'inbox-3', feature: 'inbox', text: '在收件箱直接审批，确认所有端的待办同步移除。', demo: 'permission' },

  // 模型与成本
  { id: 'models-1', feature: 'models', text: '新建账号/分组，切换模型与思考强度，确认会话头部回显与请求一致。', settingsTab: 'profiles' },
  { id: 'models-2', feature: 'models', text: '同一分组配置多 Key，确认 failover/round-robin 与冷却状态展示。', settingsTab: 'profiles' },
  { id: 'auto-route-1', feature: 'auto-route', text: '开启自动路由，简单消息走快速档、长难任务走强力档。', demo: 'chat-tools' },
  { id: 'auto-route-2', feature: 'auto-route', text: '构造连续工具失败，确认升级一档并在消息里显示路由理由。', settingsTab: 'routing' },
  { id: 'division-routing-1', feature: 'division-routing', text: '发一条问答或小改动，确认提示行是「单代理」，且没有派出子代理。', demo: 'chat-tools' },
  { id: 'division-routing-2', feature: 'division-routing', text: '在模型菜单把取向切到「省钱」发送一条机械命令，确认「整单交执行者」完成并只回传摘要。', settingsTab: 'routing' },
  { id: 'division-routing-3', feature: 'division-routing', text: '把「分工前确认」设为总是，确认计划卡可换模型、删子任务或整单改为单代理后再派发。', settingsTab: 'routing' },
  { id: 'usage-budget-1', feature: 'usage-budget', text: '跑几轮后查看用量页，确认 token、花费与按模型/账号汇总。', settingsTab: 'usage' },
  { id: 'usage-budget-2', feature: 'usage-budget', text: '设置日预算 80% 告警与阻止，确认收件箱和会话内提示。', settingsTab: 'usage' },
  { id: 'gateway-1', feature: 'gateway', text: '开启 Key 网关，创建成员令牌并确认可列出允许模型。', settingsTab: 'gateway' },
  { id: 'gateway-2', feature: 'gateway', text: '确认网关只转发到本机账号，调试正文默认关闭。', settingsTab: 'gateway' },

  // 审阅与并行
  { id: 'board-1', feature: 'board', text: '打开演示看板，确认七列、依赖卡与需我处理数字。', demo: 'board' },
  { id: 'board-2', feature: 'board', text: '拖动卡片到允许的列，确认不可投放的列变淡。', demo: 'board' },
  { id: 'board-3', feature: 'board', text: '打开待审批卡，测试通过/打回与打回意见回填。', demo: 'board' },
  { id: 'board-4', feature: 'board', text: '打开失败卡重试，确认失败原因与重试次数可见。', demo: 'board' },
  { id: 'changes-1', feature: 'changes', text: '打开改动面板，确认文件统计、diff 颜色与行号。', demo: 'changes' },
  { id: 'changes-2', feature: 'changes', text: '选中一段行写评论，确认提交后行侧有标记且消息可发送。', demo: 'changes' },
  { id: 'changes-3', feature: 'changes', text: '测试提交与丢弃改动，确认危险操作使用中性按钮。', demo: 'changes' },
  { id: 'ai-review-1', feature: 'ai-review', text: '对未提交改动运行 AI 评审，确认意见挂到对应 diff 行。', demo: 'ai-review' },
  { id: 'ai-review-2', feature: 'ai-review', text: '采纳意见转人工评论，或标记误报后不再重复出现。', demo: 'ai-review' },
  { id: 'split-1', feature: 'split', text: '用分屏打开两个会话，确认布局刷新后保留、分隔条可拖动。', action: 'split' },
  { id: 'split-2', feature: 'split', text: '手机端圆点滑动切换窗格，关闭窗格后剩余布局正常。', action: 'split' },
  { id: 'evals-1', feature: 'evals', text: '打开评测运行，确认两个配置的通过率、耗时与花费对比。', demo: 'evals' },
  { id: 'evals-2', feature: 'evals', text: '打开单条轨迹，确认消息、工具调用与检查命令输出可回放。', demo: 'evals' },
  { id: 'evals-3', feature: 'evals', text: '从会话保存用例，确认套件、通过标准与检查命令可编辑。', demo: 'changes' },
  { id: 'paging-1', feature: 'paging', text: '打开超大会话，确认首屏只加载尾部且滚到顶自动加载更早。', demo: 'chat-tools' },
  { id: 'paging-2', feature: 'paging', text: '用轮次大纲跳到未加载的轮，确认按需取该段并显示缺口占位。', demo: 'chat-tools' },

  // 工作区与发现
  { id: 'wiki-1', feature: 'wiki', text: '打开项目 Wiki，确认概览/模块/术语页与全文搜索。', demo: 'wiki' },
  { id: 'wiki-2', feature: 'wiki', text: '编辑手写段落，确认增量更新后手写内容保留。', demo: 'wiki' },
  { id: 'preview-1', feature: 'preview', text: '打开演示静态页，切换桌面/手机尺寸并刷新。', demo: 'preview' },
  { id: 'preview-2', feature: 'preview', text: '点选元素，确认选择器/可访问名回填到对话。', demo: 'preview' },
  { id: 'envbar-1', feature: 'envbar', text: '在手机上打开会话，横向滑动环境条，确认文件夹、分支与 Worktree 都能看全。', demo: 'chat-tools' },
  { id: 'envbar-2', feature: 'envbar', text: '切换文件夹或分支，确认环境条立即更新，只有探测时显示骨架。', demo: 'chat-tools' },
  { id: 'sidebar-1', feature: 'sidebar', text: '连接两台主机，确认侧栏按主机分组显示全部会话，组标题与在线状态正确。' },
  { id: 'sidebar-2', feature: 'sidebar', text: '固定一个会话再取消，确认「已固定」与「最近」分组随之变化，刷新后保留。' },
  { id: 'sidebar-3', feature: 'sidebar', text: '在侧栏切换主机分组或收起分组，确认新会话落到当前主机分组下。' },
  { id: 'workstation-1', feature: 'workstation', text: '创建演示工作区后打开工作站，确认「演示设备」（演示安卓设备 / 演示串口板）出现在列表里并标注演示设备。', action: 'workstation' },
  { id: 'workstation-2', feature: 'workstation', text: '把演示安卓设备挂到当前会话，让 agent 执行 AdbShell（如 getprop ro.product.model），确认返回演示输出。', action: 'workstation' },
  { id: 'workstation-3', feature: 'workstation', text: '挂载演示串口板并打开终端，确认周期日志在滚，发 help / reboot 有回显。', action: 'workstation' },
  { id: 'workstation-4', feature: 'workstation', text: '在没装 adb 的主机上打开工作站，确认只显示「未检测到 adb · 如何安装 / 设置路径」，不报错且串口设备照常可用。', action: 'workstation' },
  { id: 'search-1', feature: 'search', text: '搜索中英文短语，确认命中会话、消息片段与高亮。', action: 'search' },
  { id: 'search-2', feature: 'search', text: '按状态/主机/项目筛选，确认结果与侧栏筛选一致。', action: 'search' },
  { id: 'command-palette-1', feature: 'command-palette', text: 'Ctrl/Cmd+K 搜索命令、会话与设置项，确认可直接跳转。', action: 'command' },
  { id: 'command-palette-2', feature: 'command-palette', text: '用拼音首字母搜索，确认命令与设置项都能命中。', action: 'command' },
  { id: 'browser-1', feature: 'browser', text: '打开浏览器面板，确认只允许本机/白名单域名。', settingsTab: 'browser' },
  { id: 'browser-2', feature: 'browser', text: '在面板中截图与读取控制台，确认截图随操作刷新。', settingsTab: 'browser' },
  { id: 'schedules-1', feature: 'schedules', text: '新建一个定时任务，确认 cron 预览、下次运行时间与启停。', settingsTab: 'schedules' },
  { id: 'schedules-2', feature: 'schedules', text: '让定时任务更新项目 Wiki，确认到点生成任务记录。', settingsTab: 'schedules' },
  { id: 'notifications-1', feature: 'notifications', text: '分别开关审批/回合结束/错误/预算提醒，确认收件箱与系统通知。', settingsTab: 'notifications' },
  { id: 'notifications-2', feature: 'notifications', text: '确认通知不经过第三方推送服务。', settingsTab: 'notifications' },

  // 安全与系统
  { id: 'sandbox-1', feature: 'sandbox', text: '开启沙箱，尝试写工作目录外与访问非白名单网络，确认转审批。', settingsTab: 'permissions' },
  { id: 'sandbox-2', feature: 'sandbox', text: '确认受保护路径（.ssh/.env）即使在跳过权限模式也必须审批。', settingsTab: 'permissions' },
  { id: 'secrets-1', feature: 'secrets', text: '添加项目 Secret，确认命令环境可用且消息/日志自动打码。', settingsTab: 'secrets' },
  { id: 'secrets-2', feature: 'secrets', text: '删除 Secret 后确认不再注入，导出配置不含明文。', settingsTab: 'secrets' },
  { id: 'doctor-1', feature: 'doctor', text: '运行主机诊断，确认失败项排前、Key 已脱敏、可复制修复步骤。', settingsTab: 'hosts' },
  { id: 'doctor-2', feature: 'doctor', text: '确认 Node/磁盘/账号/git/ADB/MCP/Hooks 各有一项检查结果；没装 adb 时 ADB 项给出安装或设置路径的修复命令。', settingsTab: 'hosts' },
  { id: 'mcp-1', feature: 'mcp', text: '添加 MCP 服务器，确认连接状态与暴露的工具名。', settingsTab: 'mcp' },
  { id: 'mcp-2', feature: 'mcp', text: '断开 MCP 后确认工具从会话中消失且不影响其他工具。', settingsTab: 'mcp' },
  { id: 'skills-1', feature: 'skills', text: '启用/禁用 Skill，确认系统提示与可用命令变化。', settingsTab: 'subagents' },
  { id: 'skills-2', feature: 'skills', text: '新增子代理预设，确认卡片与 Task 可选用。', settingsTab: 'prompts' },
  { id: 'prompts-1', feature: 'prompts', text: '修改四档委派或 Task 说明模板，确认系统提示注入变化。', settingsTab: 'prompts' },
  { id: 'memory-1', feature: 'memory', text: '用 #记住 写入项目记忆，确认后续会话可读到且需审批。', settingsTab: 'memory' },
  { id: 'memory-2', feature: 'memory', text: '编辑/删除记忆，确认只影响对应项目。', settingsTab: 'memory' },
  { id: 'team-2', feature: 'team', text: '创建会话分享链接，确认只读访问与撤销。', settingsTab: 'shares' },
  { id: 'accounts-1', feature: 'accounts', text: '在「工作区与账号」登录账号中心，确认侧栏一次列出所有可访问的机器。', settingsTab: 'accounts' },
  { id: 'accounts-2', feature: 'accounts', text: '所有者给账号分配角色、主机范围与项目目录，成员登录后只看到授权内容。', settingsTab: 'accounts' },
  { id: 'accounts-3', feature: 'accounts', text: '生成一次性加入码让另一台主机加入，确认过期失效且可在本机退出工作区。', settingsTab: 'accounts' },
  { id: 'update-1', feature: 'update', text: '在关于页确认版本与更新状态文案（发现/下载完成/重启）。', settingsTab: 'general' },
  { id: 'update-2', feature: 'update', text: '配置内网更新源，确认发现新版本并可下载；留空不发起请求。', settingsTab: 'general' },
  { id: 'sync-1', feature: 'sync', text: '导出加密配置，换一个临时 Host 导入，确认账号与会话恢复。', settingsTab: 'sync' },
  { id: 'sync-2', feature: 'sync', text: '确认导出文件需要口令、错误口令无法解密。', settingsTab: 'sync' },
  { id: 'feedback-1', feature: 'feedback', text: '进入反馈模式圈选元素，确认自动带上功能标签与建议根因，并可手动修改。', action: 'feedback' },
  { id: 'feedback-2', feature: 'feedback', text: '导出反馈包，确认解包后按功能与按根因分别生成文件。', action: 'feedback' },
  { id: 'demo-checklist-1', feature: 'demo-checklist', text: '创建演示工作区，逐个打开场景，确认都标注「演示数据」。', demo: 'chat-tools' },
  { id: 'demo-checklist-2', feature: 'demo-checklist', text: '在体验清单点「有问题」进入反馈模式，确认自动带上功能标签。', demo: 'board' },
  { id: 'demo-checklist-3', feature: 'demo-checklist', text: '清除演示数据，确认会话、记忆、用量、看板与索引都不留痕迹。', action: 'clear-demo' },
]
