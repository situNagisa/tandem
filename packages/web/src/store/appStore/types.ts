import type {
  AccountLoginResult,
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
  SessionTarget,
  AccountSession,
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
  /** 工作区账号会话；未登录为 null（单机模式照旧）。 */
  account: AccountSession | null
  runtimes: Record<string, HostRuntime>
  /** 各 Host 的全局收件箱；不持久化，重连时由服务端快照补齐。 */
  inbox: Record<string, HostInboxState>
  /** 外部会话按 hostId 汇总（元素带 hostId，方便侧栏合并展示）。 */
  externalSessions: Record<string, ExternalSessionItem[]>
  /** 当前聚焦/主会话；分屏时等于 sessionViews 里被聚焦的那个对象。 */
  active: ActiveSession | null
  /** 所有已打开会话的完整视图（分屏窗格），键为 `${hostId}:${sessionId}`。 */
  sessionViews: Record<string, ActiveSession>
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
      Pick<
        HostConfig,
        'name' | 'url' | 'token' | 'mode' | 'relayUrl' | 'hostId' | 'fingerprint'
      >
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
  /** 账号中心登录：保存会话并把可访问 Host 自动加入列表。 */
  workspaceLogin: (input: { centerUrl: string; username: string; password: string; totp?: string }) => Promise<void>
  /** 工作站注册：成功后与登录一样保存会话并加入主机。 */
  workspaceRegister: (input: {
    workstationUrl: string
    username: string
    password: string
    inviteCode?: string
  }) => Promise<void>
  /** 工作站 setup 返回的结果直接落地（首次创建管理员）。 */
  applyWorkstationLogin: (workstationUrl: string, result: AccountLoginResult) => void
  /** 从工作站重新拉取「我的主机」：授权/撤销后刷新列表。 */
  syncWorkstationHosts: () => Promise<void>
  /** 退出工作区账号：作废刷新令牌并移除账号添加的 Host。 */
  workspaceLogout: () => Promise<void>
  /** 刷新访问令牌并同步到所有账号 Host。 */
  refreshWorkspace: () => Promise<boolean>

  openSession: (hostId: string, sessionId: string) => void
  /** 后台打开一个分屏会话视图，不切换焦点。 */
  openSessionView: (hostId: string, sessionId: string) => void
  /** 切换会话时目标首屏未就绪则暂留当前画面；目标就绪后由 store 订阅调用，force 为超时兜底。 */
  commitPendingFocus: (force?: boolean) => void
  /** 关闭一个会话视图（不改变路由）。 */
  closeSessionView: (hostId: string, sessionId: string) => void
  /** 聚焦一个已打开的会话视图（若尚未打开则先打开）。 */
  focusSessionView: (hostId: string, sessionId: string) => void
  closeSession: () => void
  reloadActiveSession: (target?: SessionTarget) => void
  clearTurnError: (target?: SessionTarget) => void
  send: (blocks: ContentBlock[], target?: SessionTarget, routeMode?: import('@tandem/protocol').TurnRouteMode) => boolean
  interrupt: (target?: SessionTarget) => void
  /** 网络中断等待重试期间立即重试。 */
  retryNow: (target?: SessionTarget) => void
  /** 恢复 Host 重启后暂停的会话。 */
  resumePaused: (target?: SessionTarget) => Promise<void>
  decidePermission: (
    requestId: string,
    decision: PermissionDecision,
    reason?: string,
    target?: SessionTarget,
  ) => void
  /** 收件箱里直接审批（不要求该会话已打开）。 */
  decideInboxPermission: (
    hostId: string,
    requestId: string,
    decision: PermissionDecision,
    reason?: string,
  ) => void
  /** 打开收件箱后清掉未读徽标。 */
  markInboxSeen: () => void
  setPermissionMode: (mode: PermissionMode, target?: SessionTarget) => Promise<void>
  rewind: (input: RewindInput, seedText?: string) => Promise<boolean>
  /** 撤销最近一次手动压缩：恢复压缩前的上下文。 */
  undoCompaction: (noticeId: string, target?: SessionTarget) => Promise<boolean>
  setModel: (
    profileId: string,
    groupId: string | undefined,
    model: string,
    target?: SessionTarget,
  ) => Promise<void>
  createSession: (hostId: string, input: CreateSessionInput) => Promise<SessionSummary>
  startSession: (hostId: string, input: CreateSessionInput, content: ContentBlock[]) => Promise<SessionSummary>
  updateSession: (
    hostId: string,
    sessionId: string,
    patch: UpdateSessionInput,
  ) => Promise<SessionSummary | null>
  /** 标记已读并同步到 Host（多端共享未读状态）。 */
  markSessionRead: (hostId: string, sessionId: string) => Promise<void>
  /** 额度将尽：选择切换备用分组 / 等待重置 / 暂停。 */
  handoffSession: (
    hostId: string,
    sessionId: string,
    action: 'switch' | 'wait' | 'pause',
  ) => Promise<void>
  forkSession: (hostId: string, sessionId: string, messageId?: string) => Promise<SessionSummary | null>
  deleteSession: (hostId: string, sessionId: string, force?: boolean) => Promise<void>
  /** 滚到顶时向前加载一页更早的消息（保持滚动位置由消息列表处理）。 */
  loadEarlierMessages: (target?: SessionTarget) => Promise<boolean>
  /** 会话被截断时拉取服务端轮次大纲（轮号/消息 id/前 80 字）。 */
  loadSessionTurns: (hostId: string, sessionId: string) => Promise<void>
  /** 大纲/搜索跳转：确保目标消息所在的一段已加载。 */
  ensureMessageLoaded: (hostId: string, sessionId: string, messageId: string) => Promise<boolean>
  /** 补齐分页缺口（继续加载缺口下方的一页）。 */
  fillMessageGap: (hostId: string, sessionId: string, gapId: string) => Promise<boolean>
  /** 占位条按轮次范围加载（加载前 N 轮 / 全部）：逐轮取回缺失的段。 */
  loadTurnRange: (hostId: string, sessionId: string, messageIds: string[]) => Promise<boolean>
  /** 单独停止一个 Task 子代理会话。 */
  interruptSubagent: (childId: string, target?: SessionTarget) => void
  /** 把 worktree 分支合回基准分支。 */
  mergeWorktree: (hostId: string, sessionId: string, strategy: 'merge' | 'squash') => Promise<boolean>
  /** 只记录 worktree 意图，不立即创建。 */
  setWorktreeIntent: (hostId: string, sessionId: string, on: boolean) => void
  /** 发送消息前创建待处理的 worktree；无需创建时直接返回 true。 */
  ensureWorktree: (hostId: string, sessionId: string) => Promise<boolean>
}
