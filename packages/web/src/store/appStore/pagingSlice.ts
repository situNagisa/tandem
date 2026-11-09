import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import {
  MESSAGE_PAGE_SIZE,
  fillGapPage,
  mergeOlderPage,
  mergeSegmentPage,
} from '../../lib/messagePaging'
import type { SessionTarget } from '../../lib/types'
import { collectToolResults, toast, viewKeyOf } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type PagingSlice = Pick<
  AppState,
  | 'loadEarlierMessages'
  | 'loadSessionTurns'
  | 'ensureMessageLoaded'
  | 'fillMessageGap'
  | 'loadTurnRange'
>

/** 大会话按需加载：向前翻页、轮次大纲、跳转到未加载的轮/搜索命中、补齐缺口。 */
export function createPagingSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): PagingSlice {
  const { getHost, patchView } = core

  const viewOf = (target?: SessionTarget | null) =>
    target
      ? (get().sessionViews[viewKeyOf(target.hostId, target.sessionId)] ?? null)
      : get().active

  const loadEarlierMessages = async (target?: SessionTarget): Promise<boolean> => {
    const view = viewOf(target)
    if (!view || view.loadingEarlier || !view.hasEarlier) return false
    const host = getHost(view.hostId)
    const before = view.firstMessageId ?? view.messages.find((message) => !message.gap)?.id
    if (!host || !before) return false
    patchView(view.hostId, view.sessionId, (active) => ({ ...active, loadingEarlier: true }))
    try {
      const page = await api.sessionMessages(host, view.sessionId, {
        before,
        limit: MESSAGE_PAGE_SIZE,
      })
      patchView(view.hostId, view.sessionId, (active) => {
        // 等待期间收到新快照/重新加载：锚点已变，丢弃这一页。
        if (active.firstMessageId !== before) return { ...active, loadingEarlier: false }
        const merged = mergeOlderPage(active.messages, page)
        return {
          ...active,
          ...merged,
          loadingEarlier: false,
          toolResults: collectToolResults(page.messages, active.toolResults),
        }
      })
      return true
    } catch (err) {
      patchView(view.hostId, view.sessionId, (active) => ({ ...active, loadingEarlier: false }))
      toast(err instanceof Error ? err.message : '加载更早消息失败', 'error')
      return false
    }
  }

  const loadSessionTurns = async (hostId: string, sessionId: string): Promise<void> => {
    const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
    if (!view || view.turns || view.loadingTurns) return
    const host = getHost(hostId)
    if (!host) return
    patchView(hostId, sessionId, (active) => ({ ...active, loadingTurns: true }))
    try {
      const data = await api.sessionTurns(host, sessionId)
      patchView(hostId, sessionId, (active) =>
        active.loadingTurns
          ? { ...active, turns: data.turns, totalMessages: data.totalMessages, loadingTurns: false }
          : active,
      )
    } catch {
      patchView(hostId, sessionId, (active) => ({ ...active, loadingTurns: false }))
    }
  }

  const ensureMessageLoaded = async (
    hostId: string,
    sessionId: string,
    messageId: string,
  ): Promise<boolean> => {
    const key = viewKeyOf(hostId, sessionId)
    const view = get().sessionViews[key]
    if (!view) return false
    if (view.messages.some((message) => message.id === messageId)) return true
    if (view.loadingSegment) return false
    const host = getHost(hostId)
    if (!host) return false
    patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: true }))
    try {
      const page = await api.sessionMessages(host, sessionId, {
        around: messageId,
        limit: MESSAGE_PAGE_SIZE,
      })
      if (!page.messages.some((message) => message.id === messageId)) {
        patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: false }))
        return false
      }
      patchView(hostId, sessionId, (active) => {
        if (active.messages.some((message) => message.id === messageId)) {
          return { ...active, loadingSegment: false }
        }
        const merged = mergeSegmentPage(active.messages, page, active.hasEarlier)
        return {
          ...active,
          ...merged,
          loadingSegment: false,
          toolResults: collectToolResults(page.messages, active.toolResults),
        }
      })
      return true
    } catch (err) {
      patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: false }))
      toast(err instanceof Error ? err.message : '加载该轮消息失败', 'error')
      return false
    }
  }

  const fillMessageGap = async (
    hostId: string,
    sessionId: string,
    gapId: string,
  ): Promise<boolean> => {
    const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
    const gap = view?.messages.find((message) => message.id === gapId)?.gap
    if (!view || !gap) return false
    const host = getHost(hostId)
    if (!host) return false
    const before = gap.beforeId
    patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: true }))
    try {
      const page = await api.sessionMessages(host, sessionId, {
        before,
        limit: MESSAGE_PAGE_SIZE,
      })
      patchView(hostId, sessionId, (active) => {
        const index = active.messages.findIndex(
          (message) => message.gap?.beforeId === before,
        )
        if (index < 0) return { ...active, loadingSegment: false }
        const merged = fillGapPage(active.messages, index, page, active.hasEarlier)
        return {
          ...active,
          ...merged,
          loadingSegment: false,
          toolResults: collectToolResults(page.messages, active.toolResults),
        }
      })
      return true
    } catch (err) {
      patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: false }))
      toast(err instanceof Error ? err.message : '加载中间消息失败', 'error')
      return false
    }
  }

  /**
   * 占位条「加载前 10 轮 / 全部」：按轮次 id 逐段取回。
   * 每次 around 取一页（与已加载区间自动拼接，缺口由 mergeSegmentPage 收紧），
   * 每一轮取到后重新判断是否还需要请求，长段也不会一次性拉全量。
   */
  const loadTurnRange = async (
    hostId: string,
    sessionId: string,
    messageIds: string[],
  ): Promise<boolean> => {
    const key = viewKeyOf(hostId, sessionId)
    const view = get().sessionViews[key]
    if (!view || view.loadingSegment || messageIds.length === 0) return false
    const host = getHost(hostId)
    if (!host) return false
    const isLoaded = (id: string) =>
      get().sessionViews[key]?.messages.some((message) => message.id === id) ?? false
    const pending = messageIds.filter((id) => !isLoaded(id))
    if (pending.length === 0) return true
    patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: true }))
    try {
      for (const id of pending) {
        if (isLoaded(id)) continue
        const page = await api.sessionMessages(host, sessionId, {
          around: id,
          limit: MESSAGE_PAGE_SIZE,
        })
        if (!page.messages.length) continue
        patchView(hostId, sessionId, (active) => {
          if (active.messages.some((message) => message.id === id)) return active
          const merged = mergeSegmentPage(active.messages, page, active.hasEarlier)
          return {
            ...active,
            ...merged,
            toolResults: collectToolResults(page.messages, active.toolResults),
          }
        })
      }
      patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: false }))
      return true
    } catch (err) {
      patchView(hostId, sessionId, (active) => ({ ...active, loadingSegment: false }))
      toast(err instanceof Error ? err.message : '加载这一段的对话失败', 'error')
      return false
    }
  }

  return {
    loadEarlierMessages,
    loadSessionTurns,
    ensureMessageLoaded,
    fillMessageGap,
    loadTurnRange,
  }
}
