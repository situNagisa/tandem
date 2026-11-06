import { create } from 'zustand'
import type { SettingsTab, Theme, Toast } from '../lib/types'
import {
  loadCollapsedProjects,
  loadSidebarWidth,
  loadTheme,
  loadUiPrefs,
  saveCollapsedProjects,
  saveSidebarWidth,
  saveTheme,
  saveUiPrefs,
} from '../lib/storage'

let toastSeq = 1
const toastTimers = new Map<number, number>()

interface UiState {
  theme: Theme
  sidebarCollapsed: boolean
  sidebarWidth: number
  collapsedProjects: Record<string, boolean>
  showArchived: boolean
  showSubagents: boolean
  showExternalSessions: boolean
  panelOpen: boolean
  changesOpen: boolean
  changesWidth: number
  mobileSidebar: boolean
  mobilePanel: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  newSessionOpen: boolean
  searchOpen: boolean
  notifications: boolean
  toasts: Toast[]
  promptSeed: { text: string; nonce: number } | null

  setTheme: (theme: Theme) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  toggleProject: (key: string) => void
  setShowArchived: (show: boolean) => void
  setShowSubagents: (show: boolean) => void
  setShowExternalSessions: (show: boolean) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  setChangesOpen: (open: boolean) => void
  toggleChanges: () => void
  setChangesWidth: (width: number) => void
  setMobileSidebar: (open: boolean) => void
  setMobilePanel: (open: boolean) => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setSettingsTab: (tab: SettingsTab) => void
  setNewSessionOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setNotifications: (enabled: boolean) => void
  toast: (text: string, kind?: Toast['kind'], options?: { onClick?: () => void }) => void
  dismissToast: (id: number) => void
  seedPrompt: (text: string) => void
  clearPromptSeed: () => void
}

const prefs = loadUiPrefs()

export const useUiStore = create<UiState>((set, get) => ({
  theme: loadTheme(),
  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  sidebarWidth: loadSidebarWidth(),
  collapsedProjects: loadCollapsedProjects(),
  showArchived: false,
  showSubagents: prefs.showSubagents ?? false,
  showExternalSessions: prefs.showExternalSessions ?? true,
  panelOpen: prefs.panelOpen ?? true,
  changesOpen: false,
  changesWidth: Math.min(760, Math.max(380, prefs.changesWidth ?? 520)),
  mobileSidebar: false,
  mobilePanel: false,
  settingsOpen: false,
  settingsTab: 'profiles',
  newSessionOpen: false,
  searchOpen: false,
  notifications: prefs.notifications ?? true,
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
  setSidebarWidth: (width) => {
    const next = Math.min(400, Math.max(220, Math.round(width)))
    saveSidebarWidth(next)
    set({ sidebarWidth: next })
  },
  toggleProject: (key) => {
    const next = { ...get().collapsedProjects, [key]: !get().collapsedProjects[key] }
    saveCollapsedProjects(next)
    set({ collapsedProjects: next })
  },
  setShowArchived: (show) => set({ showArchived: show }),
  setShowSubagents: (show) => {
    saveUiPrefs({ showSubagents: show })
    set({ showSubagents: show })
  },
  setShowExternalSessions: (show) => {
    saveUiPrefs({ showExternalSessions: show })
    set({ showExternalSessions: show })
  },
  setPanelOpen: (open) => {
    saveUiPrefs({ panelOpen: open })
    set({ panelOpen: open })
  },
  togglePanel: () => get().setPanelOpen(!get().panelOpen),
  setChangesOpen: (open) =>
    set((s) => ({ changesOpen: open, ...(open ? { panelOpen: false } : {}) })),
  toggleChanges: () => get().setChangesOpen(!get().changesOpen),
  setChangesWidth: (width) => {
    const next = Math.min(760, Math.max(380, Math.round(width)))
    saveUiPrefs({ changesWidth: next })
    set({ changesWidth: next })
  },
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
  setNotifications: (enabled) => {
    saveUiPrefs({ notifications: enabled })
    set({ notifications: enabled })
  },
  toast: (text, kind = 'info', options) => {
    const id = toastSeq++
    set((s) => ({
      toasts: [...s.toasts.slice(-3), { id, kind, text, onClick: options?.onClick }],
    }))
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
  if (meta) meta.setAttribute('content', dark ? '#262624' : '#faf9f5')
}
