import { create } from 'zustand'
import type { VcsState } from '@tandem/protocol'
import { api } from './api'
import type { HostConfig } from './types'

export function vcsKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

interface VcsEntry {
  state?: VcsState
  loading: boolean
  error?: string
  fetchedAt?: number
}

interface VcsStore {
  byKey: Record<string, VcsEntry>
  refresh: (host: HostConfig, sessionId: string, force?: boolean) => Promise<VcsState | undefined>
  apply: (hostId: string, sessionId: string, state: VcsState) => void
}

const inflight = new Map<string, Promise<VcsState | undefined>>()

export const useVcsStore = create<VcsStore>((set, get) => ({
  byKey: {},
  refresh: (host, sessionId, force = false) => {
    const key = vcsKey(host.id, sessionId)
    const current = get().byKey[key]
    // 非强制刷新时 15s 内复用结果，避免顶栏与面板重复请求
    if (!force && current?.state && Date.now() - (current.fetchedAt ?? 0) < 15_000) {
      return Promise.resolve(current.state)
    }
    const existing = inflight.get(key)
    if (existing) return existing
    set((s) => ({
      byKey: { ...s.byKey, [key]: { ...s.byKey[key], loading: true, error: undefined } },
    }))
    const task = api
      .vcs(host, sessionId)
      .then((state) => {
        set((s) => ({
          byKey: {
            ...s.byKey,
            [key]: { state, loading: false, fetchedAt: Date.now() },
          },
        }))
        return state
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '读取 PR 状态失败'
        set((s) => ({
          byKey: { ...s.byKey, [key]: { ...s.byKey[key], loading: false, error: message } },
        }))
        return undefined
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, task)
    return task
  },
  apply: (hostId, sessionId, state) => {
    const key = vcsKey(hostId, sessionId)
    set((s) => ({
      byKey: {
        ...s.byKey,
        [key]: { state, loading: false, fetchedAt: Date.now() },
      },
    }))
  },
}))
