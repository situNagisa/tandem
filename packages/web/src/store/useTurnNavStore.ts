import { create } from 'zustand'

/** 轮次导航的轻量共享状态：顶栏"第 N/M 轮"按钮（手机）与对话区的 TurnRail 之间同步。 */
interface TurnNavState {
  total: number
  active: number
  sheetOpen: boolean
  setProgress: (active: number, total: number) => void
  setSheetOpen: (open: boolean) => void
}

export const useTurnNavStore = create<TurnNavState>((set) => ({
  total: 0,
  active: 1,
  sheetOpen: false,
  setProgress: (active, total) =>
    set((s) => (s.active === active && s.total === total ? s : { active, total })),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}))
