import type {
  AiReviewRun,
  Board,
  BoardCard,
  BoardCardAction,
  BoardCardCheck,
  BoardCardDiff,
  BoardCardInput,
  BoardInput,
  BoardMergePreview,
  BoardPlanDraft,
  BoardPrInput,
  BoardPrResult,
  BoardPrState,
  BoardSummary,
  ChangesResult,
  Checkpoint,
  ConfigBundle,
  ConfigExportInput,
  ContentBlock,
  ContextBreakdown,
  ConfigImportInput,
  ConfigImportResult,
  CreateSessionInput,
  CreateShareInput,
  CreateShareResult,
  PublicShare,
  ShareInfo,
  MemoryFile,
  MemoryListItem,
  MemoryScope,
  Message,
  MessagePage,
  CreatePrInput,
  DiffEmptyReason,
  DemoState,
  SerialOpenResult,
  SerialReadResult,
  SessionDevices,
  DeviceListResult,
  DeviceAccess,
  DeviceLogcatRead,
  DeviceLogcatStart,
  DeviceMount,
  DeviceMountInput,
  DevicePeerToken,
  DevicePeerTokenIssued,
  DoctorReport,
  EvalCase,
  EvalRun,
  EvalRunSummary,
  ExternalSession,
  ExternalSource,
  FsEntry,
  FsGitResult,
  GatewayOverview,
  GatewaySettings,
  GatewayToken,
  GatewayTokenInput,
  GatewayTokenIssued,
  GatewayTokenUpdateInput,
  FsReadResult,
  FsRevealResult,
  HookEntry,
  HookSettings,
  HostInfo,
  HostSettings,
  InjectionSnapshot,
  ListModelsInput,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  ModelPriceInfo,
  PermissionInsights,
  PermissionRule,
  SandboxStatus,
  PermissionRuleDraft,
  PermissionRequest,
  PrActionResult,
  RemoteSshHost,
  SshHostInput,
  SshHostKeyInfo,
  SshJob,
  SshProbeResult,
  SshTarget,
  PrMergeMethod,
  Profile,
  PromptTemplate,
  PromptTemplateKey,
  ProfileInput,
  BackgroundTask,
  BackgroundTaskOutput,
  BrowserSettings,
  BrowserState,
  BrowserStatus,
  PreviewCandidate,
  PreviewMount,
  PreviewSelection,
  PreviewSnapshot,
  PreviewState,
  BudgetRule,
  BudgetStatus,
  RewindInput,
  SttCapabilities,
  SttInput,
  SttResult,
  SttTestResult,
  SaveEvalCaseInput,
  Schedule,
  ScheduleInput,
  SearchFilters,
  SearchResponse,
  SecretInput,
  SecretMeta,
  SecretsOverview,
  SecretsSettings,
  Session,
  StartEvalRunInput,
  SessionSummary,
  SessionTurns,
  SkillInfo,
  SlashCommand,
  SubagentPreset,
  SubagentPresetInput,
  UpdateSessionInput,
  UsageStatsRow,
  VcsState,
  WikiEstimate,
  WikiEstimateInput,
  WikiGenerateInput,
  WikiJob,
  WikiMeta,
  WikiPage,
  WikiSearchResult,
  AcceptTeamInviteResult,
  CreateTeamInviteInput,
  CreateTeamInviteResult,
  TeamAuditEntry,
  TeamIdentity,
  AccountLoginInput,
  AccountLoginResult,
  AccountTokens,
  WorkspaceHostInfo,
  WorkspaceOverview,
  WorkspaceProfilesSnapshot,
  WorkspaceStatus,
  WorkspaceAuditEntry,
  WorkstationAccountSummary,
  WorkstationBindCode,
  WorkstationGrantInput,
  WorkstationHostClaimResult,
  WorkstationInvite,
  WorkstationPublicStatus,
  WorkstationRegisterInput,
  WorkstationSettingsInput,
  WorkstationSetupInput,
  TeamMember,
  TeamOverview,
  UpdateTeamMemberInput,
} from '@tandem/protocol'
import type { HostConfig } from './types'
import { requestBase } from './hostUrl'
import {
  RELAY_UNSUPPORTED_MESSAGE,
  detectRelayCryptoSupport,
  isRelayHost,
  relayChannel,
  relayErrorMessage,
} from './relay'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function describe(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as { error?: string; message?: string }
    const msg = data.error || data.message
    if (msg) return msg
  } catch {
    /* 非 JSON 错误体 */
  }
  if (status === 401 || status === 403) return 'Token 无效或没有权限'
  if (status === 404) return '接口不存在'
  return text.trim().slice(0, 300) || `请求失败（HTTP ${status}）`
}

/** 所有 REST 请求的出口：加密隧道 Host 走 E2E channel，直连照旧 fetch。 */
async function send(host: HostConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (host.token) headers.set('Authorization', `Bearer ${host.token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('Accept', 'application/json')

  if (isRelayHost(host)) {
    if (!(await detectRelayCryptoSupport())) throw new ApiError(RELAY_UNSUPPORTED_MESSAGE, 0)
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? init.body
          : undefined
    try {
      return await relayChannel(host).fetch(path, {
        method: init.method,
        headers,
        body,
        signal: init.signal ?? undefined,
      })
    } catch (err) {
      throw new ApiError(relayErrorMessage(err), 0)
    }
  }
  try {
    return await fetch(requestBase(host.url) + path, { ...init, headers })
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? `无法连接 Host：${err.message}` : '无法连接 Host',
      0,
    )
  }
}

async function request<T>(host: HostConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(host, path, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(describe(res.status, text), res.status)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('Host 返回了无法解析的数据', res.status)
  }
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, v)
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

type DemoApi = {
  demo: (h: HostConfig) => Promise<DemoState>
  createDemo: (h: HostConfig) => Promise<DemoState>
  clearDemo: (h: HostConfig) => Promise<{ ok: boolean }>
  replayDemo: (h: HostConfig, id: string) => Promise<DemoState>
  playDemo: (h: HostConfig, id: string) => Promise<{ ok: boolean }>
}

// 演示工作区 API 只编入调试版；发布版里为空对象，相关模块也不会被打包。
const demoApi = (__TANDEM_DEBUG__
  ? {
      demo: (h: HostConfig) => request<DemoState>(h, '/api/demo'),
      createDemo: (h: HostConfig) =>
        request<DemoState>(h, '/api/demo', { method: 'POST', body: JSON.stringify({}) }),
      clearDemo: (h: HostConfig) => request<{ ok: boolean }>(h, '/api/demo', { method: 'DELETE' }),
      replayDemo: (h: HostConfig, id: string) =>
        request<DemoState>(h, `/api/demo/scenarios/${encodeURIComponent(id)}/replay`, { method: 'POST' }),
      playDemo: (h: HostConfig, id: string) =>
        request<{ ok: boolean }>(h, `/api/demo/scenarios/${encodeURIComponent(id)}/play`, { method: 'POST' }),
    }
  : {}) as DemoApi

export const api = {
  host: (h: HostConfig) => request<HostInfo>(h, '/api/host'),

  devices: (h: HostConfig) => request<DeviceListResult>(h, '/api/devices'),
  deviceAccessCheck: (h: HostConfig, deviceId: string) =>
    request<DeviceAccess>(h, `/api/devices/${encodeURIComponent(deviceId)}/access-check`, {
      method: 'POST',
    }),
  devicePeerTokens: (h: HostConfig) => request<DevicePeerToken[]>(h, '/api/devices/peer-tokens'),
  issueDevicePeerToken: (h: HostConfig, label?: string) =>
    request<DevicePeerTokenIssued>(h, '/api/devices/peer-tokens', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  revokeDevicePeerToken: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/devices/peer-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sessionDevices: (h: HostConfig, sessionId: string) =>
    request<SessionDevices>(h, `/api/sessions/${encodeURIComponent(sessionId)}/devices`),
  mountDevice: (h: HostConfig, sessionId: string, input: DeviceMountInput) =>
    request<DeviceMount>(h, `/api/sessions/${encodeURIComponent(sessionId)}/devices/mount`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  unmountDevice: (h: HostConfig, sessionId: string, mountId: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}`,
      { method: 'DELETE' },
    ),
  serialOpen: (h: HostConfig, sessionId: string, mountId: string, baud: number, shared = false) =>
    request<SerialOpenResult>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/serial/open`,
      { method: 'POST', body: JSON.stringify({ baud, shared }) },
    ),
  serialRead: (
    h: HostConfig,
    sessionId: string,
    mountId: string,
    opts: { since?: number; waitMs?: number; windowMs?: number; filter?: string; maxBytes?: number } = {},
  ) =>
    request<SerialReadResult>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/serial${qs({
        since: opts.since !== undefined ? String(opts.since) : undefined,
        waitMs: opts.waitMs !== undefined ? String(opts.waitMs) : undefined,
        windowMs: opts.windowMs !== undefined ? String(opts.windowMs) : undefined,
        filter: opts.filter,
        maxBytes: opts.maxBytes !== undefined ? String(opts.maxBytes) : undefined,
      })}`,
    ),
  serialWrite: (h: HostConfig, sessionId: string, mountId: string, data: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/serial/write`,
      { method: 'POST', body: JSON.stringify({ data }) },
    ),
  serialClose: (h: HostConfig, sessionId: string, mountId: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/serial/close`,
      { method: 'POST' },
    ),
  logcatStart: (h: HostConfig, sessionId: string, mountId: string, filter?: string) =>
    request<DeviceLogcatStart>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/logcat/start`,
      { method: 'POST', body: JSON.stringify({ filter }) },
    ),
  logcatRead: (h: HostConfig, sessionId: string, mountId: string, streamId: string, since = 0) =>
    request<DeviceLogcatRead>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/logcat${qs({
        streamId,
        since: String(since),
      })}`,
    ),
  logcatStop: (h: HostConfig, sessionId: string, mountId: string, streamId: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(mountId)}/logcat/stop`,
      { method: 'POST', body: JSON.stringify({ streamId }) },
    ),

  sshHosts: (h: HostConfig) => request<RemoteSshHost[]>(h, '/api/ssh-hosts'),
  sshScanKey: (h: HostConfig, target: SshTarget) =>
    request<SshHostKeyInfo>(h, '/api/ssh-hosts/scan-key', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  sshProbe: (
    h: HostConfig,
    input: { target: SshTarget; auth: SshHostInput['auth']; fingerprint: string },
  ) =>
    request<SshProbeResult>(h, '/api/ssh-hosts/probe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sshDeploy: (h: HostConfig, input: SshHostInput) =>
    request<SshJob>(h, '/api/ssh-hosts', { method: 'POST', body: JSON.stringify(input) }),
  sshJob: (h: HostConfig, id: string) =>
    request<SshJob>(h, `/api/ssh-hosts/jobs/${encodeURIComponent(id)}`),
  sshRestart: (h: HostConfig, id: string) =>
    request<SshJob>(h, `/api/ssh-hosts/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  sshUpgrade: (h: HostConfig, id: string) =>
    request<SshJob>(h, `/api/ssh-hosts/${encodeURIComponent(id)}/upgrade`, { method: 'POST' }),
  sshLogs: (h: HostConfig, id: string, lines = 200) =>
    request<{ lines: string[] }>(
      h,
      `/api/ssh-hosts/${encodeURIComponent(id)}/logs${qs({ lines: String(lines) })}`,
    ),
  sshUninstall: (h: HostConfig, id: string, keepData: boolean) =>
    request<SshJob>(
      h,
      `/api/ssh-hosts/${encodeURIComponent(id)}${qs({ keepData: keepData ? '1' : '0' })}`,
      { method: 'DELETE' },
    ),
  sshSetPassword: (h: HostConfig, id: string, password: string) =>
    request<{ ok: boolean }>(h, `/api/ssh-hosts/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  doctor: (h: HostConfig, options: { checks?: string[]; clientTime?: number } = {}) =>
    request<DoctorReport>(
      h,
      `/api/doctor${qs({
        checks: options.checks?.length ? options.checks.join(',') : undefined,
        clientTime: options.clientTime !== undefined ? String(options.clientTime) : undefined,
      })}`,
    ),

  createShare: (h: HostConfig, sessionId: string, input: CreateShareInput) =>
    request<CreateShareResult>(h, `/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  shares: (h: HostConfig) => request<ShareInfo[]>(h, '/api/shares'),
  teamMe: (h: HostConfig) => request<TeamIdentity>(h, '/api/team/me'),
  teamMembers: (h: HostConfig) => request<TeamOverview>(h, '/api/team/members'),
  teamApprovers: (h: HostConfig) => request<TeamMember[]>(h, '/api/team/approvers'),
  createTeamInvite: (h: HostConfig, input: CreateTeamInviteInput) =>
    request<CreateTeamInviteResult>(h, '/api/team/invites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteTeamInvite: (h: HostConfig, id: string) =>
    request<void>(h, `/api/team/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateTeamMember: (h: HostConfig, id: string, input: UpdateTeamMemberInput) =>
    request<TeamMember>(h, `/api/team/members/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revokeTeamMember: (h: HostConfig, id: string) =>
    request<void>(h, `/api/team/members/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  teamAudit: (h: HostConfig, limit = 200) =>
    request<TeamAuditEntry[]>(h, `/api/team/audit?limit=${limit}`),
  gateway: (h: HostConfig) => request<GatewayOverview>(h, '/api/gateway'),
  updateGatewaySettings: (h: HostConfig, input: GatewaySettings) =>
    request<GatewaySettings>(h, '/api/gateway/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  issueGatewayToken: (h: HostConfig, input: GatewayTokenInput) =>
    request<GatewayTokenIssued>(h, '/api/gateway/tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateGatewayToken: (h: HostConfig, id: string, input: GatewayTokenUpdateInput) =>
    request<GatewayToken>(h, `/api/gateway/tokens/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revokeGatewayToken: (h: HostConfig, id: string) =>
    request<void>(h, `/api/gateway/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  transferPermission: (h: HostConfig, requestId: string, toMemberId: string) =>
    request<PermissionRequest>(h, `/api/permissions/${encodeURIComponent(requestId)}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ toMemberId }),
    }),
  deleteShare: (h: HostConfig, id: string) =>
    request<void>(h, `/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  settings: (h: HostConfig) => request<HostSettings>(h, '/api/settings'),
  sandboxStatus: (h: HostConfig) => request<SandboxStatus>(h, '/api/sandbox/status'),
  updateSettings: (h: HostConfig, input: Partial<HostSettings>) =>
    request<HostSettings>(h, '/api/settings', { method: 'PUT', body: JSON.stringify(input) }),

  browserSettings: (h: HostConfig) => request<BrowserSettings>(h, '/api/browser/settings'),
  updateBrowserSettings: (h: HostConfig, input: BrowserSettings) =>
    request<BrowserSettings>(h, '/api/browser/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  browserStatus: (h: HostConfig) => request<BrowserStatus>(h, '/api/browser/status'),
  browserState: (h: HostConfig, sessionId: string) =>
    request<BrowserState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/browser/state`),
  browserScreenshot: async (h: HostConfig, sessionId: string, shotId?: string) => {
    const res = await send(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/browser/screenshot${qs({ shot: shotId })}`,
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(describe(res.status, text), res.status)
    }
    return res.blob()
  },

  previewState: (h: HostConfig, sessionId: string) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/state`),
  previewDetect: (h: HostConfig, sessionId: string) =>
    request<PreviewCandidate[]>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/detect`),
  previewOpen: (
    h: HostConfig,
    sessionId: string,
    input: { url: string; width?: number; height?: number },
  ) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/open`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  previewReload: (h: HostConfig, sessionId: string) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/reload`, {
      method: 'POST',
    }),
  previewBack: (h: HostConfig, sessionId: string) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/back`, {
      method: 'POST',
    }),
  previewForward: (h: HostConfig, sessionId: string) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/forward`, {
      method: 'POST',
    }),
  previewResize: (h: HostConfig, sessionId: string, width: number, height: number) =>
    request<PreviewState>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/resize`, {
      method: 'POST',
      body: JSON.stringify({ width, height }),
    }),
  previewSelect: (h: HostConfig, sessionId: string, x: number, y: number) =>
    request<PreviewSelection>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/select`, {
      method: 'POST',
      body: JSON.stringify({ x, y }),
    }),
  previewScreenshot: async (h: HostConfig, sessionId: string, shotId?: string) => {
    const res = await send(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/preview/screenshot${qs({ shot: shotId })}`,
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(describe(res.status, text), res.status)
    }
    return res.blob()
  },
  previewSnapshots: (h: HostConfig, sessionId: string) =>
    request<PreviewSnapshot[]>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/snapshots`),
  previewSnapshot: (h: HostConfig, sessionId: string, label?: string) =>
    request<PreviewSnapshot>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/snapshots`, {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    }),
  previewDeleteSnapshot: (h: HostConfig, sessionId: string, snapshotId: string) =>
    request<void>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/preview/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'DELETE' },
    ),
  previewMount: (h: HostConfig, sessionId: string) =>
    request<PreviewMount>(h, `/api/sessions/${encodeURIComponent(sessionId)}/preview/mount`),

  sttCapabilities: (h: HostConfig) => request<SttCapabilities>(h, '/api/stt/capabilities'),
  testStt: (h: HostConfig) => request<SttTestResult>(h, '/api/stt/test', { method: 'POST' }),
  transcribe: (h: HostConfig, input: SttInput) =>
    request<SttResult>(h, '/api/stt', { method: 'POST', body: JSON.stringify(input) }),

  ...demoApi,

  profiles: (h: HostConfig) => request<Profile[]>(h, '/api/profiles'),
  createProfile: (h: HostConfig, input: ProfileInput) =>
    request<Profile>(h, '/api/profiles', { method: 'POST', body: JSON.stringify(input) }),
  updateProfile: (h: HostConfig, id: string, input: ProfileInput) =>
    request<Profile>(h, `/api/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteProfile: (h: HostConfig, id: string) =>
    request<void>(h, `/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testProfile: (h: HostConfig, id: string, groupId?: string, keyId?: string) =>
    request<{ ok: boolean; error?: string }>(h, `/api/profiles/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      ...(groupId || keyId
        ? { body: JSON.stringify({ ...(groupId ? { groupId } : {}), ...(keyId ? { keyId } : {}) }) }
        : {}),
    }),
  listModels: (h: HostConfig, input: ListModelsInput) =>
    request<{ ok: boolean; models: ModelInfo[]; error?: string }>(h, '/api/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  modelCapabilities: (
    h: HostConfig,
    profileId: string,
    groupId: string | undefined,
    model: string,
  ) =>
    request<ModelInfo>(
      h,
      `/api/models/capabilities${qs({ profileId, groupId, model })}`,
    ),
  modelPrices: (h: HostConfig, profileId: string, groupId?: string) =>
    request<{ prices: Record<string, ModelPriceInfo> }>(
      h,
      `/api/models/prices${qs({ profileId, groupId })}`,
    ),

  sessions: (h: HostConfig) => request<SessionSummary[]>(h, '/api/sessions'),
  createSession: (h: HostConfig, input: CreateSessionInput) =>
    request<SessionSummary>(h, '/api/sessions', { method: 'POST', body: JSON.stringify(input) }),
  session: (h: HostConfig, id: string, options: { tail?: number } = {}) =>
    request<Session>(
      h,
      `/api/sessions/${encodeURIComponent(id)}${qs({
        tail: options.tail ? String(options.tail) : undefined,
      })}`,
    ),
  /** 向前翻页 / 按需取一段（around）消息。 */
  sessionMessages: (
    h: HostConfig,
    id: string,
    options: { before?: string; around?: string; limit?: number } = {},
  ) =>
    request<MessagePage>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/messages${qs({
        before: options.before,
        around: options.around,
        limit: options.limit ? String(options.limit) : undefined,
      })}`,
    ),
  sessionTurns: (h: HostConfig, id: string) =>
    request<SessionTurns>(h, `/api/sessions/${encodeURIComponent(id)}/turns`),
  /** 完整内容块：超大工具输出“显示全部”（按消息 + 下标或 toolUseId 定位）。 */
  messageBlock: (
    h: HostConfig,
    id: string,
    lookup: { messageId?: string; index?: number; toolUseId?: string },
  ) =>
    request<{ block: ContentBlock }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/message-block${qs({
        messageId: lookup.messageId,
        index: lookup.index !== undefined ? String(lookup.index) : undefined,
        toolUseId: lookup.toolUseId,
      })}`,
    ),
  resumeSession: (h: HostConfig, id: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  handoffSession: (h: HostConfig, id: string, action: 'switch' | 'wait' | 'pause') =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  patchSession: (h: HostConfig, id: string, input: UpdateSessionInput) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  resolveDivisionPlan: (
    h: HostConfig,
    id: string,
    planId: string,
    decision: import('@tandem/protocol').DivisionPlanDecision,
  ) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/division-plan/${encodeURIComponent(planId)}`,
      { method: 'POST', body: JSON.stringify(decision) },
    ),
  rerunSubagent: (h: HostConfig, id: string, model?: string) =>
    request<{ ok: boolean; subagent?: { id: string; model: string } }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/subagent-rerun`,
      { method: 'POST', body: JSON.stringify(model ? { model } : {}) },
    ),
  promoteSubagent: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/sessions/${encodeURIComponent(id)}/subagent-promote`, {
      method: 'POST',
    }),
  markSessionRead: (h: HostConfig, id: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/read`, {
      method: 'POST',
    }),
  search: (h: HostConfig, q: string, filters: SearchFilters = {}) =>
    request<SearchResponse>(
      h,
      `/api/search${qs({ q, filters: JSON.stringify(filters) })}`,
    ),
  deleteSession: (h: HostConfig, id: string, force = false) =>
    request<void>(
      h,
      `/api/sessions/${encodeURIComponent(id)}${force ? '?force=1' : ''}`,
      { method: 'DELETE' },
    ),
  mergeWorktree: (h: HostConfig, id: string, strategy: 'merge' | 'squash') =>
    request<{ ok: boolean; error?: string }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/worktree/merge`,
      { method: 'POST', body: JSON.stringify({ strategy }) },
    ),
  forkSession: (h: HostConfig, id: string, messageId?: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
      ...(messageId ? { body: JSON.stringify({ messageId }) } : {}),
    }),
  branches: (h: HostConfig, id: string) =>
    request<{ current?: string; branches: string[] }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/branches`,
    ),
  checkout: (h: HostConfig, id: string, branch: string, create = false) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ branch, create }),
    }),
  worktree: (h: HostConfig, id: string, branch?: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/worktree`, {
      method: 'POST',
      body: JSON.stringify({ ...(branch ? { branch } : {}) }),
    }),
  exportSession: (h: HostConfig, id: string) =>
    request<Session>(h, `/api/sessions/${encodeURIComponent(id)}/export`),
  importSession: (h: HostConfig, input: { session: Session; cwd?: string }) =>
    request<SessionSummary>(h, '/api/sessions/import', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  checkpoints: (h: HostConfig, id: string) =>
    request<Checkpoint[]>(h, `/api/sessions/${encodeURIComponent(id)}/checkpoints`),
  rewind: (h: HostConfig, id: string, input: RewindInput) =>
    request<Session>(h, `/api/sessions/${encodeURIComponent(id)}/rewind`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  compactionOriginal: (h: HostConfig, id: string, noticeId: string) =>
    request<{ summary: string; messages: Message[] }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/compaction/${encodeURIComponent(noticeId)}`,
    ),
  undoCompaction: (h: HostConfig, id: string, noticeId: string) =>
    request<Session>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/compaction/${encodeURIComponent(noticeId)}/undo`,
      { method: 'POST' },
    ),
  changes: (h: HostConfig, id: string) =>
    request<ChangesResult>(h, `/api/sessions/${encodeURIComponent(id)}/changes`),
  changesDiff: (h: HostConfig, id: string, path: string) =>
    request<{ path: string; diff: string; emptyReason?: DiffEmptyReason; truncated?: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/changes/diff${qs({ path })}`,
    ),
  revertChanges: (h: HostConfig, id: string, paths: string[]) =>
    request<ChangesResult>(h, `/api/sessions/${encodeURIComponent(id)}/changes/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  startAiReview: (h: HostConfig, id: string, paths?: string[]) =>
    request<{ review: AiReviewRun }>(h, `/api/sessions/${encodeURIComponent(id)}/ai-review`, {
      method: 'POST',
      body: JSON.stringify(paths?.length ? { paths } : {}),
    }),
  aiReviewLatest: (h: HostConfig, id: string) =>
    request<{ review?: AiReviewRun }>(h, `/api/sessions/${encodeURIComponent(id)}/ai-review`),
  aiReview: (h: HostConfig, id: string, reviewId: string) =>
    request<{ review: AiReviewRun }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/ai-review/${encodeURIComponent(reviewId)}`,
    ),
  markAiReviewFalsePositive: (h: HostConfig, id: string, reviewId: string, findingId: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/ai-review/${encodeURIComponent(reviewId)}/false-positive`,
      { method: 'POST', body: JSON.stringify({ findingId }) },
    ),
  commitChanges: (h: HostConfig, id: string, message: string, paths?: string[]) =>
    request<{ ok: boolean; commit?: string; error?: string }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/changes/commit`,
      { method: 'POST', body: JSON.stringify({ message, ...(paths?.length ? { paths } : {}) }) },
    ),

  vcs: (h: HostConfig, id: string) =>
    request<VcsState>(h, `/api/sessions/${encodeURIComponent(id)}/vcs`),
  pr: (h: HostConfig, id: string) =>
    request<VcsState>(h, `/api/sessions/${encodeURIComponent(id)}/pr`),
  createPr: (h: HostConfig, id: string, input: CreatePrInput) =>
    request<PrActionResult>(h, `/api/sessions/${encodeURIComponent(id)}/pr`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  mergePr: (h: HostConfig, id: string, method: PrMergeMethod) =>
    request<PrActionResult>(h, `/api/sessions/${encodeURIComponent(id)}/pr/merge`, {
      method: 'POST',
      body: JSON.stringify({ method }),
    }),
  fixPrCheck: (
    h: HostConfig,
    id: string,
    input: { checkName: string; runId?: string; url?: string },
  ) =>
    request<{ ok: boolean; sent?: boolean; error?: string }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/pr/fix`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  hooks: (h: HostConfig, cwd?: string) =>
    request<HookSettings>(h, `/api/hooks${qs({ cwd })}`),
  saveHooks: (h: HostConfig, entries: HookEntry[], cwd?: string) =>
    request<HookSettings>(h, '/api/hooks', {
      method: 'PUT',
      body: JSON.stringify({ entries, ...(cwd ? { cwd } : {}) }),
    }),
  trustHooks: (h: HostConfig, cwd: string, trusted: boolean) =>
    request<HookSettings>(h, '/api/hooks/trust', {
      method: 'PUT',
      body: JSON.stringify({ cwd, trusted }),
    }),

  secrets: (h: HostConfig, cwd?: string) =>
    request<SecretsOverview>(h, `/api/secrets${qs({ cwd })}`),
  createSecret: (h: HostConfig, input: SecretInput) =>
    request<SecretMeta>(h, '/api/secrets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSecret: (h: HostConfig, id: string, input: SecretInput) =>
    request<SecretMeta>(h, `/api/secrets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteSecret: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveSecretsSettings: (h: HostConfig, settings: SecretsSettings) =>
    request<SecretsSettings>(h, '/api/secrets/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  subagentPresets: (h: HostConfig, cwd?: string) =>
    request<{ presets: SubagentPreset[] }>(h, `/api/subagent-presets${qs({ cwd })}`),
  saveSubagentPresets: (h: HostConfig, presets: SubagentPresetInput[], cwd?: string) =>
    request<{ presets: SubagentPreset[] }>(h, '/api/subagent-presets', {
      method: 'PUT',
      body: JSON.stringify({ presets, ...(cwd ? { cwd } : {}) }),
    }),
  promptTemplates: (h: HostConfig, cwd?: string) =>
    request<{ templates: PromptTemplate[] }>(h, `/api/prompt-templates${qs({ cwd })}`),
  savePromptTemplates: (
    h: HostConfig,
    values: Partial<Record<PromptTemplateKey, string>>,
    cwd?: string,
  ) =>
    request<{ templates: PromptTemplate[] }>(h, '/api/prompt-templates', {
      method: 'PUT',
      body: JSON.stringify({ values, ...(cwd ? { cwd } : {}) }),
    }),
  injections: (h: HostConfig, sessionId: string) =>
    request<InjectionSnapshot>(h, `/api/sessions/${sessionId}/injections`),

  memory: (h: HostConfig, scope: MemoryScope, project?: string) =>
    request<MemoryFile>(h, `/api/memory${qs({ scope, project })}`),
  saveMemory: (h: HostConfig, input: { scope: MemoryScope; project?: string; text: string }) =>
    request<MemoryFile>(h, '/api/memory', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteMemory: (h: HostConfig, scope: MemoryScope, project?: string) =>
    request<{ ok: boolean }>(h, `/api/memory${qs({ scope, project })}`, { method: 'DELETE' }),
  memoryList: (h: HostConfig) =>
    request<{ global?: MemoryListItem; projects: MemoryListItem[] }>(h, '/api/memory/list'),
  importMemory: (
    h: HostConfig,
    input: { project: string; text: string; source?: string; scope?: MemoryScope },
  ) =>
    request<{ ok: boolean; merged: boolean; entries: number }>(h, '/api/memory/import', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  wiki: (h: HostConfig, project: string) =>
    request<WikiMeta>(h, `/api/wiki${qs({ project })}`),
  wikiPage: (h: HostConfig, project: string, page: string) =>
    request<WikiPage>(h, `/api/wiki/page${qs({ project, page })}`),
  wikiSavePage: (h: HostConfig, input: { project: string; page: string; manual: string }) =>
    request<WikiPage>(h, '/api/wiki/page', { method: 'PUT', body: JSON.stringify(input) }),
  wikiSearch: (h: HostConfig, project: string, q: string, limit = 8) =>
    request<WikiSearchResult>(h, `/api/wiki/search${qs({ project, q, limit: String(limit) })}`),
  wikiEstimate: (h: HostConfig, input: WikiEstimateInput) =>
    request<WikiEstimate>(
      h,
      `/api/wiki/estimate${qs({
        project: input.project,
        mode: input.mode,
        profileId: input.profileId,
        groupId: input.groupId,
        model: input.model,
      })}`,
    ),
  wikiGenerate: (h: HostConfig, input: WikiGenerateInput) =>
    request<WikiJob>(h, '/api/wiki/generate', { method: 'POST', body: JSON.stringify(input) }),
  wikiJobs: (h: HostConfig, project: string) =>
    request<WikiJob[]>(h, `/api/wiki/jobs${qs({ project })}`),
  wikiCancelJob: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/wiki/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  wikiSchedule: (h: HostConfig, project: string) =>
    request<Schedule>(h, '/api/wiki/schedule', { method: 'POST', body: JSON.stringify({ project }) }),

  permissions: (h: HostConfig) => request<PermissionRule[]>(h, '/api/permissions'),
  setPermissions: (h: HostConfig, rules: PermissionRule[]) =>
    request<PermissionRule[]>(h, '/api/permissions', {
      method: 'PUT',
      body: JSON.stringify(rules),
    }),
  permissionInsights: (h: HostConfig) =>
    request<PermissionInsights>(h, '/api/permissions/insights'),
  adoptPermissionSuggestion: (h: HostConfig, id: string) =>
    request<PermissionRule[]>(h, `/api/permissions/suggestions/${encodeURIComponent(id)}/adopt`, {
      method: 'POST',
    }),
  ignorePermissionSuggestion: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/permissions/suggestions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  addPermissionRule: (h: HostConfig, rule: PermissionRule) =>
    request<PermissionRule[]>(h, '/api/permissions/rules', {
      method: 'POST',
      body: JSON.stringify({ rule }),
    }),
  draftPermissionRule: (h: HostConfig, sessionId: string, text: string) =>
    request<PermissionRuleDraft>(h, '/api/permissions/draft', {
      method: 'POST',
      body: JSON.stringify({ sessionId, text }),
    }),

  fsList: (h: HostConfig, path: string, options?: { files?: boolean }) =>
    request<FsEntry[]>(
      h,
      `/api/fs/list${qs({ path, files: options?.files ? '1' : undefined })}`,
    ),
  fsComplete: (h: HostConfig, cwd: string, q: string) =>
    request<string[]>(h, `/api/fs/complete${qs({ cwd, q })}`),

  externalSessions: (h: HostConfig, source?: ExternalSource, since?: number) =>
    request<ExternalSession[]>(
      h,
      `/api/external-sessions${qs({ source, since: since !== undefined ? String(since) : undefined })}`,
    ),
  externalSession: (h: HostConfig, source: ExternalSource, id: string) =>
    request<Session>(
      h,
      `/api/external-sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
    ),
  importExternalSession: (
    h: HostConfig,
    source: ExternalSource,
    id: string,
    input: ExternalImportInput = {},
  ) =>
    request<SessionSummary>(
      h,
      `/api/external-sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/import`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  exportConfig: (h: HostConfig, input: ConfigExportInput) =>
    request<ConfigBundle>(h, '/api/config/export', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  importConfig: (h: HostConfig, input: ConfigImportInput) =>
    request<ConfigImportResult>(h, '/api/config/import', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  commands: (h: HostConfig, cwd?: string) =>
    request<SlashCommand[]>(h, `/api/commands${qs({ cwd })}`),
  skills: (h: HostConfig, cwd?: string) =>
    request<SkillInfo[]>(h, `/api/skills${qs({ cwd })}`),
  saveSkillState: (h: HostConfig, disabled: string[], cwd?: string) =>
    request<SkillInfo[]>(h, '/api/skills/state', {
      method: 'PUT',
      body: JSON.stringify({ disabled, cwd }),
    }),

  context: (h: HostConfig, sessionId: string) =>
    request<ContextBreakdown>(h, `/api/sessions/${encodeURIComponent(sessionId)}/context`),

  fsGit: (h: HostConfig, path: string) =>
    request<FsGitResult>(h, `/api/fs/git${qs({ path })}`),
  fsRead: (h: HostConfig, path: string, cwd?: string) =>
    request<FsReadResult>(h, `/api/fs/read${qs({ path, cwd })}`),
  fsReveal: (h: HostConfig, path: string) =>
    request<FsRevealResult>(h, '/api/fs/reveal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  /** 直连时可直接作为 <img src>；加密隧道 Host 必须用 fsRawBlob。 */
  fsRawUrl: (h: HostConfig, path: string, cwd?: string) =>
    `${requestBase(h.url)}/api/fs/raw${qs({ path, cwd, token: h.token })}`,
  /** 加密隧道 Host 无法直接拼 URL（token 要进密文），取回内容后转成 blob URL 使用。 */
  fsRawBlob: async (h: HostConfig, path: string, cwd?: string): Promise<Blob> => {
    if (!isRelayHost(h)) {
      const res = await fetch(api.fsRawUrl(h, path, cwd))
      if (!res.ok) throw new ApiError(describe(res.status, await res.text().catch(() => '')), res.status)
      return res.blob()
    }
    const res = await send(h, `/api/fs/raw${qs({ path, cwd })}`)
    if (!res.ok) {
      throw new ApiError(describe(res.status, await res.text().catch(() => '')), res.status)
    }
    return res.blob()
  },

  mcp: (h: HostConfig, cwd?: string, retry = false) =>
    request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>(
      h,
      `/api/mcp${qs({ cwd, retry: retry ? '1' : undefined })}`,
    ),
  saveMcp: (h: HostConfig, servers: McpServerConfig[]) =>
    request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>(h, '/api/mcp', {
      method: 'PUT',
      body: JSON.stringify(servers),
    }),

  usage: (h: HostConfig, from?: string, to?: string) =>
    request<UsageStatsRow[]>(h, `/api/usage${qs({ from, to })}`),

  budgets: (h: HostConfig) => request<BudgetRule[]>(h, '/api/budgets'),
  saveBudgets: (h: HostConfig, rules: BudgetRule[]) =>
    request<BudgetRule[]>(h, '/api/budgets', { method: 'PUT', body: JSON.stringify(rules) }),
  budgetStatus: (h: HostConfig) => request<BudgetStatus[]>(h, '/api/budgets/status'),
  budgetAllowOnce: (h: HostConfig, sessionId: string) =>
    request<{ ok: boolean }>(
      h,
      `/api/sessions/${encodeURIComponent(sessionId)}/budget-allow-once`,
      { method: 'POST' },
    ),

  tasks: (h: HostConfig, sessionId?: string) =>
    request<BackgroundTask[]>(h, `/api/tasks${qs({ sessionId })}`),
  taskOutput: (h: HostConfig, id: string, since = 0) =>
    request<BackgroundTaskOutput>(
      h,
      `/api/tasks/${encodeURIComponent(id)}/output${qs({ since: String(since) })}`,
    ),
  killTask: (h: HostConfig, id: string) =>
    request<BackgroundTask>(h, `/api/tasks/${encodeURIComponent(id)}/kill`, { method: 'POST' }),

  schedules: (h: HostConfig) => request<Schedule[]>(h, '/api/schedules'),
  createSchedule: (h: HostConfig, input: ScheduleInput) =>
    request<Schedule>(h, '/api/schedules', { method: 'POST', body: JSON.stringify(input) }),
  updateSchedule: (h: HostConfig, id: string, input: ScheduleInput) =>
    request<Schedule>(h, `/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteSchedule: (h: HostConfig, id: string) =>
    request<void>(h, `/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runSchedule: (h: HostConfig, id: string) =>
    request<{ ok: boolean; sessionId?: string; error?: string }>(
      h,
      `/api/schedules/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),

  boards: (h: HostConfig) => request<BoardSummary[]>(h, '/api/boards'),
  board: (h: HostConfig, id: string) => request<Board>(h, `/api/boards/${encodeURIComponent(id)}`),
  createBoard: (h: HostConfig, input: BoardInput) =>
    request<Board>(h, '/api/boards', { method: 'POST', body: JSON.stringify(input) }),
  updateBoard: (h: HostConfig, id: string, input: BoardInput) =>
    request<Board>(h, `/api/boards/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteBoard: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createBoardCard: (h: HostConfig, boardId: string, input: BoardCardInput) =>
    request<BoardCard>(h, `/api/boards/${encodeURIComponent(boardId)}/cards`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateBoardCard: (h: HostConfig, boardId: string, cardId: string, input: BoardCardInput) =>
    request<BoardCard>(h, `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteBoardCard: (h: HostConfig, boardId: string, cardId: string) =>
    request<{ ok: boolean }>(h, `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`, {
      method: 'DELETE',
    }),
  boardCardAction: (
    h: HostConfig,
    boardId: string,
    cardId: string,
    action: BoardCardAction,
    extra: { note?: string; strategy?: 'merge' | 'squash' } = {},
  ) =>
    request<BoardCard>(
      h,
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/action`,
      { method: 'POST', body: JSON.stringify({ action, ...extra }) },
    ),
  moveBoardCard: (h: HostConfig, boardId: string, cardId: string, beforeId: string | null) =>
    request<Board>(
      h,
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/move`,
      { method: 'POST', body: JSON.stringify({ beforeId }) },
    ),
  mergeBoardAll: (h: HostConfig, boardId: string) =>
    request<{ merged: string[]; failed: Array<{ cardId: string; error: string }> }>(
      h,
      `/api/boards/${encodeURIComponent(boardId)}/merge-all`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  boardMergePreview: (h: HostConfig, boardId: string) =>
    request<BoardMergePreview>(h, `/api/boards/${encodeURIComponent(boardId)}/merge-preview`),
  boardCardDiff: (h: HostConfig, boardId: string, cardId: string, filePath?: string) =>
    request<BoardCardDiff>(
      h,
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/diff${qs({ path: filePath })}`,
    ),
  boardCardChecks: (h: HostConfig, boardId: string, cardId: string) =>
    request<{ check?: BoardCardCheck }>(
      h,
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/checks`,
    ),
  planBoard: (h: HostConfig, boardId: string, goal: string) =>
    request<{ drafts: BoardPlanDraft[] }>(h, `/api/boards/${encodeURIComponent(boardId)}/plan`, {
      method: 'POST',
      body: JSON.stringify({ goal }),
    }),
  applyBoardPlan: (h: HostConfig, boardId: string, drafts: BoardPlanDraft[]) =>
    request<{ cards: BoardCard[] }>(h, `/api/boards/${encodeURIComponent(boardId)}/plan/apply`, {
      method: 'POST',
      body: JSON.stringify({ drafts }),
    }),
  openBoardPr: (h: HostConfig, boardId: string, input: BoardPrInput) =>
    request<BoardPrResult>(h, `/api/boards/${encodeURIComponent(boardId)}/pr`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  boardPr: (h: HostConfig, boardId: string) =>
    request<{ pr?: BoardPrState }>(h, `/api/boards/${encodeURIComponent(boardId)}/pr`),
  boardVcs: (h: HostConfig, boardId: string) =>
    request<VcsState>(h, `/api/boards/${encodeURIComponent(boardId)}/vcs`),

  evalSuites: (h: HostConfig) => request<{ suites: string[] }>(h, '/api/evals/suites'),
  evalCases: (h: HostConfig, suite?: string) =>
    request<{ cases: EvalCase[] }>(h, `/api/evals/cases${qs({ suite })}`),
  saveEvalCase: (h: HostConfig, input: SaveEvalCaseInput) =>
    request<EvalCase>(h, '/api/evals/cases', { method: 'POST', body: JSON.stringify(input) }),
  deleteEvalCase: (h: HostConfig, suite: string, name: string) =>
    request<void>(
      h,
      `/api/evals/cases/${encodeURIComponent(suite)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  evalRuns: (h: HostConfig) => request<EvalRunSummary[]>(h, '/api/evals/runs'),
  evalRun: (h: HostConfig, id: string) =>
    request<EvalRun>(h, `/api/evals/runs/${encodeURIComponent(id)}`),
  startEvalRun: (h: HostConfig, input: StartEvalRunInput) =>
    request<EvalRun>(h, '/api/evals/runs', { method: 'POST', body: JSON.stringify(input) }),
  cancelEvalRun: (h: HostConfig, id: string) =>
    request<{ ok: boolean }>(h, `/api/evals/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),

  pair: (h: HostConfig) =>
    request<{
      urls: string[]
      token: string
      loopback?: boolean
      hint?: string
    }>(h, '/api/pair'),
}

/** 工作站服务：客户端只填工作站地址，账号、主机、授权都从这里取。 */
async function wsFetch<T>(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    })
  } catch (err) {
    throw new ApiError(err instanceof Error ? `无法连接工作站：${err.message}` : '无法连接工作站', 0)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new ApiError(describe(res.status, text), res.status)
  if (res.status === 204 || !text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('工作站返回了无法解析的数据', res.status)
  }
}

export const workstationApi = {
  publicStatus: (baseUrl: string) => wsFetch<WorkstationPublicStatus>(baseUrl, '/api/workstation/status'),
  setup: (baseUrl: string, input: WorkstationSetupInput) =>
    wsFetch<AccountLoginResult>(baseUrl, '/api/workstation/setup', { method: 'POST', body: input }),
  register: (baseUrl: string, input: WorkstationRegisterInput) =>
    wsFetch<AccountLoginResult>(baseUrl, '/api/workstation/register', { method: 'POST', body: input }),
  login: (baseUrl: string, input: AccountLoginInput) =>
    wsFetch<AccountLoginResult>(baseUrl, '/api/workstation/login', { method: 'POST', body: input }),
  refresh: (baseUrl: string, refreshToken: string) =>
    wsFetch<AccountTokens>(baseUrl, '/api/workstation/refresh', { method: 'POST', body: { refreshToken } }),
  logout: (baseUrl: string, refreshToken: string) =>
    wsFetch<void>(baseUrl, '/api/workstation/logout', { method: 'POST', body: { refreshToken } }).catch(() => undefined),
  hosts: (baseUrl: string, token: string) =>
    wsFetch<WorkspaceHostInfo[]>(baseUrl, '/api/workstation/hosts', { token }),
  // 账号级模型账号：Key 加密保存在工作站，客户端只拿掩码。
  profiles: (baseUrl: string, token: string, refreshBalances = false) =>
    wsFetch<WorkspaceProfilesSnapshot>(
      baseUrl,
      `/api/workstation/profiles${refreshBalances ? '?refresh=1' : ''}`,
      { token },
    ),
  createProfile: (baseUrl: string, token: string, input: ProfileInput) =>
    wsFetch<Profile>(baseUrl, '/api/workstation/profiles', { method: 'POST', token, body: input }),
  updateProfile: (baseUrl: string, token: string, id: string, input: ProfileInput) =>
    wsFetch<Profile>(baseUrl, `/api/workstation/profiles/${encodeURIComponent(id)}`, { method: 'PUT', token, body: input }),
  deleteProfile: (baseUrl: string, token: string, id: string) =>
    wsFetch<void>(baseUrl, `/api/workstation/profiles/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
  testProfile: (baseUrl: string, token: string, id: string, groupId?: string, keyId?: string) =>
    wsFetch<{ ok: boolean; error?: string }>(baseUrl, `/api/workstation/profiles/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      token,
      body: { ...(groupId ? { groupId } : {}), ...(keyId ? { keyId } : {}) },
    }),
  bindCode: (baseUrl: string, token: string) =>
    wsFetch<WorkstationBindCode>(baseUrl, '/api/workstation/hosts/bind-code', { method: 'POST', token }),
  removeHost: (baseUrl: string, token: string, hostId: string) =>
    wsFetch<void>(baseUrl, `/api/workstation/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE', token }),
  setGrant: (baseUrl: string, token: string, hostId: string, input: WorkstationGrantInput) =>
    wsFetch<WorkspaceHostInfo>(baseUrl, `/api/workstation/hosts/${encodeURIComponent(hostId)}/grants`, {
      method: 'POST',
      token,
      body: input,
    }),
  removeGrant: (baseUrl: string, token: string, hostId: string, accountId: string) =>
    wsFetch<void>(
      baseUrl,
      `/api/workstation/hosts/${encodeURIComponent(hostId)}/grants/${encodeURIComponent(accountId)}`,
      { method: 'DELETE', token },
    ),
  accounts: (baseUrl: string, token: string, q = '') =>
    wsFetch<WorkstationAccountSummary[]>(
      baseUrl,
      `/api/workstation/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      { token },
    ),
  overview: (baseUrl: string, token: string) =>
    wsFetch<WorkspaceOverview>(baseUrl, '/api/workstation/overview', { token }),
  settings: (baseUrl: string, token: string, input: WorkstationSettingsInput) =>
    wsFetch<WorkstationPublicStatus>(baseUrl, '/api/workstation/settings', { method: 'PATCH', token, body: input }),
  invite: (baseUrl: string, token: string) =>
    wsFetch<WorkstationInvite>(baseUrl, '/api/workstation/invites', { method: 'POST', token }),
  audit: (baseUrl: string, token: string, limit = 200) =>
    wsFetch<WorkspaceAuditEntry[]>(baseUrl, `/api/workstation/audit?limit=${limit}`, { token }),
  localStatus: (h: HostConfig) =>
    request<{
      mode: WorkspaceStatus['mode']
      role?: WorkspaceStatus['role']
      embedded: { running: boolean; urls: string[]; port?: number }
      join: null | { url: string; workspaceName: string; fingerprint: string; connected: boolean }
    }>(h, '/api/workstation/local/status'),
  enableLocal: (h: HostConfig) =>
    request<{ urls: string[]; port: number; initialized: boolean }>(h, '/api/workstation/local/enable', {
      method: 'POST',
    }),
  join: (h: HostConfig, input: { workstationUrl: string; code?: string; username?: string; password?: string }) =>
    request<WorkspaceStatus>(h, '/api/workstation/join', { method: 'POST', body: JSON.stringify(input) }),
  leave: (h: HostConfig) => request<void>(h, '/api/workstation/leave', { method: 'POST' }),
}

/** 导入外部会话时可选的目标账号 / 分组 / 模型；不填则沿用原软件上下文。 */
export interface ExternalImportInput {
  profileId?: string
  groupId?: string
  model?: string
}

/** 分享页专用：同源公开接口，只带分享 token，不带 Host 主 token。 */
export async function fetchPublicShare(
  shareId: string,
  token: string,
  poll = false,
): Promise<PublicShare> {
  const res = await fetch(`/api/public/shares/${encodeURIComponent(shareId)}${poll ? '?poll=1' : ''}`, {
    headers: { Accept: 'application/json', Authorization: `Share ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(describe(res.status, text), res.status)
  }
  return (await res.json()) as PublicShare
}

/** 公开接口：凭一次性邀请码换取成员 token（无需 Host 主 token）。 */
export async function acceptTeamInvite(
  baseUrl: string,
  code: string,
  name: string,
): Promise<AcceptTeamInviteResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/team/invites/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, name }),
    })
  } catch (err) {
    throw new ApiError(err instanceof Error ? `无法连接 Host：${err.message}` : '无法连接 Host', 0)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new ApiError(describe(res.status, text), res.status)
  try {
    return JSON.parse(text) as AcceptTeamInviteResult
  } catch {
    throw new ApiError('Host 返回了无法解析的数据', res.status)
  }
}
