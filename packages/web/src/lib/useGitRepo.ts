import { useEffect, useState } from 'react'
import type { SessionEnv } from '@tandem/protocol'
import { api } from './api'
import type { HostConfig } from './types'

export type GitRepoState = 'checking' | 'yes' | 'no'

export interface GitRepoInfo {
  state: GitRepoState
  /** 仓库根与当前分支；检测完成前为 undefined。 */
  env?: SessionEnv
}

/** 目录的 git 环境：新会话页在创建会话前也要显示当前分支与 worktree 能否开启。 */
export function useGitRepo(host: HostConfig | null, cwd: string): GitRepoInfo {
  const [info, setInfo] = useState<GitRepoInfo>({ state: 'checking' })

  useEffect(() => {
    const path = cwd.trim()
    if (!host || !path) {
      setInfo({ state: 'no' })
      return
    }
    let cancelled = false
    setInfo({ state: 'checking' })
    // 目录选择时会连续变化，防抖后再探测。
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.fsGit(host, path)
        if (cancelled) return
        setInfo(result.isRepo ? { state: 'yes', env: result.env } : { state: 'no' })
      } catch {
        if (!cancelled) setInfo({ state: 'no' })
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [host, cwd])

  return info
}
