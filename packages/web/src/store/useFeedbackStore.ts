import { create } from 'zustand'
import {
  loadFeedbackState,
  saveFeedbackState,
  type FeedbackDraftInfo,
  type FeedbackItem,
  type FeedbackPageShot,
  type FeedbackReceipt,
} from '../lib/feedback'
import { draftFolderName } from '../lib/feedbackArchive'
import type { FeedbackTag } from '../lib/feedbackFeatures'

interface HydrateResult {
  restored: number
  /** 恢复出来的是尚未导出的草稿。 */
  unexported: boolean
}

interface FeedbackState {
  active: boolean
  hydrated: boolean
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
  receipt: FeedbackReceipt | null
  /** 当前草稿：有未导出内容时随记录实时落盘。 */
  draft: FeedbackDraftInfo | null
  /** 从体验清单「有问题」进入时预置的功能/根因标签，保存一条后清除。 */
  pendingFeature: FeedbackTag | null
  enter: () => void
  exit: () => void
  hydrate: () => Promise<HydrateResult>
  upsertItem: (item: FeedbackItem) => void
  removeItem: (id: string) => void
  moveItem: (from: number, to: number) => void
  importReceipt: (receipt: FeedbackReceipt) => void
  clearReceipt: () => void
  setVerification: (id: string, result: 'pass' | 'fail', note?: string) => void
  addPageShot: (shot: FeedbackPageShot) => void
  setPendingFeature: (tag: FeedbackTag | null) => void
  markExported: () => FeedbackDraftInfo | null
  clear: () => void
}

function startDraft(now = Date.now()): FeedbackDraftInfo {
  return { id: draftFolderName(new Date(now)), startedAt: now }
}

/** 已有未导出草稿就沿用（刷新后继续写同一个目录）；导出后新条目开新草稿。 */
function ensureDraft(draft: FeedbackDraftInfo | null): FeedbackDraftInfo {
  if (draft && !draft.exportedAt) return draft
  return startDraft()
}

function persist(
  items: FeedbackItem[],
  pageShots: FeedbackPageShot[],
  receipt: FeedbackReceipt | null,
  draft: FeedbackDraftInfo | null,
): void {
  void saveFeedbackState({ items, pageShots, receipt, draft })
}

function draftForItems(
  draft: FeedbackDraftInfo | null,
  items: FeedbackItem[],
): FeedbackDraftInfo | null {
  if (items.length === 0) return draft
  return ensureDraft(draft)
}

export const useFeedbackStore = create<FeedbackState>()((set, get) => ({
  active: false,
  hydrated: false,
  items: [],
  pageShots: [],
  receipt: null,
  draft: null,
  pendingFeature: null,

  enter: () => {
    set({ active: true })
    void get().hydrate()
  },

  exit: () => set({ active: false }),

  hydrate: async (): Promise<HydrateResult> => {
    if (get().hydrated) {
      const state = get()
      return {
        restored: state.items.length,
        unexported: !!state.draft && !state.draft.exportedAt && state.items.length > 0,
      }
    }
    const stored = await loadFeedbackState()
    const existing = get().items
    const merged = [...stored.items]
    for (const item of existing) {
      if (!merged.some((entry) => entry.id === item.id)) merged.push(item)
    }
    const shots = [...stored.pageShots]
    for (const shot of get().pageShots) {
      if (!shots.some((entry) => entry.id === shot.id)) shots.push(shot)
    }
    const draft =
      get().draft ??
      stored.draft ??
      (merged.length
        ? { id: draftFolderName(new Date(merged[0].createdAt || Date.now())), startedAt: merged[0].createdAt || Date.now() }
        : null)
    set({
      hydrated: true,
      items: merged,
      pageShots: shots,
      receipt: get().receipt ?? stored.receipt ?? null,
      draft,
    })
    persist(merged, shots, get().receipt, draft)
    return {
      restored: merged.length,
      unexported: !!draft && !draft.exportedAt && merged.length > 0,
    }
  },

  upsertItem: (item) => {
    const items = get().items
    const index = items.findIndex((entry) => entry.id === item.id)
    const next = index >= 0 ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]
    const draft = ensureDraft(get().draft)
    set({ items: next, draft })
    persist(next, get().pageShots, get().receipt, draft)
  },

  removeItem: (id) => {
    const next = get().items.filter((item) => item.id !== id)
    set({ items: next })
    persist(next, get().pageShots, get().receipt, get().draft)
  },

  moveItem: (from, to) => {
    const items = get().items.slice()
    if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return
    const [moved] = items.splice(from, 1)
    items.splice(to, 0, moved)
    const draft = draftForItems(get().draft, items)
    set({ items, draft })
    persist(items, get().pageShots, get().receipt, draft)
  },

  importReceipt: (receipt) => {
    set({ receipt })
    persist(get().items, get().pageShots, receipt, get().draft)
  },

  clearReceipt: () => {
    set({ receipt: null })
    persist(get().items, get().pageShots, null, get().draft)
  },

  setVerification: (id, result, note) => {
    const receipt = get().receipt
    if (!receipt) return
    const items = receipt.items.map((entry) =>
      entry.id === id
        ? { ...entry, verification: { result, note, at: Date.now() } }
        : entry,
    )
    const next = { ...receipt, items }
    set({ receipt: next })
    persist(get().items, get().pageShots, next, get().draft)
  },

  setPendingFeature: (tag) => set({ pendingFeature: tag }),

  addPageShot: (shot) => {
    const next = [...get().pageShots.filter((entry) => entry.route !== shot.route), shot].slice(-12)
    const draft = draftForItems(get().draft, get().items)
    set({ pageShots: next, draft })
    persist(get().items, next, get().receipt, draft)
  },

  markExported: () => {
    const draft = get().draft
    if (!draft) return null
    const next = { ...draft, exportedAt: Date.now() }
    // 导出后条目清空：桌面草稿目录与 IndexedDB 记录保留 7 天，新记录进新草稿。
    set({ items: [], pageShots: [], draft: next })
    persist([], [], get().receipt, next)
    return next
  },

  clear: () => {
    set({ items: [], pageShots: [], receipt: null, pendingFeature: null, draft: null })
    persist([], [], null, null)
  },
}))
