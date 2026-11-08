import { create } from 'zustand'
import type { DemoState } from '@tandem/protocol'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'

interface DemoStore {
  byHost: Record<string, DemoState | undefined>
  loading: Record<string, boolean>
  error: Record<string, string | undefined>
  load: (host: HostConfig) => Promise<DemoState | undefined>
  create: (host: HostConfig) => Promise<DemoState | undefined>
  clear: (host: HostConfig) => Promise<boolean>
  replay: (host: HostConfig, scenarioId: string) => Promise<DemoState | undefined>
  apply: (hostId: string, state: DemoState) => void
  forget: (hostId: string) => void
}

export const useDemoStore = create<DemoStore>()((set, get) => ({
  byHost: {},
  loading: {},
  error: {},

  load: async (host) => {
    try {
      const state = await api.demo(host)
      set((s) => ({ byHost: { ...s.byHost, [host.id]: state }, error: { ...s.error, [host.id]: undefined } }))
      return state
    } catch (err) {
      set((s) => ({
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '读取演示工作区失败' },
      }))
      return undefined
    }
  },

  create: async (host) => {
    set((s) => ({ loading: { ...s.loading, [host.id]: true }, error: { ...s.error, [host.id]: undefined } }))
    try {
      const state = await api.createDemo(host)
      set((s) => ({ byHost: { ...s.byHost, [host.id]: state } }))
      return state
    } catch (err) {
      set((s) => ({
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '创建演示工作区失败' },
      }))
      return undefined
    } finally {
      set((s) => ({ loading: { ...s.loading, [host.id]: false } }))
    }
  },

  clear: async (host) => {
    set((s) => ({ loading: { ...s.loading, [host.id]: true } }))
    try {
      await api.clearDemo(host)
      const state = await api.demo(host)
      set((s) => ({ byHost: { ...s.byHost, [host.id]: state } }))
      return true
    } catch (err) {
      set((s) => ({
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '清除演示工作区失败' },
      }))
      return false
    } finally {
      set((s) => ({ loading: { ...s.loading, [host.id]: false } }))
    }
  },

  replay: async (host, scenarioId) => {
    set((s) => ({ loading: { ...s.loading, [host.id]: true } }))
    try {
      const state = await api.replayDemo(host, scenarioId)
      set((s) => ({ byHost: { ...s.byHost, [host.id]: state } }))
      return state
    } catch (err) {
      set((s) => ({
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '重新播放失败' },
      }))
      return undefined
    } finally {
      set((s) => ({ loading: { ...s.loading, [host.id]: false } }))
    }
  },

  apply: (hostId, state) => set((s) => ({ byHost: { ...s.byHost, [hostId]: state } })),
  forget: (hostId) =>
    set((s) => {
      const byHost = { ...s.byHost }
      delete byHost[hostId]
      return { byHost }
    }),
}))
