import { create } from 'zustand'
import type { Schedule, ScheduleInput } from '@tandem/protocol'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'

interface ScheduleState {
  byHost: Record<string, Schedule[]>
  loading: Record<string, boolean>
  loaded: Record<string, boolean>
  error: Record<string, string | undefined>

  refresh: (host: HostConfig) => Promise<void>
  create: (host: HostConfig, input: ScheduleInput) => Promise<Schedule>
  update: (host: HostConfig, id: string, input: ScheduleInput) => Promise<Schedule>
  remove: (host: HostConfig, id: string) => Promise<void>
  runNow: (host: HostConfig, id: string) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
  applyList: (hostId: string, schedules: Schedule[]) => void
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  byHost: {},
  loading: {},
  loaded: {},
  error: {},

  refresh: async (host) => {
    if (get().loading[host.id]) return
    set((s) => ({ loading: { ...s.loading, [host.id]: true }, error: { ...s.error, [host.id]: undefined } }))
    try {
      const list = await api.schedules(host)
      set((s) => ({
        byHost: { ...s.byHost, [host.id]: list },
        loading: { ...s.loading, [host.id]: false },
        loaded: { ...s.loaded, [host.id]: true },
      }))
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [host.id]: false },
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '加载定时任务失败' },
      }))
    }
  },

  create: async (host, input) => {
    const schedule = await api.createSchedule(host, input)
    set((s) => ({ byHost: { ...s.byHost, [host.id]: sortSchedules([...(s.byHost[host.id] ?? []), schedule]) } }))
    return schedule
  },

  update: async (host, id, input) => {
    const schedule = await api.updateSchedule(host, id, input)
    set((s) => ({
      byHost: {
        ...s.byHost,
        [host.id]: sortSchedules((s.byHost[host.id] ?? []).map((item) => (item.id === id ? schedule : item))),
      },
    }))
    return schedule
  },

  remove: async (host, id) => {
    await api.deleteSchedule(host, id)
    set((s) => ({
      byHost: { ...s.byHost, [host.id]: (s.byHost[host.id] ?? []).filter((item) => item.id !== id) },
    }))
  },

  runNow: async (host, id) => {
    const result = await api.runSchedule(host, id)
    void get().refresh(host)
    return result
  },

  applyList: (hostId, schedules) => {
    set((s) => ({
      byHost: { ...s.byHost, [hostId]: sortSchedules(schedules) },
      loaded: { ...s.loaded, [hostId]: true },
    }))
  },
}))

function sortSchedules(list: Schedule[]): Schedule[] {
  return list.slice().sort((a, b) => a.createdAt - b.createdAt)
}
