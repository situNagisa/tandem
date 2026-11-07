import { create } from 'zustand'
import type { MemoryScope } from '@tandem/protocol'
import {
  DEFAULT_SESSION_FILTER,
  type SessionFilter,
  type SessionTarget,
  type SettingsTab,
  type SplitLayout,
  type SplitPane,
  type SplitState,
  type Theme,
  type Toast,
} from '../lib/types'
import type { InviteTarget } from '../lib/inviteLink'
import { boardPaneSessionId, columnCount, equalWeights, MAX_SPLIT_PANES, rowCount } from '../lib/split'
import {
  loadCollapsedProjects,
  loadPinnedProjects,
  loadSidebarWidth,
  loadSplitState,
  loadTheme,
  loadUiPrefs,
  saveCollapsedProjects,
  savePinnedProjects,
  saveSidebarWidth,
  saveSplitState,
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
  /** 侧栏会话筛选（状态 / 主机 / 项目 / 来源组合）。 */
  sessionFilter: SessionFilter
  /** 固定在侧栏顶部的项目分组 key。 */
  pinnedProjects: string[]
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
  /** 从命令面板/设置搜索定位到某一项：滚动并短暂高亮。 */
  settingsFocus: { id: string; nonce: number } | null
  /** 新功能导览 / 关于 / 重新看上手指引。 */
  tourOpen: boolean
  aboutOpen: boolean
  onboardingOpen: boolean
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
  /** 手机首页内嵌的收件箱视图是否可见；只用于抑制未读角标，不控制弹层。 */
  inboxViewOpen: boolean
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
  /** Host 诊断面板：目标 Host id。 */
  doctorHostId: string | null
  /** PR 面板；composeTitle 用于「提交并创建 PR」预填标题。 */
  prOpen: boolean
  prComposeTitle: string
  /** 记忆 Markdown 编辑器；project 为项目根路径，global 时忽略。 */
  memoryEditor: { scope: MemoryScope; project?: string } | null
  /** 多会话分屏：打开的窗格、布局与分隔条权重。 */
  splitPanes: SplitPane[]
  splitLayout: SplitLayout
  splitCols: number[]
  splitRows: number[]
  /** 「分屏打开…」会话选择弹层。 */
  splitPickerOpen: boolean

  setTheme: (theme: Theme) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  toggleProject: (key: string) => void
  setShowArchived: (show: boolean) => void
  setShowSubagents: (show: boolean) => void
  setShowExternalSessions: (show: boolean) => void
  setExternalSourceVisible: (source: string, visible: boolean) => void
  setSessionFilter: (patch: Partial<SessionFilter>) => void
  clearSessionFilter: () => void
  toggleProjectPinned: (key: string) => void
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
  focusSetting: (tab: SettingsTab, id: string) => void
  setTourOpen: (open: boolean) => void
  setAboutOpen: (open: boolean) => void
  setOnboardingOpen: (open: boolean) => void
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
  setInboxViewOpen: (open: boolean) => void
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
  openDoctor: (hostId: string) => void
  closeDoctor: () => void
  openPrPanel: (title?: string) => void
  closePrPanel: () => void
  openMemoryEditor: (input: { scope: MemoryScope; project?: string }) => void
  closeMemoryEditor: () => void
  /** 在分屏中打开：自动补位/替换聚焦窗格。 */
  openSplitPane: (current: SessionTarget | null, target: SessionTarget) => void
  /** 看板 + 卡片会话一起进分屏：看板作为左窗格，会话作为另一窗格。 */
  openBoardSplit: (hostId: string, boardId: string, sessionId: string) => void
  /** 侧栏会话拖到主区左/右/下半边。 */
  openSplitPaneAt: (
    current: SessionTarget | null,
    target: SessionTarget,
    zone: 'left' | 'right' | 'bottom',
  ) => void
  closeSplitPane: (hostId: string, sessionId: string) => void
  /** 会话被删除时静默移除对应窗格。 */
  removePaneForSession: (hostId: string, sessionId: string) => void
  /** 普通点击侧栏/路由切换：分屏时把聚焦窗格换成目标会话。 */
  replaceSplitPane: (focused: SessionTarget | null, target: SessionTarget) => void
  setSplitLayout: (layout: SplitLayout) => void
  setSplitColWeights: (weights: number[]) => void
  setSplitRowWeights: (weights: number[]) => void
  clearSplit: () => void
  setSplitPickerOpen: (open: boolean) => void
}

const prefs = loadUiPrefs()
const restoredSplit = loadSplitState()

export const useUiStore = create<UiState>((set, get) => {
  const commitSplit = (patch: Partial<SplitState>) => {
    const state = get()
    const panes = patch.panes ?? state.splitPanes
    const layout = patch.layout ?? state.splitLayout
    const next: SplitState = {
      panes,
      layout,
      cols: patch.cols ?? state.splitCols,
      rows: patch.rows ?? state.splitRows,
    }
    saveSplitState(next)
    set({
      splitPanes: next.panes,
      splitLayout: next.layout,
      splitCols: next.cols,
      splitRows: next.rows,
    })
  }

  const layoutWeights = (layout: SplitLayout, prev?: SplitState) => ({
    cols:
      columnCount(layout) === (prev?.cols.length ?? 0)
        ? prev!.cols
        : equalWeights(columnCount(layout)),
    rows:
      rowCount(layout) === (prev?.rows.length ?? 0)
        ? prev!.rows
        : equalWeights(rowCount(layout)),
  })

  const commitLayout = (layout: SplitLayout) => {
    const state = get()
    const weights = layoutWeights(layout, {
      panes: state.splitPanes,
      layout: state.splitLayout,
      cols: state.splitCols,
      rows: state.splitRows,
    })
    commitSplit({ layout, ...weights })
  }

  return {
    theme: loadTheme(),
  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  sidebarWidth: loadSidebarWidth(),
  collapsedProjects: loadCollapsedProjects(),
  showArchived: false,
  showSubagents: prefs.showSubagents ?? false,
  showExternalSessions: prefs.showExternalSessions ?? true,
  hiddenExternalSources: prefs.hiddenExternalSources ?? [],
  sessionFilter: { ...DEFAULT_SESSION_FILTER },
  pinnedProjects: loadPinnedProjects(),
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
  settingsFocus: null,
  tourOpen: false,
  aboutOpen: false,
  onboardingOpen: false,
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
  inboxViewOpen: false,
  joinInvite: null,
  dispatchOpen: false,
  dispatchHostId: null,
  toasts: [],
  promptSeed: null,
  agentFocus: null,
  composerResetNonce: 0,
  backgroundPanel: null,
  browserPanel: null,
  doctorHostId: null,
  prOpen: false,
  prComposeTitle: '',
  memoryEditor: null,
  scheduleComposeNonce: 0,
  splitPanes: restoredSplit?.panes ?? [],
  splitLayout: restoredSplit?.layout ?? 'cols2',
  splitCols: restoredSplit?.cols ?? equalWeights(2),
  splitRows: restoredSplit?.rows ?? equalWeights(1),
  splitPickerOpen: false,

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
  setSessionFilter: (patch) =>
    set((s) => ({ sessionFilter: { ...s.sessionFilter, ...patch } })),
  clearSessionFilter: () => set({ sessionFilter: { ...DEFAULT_SESSION_FILTER } }),
  toggleProjectPinned: (key) => {
    const current = get().pinnedProjects
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]
    savePinnedProjects(next)
    set({ pinnedProjects: next })
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
      settingsFocus: null,
      mobileSidebar: false,
      mobilePanel: false,
    })),
  closeSettings: () => set({ settingsOpen: false, settingsFocus: null }),
  focusSetting: (tab, id) =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: tab,
      settingsFocus: { id, nonce: (s.settingsFocus?.nonce ?? 0) + 1 },
      mobileSidebar: false,
      mobilePanel: false,
    })),
  setTourOpen: (open) =>
    set(open ? { tourOpen: true, aboutOpen: false, mobileSidebar: false } : { tourOpen: false }),
  setAboutOpen: (open) =>
    set(open ? { aboutOpen: true, settingsOpen: false, mobileSidebar: false } : { aboutOpen: false }),
  setOnboardingOpen: (open) =>
    set(open ? { onboardingOpen: true, aboutOpen: false } : { onboardingOpen: false }),
  openBackgroundTasks: (hostId, sessionId, taskId) =>
    set({ backgroundPanel: { hostId, sessionId, ...(taskId ? { taskId } : {}) } }),
  closeBackgroundTasks: () => set({ backgroundPanel: null }),
  openBrowserPanel: (hostId, sessionId) => set({ browserPanel: { hostId, sessionId } }),
  closeBrowserPanel: () => set({ browserPanel: null }),
  openDoctor: (hostId) => set({ doctorHostId: hostId }),
  closeDoctor: () => set({ doctorHostId: null }),
  openPrPanel: (title) => set({ prOpen: true, prComposeTitle: title ?? '' }),
  closePrPanel: () => set({ prOpen: false, prComposeTitle: '' }),
  openMemoryEditor: (input) => set({ memoryEditor: input }),
  closeMemoryEditor: () => set({ memoryEditor: null }),
  openScheduleComposer: () =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: 'schedules',
      settingsFocus: null,
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
  setInboxViewOpen: (open) => set({ inboxViewOpen: open }),

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

  openSplitPane: (current, target) => {
    const state = get()
    const panes = state.splitPanes.slice()
    if (panes.some((p) => p.hostId === target.hostId && p.sessionId === target.sessionId)) return
    if (panes.length === 0) {
      if (!current || (current.hostId === target.hostId && current.sessionId === target.sessionId)) {
        return
      }
      panes.push(current, target)
    } else if (panes.length < MAX_SPLIT_PANES) {
      panes.push(target)
    } else {
      const index = current
        ? panes.findIndex((p) => p.hostId === current.hostId && p.sessionId === current.sessionId)
        : -1
      panes[index >= 0 ? index : panes.length - 1] = target
    }
    let layout: SplitLayout
    if (panes.length === 2) layout = 'cols2'
    else if (panes.length === 3) {
      layout = state.splitLayout === 'grid2x2' ? 'grid2x2' : 'cols3'
    } else layout = 'grid2x2'
    const weights = layoutWeights(layout, {
      panes: state.splitPanes,
      layout: state.splitLayout,
      cols: state.splitCols,
      rows: state.splitRows,
    })
    commitSplit({ panes, layout, ...weights })
  },

  openBoardSplit: (hostId, boardId, sessionId) => {
    const state = get()
    const boardPane = { hostId, sessionId: boardPaneSessionId(boardId) }
    const sessionPane = { hostId, sessionId }
    let panes = state.splitPanes.filter(
      (pane) => !(pane.hostId === hostId && (pane.sessionId === boardPane.sessionId || pane.sessionId === sessionPane.sessionId)),
    )
    panes.unshift(boardPane)
    panes.push(sessionPane)
    if (panes.length > MAX_SPLIT_PANES) panes = panes.slice(0, MAX_SPLIT_PANES)
    if (panes.length < 2) panes.push(sessionPane)
    const layout: SplitLayout = panes.length === 2 ? 'cols2' : panes.length === 3 ? 'cols3' : 'grid2x2'
    const weights = layoutWeights(layout, {
      panes: state.splitPanes,
      layout: state.splitLayout,
      cols: state.splitCols,
      rows: state.splitRows,
    })
    commitSplit({ panes, layout, ...weights })
  },

  openSplitPaneAt: (current, target, zone) => {
    const state = get()
    const panes = state.splitPanes.slice()
    if (panes.some((p) => p.hostId === target.hostId && p.sessionId === target.sessionId)) return
    if (panes.length === 0) {
      if (!current || (current.hostId === target.hostId && current.sessionId === target.sessionId)) {
        return
      }
      panes.push(current)
    }
    let layout = state.splitLayout
    if (zone === 'left' || zone === 'right') {
      if (panes.length === 1) {
        if (zone === 'left') panes.unshift(target)
        else panes.push(target)
        layout = 'cols2'
      } else {
        const index = zone === 'left' ? 0 : panes.length - 1
        panes[index] = target
        layout =
          panes.length === 2 ? 'cols2' : panes.length === 3 ? 'cols3' : 'grid2x2'
      }
    } else if (panes.length === 1) {
      panes.push(target)
      layout = 'rows2'
    } else if (panes.length === 2) {
      if (layout === 'rows2') {
        panes[1] = target
      } else {
        panes.push(target)
        layout = 'grid2x2'
      }
    } else {
      panes[panes.length - 1] = target
      layout = layout === 'cols3' ? 'cols3' : 'grid2x2'
    }
    const weights = layoutWeights(layout, {
      panes: state.splitPanes,
      layout: state.splitLayout,
      cols: state.splitCols,
      rows: state.splitRows,
    })
    commitSplit({ panes, layout, ...weights })
  },

  closeSplitPane: (hostId, sessionId) => {
    const state = get()
    const panes = state.splitPanes.filter(
      (p) => !(p.hostId === hostId && p.sessionId === sessionId),
    )
    if (panes.length < 2) {
      saveSplitState(null)
      set({ splitPanes: [], splitLayout: 'cols2' })
      return
    }
    let layout = state.splitLayout
    if (layout === 'cols3' && panes.length === 2) layout = 'cols2'
    if (layout === 'rows2' && panes.length > 2) layout = 'grid2x2'
    const weights = layoutWeights(layout, {
      panes: state.splitPanes,
      layout: state.splitLayout,
      cols: state.splitCols,
      rows: state.splitRows,
    })
    commitSplit({ panes, layout, ...weights })
  },

  removePaneForSession: (hostId, sessionId) => {
    const state = get()
    if (!state.splitPanes.some((p) => p.hostId === hostId && p.sessionId === sessionId)) return
    get().closeSplitPane(hostId, sessionId)
  },

  replaceSplitPane: (focused, target) => {
    const state = get()
    if (state.splitPanes.length < 2) return
    if (state.splitPanes.some((p) => p.hostId === target.hostId && p.sessionId === target.sessionId)) return
    const panes = state.splitPanes.slice()
    const index = focused
      ? panes.findIndex((p) => p.hostId === focused.hostId && p.sessionId === focused.sessionId)
      : -1
    panes[index >= 0 ? index : 0] = target
    commitSplit({ panes })
  },

  setSplitLayout: (layout) => {
    if (get().splitPanes.length < 2) return
    commitLayout(layout)
  },

  setSplitColWeights: (weights) => {
    const next = weights.filter((n) => Number.isFinite(n) && n > 0)
    if (next.length !== get().splitCols.length) return
    commitSplit({ cols: next })
  },

  setSplitRowWeights: (weights) => {
    const next = weights.filter((n) => Number.isFinite(n) && n > 0)
    if (next.length !== get().splitRows.length) return
    commitSplit({ rows: next })
  },

  clearSplit: () => {
    saveSplitState(null)
    set({ splitPanes: [], splitLayout: 'cols2', splitCols: equalWeights(2), splitRows: equalWeights(1) })
  },

  setSplitPickerOpen: (open) => set({ splitPickerOpen: open }),
  }
})

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
