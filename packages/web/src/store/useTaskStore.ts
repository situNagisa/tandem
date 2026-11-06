import { create } from 'zustand'
import type { BackgroundTask } from '@tandem/protocol'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'

export interface TaskOutputState {
  text: string
  since: number
  truncated?: boolean
}

interface TaskState {
  byHost: Record<string, BackgroundTask[]>
  outputs: Record<string, Record<string, TaskOutputState>>
  loading: Record<string, boolean>
  /** 本 Host 已加载过任务列表（面板首次打开时再补拉）。 */
  loaded: Record<string, boolean>

  refresh: (host: HostConfig) => Promise<BackgroundTask[]>
  loadOutput: (host: HostConfig, taskId: string, since?: number) => Promise<void>
  kill: (host: HostConfig, taskId: string) => Promise<BackgroundTask | null>
  applyEvent: (
    hostId: string,
    task: BackgroundTask,
    content?: string,
    since?: number,
    truncated?: boolean,
  ) => void
  resetHost: (hostId: string) => void
}

const MAX_CLIENT_OUTPUT = 2_000_000

export const useTaskStore = create<TaskState>((set, get) => ({
  byHost: {},
  outputs: {},
  loading: {},
  loaded: {},

  refresh: async (host) => {
    if (get().loading[host.id]) return get().byHost[host.id] ?? []
    set((s) => ({ loading: { ...s.loading, [host.id]: true } }))
    try {
      const tasks = await api.tasks(host)
      set((s) => ({
        byHost: { ...s.byHost, [host.id]: tasks },
        loading: { ...s.loading, [host.id]: false },
        loaded: { ...s.loaded, [host.id]: true },
      }))
      return tasks
    } catch {
      set((s) => ({ loading: { ...s.loading, [host.id]: false } }))
      return get().byHost[host.id] ?? []
    }
  },

  loadOutput: async (host, taskId, since = 0) => {
    const data = await api.taskOutput(host, taskId, since)
    set((s) => {
      const previous = s.outputs[host.id]?.[taskId]
      // since=0 表示重新拉全量，直接替换；否则按位移续接并去重
      const text = since === 0 || !previous ? data.content : mergeChunk(previous, data)
      return {
        outputs: {
          ...s.outputs,
          [host.id]: {
            ...(s.outputs[host.id] ?? {}),
            [taskId]: { text: text.slice(-MAX_CLIENT_OUTPUT), since: data.since, ...(data.truncated || previous?.truncated ? { truncated: true } : {}) },
          },
        },
        byHost: {
          ...s.byHost,
          [host.id]: (s.byHost[host.id] ?? []).map((t) => (t.id === taskId ? data.task : t)),
        },
      }
    })
  },

  kill: async (host, taskId) => {
    try {
      const task = await api.killTask(host, taskId)
      get().applyEvent(host.id, task)
      return task
    } catch {
      return null
    }
  },

  applyEvent: (hostId, task, content, since, truncated) => {
    set((s) => {
      const list = s.byHost[hostId] ?? []
      const exists = list.some((t) => t.id === task.id)
      const byHost = {
        ...s.byHost,
        [hostId]: exists
          ? list.map((t) => (t.id === task.id ? task : t))
          : [task, ...list],
      }
      if (!content && !truncated) return { byHost }
      const previous = s.outputs[hostId]?.[task.id]
      const base =
        previous ??
        ({
          text: '',
          since: since !== undefined ? Math.max(0, since - contentLength(content)) : 0,
        } satisfies TaskOutputState)
      const nextText = `${base.text}${content ?? ''}`.slice(-MAX_CLIENT_OUTPUT)
      return {
        byHost,
        outputs: {
          ...s.outputs,
          [hostId]: {
            ...(s.outputs[hostId] ?? {}),
            [task.id]: {
              text: nextText,
              since: since ?? base.since + contentLength(content),
              ...(truncated || base.truncated ? { truncated: true } : {}),
            },
          },
        },
      }
    })
  },

  resetHost: (hostId) => {
    set((s) => {
      const byHost = { ...s.byHost }
      const outputs = { ...s.outputs }
      delete byHost[hostId]
      delete outputs[hostId]
      return { byHost, outputs }
    })
  },
}))

function contentLength(content?: string): number {
  return content ? content.length : 0
}

/** 位移对得上就直接拼接；服务端缓冲起点前移时用返回内容兜底。 */
function mergeChunk(previous: TaskOutputState, data: { content: string; since: number }): string {
  if (data.since < previous.since) return data.content
  const overlap = previous.since - (data.since - data.content.length)
  if (overlap > 0 && overlap < data.content.length) {
    return previous.text + data.content.slice(overlap)
  }
  return previous.text + data.content
}
