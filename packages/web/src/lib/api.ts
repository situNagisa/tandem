import type {
  ChangesResult,
  Checkpoint,
  ConfigBundle,
  ConfigExportInput,
  ConfigImportInput,
  ConfigImportResult,
  CreateSessionInput,
  ExternalSession,
  ExternalSource,
  FsEntry,
  HostInfo,
  ListModelsInput,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  PermissionRule,
  Profile,
  ProfileInput,
  RewindInput,
  Session,
  SessionSummary,
  SlashCommand,
  UpdateSessionInput,
  UsageStatsRow,
} from '@tandem/protocol'
import type { HostConfig } from './types'
import { requestBase } from './hostUrl'

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

async function request<T>(host: HostConfig, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (host.token) headers.set('Authorization', `Bearer ${host.token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('Accept', 'application/json')

  let res: Response
  try {
    res = await fetch(requestBase(host.url) + path, { ...init, headers })
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? `无法连接 Host：${err.message}` : '无法连接 Host',
      0,
    )
  }
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
  testProfile: (h: HostConfig, id: string) =>
    request<{ ok: boolean; error?: string }>(h, `/api/profiles/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  listModels: (h: HostConfig, input: ListModelsInput) =>
    request<{ ok: boolean; models: ModelInfo[]; error?: string }>(h, '/api/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  sessions: (h: HostConfig) => request<SessionSummary[]>(h, '/api/sessions'),
  createSession: (h: HostConfig, input: CreateSessionInput) =>
    request<SessionSummary>(h, '/api/sessions', { method: 'POST', body: JSON.stringify(input) }),
  session: (h: HostConfig, id: string) =>
    request<Session>(h, `/api/sessions/${encodeURIComponent(id)}`),
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
  forkSession: (h: HostConfig, id: string) =>
    request<SessionSummary>(h, `/api/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST' }),

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
    request<{ path: string; diff: string }>(
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

  permissions: (h: HostConfig) => request<PermissionRule[]>(h, '/api/permissions'),
  setPermissions: (h: HostConfig, rules: PermissionRule[]) =>
    request<PermissionRule[]>(h, '/api/permissions', {
      method: 'PUT',
      body: JSON.stringify(rules),
    }),

  fsList: (h: HostConfig, path: string) =>
    request<FsEntry[]>(h, `/api/fs/list${qs({ path })}`),
  fsComplete: (h: HostConfig, cwd: string, q: string) =>
    request<string[]>(h, `/api/fs/complete${qs({ cwd, q })}`),

  externalSessions: (h: HostConfig, source?: ExternalSource) =>
    request<ExternalSession[]>(h, `/api/external-sessions${qs({ source })}`),
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

  commands: (h: HostConfig) => request<SlashCommand[]>(h, '/api/commands'),

  mcp: (h: HostConfig, cwd?: string) =>
    request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>(
      h,
      `/api/mcp${qs({ cwd })}`,
    ),
  saveMcp: (h: HostConfig, servers: McpServerConfig[]) =>
    request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>(h, '/api/mcp', {
      method: 'PUT',
      body: JSON.stringify(servers),
    }),

  usage: (h: HostConfig, from?: string, to?: string) =>
    request<UsageStatsRow[]>(h, `/api/usage${qs({ from, to })}`),

  pair: (h: HostConfig) =>
    request<{ urls: string[]; token: string; hint?: string }>(h, '/api/pair'),
}

/** 导入外部会话时可选的目标账号 / 分组 / 模型；不填则沿用原软件上下文。 */
export interface ExternalImportInput {
  profileId?: string
  groupId?: string
  model?: string
}
