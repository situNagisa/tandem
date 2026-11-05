import type {
  CreateSessionInput,
  FsEntry,
  HostInfo,
  Profile,
  ProfileInput,
  Session,
  SessionSummary,
  SlashCommand,
  UpdateSessionInput,
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
  deleteSession: (h: HostConfig, id: string) =>
    request<void>(h, `/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  fsList: (h: HostConfig, path: string) =>
    request<FsEntry[]>(h, `/api/fs/list${qs({ path })}`),
  fsComplete: (h: HostConfig, cwd: string, q: string) =>
    request<string[]>(h, `/api/fs/complete${qs({ cwd, q })}`),
  commands: (h: HostConfig) => request<SlashCommand[]>(h, '/api/commands'),
}
