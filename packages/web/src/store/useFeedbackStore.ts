import { create } from 'zustand'
import {
  loadFeedbackState,
  saveFeedbackState,
  type FeedbackItem,
  type FeedbackPageShot,
  type FeedbackReceipt,
} from '../lib/feedback'
import type { FeedbackTag } from '../lib/feedbackFeatures'

interface FeedbackState {
  active: boolean
  hydrated: boolean
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
  receipt: FeedbackReceipt | null
  /** 从体验清单「有问题」进入时预置的功能/根因标签，保存一条后清除。 */
  pendingFeature: FeedbackTag | null
  enter: () => void
  exit: () => void
  hydrate: () => Promise<void>
  upsertItem: (item: FeedbackItem) => void
  removeItem: (id: string) => void
  moveItem: (from: number, to: number) => void
  importReceipt: (receipt: FeedbackReceipt) => void
  clearReceipt: () => void
  setVerification: (id: string, result: 'pass' | 'fail', note?: string) => void
  addPageShot: (shot: FeedbackPageShot) => void
  setPendingFeature: (tag: FeedbackTag | null) => void
  clear: () => void
}

function persist(
  items: FeedbackItem[],
  pageShots: FeedbackPageShot[],
  receipt: FeedbackReceipt | null,
): void {
  void saveFeedbackState({ items, pageShots, receipt })
}

export const useFeedbackStore = create<FeedbackState>()((set, get) => ({
  active: false,
  hydrated: false,
  items: [],
  pageShots: [],
  receipt: null,
  pendingFeature: null,

  enter: () => {
    set({ active: true })
    void get().hydrate()
  },

  exit: () => set({ active: false }),

  hydrate: async () => {
    if (get().hydrated) return
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
    set({
      hydrated: true,
      items: merged,
      pageShots: shots,
      receipt: get().receipt ?? stored.receipt ?? null,
    })
  },

  upsertItem: (item) => {
    const items = get().items
    const index = items.findIndex((entry) => entry.id === item.id)
    const next = index >= 0 ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]
    set({ items: next })
    persist(next, get().pageShots, get().receipt)
  },

  removeItem: (id) => {
    const next = get().items.filter((item) => item.id !== id)
    set({ items: next })
    persist(next, get().pageShots, get().receipt)
  },

  moveItem: (from, to) => {
    const items = get().items.slice()
    if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return
    const [moved] = items.splice(from, 1)
    items.splice(to, 0, moved)
    set({ items })
    persist(items, get().pageShots, get().receipt)
  },

  importReceipt: (receipt) => {
    set({ receipt })
    persist(get().items, get().pageShots, receipt)
  },

  clearReceipt: () => {
    set({ receipt: null })
    persist(get().items, get().pageShots, null)
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
    persist(get().items, get().pageShots, next)
  },

  setPendingFeature: (tag) => set({ pendingFeature: tag }),

  addPageShot: (shot) => {
    const next = [...get().pageShots.filter((entry) => entry.route !== shot.route), shot].slice(-12)
    set({ pageShots: next })
    persist(get().items, next, get().receipt)
  },

  clear: () => {
    set({ items: [], pageShots: [], receipt: null, pendingFeature: null })
    persist([], [], null)
  },
}))
