// 「添加这台电脑」：用本机 Host 的凭据，就地把它登记为当前账号的主机（不需要复制命令）。
import { ApiError, workstationApi } from './api'
import { findLocalControl } from './localHosts'
import { useAppStore } from '../store/useAppStore'

const POLL_MS = 1000
const TIMEOUT_MS = 30_000

export function canAddThisComputer(): boolean {
  return !!findLocalControl()
}

async function withFreshSession<T>(task: (centerUrl: string, token: string) => Promise<T>): Promise<T> {
  const session = useAppStore.getState().account
  if (!session) throw new Error('请先登录')
  try {
    return await task(session.centerUrl, session.accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
    if (!(await useAppStore.getState().refreshWorkspace())) throw err
    const fresh = useAppStore.getState().account
    if (!fresh) throw err
    return task(fresh.centerUrl, fresh.accessToken)
  }
}

/** 登记并等主机上线；返回主机名。 */
export async function addThisComputer(): Promise<string> {
  const control = findLocalControl()
  if (!control) throw new Error('这个页面不是从本机 Host 打开的，请改用「添加主机」里的一行命令。')
  const session = useAppStore.getState().account
  if (!session) throw new Error('请先登录')
  const bind = await withFreshSession((url, token) => workstationApi.bindCode(url, token))
  await workstationApi.join(control, { workstationUrl: session.centerUrl, code: bind.code })
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const hosts = await withFreshSession((url, token) => workstationApi.hosts(url, token))
    const mine = hosts.find((h) => h.ownerId === session.account.id && h.online)
    if (mine) {
      await useAppStore.getState().syncWorkstationHosts()
      return mine.name
    }
    if (Date.now() > deadline) throw new Error('已登记，但主机还没有上线；稍后会自动出现在列表里。')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
