// 工作站请求统一处理访问令牌过期：刷新一次再重试。
import { ApiError } from './api'
import { useAppStore } from '../store/useAppStore'

export async function withWorkstationSession<T>(
  run: (centerUrl: string, token: string) => Promise<T>,
): Promise<T> {
  const session = useAppStore.getState().account
  if (!session) throw new Error('请先登录工作站')
  try {
    return await run(session.centerUrl, session.accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
    if (!(await useAppStore.getState().refreshWorkspace())) throw err
    const fresh = useAppStore.getState().account
    if (!fresh) throw err
    return await run(fresh.centerUrl, fresh.accessToken)
  }
}
