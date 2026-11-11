import { useEffect, useMemo, useState } from 'react'
import type { SessionGraphTree } from '@tandem/protocol'
import { api } from '../../lib/api'
import { sessionTreeRootId } from '../../lib/sessionTree'
import { useAppStore } from '../../store/useAppStore'

/** 一棵会话树只拉一次：同树的主会话/分叉共用同一份拓扑（切主线不重新请求）。 */
const cache = new Map<string, SessionGraphTree>()

/**
 * 会话树拓扑：根 + 递归分叉 + 所有子代理的轮次摘要与接入关系。
 * 按树的根缓存；树内任何会话的更新时间变化（新轮次、分叉、子代理结束）时重新拉取。
 */
export function useSessionGraphTree(
  hostId: string | null,
  sessionId: string | null,
): SessionGraphTree | null {
  const sessions = useAppStore((s) => (hostId ? s.runtimes[hostId]?.sessions : undefined))
  const { rootId, signature } = useMemo(() => {
    const all = sessions ?? []
    const byId = new Map(all.map((session) => [session.id, session]))
    const target = sessionId ? byId.get(sessionId) : undefined
    if (!target) return { rootId: sessionId ?? null, signature: '' }
    const root = sessionTreeRootId(target, byId)
    const members = all
      .filter((session) => sessionTreeRootId(session, byId) === root)
      .sort((a, b) => a.id.localeCompare(b.id))
    const signature = members
      .map((session) => `${session.id}:${session.updatedAt}:${session.title}`)
      .join('|')
    return { rootId: root, signature }
  }, [sessions, sessionId])

  const key = hostId && rootId ? `${hostId}:${rootId}` : null
  const [tree, setTree] = useState<SessionGraphTree | null>(() => (key ? (cache.get(key) ?? null) : null))

  useEffect(() => {
    if (!key) {
      setTree(null)
      return
    }
    // 切会话时先换成这棵树的缓存；没有缓存就清空，避免短暂显示上一棵树的拓扑。
    setTree(cache.get(key) ?? null)
    const host = useAppStore.getState().hosts.find((item) => item.id === hostId)
    if (!host || !rootId) return
    let cancelled = false
    // 连点会话/新轮次到达时合并请求，避免同一棵树在短时间被拉多次。
    const timer = window.setTimeout(() => {
      void api
        .sessionGraph(host, rootId)
        .then((next) => {
          cache.set(key, next)
          if (!cancelled) setTree(next)
        })
        .catch(() => {
          /* Host 暂时不可达：保留上一份拓扑，下次变化再试 */
        })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hostId, key, rootId, signature])

  return tree
}
