// 服务端内部类型：在协议类型之上补充持久化/运行时字段。
import type { HostEnv } from './host-env.js';
import type {
  Checkpoint,
  ContentBlock,
  ExternalSource,
  Message,
  ModelCapabilities,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProviderKind,
  RetryInfo,
  TurnRouteOverride,
  Session,
  SessionStatus,
  Todo,
  Usage,
} from '@tandem/protocol';

/** 持久化的分组 Key：明文只在本机 profiles.json，接口只回掩码与运行状态。 */
export interface StoredProfileKey {
  id: string;
  label?: string;
  apiKey: string;
  /** 401/403 后自动置位，需用户手动重新启用。 */
  disabled?: boolean;
  /** 冷却截止（epoch ms）。 */
  cooldownUntil?: number;
  /** 连续冷却失败次数，用于 60s→30min 指数退避；成功后清零。 */
  failures?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** provider 响应头返回的剩余额度/重置时间，用于配额预估。 */
  quota?: import('@tandem/protocol').KeyQuota;
  /** 累计 429 次数（成功请求不清零）。 */
  rateLimitHits?: number;
  /** 主机镜像：工作站只回掩码，主机不保存明文（apiKey 为空）。 */
  masked?: string;
}

/** 持久化的账号分组：明文 key 只在本机，接口只回掩码。 */
export interface StoredProfileGroup {
  id: string;
  name: string;
  /** 该分组的协议；缺省继承账号 kind。同一 baseUrl 下可混用 Anthropic / OpenAI。 */
  kind?: ProviderKind;
  /** 兼容旧数据：等同于 keys[0].apiKey（分组没有 Key 时回落到账号 key）。 */
  apiKey: string;
  keys?: StoredProfileKey[];
  keyStrategy?: import('@tandem/protocol').KeyStrategy;
  baseUrl?: string;
  models: string[];
  defaultModel: string;
  /** 价格倍率：官方参考价 × 账号倍率 × 分组倍率；缺省 1。 */
  multiplier?: number;
  modelCapabilities?: Record<string, ModelCapabilities>;
  /** 备用分组链（同一账号内，按顺序）。 */
  fallbackGroupIds?: string[];
}

/** 持久化的账号：apiKey 只存在本机 profiles.json 中，永不下发。 */
export interface StoredProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  /** 价格倍率：官方参考价 × 账号倍率 × 分组倍率；默认 1。 */
  multiplier?: number;
  /** effectiveProfile 合并分组后的分组倍率（仅服务端运行时使用，不落盘）。 */
  groupMultiplier?: number;
  /** 每百万 token 美元，覆盖内置参考单价（按模型名精确或前缀匹配）；覆盖后不再乘倍率。 */
  price?: Record<string, { input: number; output: number }>;
  modelCapabilities?: Record<string, ModelCapabilities>;
  groups?: StoredProfileGroup[];
  createdAt: number;
  /** 主机镜像：该账号属于哪个工作站账号（按账号隔离展示）。 */
  accountId?: string;
  /** 主机镜像：工作站回的账号级掩码（主机不保存明文）。 */
  apiKeyMasked?: string;
  /** 余额查询配置（工作站用 Key 查询，主机只看到配置与缓存结果）。 */
  balanceQuery?: import('@tandem/protocol').BalanceQueryConfig;
  balance?: import('@tandem/protocol').ProfileBalance;
  /** 主机镜像：请求经工作站代理，Key 不在本机。 */
  proxied?: boolean;
}

export interface HostConfig {
  hostId: string;
  token: string;
  idleTimeoutSec?: number;
  /** Host 重启后对未完成会话：自动继续（默认）/ 恢复为暂停等我确认。 */
  resumeOnRestart?: 'auto' | 'pause';
  /** 新会话默认分工（缺省 less）。 */
  defaultDelegation?: import('@tandem/protocol').DelegationStrategy;
  /** 本机语音转写（Whisper）配置。 */
  voice?: import('@tandem/protocol').VoiceSettings;
  /** 上下文自动压缩与旧工具输出裁剪。 */
  context?: import('@tandem/protocol').ContextSettings;
  /** 提交前 AI 评审的模型与拦截策略。 */
  aiReview?: import('@tandem/protocol').AiReviewSettings;
  /** 额度将尽时的默认交接策略。 */
  handoff?: import('@tandem/protocol').HandoffSettings;
  /** 自动模型路由：候选池与偏好。 */
  modelRouting?: import('@tandem/protocol').ModelRoutingSettings;
  /** 桌面端更新文件托管目录；空 = 关闭。 */
  updateShareDir?: string;
  /** 工作站设备设置（adb 路径、虚拟串口、是否接受其他 Host 的设备访问）。 */
  devices?: import('@tandem/protocol').DeviceSettings;
}

/** 会话记录：协议 Session + 仅服务端使用的字段。 */
export interface SessionRecord extends Session {
  allowedTools: string[];
  /** 发起/主导该会话的工作站账号：模型请求按该账号的账号级模型账号代理（共享主机时用被授权人自己的 Key）。 */
  workspaceAccountId?: string;
  /** 子代理会话：指向派发它的会话。 */
  parentId?: string;
  /** 子代理会话：派发它的 Task 工具 tool_use id（会话图定位到具体轮次）。 */
  parentToolUseId?: string;
  /** 代理层级：0 主会话 / 1 子代理 / 2 孙代理… */
  depth?: number;
  /** worktree 会话：路径/分支/基准分支。 */
  worktree?: { path: string; branch: string; baseBranch: string };
  /** 子代理预设：附加系统提示（仅该子会话生效）。 */
  systemPromptExtra?: string;
  /** 子代理预设：工具白名单（非空时只暴露这些工具）。 */
  toolWhitelist?: string[];
  /** worktree 所属原仓库（仅内部使用，用于 merge/清理）。 */
  worktreeRepoRoot?: string;
  /** 从外部会话导入时记录来源；仅内部使用，不下发（协议 Session 无此字段）。 */
  importedFrom?: { source: ExternalSource; id: string };
  /** 最近一次请求的上下文占用（内存态，随 session_updated 下发）。 */
  context?: import('@tandem/protocol').ContextBreakdown;
  /** 未完成运行的恢复意图：Host 重启后据此续跑（落盘，不随接口下发）。 */
  runState?: RunState;
  /** Host 重启后按设置暂停，等待用户确认继续（随 SessionSummary 下发）。 */
  resumePaused?: boolean;
  /** 评测运行创建的内部会话：从会话列表隐藏，运行结束后删除。 */
  evalRun?: { runId: string; caseName: string; configId: string };
  /** Wiki 生成使用的只读内部会话：从会话列表隐藏，任务结束后删除。 */
  wikiRun?: { project: string; jobId: string };
  /** 评测配置临时覆盖的提示词（仅该会话生效，不写回 prompts.json）。 */
  promptOverrides?: Partial<Record<import('@tandem/protocol').PromptTemplateKey, string>>;
  /** 提交前 AI 评审累计用量（已计入 usage）。 */
  aiReviewUsage?: Usage;
  /** 任务看板卡片会话：卡片会话不进侧栏、不产生回合结束收件箱项。 */
  board?: { boardId: string; cardId: string };
  /** 额度将尽时的会话交接状态（持久化，随 SessionSummary 下发）。 */
  handoff?: import('@tandem/protocol').HandoffState;
  /** 自动模型路由的运行态：升级偏移、连续简单成功与失败标记（持久化，不下发）。 */
  routeState?: {
    tierBias: number;
    simpleSuccesses: number;
    toolFailStreak: number;
    lastFailed: boolean;
    lastTier?: import('@tandem/protocol').ModelTier;
    lastModel?: string;
    /** 失败后下一轮至少升到这一档（成功后清除）。 */
    escalateFloor?: number;
    lastTrigger?: 'failure' | 'simple-success';
    /** 上一轮实际花费，用于成本上限与展示。 */
    lastTurnCostUsd?: number;
  };
  /** 分工路由：子代理会话的角色（用于按角色统计）。 */
  routeRole?: import('@tandem/protocol').RouteRole;
  /** 最近一次分工分类结果与原文，用户改偏好时用于学习。 */
  lastRoutePlan?: { plan: import('@tandem/protocol').RoutePlan; text: string };
  /** 最近一次配额预估（运行态，随 summary/context 下发）。 */
  quota?: import('@tandem/protocol').QuotaEstimate;
  /** 演示工作区会话：不进入真实搜索索引/用量统计，清除演示数据时一并删除。 */
  demo?: boolean;
  /** 所属演示场景 id。 */
  demoScenario?: string;
}

/**
 * 运行意图：每完成一个模型响应/工具结果就通过 store.saveNow 原子落盘，
 * Host 崩溃或重启后据此继续，而不是从头再来。
 */
export interface RunState {
  version: 1;
  startedAt: number;
  updatedAt: number;
  /** 触发当前轮的用户消息 id。 */
  turnMessageId?: string;
  /** 已完整落盘的消息 id（assistant 完整响应 / tool_result 消息），用于诊断与断点判断。 */
  completedMessages: string[];
  /** 已排队、尚未执行的用户消息。 */
  queue: ContentBlock[][];
  /** 正在执行中的工具调用（Host 重启后据此判断哪些不能自动重放）。 */
  inFlightTools: Array<{ id: string; name: string; startedAt: number }>;
  /** 等待用户审批的请求；重启后恢复为待审批并重新广播。 */
  pendingPermissions: PermissionRequest[];
  /** 当前阶段的粗粒度标记。 */
  phase: 'model' | 'tools';
  permissionMode: PermissionMode;
  /** 本轮最后一条 assistant 消息 id。 */
  assistantMessageId?: string;
}

export interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision, reason?: string) => void;
}

/** 每个会话的内存运行时状态（不落盘）。 */
export interface SessionRuntime {
  running: boolean;
  interrupted: boolean;
  draining: boolean;
  abort?: AbortController;
  /** 运行中收到的用户消息，本轮结束后依次执行。 */
  queue: ContentBlock[][];
  pending: Map<string, PendingPermission>;
  deleted: boolean;
  /** 本轮检查点：Write/Edit 执行前把文件原内容快照进去。 */
  checkpoint?: Checkpoint;
  /** 本会话的 SessionStart hook 是否已执行。 */
  sessionStartDone?: boolean;
  /** UserPromptSubmit hook 的附加上下文，下一轮系统提示使用后清空。 */
  pendingHookContext?: string;
  /** 预算 block 下用户在会话内临时放行一次；下一次模型请求后清除。 */
  budgetAllowOnce?: boolean;
  /** 网络等待重试状态（随 SessionSummary.retryInfo 下发）。 */
  retryInfo?: RetryInfo;
  /** 「立即重试」时提前唤醒退避等待。 */
  retryWake?: () => void;
  /** 当前轮的触发消息 id，用于写 runState。 */
  turnMessageId?: string;
  /** 分工路由：本轮累计花费（主会话 + 子代理）。 */
  turnCostUsd?: number;
  /** 本轮已触发成本上限。 */
  costCapHit?: boolean;
  /** 本轮分工计划已确认，不再重复弹卡。 */
  divisionConfirmed?: boolean;
  /** 发送时附带的一次性分工/取向覆盖，只在本轮生效，结束后清空。 */
  turnRoute?: TurnRouteOverride;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 只读工具在 default 模式下无需审批，plan 模式下允许。 */
  readOnly: boolean;
  /** default 模式下是否需要用户审批。 */
  requiresApproval: boolean;
  /** MCP 工具来源（用于把调用路由到对应服务器）。 */
  mcp?: { server: string; tool: string };
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** 可选的附加图片块（如 Read 图片），会跟在 tool_result 后面进入用户消息。 */
  images?: ContentBlock[];
  /** Task 子代理：创建的子会话与模型（用于「换模型重跑」）。 */
  subagent?: { id: string; model: string };
}

export interface ToolContext {
  cwd: string;
  session: SessionRecord;
  signal: AbortSignal;
  /** 项目所在机器的访问接口：工具读写文件、遍历目录、执行命令都经它。 */
  env: HostEnv;
  updateTodos: (todos: Todo[]) => void;
  setUsage?: (usage: Usage) => void;
  /** Task 工具：在当前会话下创建子代理会话并执行完整 agent 循环。 */
  runSubagent?: (input: {
    description: string;
    prompt: string;
    subagentType?: string;
    model?: string;
    role?: import('@tandem/protocol').RouteRole;
    domain?: import('@tandem/protocol').RouteDomain;
    /** 派发它的 Task 工具 tool_use id（会话图定位用）。 */
    toolUseId?: string;
  }) => Promise<ToolResult>;
  /** MCP 工具：把调用转发给对应服务器。 */
  callMcp?: (server: string, tool: string, input: unknown) => Promise<ToolResult>;
  /** Skill 工具：按名称取已启用技能的正文与目录。 */
  getSkill?: (name: string) => { info: import('@tandem/protocol').SkillInfo; body: string } | undefined;
  /** ProposeCards 工具：仅看板卡片会话有值，把提议落成待办草稿（或按看板设置自动排队）。 */
  proposeCards?: (input: unknown) => Promise<ToolResult>;
  /** Tandem home（记忆/配置根目录）。 */
  home?: string;
  /** 项目记忆存储；Memory 工具直接读写它。 */
  memory?: import('./memory.js').MemoryStore;
  /** 项目 Wiki 存储/检索；WikiSearch / WikiRead 工具使用。 */
  wiki?: import('./wiki.js').WikiManager;
  /** 后台 Bash 任务管理器；Bash / BashOutput / KillBash 使用。 */
  backgroundTasks?: import('./tasks.js').BackgroundTaskManager;
  /** 浏览器操作管理器；browser_* 工具使用。 */
  browser?: import('./browser.js').BrowserManager;
  /** 工作站设备管理器；DeviceList、AdbShell/AdbInstall/AdbLogcat、SerialOpen/Read/Write 使用。 */
  devices?: import('./devices/manager.js').DeviceManager;
  /** 本项目/全局 secrets 注入的 bash 环境变量。 */
  secretEnv?: Record<string, string>;
  /** 写类工具改写文件前调用：把原内容（不存在时为 undefined）交给当前轮的检查点。 */
  snapshot?: (absPath: string, before: Buffer | undefined) => void;
  /** 工具输出进入会话前打码（匹配本机 secrets 值及常见 Key 形态）。 */
  redact?: (text: string) => string;
}

export type { ContentBlock, Message, Session, SessionStatus, Todo, Usage };
