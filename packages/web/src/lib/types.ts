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
  SessionTurnMark,
  SlashCommand,
  TeamIdentity,
  TeamPresence,
  Todo,
  WorkspaceAccount,
  WorkspaceInfo,
} from '@tandem/protocol'

/** 直连：url + token；中继：经 relay 的端到端加密通道（fingerprint 必须是配对时带过来的）。 */
export type HostMode = 'direct' | 'relay' | 'ssh'

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
  /** SSH 一键接入：本机 Host 上记录的远程主机 id。 */
  sshHostId?: string
  /** 管理这台 SSH 主机的本机 Host（客户端 HostConfig.id）。 */
  sshControllerId?: string
  /** 展示用 user@host:port。 */
  sshTarget?: string
  /** 工作区账号登录添加的主机：账号 id（退出登录时移除这些主机）。 */
  accountId?: string
  /** 工作区账号展示名。 */
  accountName?: string
}

/** 工作区账号会话（只在客户端 localStorage；令牌由账号中心签发）。 */
export interface AccountSession {
  centerUrl: string
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
  account: WorkspaceAccount
  workspace: WorkspaceInfo
}

export type ConnectionState = 'connecting' | 'online' | 'offline'

/** 外部会话的客户端视图：附带所属 Host，便于侧栏与路由直接使用。 */
export interface ExternalSessionItem extends ExternalSession {
  hostId: string
}

/** 每个 Host 在前端的运行时状态（不持久化）。 */
export interface HostRuntime {
  status: ConnectionState
  /** WS ping/pong 往返延迟（毫秒）。 */
  latencyMs?: number
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

/** 分页产生的消息缺口：两侧消息已加载，中间还有未加载的历史。 */
export interface MessageGap {
  /** 缺口上方最后一条已加载消息 id；顶部分页时为 undefined。 */
  afterId?: string
  /** 缺口下方第一条已加载消息 id（向前加载的锚点）。 */
  beforeId: string
  /** 占位条展示的轮次范围（由服务端轮次大纲换算，含两端）。 */
  fromTurn?: number
  toTurn?: number
  /** true：消息已在内存里、只是超出挂载窗口（点「显示」扩大/移动窗口）。 */
  unmounted?: boolean
}

/** 界面上的消息：多出本地乐观状态字段。 */
export interface UiMessage extends Message {
  local?: boolean
  queued?: boolean
  /** 分页缺口占位（不是真实消息，不参与工具结果与轮次统计）。 */
  gap?: MessageGap
}

export type SessionFilterStatus =
  | 'all'
  | 'running'
  | 'waiting_permission'
  | 'error'
  | 'unread'

/** 侧栏会话筛选：状态 / 主机 / 项目 / 来源可自由组合。 */
export interface SessionFilter {
  status: SessionFilterStatus
  hostId: string
  project: string
  source: 'all' | 'tandem' | 'claude-code' | 'codex'
}

export const DEFAULT_SESSION_FILTER: SessionFilter = {
  status: 'all',
  hostId: 'all',
  project: 'all',
  source: 'all',
}

export function isSessionFilterActive(filter: SessionFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.hostId !== 'all' ||
    filter.project !== 'all' ||
    filter.source !== 'all'
  )
}


/** 指向一个已打开会话的定位符：分屏窗格、会话作用域与带目标的 store action 共用。 */
export interface SessionTarget {
  hostId: string
  sessionId: string
}

export type SplitLayout = 'cols2' | 'cols3' | 'grid2x2' | 'rows2'

export interface SplitPane {
  hostId: string
  sessionId: string
}

export interface SplitState {
  panes: SplitPane[]
  layout: SplitLayout
  /** 各列宽度权重，和为 1。 */
  cols: number[]
  /** 2×2 / 上下分屏的行高权重。 */
  rows: number[]
}

export interface ActiveSession {
  hostId: string
  sessionId: string
  summary: SessionSummary | null
  messages: UiMessage[]
  pending: PermissionRequest[]
  /** 已处理的审批（客户端本地记录）：在对话流里留一行结果。 */
  permissionTrail?: PermissionTrailEntry[]
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
  /** 服务端分页：会话消息总数。 */
  totalMessages?: number
  /** 已加载窗口的第一条真实消息 id（向前翻页锚点）。 */
  firstMessageId?: string
  /** 还有更早的消息未加载。 */
  hasEarlier: boolean
  /** 正在向前加载一页。 */
  loadingEarlier?: boolean
  /** 正在按需加载某段历史（大纲/搜索跳转）。 */
  loadingSegment?: boolean
  /** 服务端轮次大纲（会话被截断时拉取，避免本地缺前段）。 */
  turns?: SessionTurnMark[]
  loadingTurns?: boolean
}

/** 客户端补充锚点：错误提示内联在产生它的消息之后。 */
export interface HookNotice extends HookEventNotice {
  messageId?: string
}

/** 审批处理结果：会话内联留痕，按 toolUseId 放回触发它的工具调用之后。 */
export interface PermissionTrailEntry {
  id: string
  toolUseId: string
  /** 标题里的目标（命令首行或路径），用于「已允许 · xxx」。 */
  label: string
  decision: 'allow' | 'allow_always' | 'deny'
  at: number
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
export type SettingsTab = 'general' | 'profiles' | 'hosts' | 'team' | 'gateway' | 'permissions' | 'hooks' | 'mcp' | 'skills' | 'schedules' | 'budgets' | 'usage' | 'appearance' | 'sync' | 'memory' | 'subagents' | 'prompts' | 'shares' | 'voice' | 'notifications' | 'browser' | 'evals' | 'secrets' | 'routing'
  | 'accounts'

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
