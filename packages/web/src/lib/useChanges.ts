import { useCallback, useEffect, useState } from 'react'
import type { ChangesResult } from '@tandem/protocol'
import { api } from './api'
import { isDraftSession } from './draftSession'
import type { HostConfig } from './types'

/** 拉取会话工作区的 git 改动；nonce 变化（回合结束等）时自动刷新。 */
export function useSessionChanges(
  host: HostConfig | null | undefined,
  sessionId: string | null | undefined,
  nonce: number,
  enabled = true,
) {
  const [changes, setChanges] = useState<ChangesResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!host || !sessionId || !enabled || isDraftSession(sessionId)) return
    let cancelled = false
    setLoading(true)
    api
      .changes(host, sessionId)
      .then((result) => {
        if (cancelled) return
        setChanges(result)
        setError(undefined)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取改动失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, sessionId, nonce, tick, enabled])

  return { changes, loading, error, reload, setChanges }
}
