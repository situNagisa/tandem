import { create } from 'zustand'
import {
  loadFeedbackState,
  saveFeedbackState,
  type FeedbackItem,
  type FeedbackPageShot,
} from '../lib/feedback'

interface FeedbackState {
  active: boolean
  hydrated: boolean
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
  enter: () => void
  exit: () => void
  hydrate: () => Promise<void>
  upsertItem: (item: FeedbackItem) => void
  removeItem: (id: string) => void
  addPageShot: (shot: FeedbackPageShot) => void
  clear: () => void
}

function persist(items: FeedbackItem[], pageShots: FeedbackPageShot[]): void {
  void saveFeedbackState({ items, pageShots })
}

export const useFeedbackStore = create<FeedbackState>()((set, get) => ({
  active: false,
  hydrated: false,
  items: [],
  pageShots: [],

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
    set({ hydrated: true, items: merged, pageShots: shots })
  },

  upsertItem: (item) => {
    const items = get().items
    const index = items.findIndex((entry) => entry.id === item.id)
    const next = index >= 0 ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item]
    set({ items: next })
    persist(next, get().pageShots)
  },

  removeItem: (id) => {
    const next = get().items.filter((item) => item.id !== id)
    set({ items: next })
    persist(next, get().pageShots)
  },

  addPageShot: (shot) => {
    const next = [...get().pageShots.filter((entry) => entry.route !== shot.route), shot].slice(-12)
    set({ pageShots: next })
    persist(get().items, next)
  },

  clear: () => {
    set({ items: [], pageShots: [] })
    persist([], [])
  },
}))
