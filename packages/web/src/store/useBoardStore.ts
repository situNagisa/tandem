// 任务看板缓存与轮询：独立于 useAppStore。看板数据以 Host 为准，这里只做缓存与刷新。
import { useEffect } from 'react'
import { create } from 'zustand'
import type { Board, BoardSummary } from '@tandem/protocol'
import { api, ApiError } from '../lib/api'
import type { HostConfig } from '../lib/types'

const key = (hostId: string, boardId: string) => `${hostId}:${boardId}`

interface BoardState {
  summaries: Record<string, BoardSummary[]>
  loaded: Record<string, boolean>
  boards: Record<string, Board>
  error: Record<string, string | undefined>
  refreshList: (host: HostConfig) => Promise<void>
  refreshBoard: (host: HostConfig, boardId: string) => Promise<void>
  applyBoard: (hostId: string, board: Board) => void
  /** Host 推来 board_updated：只刷新已经加载过的列表与已缓存的看板。 */
  onUpdated: (host: HostConfig, boardId: string) => void
  forget: (hostId: string, boardId: string) => void
}

export const useBoardStore = create<BoardState>((set) => ({
  summaries: {},
  loaded: {},
  boards: {},
  error: {},

  refreshList: async (host) => {
    try {
      const list = await api.boards(host)
      set((s) => ({
        summaries: { ...s.summaries, [host.id]: list },
        loaded: { ...s.loaded, [host.id]: true },
        error: { ...s.error, [host.id]: undefined },
      }))
    } catch (err) {
      set((s) => ({
        loaded: { ...s.loaded, [host.id]: true },
        error: { ...s.error, [host.id]: err instanceof Error ? err.message : '加载看板失败' },
      }))
    }
  },

  refreshBoard: async (host, boardId) => {
    try {
      const board = await api.board(host, boardId)
      set((s) => ({ boards: { ...s.boards, [key(host.id, boardId)]: board }, error: { ...s.error, [host.id]: undefined } }))
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        set((s) => {
          const boards = { ...s.boards }
          delete boards[key(host.id, boardId)]
          return { boards }
        })
      }
    }
  },

  applyBoard: (hostId, board) => set((s) => ({ boards: { ...s.boards, [key(hostId, board.id)]: board } })),

  onUpdated: (host, boardId) => {
    const state = useBoardStore.getState()
    if (state.loaded[host.id]) void state.refreshList(host)
    if (state.boards[key(host.id, boardId)]) void state.refreshBoard(host, boardId)
  },

  forget: (hostId, boardId) =>
    set((s) => {
      const boards = { ...s.boards }
      delete boards[key(hostId, boardId)]
      return { boards }
    }),
}))

export function boardKey(hostId: string, boardId: string): string {
  return key(hostId, boardId)
}

/** 看板视图打开期间轮询（页面可见时 2 秒一次）；Host 的 board_updated 事件只是加快它，轮询是兜底。 */
export function useBoardPolling(host: HostConfig | null, boardId: string | undefined): void {
  const refreshList = useBoardStore((s) => s.refreshList)
  const refreshBoard = useBoardStore((s) => s.refreshBoard)
  useEffect(() => {
    if (!host) return
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      void refreshList(host)
      if (boardId) void refreshBoard(host, boardId)
    }
    tick()
    const timer = window.setInterval(tick, 2000)
    return () => window.clearInterval(timer)
  }, [host, boardId, refreshList, refreshBoard])
}

/** 侧栏徽标：需要我处理的卡数，15 秒刷新一次。 */
export function useBoardBadge(host: HostConfig | null): number {
  const refreshList = useBoardStore((s) => s.refreshList)
  const count = useBoardStore((s) =>
    host ? (s.summaries[host.id] ?? []).reduce((sum, item) => sum + item.needsMe, 0) : 0,
  )
  useEffect(() => {
    if (!host) return
    const tick = () => {
      if (document.visibilityState !== 'hidden') void refreshList(host)
    }
    tick()
    const timer = window.setInterval(tick, 15_000)
    return () => window.clearInterval(timer)
  }, [host, refreshList])
  return count
}
