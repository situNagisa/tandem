import { create } from 'zustand'
import type { MemoryScope } from '@tandem/protocol'
import type { SettingsTab, Theme, Toast } from '../lib/types'
import type { InviteTarget } from '../lib/inviteLink'
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
const TOAST_DEDUPE_MS = 3000
const recentToastAt = new Map<string, number>()

export interface FilePreviewTarget {
  path: string
  cwd: string
  lineStart?: number
  lineEnd?: number
}

interface UiState {
  theme: Theme
  sidebarCollapsed: boolean
  sidebarWidth: number
  collapsedProjects: Record<string, boolean>
  showArchived: boolean
  showSubagents: boolean
  showExternalSessions: boolean
  hiddenExternalSources: string[]
  panelOpen: boolean
  changesOpen: boolean
  changesWidth: number
  filePreview: FilePreviewTarget | null
  filePreviewWidth: number
  /** 预览面板左侧的文件浏览器是否展开。 */
  fileBrowserVisible: boolean
  fileBrowserWidth: number
  mobileSidebar: boolean
  mobilePanel: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  newSessionOpen: boolean
  searchOpen: boolean
  notifications: boolean
  /** App 本地通知（安卓不经推送服务，直接由常驻连接触发系统通知）。 */
  nativeNotifications: boolean
  /** 安卓前台服务：退到后台后保持 WS，耗电更高，默认关闭。 */
  backgroundService: boolean
  /** 收件箱提醒的事件类型开关。 */
  notifyEvents: { permission: boolean; turnEnd: boolean; error: boolean; budget: boolean }
  /** 收件箱对话框（桌面/移动端均可打开）。 */
  inboxOpen: boolean
  /** 通过邀请链接加入 Host 的弹层。 */
  joinInvite: InviteTarget | null
  /** 派单对话框；hostId 是预选目标。 */
  dispatchOpen: boolean
  dispatchHostId: string | null
  toasts: Toast[]
  promptSeed: { text: string; nonce: number } | null
  /** 右侧代理列表点击后，定位并展开消息流中的对应 Task 卡片。 */
  agentFocus: { id: string; nonce: number } | null
  /** 自增通知输入框清空并聚焦（已在新会话页时再点“新会话”）。 */
  composerResetNonce: number
  /** 每次 /schedule 自增，定时任务页监听到后打开新建表单。 */
  scheduleComposeNonce: number
  /** 后台任务面板：指定 Host/会话，可带要直接查看的任务。 */
  backgroundPanel: { hostId: string; sessionId: string; taskId?: string } | null
  /** 浏览器面板：最新截图与 URL。 */
  browserPanel: { hostId: string; sessionId: string } | null
  /** PR 面板；composeTitle 用于「提交并创建 PR」预填标题。 */
  prOpen: boolean
  prComposeTitle: string
  /** 记忆 Markdown 编辑器；project 为项目根路径，global 时忽略。 */
  memoryEditor: { scope: MemoryScope; project?: string } | null

  setTheme: (theme: Theme) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  toggleProject: (key: string) => void
  setShowArchived: (show: boolean) => void
  setShowSubagents: (show: boolean) => void
  setShowExternalSessions: (show: boolean) => void
  setExternalSourceVisible: (source: string, visible: boolean) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  setChangesOpen: (open: boolean) => void
  toggleChanges: () => void
  setChangesWidth: (width: number) => void
  openFilePreview: (target: FilePreviewTarget) => void
  closeFilePreview: () => void
  setFilePreviewWidth: (width: number) => void
  setFileBrowserVisible: (visible: boolean) => void
  setFileBrowserWidth: (width: number) => void
  setMobileSidebar: (open: boolean) => void
  setMobilePanel: (open: boolean) => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setSettingsTab: (tab: SettingsTab) => void
  setNewSessionOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setNotifications: (enabled: boolean) => void
  setNativeNotifications: (enabled: boolean) => void
  setBackgroundService: (enabled: boolean) => void
  setNotifyEvent: (
    key: 'permission' | 'turnEnd' | 'error' | 'budget',
    enabled: boolean,
  ) => void
  openJoinInvite: (target: InviteTarget) => void
  closeJoinInvite: () => void
  setInboxOpen: (open: boolean) => void
  setDispatchOpen: (open: boolean, hostId?: string) => void
  toast: (
    text: string,
    kind?: Toast['kind'],
    options?: { onClick?: () => void; actionLabel?: string },
  ) => void
  dismissToast: (id: number) => void
  seedPrompt: (text: string) => void
  clearPromptSeed: () => void
  focusAgent: (id: string) => void
  resetComposer: () => void
  openBackgroundTasks: (hostId: string, sessionId: string, taskId?: string) => void
  openScheduleComposer: () => void
  closeBackgroundTasks: () => void
  openBrowserPanel: (hostId: string, sessionId: string) => void
  closeBrowserPanel: () => void
  openPrPanel: (title?: string) => void
  closePrPanel: () => void
  openMemoryEditor: (input: { scope: MemoryScope; project?: string }) => void
  closeMemoryEditor: () => void
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
  hiddenExternalSources: prefs.hiddenExternalSources ?? [],
  panelOpen: prefs.panelOpen ?? true,
  changesOpen: false,
  changesWidth: Math.min(760, Math.max(380, prefs.changesWidth ?? 520)),
  filePreview: null,
  filePreviewWidth: Math.min(900, Math.max(380, prefs.filePreviewWidth ?? 560)),
  fileBrowserVisible: prefs.fileBrowserVisible ?? false,
  fileBrowserWidth: Math.min(360, Math.max(160, prefs.fileBrowserWidth ?? 220)),
  mobileSidebar: false,
  mobilePanel: false,
  settingsOpen: false,
  settingsTab: 'profiles',
  newSessionOpen: false,
  searchOpen: false,
  notifications: prefs.notifications ?? true,
  nativeNotifications: prefs.nativeNotifications ?? true,
  backgroundService: prefs.backgroundService ?? false,
  notifyEvents: {
    permission: prefs.notifyEvents?.permission ?? true,
    turnEnd: prefs.notifyEvents?.turnEnd ?? true,
    error: prefs.notifyEvents?.error ?? true,
    budget: prefs.notifyEvents?.budget ?? true,
  },
  inboxOpen: false,
  joinInvite: null,
  dispatchOpen: false,
  dispatchHostId: null,
  toasts: [],
  promptSeed: null,
  agentFocus: null,
  composerResetNonce: 0,
  backgroundPanel: null,
  browserPanel: null,
  prOpen: false,
  prComposeTitle: '',
  memoryEditor: null,
  scheduleComposeNonce: 0,

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
  setExternalSourceVisible: (source, visible) => {
    const next = new Set(get().hiddenExternalSources)
    if (visible) next.delete(source)
    else next.add(source)
    const hiddenExternalSources = [...next]
    saveUiPrefs({ hiddenExternalSources })
    set({ hiddenExternalSources })
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
  openFilePreview: (target) => set({ filePreview: target }),
  closeFilePreview: () => set({ filePreview: null }),
  setFilePreviewWidth: (width) => {
    const next = Math.min(900, Math.max(380, Math.round(width)))
    saveUiPrefs({ filePreviewWidth: next })
    set({ filePreviewWidth: next })
  },
  setFileBrowserVisible: (visible) => {
    saveUiPrefs({ fileBrowserVisible: visible })
    set({ fileBrowserVisible: visible })
  },
  setFileBrowserWidth: (width) => {
    const next = Math.min(360, Math.max(160, Math.round(width)))
    saveUiPrefs({ fileBrowserWidth: next })
    set({ fileBrowserWidth: next })
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
  openBackgroundTasks: (hostId, sessionId, taskId) =>
    set({ backgroundPanel: { hostId, sessionId, ...(taskId ? { taskId } : {}) } }),
  closeBackgroundTasks: () => set({ backgroundPanel: null }),
  openBrowserPanel: (hostId, sessionId) => set({ browserPanel: { hostId, sessionId } }),
  closeBrowserPanel: () => set({ browserPanel: null }),
  openPrPanel: (title) => set({ prOpen: true, prComposeTitle: title ?? '' }),
  closePrPanel: () => set({ prOpen: false, prComposeTitle: '' }),
  openMemoryEditor: (input) => set({ memoryEditor: input }),
  closeMemoryEditor: () => set({ memoryEditor: null }),
  openScheduleComposer: () =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: 'schedules',
      scheduleComposeNonce: s.scheduleComposeNonce + 1,
      mobileSidebar: false,
      mobilePanel: false,
    })),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setNewSessionOpen: (open) => set({ newSessionOpen: open, mobileSidebar: false }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setNotifications: (enabled) => {
    saveUiPrefs({ notifications: enabled })
    set({ notifications: enabled })
  },
  setNativeNotifications: (enabled) => {
    saveUiPrefs({ nativeNotifications: enabled })
    set({ nativeNotifications: enabled })
  },
  setBackgroundService: (enabled) => {
    saveUiPrefs({ backgroundService: enabled })
    set({ backgroundService: enabled })
  },
  setNotifyEvent: (key, enabled) => {
    const next = { ...get().notifyEvents, [key]: enabled }
    saveUiPrefs({ notifyEvents: next })
    set({ notifyEvents: next })
  },
  setInboxOpen: (open) => set({ inboxOpen: open }),

  openJoinInvite: (target) => set({ joinInvite: target }),

  closeJoinInvite: () => set({ joinInvite: null }),
  setDispatchOpen: (open, hostId) =>
    set((s) => ({ dispatchOpen: open, dispatchHostId: hostId ?? s.dispatchHostId })),
  toast: (text, kind = 'info', options) => {
    const now = Date.now()
    for (const [key, at] of recentToastAt) {
      if (now - at >= TOAST_DEDUPE_MS) recentToastAt.delete(key)
    }
    if (recentToastAt.has(text)) return
    recentToastAt.set(text, now)
    const id = toastSeq++
    set((s) => ({
      toasts: [
        ...s.toasts.slice(-3),
        {
          id,
          kind,
          text,
          onClick: options?.onClick,
          ...(options?.actionLabel ? { actionLabel: options.actionLabel } : {}),
        },
      ],
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
  focusAgent: (id) =>
    set((s) => ({ agentFocus: { id, nonce: (s.agentFocus?.nonce ?? 0) + 1 } })),
  resetComposer: () => set((s) => ({ composerResetNonce: s.composerResetNonce + 1 })),
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
