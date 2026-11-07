import type {
  ContentBlock,
  CreateSessionInput,
  ExternalSource,
  InboxEvent,
  PermissionDecision,
  PermissionMode,
  RewindInput,
  SessionSummary,
  SlashCommand,
  UpdateSessionInput,
} from '@tandem/protocol'
import type { ExternalImportInput } from '../../lib/api'
import type { ClientSettingsBundle } from '../../lib/storage'
import type {
  ActiveSession,
  ExternalSessionItem,
  HostConfig,
  HostRuntime,
} from '../../lib/types'

/** 单台 Host 的收件箱状态（跨会话事件流 + 未处理审批）。 */
export interface HostInboxState {
  seq: number
  events: InboxEvent[]
  pending: InboxEvent[]
  /** 未查看的提醒数（打开收件箱后清零）。 */
  unread: number
}

export interface AppState {
  initialized: boolean
  hosts: HostConfig[]
  activeHostId: string | null
  runtimes: Record<string, HostRuntime>
  /** 各 Host 的全局收件箱；不持久化，重连时由服务端快照补齐。 */
  inbox: Record<string, HostInboxState>
  /** 外部会话按 hostId 汇总（元素带 hostId，方便侧栏合并展示）。 */
  externalSessions: Record<string, ExternalSessionItem[]>
  active: ActiveSession | null
  /** 回合结束后自增，改动审阅据此刷新。 */
  changesNonce: number
  /** 已打开但尚未创建的 worktree 意图，键为 `${hostId}:${sessionId}`；发送下一条消息前创建。 */
  worktreeIntents: Record<string, boolean>

  initialize: () => void
  checkConnections: () => void
  goOffline: () => void
  bumpChanges: () => void
  /** 打开文件浏览器（预览面板左侧树）；path 给定时同时预览该文件。 */
  openFileBrowser: (path?: string) => void
  addHost: (input: {
    name: string
    url: string
    token: string
    mode?: HostConfig['mode']
    relayUrl?: string
    hostId?: string
    fingerprint?: string
  }) => HostConfig
  updateHost: (
    id: string,
    patch: Partial<
      Pick<HostConfig, 'name' | 'url' | 'token' | 'mode' | 'relayUrl' | 'hostId' | 'fingerprint'>
    >,
  ) => void
  removeHost: (id: string) => void
  activateHost: (id: string) => void
  retryHost: (id: string) => void
  refreshSessions: (hostId: string) => Promise<void>
  refreshProfiles: (hostId: string) => Promise<void>
  refreshCommands: (hostId: string) => Promise<SlashCommand[]>
  refreshExternalSessions: (hostId: string, force?: boolean) => Promise<ExternalSessionItem[]>
  importExternalSession: (
    hostId: string,
    source: ExternalSource,
    id: string,
    input?: ExternalImportInput,
  ) => Promise<SessionSummary | null>
  /** 应用配置迁移带回的客户端设置（Host 列表 / 主题 / 侧栏偏好）。 */
  applyClientSettings: (settings: ClientSettingsBundle, mode: 'merge' | 'replace') => void

  openSession: (hostId: string, sessionId: string) => void
  closeSession: () => void
  reloadActiveSession: () => void
  clearTurnError: () => void
  send: (blocks: ContentBlock[]) => boolean
  interrupt: () => void
  /** 网络中断等待重试期间立即重试。 */
  retryNow: () => void
  /** 恢复 Host 重启后暂停的会话。 */
  resumePaused: () => Promise<void>
  decidePermission: (requestId: string, decision: PermissionDecision, reason?: string) => void
  /** 收件箱里直接审批（不要求该会话已打开）。 */
  decideInboxPermission: (
    hostId: string,
    requestId: string,
    decision: PermissionDecision,
    reason?: string,
  ) => void
  /** 打开收件箱后清掉未读徽标。 */
  markInboxSeen: () => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  rewind: (input: RewindInput, seedText?: string) => Promise<boolean>
  setModel: (profileId: string, groupId: string | undefined, model: string) => Promise<void>
  createSession: (hostId: string, input: CreateSessionInput) => Promise<SessionSummary>
  startSession: (hostId: string, input: CreateSessionInput, content: ContentBlock[]) => Promise<SessionSummary>
  /** 向任意 Host 派单：创建会话并发送，不切换当前打开的会话。 */
  dispatchSession: (
    hostId: string,
    input: CreateSessionInput,
    content: ContentBlock[],
  ) => Promise<{ summary: SessionSummary; sent: boolean }>
  updateSession: (
    hostId: string,
    sessionId: string,
    patch: UpdateSessionInput,
  ) => Promise<SessionSummary | null>
  /** 标记已读并同步到 Host（多端共享未读状态）。 */
  markSessionRead: (hostId: string, sessionId: string) => Promise<void>
  forkSession: (hostId: string, sessionId: string, messageId?: string) => Promise<SessionSummary | null>
  deleteSession: (hostId: string, sessionId: string, force?: boolean) => Promise<void>
  /** 单独停止一个 Task 子代理会话。 */
  interruptSubagent: (childId: string) => void
  /** 把 worktree 分支合回基准分支。 */
  mergeWorktree: (hostId: string, sessionId: string, strategy: 'merge' | 'squash') => Promise<boolean>
  /** 只记录 worktree 意图，不立即创建。 */
  setWorktreeIntent: (hostId: string, sessionId: string, on: boolean) => void
  /** 发送消息前创建待处理的 worktree；无需创建时直接返回 true。 */
  ensureWorktree: (hostId: string, sessionId: string) => Promise<boolean>
}
