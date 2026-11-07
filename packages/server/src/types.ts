// 服务端内部类型：在协议类型之上补充持久化/运行时字段。
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
  modelCapabilities?: Record<string, ModelCapabilities>;
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
  /** 每百万 token 美元，覆盖内置参考单价（按模型名精确或前缀匹配）。 */
  price?: Record<string, { input: number; output: number }>;
  modelCapabilities?: Record<string, ModelCapabilities>;
  groups?: StoredProfileGroup[];
  createdAt: number;
}

/** 中继配置：Host 主动向 relay 建立出站隧道；hostKey 是 Ed25519 种子（base64url），首次启用时自动生成。 */
export interface RelayConfig {
  url: string;
  hostKey?: string;
  /** 仅接受端到端加密连接，拒绝 relay 透传的明文请求。 */
  requireE2E?: boolean;
}

export interface HostConfig {
  hostId: string;
  token: string;
  idleTimeoutSec?: number;
  relay?: RelayConfig;
}

/** 会话记录：协议 Session + 仅服务端使用的字段。 */
export interface SessionRecord extends Session {
  allowedTools: string[];
  /** 子代理会话：指向派发它的会话。 */
  parentId?: string;
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
}

export interface ToolContext {
  cwd: string;
  session: SessionRecord;
  signal: AbortSignal;
  updateTodos: (todos: Todo[]) => void;
  setUsage?: (usage: Usage) => void;
  /** Task 工具：在当前会话下创建子代理会话并执行完整 agent 循环。 */
  runSubagent?: (input: { description: string; prompt: string; subagentType?: string; model?: string }) => Promise<ToolResult>;
  /** MCP 工具：把调用转发给对应服务器。 */
  callMcp?: (server: string, tool: string, input: unknown) => Promise<ToolResult>;
  /** Skill 工具：按名称取已启用技能的正文与目录。 */
  getSkill?: (name: string) => { info: import('@tandem/protocol').SkillInfo; body: string } | undefined;
  /** Tandem home（记忆/配置根目录）。 */
  home?: string;
  /** 项目记忆存储；Memory 工具直接读写它。 */
  memory?: import('./memory.js').MemoryStore;
}

export type { ContentBlock, Message, Session, SessionStatus, Todo, Usage };
