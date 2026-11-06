// 服务端内部类型：在协议类型之上补充持久化/运行时字段。
import type {
  Checkpoint,
  ContentBlock,
  ExternalSource,
  Message,
  PermissionDecision,
  PermissionRequest,
  ProviderKind,
  Session,
  SessionStatus,
  Todo,
  Usage,
} from '@tandem/protocol';

/** 持久化的账号分组：明文 key 只在本机，接口只回掩码。 */
export interface StoredProfileGroup {
  id: string;
  name: string;
  /** 该分组的协议；缺省继承账号 kind。同一 baseUrl 下可混用 Anthropic / OpenAI。 */
  kind?: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  defaultModel: string;
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
  /** 子代理会话：指向派发它的主会话。 */
  parentId?: string;
  /** worktree 会话：路径/分支/基准分支。 */
  worktree?: { path: string; branch: string; baseBranch: string };
  /** worktree 所属原仓库（仅内部使用，用于 merge/清理）。 */
  worktreeRepoRoot?: string;
  /** 从外部会话导入时记录来源；仅内部使用，不下发（协议 Session 无此字段）。 */
  importedFrom?: { source: ExternalSource; id: string };
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
  runSubagent?: (input: { description: string; prompt: string; subagentType?: string }) => Promise<ToolResult>;
  /** MCP 工具：把调用转发给对应服务器。 */
  callMcp?: (server: string, tool: string, input: unknown) => Promise<ToolResult>;
}

export type { ContentBlock, Message, Session, SessionStatus, Todo, Usage };
