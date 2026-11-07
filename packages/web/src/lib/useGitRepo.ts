import { useEffect, useState } from 'react'
import { api } from './api'
import { dirname } from './format'
import type { HostConfig } from './types'

export type GitRepoState = 'checking' | 'yes' | 'no'

/** 沿 cwd 向上查找 .git（目录或 worktree 的 gitfile），仅用于新会话的 worktree 开关。 */
export function useGitRepo(host: HostConfig | null, cwd: string, stopAt?: string[]): GitRepoState {
  const [state, setState] = useState<GitRepoState>('checking')

  useEffect(() => {
    const path = cwd.trim()
    if (!host || !path) {
      setState('no')
      return
    }
    let cancelled = false
    setState('checking')
    const timer = window.setTimeout(async () => {
      let current = path
      for (let i = 0; i < 8; i++) {
        try {
          const entries = await api.fsList(host, current)
          if (cancelled) return
          if (entries.some((entry) => entry.name === '.git')) {
            setState('yes')
            return
          }
        } catch {
          break
        }
        // 成员只能看到授权项目：到项目根就停，不再向上探测。
        if (stopAt?.includes(current)) break
        const parent = dirname(current)
        if (!parent || parent === current) break
        current = parent
      }
      if (!cancelled) setState('no')
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [host, cwd, stopAt])

  return state
}
