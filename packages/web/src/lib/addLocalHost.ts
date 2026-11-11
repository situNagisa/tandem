// 「添加这台电脑」：工作站就在这台机器上时，把它登记为当前账号的主机（不需要复制命令）。
import { ApiError, workstationApi } from './api'
import { pageIsLoopback } from './localHosts'
import { useAppStore } from '../store/useAppStore'

const POLL_MS = 500
const TIMEOUT_MS = 30_000

export function canAddThisComputer(): boolean {
  return pageIsLoopback() && !!useAppStore.getState().account
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

/** 登记并等主机出现在列表；返回主机名。 */
export async function addThisComputer(): Promise<string> {
  const session = useAppStore.getState().account
  if (!session) throw new Error('请先登录')
  if (!pageIsLoopback()) throw new Error('只有在工作站这台机器上打开页面时才能直接添加本机，其他主机请用「添加主机」里的一行命令。')
  const host = await withFreshSession((url, token) => workstationApi.addLocalHost(url, token))
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    await useAppStore.getState().syncWorkstationHosts()
    const mine = useAppStore.getState().hosts.find((h) => h.hostId === host.id)
    if (mine) return host.name
    if (Date.now() > deadline) throw new Error('已登记，但主机还没有出现在列表里；稍后会自动出现。')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
