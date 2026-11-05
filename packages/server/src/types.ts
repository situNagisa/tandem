// 服务端内部类型：在协议类型之上补充持久化/运行时字段。
import type {
  ContentBlock,
  Message,
  PermissionDecision,
  PermissionRequest,
  ProviderKind,
  Session,
  SessionStatus,
  Todo,
  Usage,
} from '@tandem/protocol';

/** 持久化的账号：apiKey 只存在本机 profiles.json 中，永不下发。 */
export interface StoredProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  createdAt: number;
}

export interface HostConfig {
  hostId: string;
  token: string;
}

/** 会话记录：协议 Session + 仅服务端使用的权限白名单。 */
export interface SessionRecord extends Session {
  allowedTools: string[];
}

export interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
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
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 只读工具在 default 模式下无需审批，plan 模式下允许。 */
  readOnly: boolean;
  /** default 模式下是否需要用户审批。 */
  requiresApproval: boolean;
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
}

export type { ContentBlock, Message, Session, SessionStatus, Todo, Usage };
