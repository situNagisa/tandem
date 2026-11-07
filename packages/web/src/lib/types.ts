import type {
  ContentBlock,
  ExternalSession,
  ExternalSource,
  HookEventNotice,
  HostInfo,
  InjectionSnapshot,
  Message,
  PermissionRequest,
  Profile,
  SessionPlan,
  SessionSummary,
  SlashCommand,
  TeamIdentity,
  TeamPresence,
  Todo,
} from '@tandem/protocol'

/** 直连：url + token；中继：经 relay 的端到端加密通道（fingerprint 必须是配对时带过来的）。 */
export type HostMode = 'direct' | 'relay'

/** 本地保存的一台 Host。id 由客户端生成，与 HostInfo.id 无关。 */
export interface HostConfig {
  id: string
  name: string
  url: string
  token: string
  addedAt: number
  /** 缺省视为 direct，兼容旧数据。 */
  mode?: HostMode
  /** 中继根地址，如 https://relay.example.com */
  relayUrl?: string
  /** 中继上的 Host ID。 */
  hostId?: string
  /** Host Ed25519 公钥的 SHA-256，64 位十六进制。 */
  fingerprint?: string
}

export type ConnectionState = 'connecting' | 'online' | 'offline'

/** 外部会话的客户端视图：附带所属 Host，便于侧栏与路由直接使用。 */
export interface ExternalSessionItem extends ExternalSession {
  hostId: string
}

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
  /** 已加载命令时对应的 cwd：切换会话后需要重新拉取项目技能/命令。 */
  commandsCwd?: string
  /** 本机已有的 Claude Code / Codex 会话（只读扫描结果）。 */
  externalSessions: ExternalSessionItem[]
  externalLoaded: boolean
  externalLoading: boolean
  externalError?: string
  /** WS 断线原因 / REST 错误提示 */
  error?: string
  /** Token 被拒绝：需要用户去设置里修改 */
  authError?: string
  /** 当前连接身份（hello 下发，缺省视为所有者以兼容旧 Host）。 */
  team?: TeamIdentity
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
  /** 当前计划（计划模式提交后保存，右侧信息栏可回看）。 */
  plan?: SessionPlan
  /** Hook 执行记录；界面只展示阻止/出错的条目。 */
  hookEvents: HookNotice[]
  /** 本轮系统提示的注入段落清单（会话开头可展开查看）。 */
  injections?: InjectionSnapshot
  /** Task 子代理会话（parentId 指向当前会话），按子会话 id 索引。 */
  subagents: Record<string, SubagentSession>
  /** 正在查看该会话的连接（含所有者，界面排除自己）。 */
  viewers: TeamPresence[]
}

/** 客户端补充锚点：错误提示内联在产生它的消息之后。 */
export interface HookNotice extends HookEventNotice {
  messageId?: string
}

/** 主会话内嵌查看的 Task 子代理状态。 */
export interface SubagentSession {
  summary: SessionSummary | null
  messages: UiMessage[]
  pending: PermissionRequest[]
  loading: boolean
  running: boolean
  streamingMessageId?: string
  liveToolInputs: Record<string, string>
  toolResults: Record<string, ToolResultBlock>
  error?: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  /** 点击提示时执行（如跳到出错的会话）。 */
  onClick?: () => void
  /** 提示右侧的操作按钮文案（如「查看」）。 */
  actionLabel?: string
}

export type Theme = 'light' | 'dark' | 'system'
export type SettingsTab = 'general' | 'profiles' | 'hosts' | 'team' | 'gateway' | 'permissions' | 'hooks' | 'mcp' | 'skills' | 'schedules' | 'budgets' | 'usage' | 'appearance' | 'sync' | 'memory' | 'subagents' | 'prompts' | 'shares' | 'voice' | 'notifications' | 'browser' | 'evals' | 'secrets'

export type AppRoute =
  | { kind: 'home' }
  | { kind: 'host'; hostId: string }
  | { kind: 'session'; hostId: string; sessionId: string }
  | { kind: 'external'; hostId: string; source: ExternalSource; id: string }
  | { kind: 'dev-ui' }

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': '兼容接口',
  gemini: 'Google Gemini',
  'tandem-gateway': 'Tandem 网关',
}

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '默认权限',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  bypassPermissions: '跳过权限检查',
}
