// 项目 Wiki 客户端状态：元数据/页面/任务的轻量缓存；WS 事件到达时按 Host 刷新。
import { create } from 'zustand'
import type { HostConfig } from '../lib/types'
import type { WikiJob, WikiMeta, WikiPage } from '@tandem/protocol'
import { api } from '../lib/api'

interface WikiEntry {
  hostId: string
  project: string
  meta: WikiMeta | null
  pages: Record<string, WikiPage>
  jobs: WikiJob[]
  loading: boolean
  error?: string
}

interface WikiState {
  entries: Record<string, WikiEntry>
  /** 拉取元数据与任务；page 存在时同时刷新该页。 */
  refresh: (host: HostConfig, project: string, page?: string) => Promise<void>
  loadPage: (host: HostConfig, project: string, page: string, force?: boolean) => Promise<WikiPage | null>
  saveManual: (host: HostConfig, project: string, page: string, manual: string) => Promise<WikiPage | null>
  applyJob: (hostId: string, job: WikiJob) => void
  onUpdated: (hostId: string) => void
  reset: () => void
}

const keyOf = (hostId: string, project: string) => `${hostId}\u0000${project}`

/** WikiView 打开时登记 Host 配置，WS 刷新需要用它重新请求。 */
const hostRef = new Map<string, HostConfig>()

function emptyEntry(hostId: string, project: string): WikiEntry {
  return { hostId, project, meta: null, pages: {}, jobs: [], loading: false }
}

export const useWikiStore = create<WikiState>((set, get) => ({
  entries: {},

  refresh: async (host, project, page) => {
    const key = keyOf(host.id, project)
    const current = get().entries[key] ?? emptyEntry(host.id, project)
    set((s) => ({ entries: { ...s.entries, [key]: { ...current, loading: true, error: undefined } } }))
    try {
      const [meta, jobs] = await Promise.all([
        api.wiki(host, project),
        api.wikiJobs(host, project).catch(() => [] as WikiJob[]),
      ])
      set((s) => {
        const base = s.entries[key] ?? emptyEntry(host.id, project)
        return {
          entries: {
            ...s.entries,
            [key]: {
              ...base,
              hostId: host.id,
              project,
              meta,
              jobs,
              loading: false,
            },
          },
        }
      })
      if (page && meta.pages.some((item) => item.id === page)) {
        await get().loadPage(host, project, page, true)
      } else if (meta.pages.length > 0 && !current.pages[meta.pages[0]!.id]) {
        await get().loadPage(host, project, meta.pages[0]!.id)
      }
    } catch (err) {
      set((s) => {
        const base = s.entries[key] ?? emptyEntry(host.id, project)
        return { entries: { ...s.entries, [key]: { ...base, loading: false, error: (err as Error).message } } }
      })
    }
  },

  loadPage: async (host, project, page, force) => {
    const key = keyOf(host.id, project)
    const current = get().entries[key]
    if (!force && current?.pages[page]) return current.pages[page]!
    try {
      const loaded = await api.wikiPage(host, project, page)
      set((s) => {
        const base = s.entries[key] ?? emptyEntry(host.id, project)
        return {
          entries: {
            ...s.entries,
            [key]: { ...base, pages: { ...base.pages, [page]: loaded } },
          },
        }
      })
      return loaded
    } catch {
      return null
    }
  },

  saveManual: async (host, project, page, manual) => {
    const key = keyOf(host.id, project)
    try {
      const saved = await api.wikiSavePage(host, { project, page, manual })
      set((s) => {
        const base = s.entries[key] ?? emptyEntry(host.id, project)
        return {
          entries: { ...s.entries, [key]: { ...base, pages: { ...base.pages, [page]: saved } } },
        }
      })
      void get().refresh(host, project)
      return saved
    } catch {
      return null
    }
  },

  applyJob: (hostId, job) => {
    set((s) => {
      let changed = false
      const entries = { ...s.entries }
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.hostId !== hostId) continue
        if (
          entry.project !== job.project &&
          !job.project.startsWith(entry.project) &&
          !entry.project.startsWith(job.project)
        ) {
          continue
        }
        const rest = entry.jobs.filter((item) => item.id !== job.id)
        entries[key] = { ...entry, jobs: [job, ...rest].slice(0, 12) }
        changed = true
      }
      return changed ? { entries } : s
    })
  },

  onUpdated: (hostId) => {
    // 事件只带项目根路径；对当前 Host 每个已加载项目刷新一次（通常 1 个）。
    for (const entry of Object.values(get().entries)) {
      if (entry.hostId !== hostId) continue
      const host = hostRef.get(hostId)
      if (host) void get().refresh(host, entry.project)
    }
  },

  reset: () => set({ entries: {} }),
}))

export function rememberWikiHost(host: HostConfig): void {
  hostRef.set(host.id, host)
}
