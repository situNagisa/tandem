import type {
  ChangesResult,
  Checkpoint,
  ConfigBundle,
  ConfigExportInput,
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
  CreatePrInput,
  DiffEmptyReason,
  ExternalSession,
  ExternalSource,
  FsEntry,
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
  PermissionRule,
  PrActionResult,
  PrMergeMethod,
  Profile,
  PromptTemplate,
  PromptTemplateKey,
  ProfileInput,
  BackgroundTask,
  BackgroundTaskOutput,
  BudgetRule,
  BudgetStatus,
  RewindInput,
  Schedule,
  ScheduleInput,
  Session,
  SessionSummary,
  SkillInfo,
  SlashCommand,
  SubagentPreset,
  SubagentPresetInput,
  UpdateSessionInput,
  UsageStatsRow,
  VcsState,
} from '@tandem/protocol'
import type { RelayPairInfo } from '@tandem/protocol'
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

/** 所有 REST 请求的出口：中继 Host 走 E2E channel，直连照旧 fetch。 */
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

export const api = {
  host: (h: HostConfig) => request<HostInfo>(h, '/api/host'),

  createShare: (h: HostConfig, sessionId: string, input: CreateShareInput) =>
    request<CreateShareResult>(h, `/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  shares: (h: HostConfig) => request<ShareInfo[]>(h, '/api/shares'),
  deleteShare: (h: HostConfig, id: string) =>
    request<void>(h, `/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  settings: (h: HostConfig) => request<HostSettings>(h, '/api/settings'),
  updateSettings: (h: HostConfig, input: HostSettings) =>
    request<HostSettings>(h, '/api/settings', { method: 'PUT', body: JSON.stringify(input) }),

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

  sessions: (h: HostConfig) => request<SessionSummary[]>(h, '/api/sessions'),
  createSession: (h: HostConfig, input: CreateSessionInput) =>
    request<SessionSummary>(h, '/api/sessions', { method: 'POST', body: JSON.stringify(input) }),
  session: (h: HostConfig, id: string) =>
    request<Session>(h, `/api/sessions/${encodeURIComponent(id)}`),
  resumeSession: (h: HostConfig, id: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  patchSession: (h: HostConfig, id: string, input: UpdateSessionInput) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
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

  changes: (h: HostConfig, id: string) =>
    request<ChangesResult>(h, `/api/sessions/${encodeURIComponent(id)}/changes`),
  changesDiff: (h: HostConfig, id: string, path: string) =>
    request<{ path: string; diff: string; emptyReason?: DiffEmptyReason }>(
      h,
      `/api/sessions/${encodeURIComponent(id)}/changes/diff${qs({ path })}`,
    ),
  revertChanges: (h: HostConfig, id: string, paths: string[]) =>
    request<ChangesResult>(h, `/api/sessions/${encodeURIComponent(id)}/changes/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
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

  permissions: (h: HostConfig) => request<PermissionRule[]>(h, '/api/permissions'),
  setPermissions: (h: HostConfig, rules: PermissionRule[]) =>
    request<PermissionRule[]>(h, '/api/permissions', {
      method: 'PUT',
      body: JSON.stringify(rules),
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

  fsRead: (h: HostConfig, path: string, cwd?: string) =>
    request<FsReadResult>(h, `/api/fs/read${qs({ path, cwd })}`),
  fsReveal: (h: HostConfig, path: string) =>
    request<FsRevealResult>(h, '/api/fs/reveal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  /** 直连时可直接作为 <img src>；中继 Host 必须用 fsRawBlob。 */
  fsRawUrl: (h: HostConfig, path: string, cwd?: string) =>
    `${requestBase(h.url)}/api/fs/raw${qs({ path, cwd, token: h.token })}`,
  /** 中继 Host 无法直接拼 URL（token 要进密文），取回内容后转成 blob URL 使用。 */
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

  pair: (h: HostConfig) =>
    request<{
      urls: string[]
      token: string
      loopback?: boolean
      hint?: string
      relay?: RelayPairInfo
    }>(h, '/api/pair'),
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
