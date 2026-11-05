import { create } from 'zustand'
import type { SettingsTab, Theme, Toast } from '../lib/types'
import { loadTheme, loadUiPrefs, saveTheme, saveUiPrefs } from '../lib/storage'

let toastSeq = 1
const toastTimers = new Map<number, number>()

interface UiState {
  theme: Theme
  sidebarCollapsed: boolean
  panelOpen: boolean
  mobileSidebar: boolean
  mobilePanel: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  newSessionOpen: boolean
  searchOpen: boolean
  toasts: Toast[]
  promptSeed: { text: string; nonce: number } | null

  setTheme: (theme: Theme) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  setMobileSidebar: (open: boolean) => void
  setMobilePanel: (open: boolean) => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setSettingsTab: (tab: SettingsTab) => void
  setNewSessionOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  seedPrompt: (text: string) => void
  clearPromptSeed: () => void
}

const prefs = loadUiPrefs()

export const useUiStore = create<UiState>((set, get) => ({
  theme: loadTheme(),
  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  panelOpen: prefs.panelOpen ?? true,
  mobileSidebar: false,
  mobilePanel: false,
  settingsOpen: false,
  settingsTab: 'profiles',
  newSessionOpen: false,
  searchOpen: false,
  toasts: [],
  promptSeed: null,

  setTheme: (theme) => {
    saveTheme(theme)
    set({ theme })
    applyTheme(theme)
  },
  setSidebarCollapsed: (collapsed) => {
    saveUiPrefs({ sidebarCollapsed: collapsed })
    set({ sidebarCollapsed: collapsed })
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setPanelOpen: (open) => {
    saveUiPrefs({ panelOpen: open })
    set({ panelOpen: open })
  },
  togglePanel: () => get().setPanelOpen(!get().panelOpen),
  setMobileSidebar: (open) => set({ mobileSidebar: open }),
  setMobilePanel: (open) => set({ mobilePanel: open }),
  openSettings: (tab) =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: tab ?? s.settingsTab,
      mobileSidebar: false,
      mobilePanel: false,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setNewSessionOpen: (open) => set({ newSessionOpen: open, mobileSidebar: false }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  toast: (text, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    const timer = window.setTimeout(() => {
      toastTimers.delete(id)
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 4500)
    toastTimers.set(id, timer)
  },
  dismissToast: (id) => {
    const timer = toastTimers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimers.delete(id)
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  seedPrompt: (text) => set({ promptSeed: { text, nonce: Date.now() } }),
  clearPromptSeed: () => set({ promptSeed: null }),
}))

export function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#1b1a18' : '#f6f3ee')
}
