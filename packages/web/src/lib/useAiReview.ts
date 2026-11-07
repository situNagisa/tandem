import { create } from 'zustand'
import type { AiReviewRun } from '@tandem/protocol'
import { api } from './api'
import type { HostConfig } from './types'

export type AiReviewAction = 'accepted' | 'ignored' | 'false_positive'

export function aiReviewKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

interface AiReviewEntry {
  review?: AiReviewRun
  starting: boolean
  error?: string
  /** 用户对单条意见的处理；采纳后转为人工评论。 */
  statuses: Record<string, AiReviewAction>
}

interface AiReviewStore {
  byKey: Record<string, AiReviewEntry>
  start: (host: HostConfig, sessionId: string, paths?: string[]) => Promise<AiReviewRun | undefined>
  setStatus: (hostId: string, sessionId: string, findingId: string, action: AiReviewAction) => void
  markFalsePositive: (
    host: HostConfig,
    sessionId: string,
    reviewId: string,
    findingId: string,
  ) => Promise<boolean>
  clear: (key: string) => void
}

const timers = new Map<string, number>()

const EMPTY: AiReviewEntry = { starting: false, statuses: {} }

function patch(
  set: (fn: (state: AiReviewStore) => Partial<AiReviewStore>) => void,
  key: string,
  value: Partial<AiReviewEntry>,
): void {
  set((state) => ({
    byKey: { ...state.byKey, [key]: { ...(state.byKey[key] ?? EMPTY), ...value } },
  }))
}

export const useAiReviewStore = create<AiReviewStore>((set, get) => {
  const stopPoll = (key: string) => {
    const timer = timers.get(key)
    if (timer) window.clearTimeout(timer)
    timers.delete(key)
  }

  const poll = (host: HostConfig, sessionId: string, key: string, review: AiReviewRun) => {
    if (review.status !== 'running') return
    stopPoll(key)
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.aiReview(host, sessionId, review.id)
        patch(set, key, { review: next.review, starting: false })
        poll(host, sessionId, key, next.review)
      } catch (err) {
        patch(set, key, {
          starting: false,
          error: err instanceof Error ? err.message : '读取评审结果失败',
        })
      }
    }, 900)
    timers.set(key, timer)
  }

  return {
    byKey: {},
    start: async (host, sessionId, paths) => {
      const key = aiReviewKey(host.id, sessionId)
      stopPoll(key)
      patch(set, key, { starting: true, error: undefined })
      try {
        const { review } = await api.startAiReview(host, sessionId, paths)
        patch(set, key, { review, starting: false, statuses: {} })
        poll(host, sessionId, key, review)
        return review
      } catch (err) {
        patch(set, key, {
          starting: false,
          error: err instanceof Error ? err.message : '启动 AI 评审失败',
        })
        return undefined
      }
    },
    setStatus: (hostId, sessionId, findingId, action) => {
      const key = aiReviewKey(hostId, sessionId)
      const entry = get().byKey[key]
      if (!entry) return
      patch(set, key, { statuses: { ...entry.statuses, [findingId]: action } })
    },
    markFalsePositive: async (host, sessionId, reviewId, findingId) => {
      const key = aiReviewKey(host.id, sessionId)
      get().setStatus(host.id, sessionId, findingId, 'false_positive')
      try {
        await api.markAiReviewFalsePositive(host, sessionId, reviewId, findingId)
        return true
      } catch {
        return false
      }
    },
    clear: (key) => {
      stopPoll(key)
      set((state) => {
        const next = { ...state.byKey }
        delete next[key]
        return { byKey: next }
      })
    },
  }
})
