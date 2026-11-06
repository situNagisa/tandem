import type {
  ContentBlock,
  ExternalSession,
  HostInfo,
  Message,
  PermissionRequest,
  Profile,
  SessionSummary,
  SlashCommand,
  Todo,
} from '@tandem/protocol'

/** 本地保存的一台 Host。id 由客户端生成，与 HostInfo.id 无关。 */
export interface HostConfig {
  id: string
  name: string
  url: string
  token: string
  addedAt: number
}

export type ConnectionState = 'connecting' | 'online' | 'offline'

/** 每个 Host 在前端的运行时状态（不持久化）。 */
export interface HostRuntime {
  status: ConnectionState
  info?: HostInfo
  profiles: Profile[]
  profilesLoaded: boolean
  profilesLoading: boolean
  sessions: SessionSummary[]
  sessionsLoaded: boolean
  sessionsLoading: boolean
  commands: SlashCommand[]
  commandsLoaded: boolean
  /** 本机已有的 Claude Code / Codex 会话（只读扫描结果）。 */
  externalSessions: ExternalSession[]
  externalLoaded: boolean
  externalLoading: boolean
  externalError?: string
  /** WS 断线原因 / REST 错误提示 */
  error?: string
  /** Token 被拒绝：需要用户去设置里修改 */
  authError?: string
}

export type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** 界面上的消息：多出本地乐观状态字段。 */
export interface UiMessage extends Message {
  local?: boolean
  queued?: boolean
}

export interface ActiveSession {
  hostId: string
  sessionId: string
  summary: SessionSummary | null
  messages: UiMessage[]
  pending: PermissionRequest[]
  todos: Todo[]
  loading: boolean
  error?: string
  running: boolean
  stopping: boolean
  streamingMessageId?: string
  /** 工具入参的流式 JSON 原文，key 为 `${messageId}:${index}` */
  liveToolInputs: Record<string, string>
  /** 已完成的工具结果，按 toolUseId 索引 */
  toolResults: Record<string, ToolResultBlock>
  turnError?: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

export type Theme = 'light' | 'dark' | 'system'
export type SettingsTab = 'profiles' | 'hosts' | 'permissions' | 'appearance' | 'sync'

export type AppRoute =
  | { kind: 'home' }
  | { kind: 'host'; hostId: string }
  | { kind: 'session'; hostId: string; sessionId: string }

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': '兼容接口',
  gemini: 'Google Gemini',
}

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '默认权限',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  bypassPermissions: '跳过权限检查',
}
