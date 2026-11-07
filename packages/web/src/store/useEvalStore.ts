import { create } from 'zustand'
import type {
  EvalCase,
  EvalRun,
  EvalRunSummary,
  SaveEvalCaseInput,
  StartEvalRunInput,
} from '@tandem/protocol'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'

export interface HostEvalState {
  suites: string[]
  cases: EvalCase[]
  runs: EvalRunSummary[]
  loading: boolean
  loaded: boolean
  error?: string
}

const EMPTY_HOST: HostEvalState = {
  suites: [],
  cases: [],
  runs: [],
  loading: false,
  loaded: false,
}

interface EvalState {
  byHost: Record<string, HostEvalState>
  /** 详情按 hostId/runId 缓存，包含完整轨迹。 */
  details: Record<string, Record<string, EvalRun>>
  /** 每个 Host 当前查看的运行。 */
  selectedRun: Record<string, string | undefined>

  refresh: (host: HostConfig) => Promise<void>
  refreshRuns: (host: HostConfig) => Promise<EvalRunSummary[]>
  refreshCases: (host: HostConfig, suite?: string) => Promise<void>
  saveCase: (host: HostConfig, input: SaveEvalCaseInput) => Promise<EvalCase>
  deleteCase: (host: HostConfig, suite: string, name: string) => Promise<void>
  startRun: (host: HostConfig, input: StartEvalRunInput) => Promise<EvalRun>
  cancelRun: (host: HostConfig, runId: string) => Promise<void>
  loadRun: (host: HostConfig, runId: string) => Promise<EvalRun | null>
  selectRun: (hostId: string, runId?: string) => void
}

function patchHost(
  set: (fn: (state: EvalState) => Partial<EvalState>) => void,
  hostId: string,
  patch: Partial<HostEvalState>,
): void {
  set((state) => ({
    byHost: {
      ...state.byHost,
      [hostId]: { ...(state.byHost[hostId] ?? EMPTY_HOST), ...patch },
    },
  }))
}

export const useEvalStore = create<EvalState>((set, get) => ({
  byHost: {},
  details: {},
  selectedRun: {},

  refresh: async (host) => {
    patchHost(set, host.id, { loading: true, error: undefined })
    try {
      const [suites, cases, runs] = await Promise.all([
        api.evalSuites(host),
        api.evalCases(host),
        api.evalRuns(host),
      ])
      patchHost(set, host.id, {
        suites: suites.suites,
        cases: cases.cases,
        runs,
        loading: false,
        loaded: true,
      })
    } catch (err) {
      patchHost(set, host.id, {
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : '加载评测数据失败',
      })
    }
  },

  refreshRuns: async (host) => {
    try {
      const runs = await api.evalRuns(host)
      patchHost(set, host.id, { runs })
      const selected = get().selectedRun[host.id]
      // 选中的运行还在跑时，详情跟着刷新（含最新轨迹）
      if (selected) {
        const summary = runs.find((run) => run.id === selected)
        if (summary?.status === 'running') {
          void get().loadRun(host, selected)
        }
      }
      return runs
    } catch {
      return get().byHost[host.id]?.runs ?? []
    }
  },

  refreshCases: async (host, suite) => {
    try {
      const [suites, cases] = await Promise.all([
        api.evalSuites(host),
        api.evalCases(host, suite),
      ])
      patchHost(set, host.id, {
        suites: suites.suites,
        cases: suite ? [...cases.cases] : cases.cases,
      })
    } catch (err) {
      patchHost(set, host.id, {
        error: err instanceof Error ? err.message : '加载评测用例失败',
      })
    }
  },

  saveCase: async (host, input) => {
    const created = await api.saveEvalCase(host, input)
    await get().refreshCases(host)
    return created
  },

  deleteCase: async (host, suite, name) => {
    await api.deleteEvalCase(host, suite, name)
    await get().refreshCases(host)
  },

  startRun: async (host, input) => {
    const run = await api.startEvalRun(host, input)
    set((state) => ({
      details: {
        ...state.details,
        [host.id]: { ...(state.details[host.id] ?? {}), [run.id]: run },
      },
      selectedRun: { ...state.selectedRun, [host.id]: run.id },
    }))
    await get().refreshRuns(host)
    return run
  },

  cancelRun: async (host, runId) => {
    await api.cancelEvalRun(host, runId)
    await get().refreshRuns(host)
    void get().loadRun(host, runId)
  },

  loadRun: async (host, runId) => {
    try {
      const run = await api.evalRun(host, runId)
      set((state) => ({
        details: {
          ...state.details,
          [host.id]: { ...(state.details[host.id] ?? {}), [runId]: run },
        },
      }))
      return run
    } catch {
      return null
    }
  },

  selectRun: (hostId, runId) => {
    set((state) => ({ selectedRun: { ...state.selectedRun, [hostId]: runId } }))
  },
}))
