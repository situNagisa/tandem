import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { applyTheme, useUiStore } from './store/useUiStore'
import { navigate, useRoute } from './lib/router'
import { useIsMobile, useViewportHeight } from './lib/hooks'
import { clearAttention } from './lib/attention'
import { commandForEvent } from './lib/commands'
import { closeFocusedPane, focusSplitPane } from './lib/splitActions'
import { initNativeBridge, syncBackgroundService } from './lib/nativeBridge'
import { isDesktop } from './lib/desktop'
import { cn } from './lib/cn'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { SplitWorkspace } from './components/split/SplitWorkspace'
import { SplitOpenDialog } from './components/split/SplitOpenDialog'
import { ExternalSessionView } from './components/ExternalSessionView'
import { BoardView } from './components/board/BoardView'
import { useBoardRoute } from './lib/boardRoute'
import { isBoardPane } from './lib/split'
import { RightPanel } from './components/RightPanel'
import { ChangeReviewPanel } from './components/ChangeReviewPanel'
import { FilePreviewPanel } from './components/FilePreviewPanel'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { JoinTeamDialog } from './components/settings/JoinTeamDialog'
import { MemoryEditorDialog } from './components/MemoryEditorDialog'
import { SearchDialog } from './components/SearchDialog'
import { BackgroundTasksPanel } from './components/BackgroundTasksPanel'
import { BrowserPanel } from './components/BrowserPanel'
import { InboxDialog } from './components/inbox/InboxDialog'
import { DispatchDialog } from './components/DispatchDialog'
import { DoctorDialog } from './components/DoctorDialog'
import { Toasts } from './components/ui/Toasts'
import { FeedbackMode } from './components/feedback/FeedbackMode'
import { FeatureTour } from './components/tour/FeatureTour'
import { OverlayScrollbar } from './components/ui/OverlayScrollbar'
import { UiGallery } from './components/ui/UiGallery'

function DispatchDialogHost() {
  const open = useUiStore((s) => s.dispatchOpen)
  const hostId = useUiStore((s) => s.dispatchHostId)
  const setOpen = useUiStore((s) => s.setDispatchOpen)
  return (
    <DispatchDialog
      open={open}
      initialHostId={hostId ?? undefined}
      onClose={() => setOpen(false)}
    />
  )
}

export default function App() {
  useViewportHeight()
  const isMobile = useIsMobile()
  const route = useRoute()
  const boardRoute = useBoardRoute()
  const initialized = useAppStore((s) => s.initialized)
  const hosts = useAppStore((s) => s.hosts)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const setPanelOpen = useUiStore((s) => s.setPanelOpen)
  const changesOpen = useUiStore((s) => s.changesOpen)
  const setChangesOpen = useUiStore((s) => s.setChangesOpen)
  const filePreview = useUiStore((s) => s.filePreview)
  const closeFilePreview = useUiStore((s) => s.closeFilePreview)
  const theme = useUiStore((s) => s.theme)
  const mobileSidebar = useUiStore((s) => s.mobileSidebar)
  const mobilePanel = useUiStore((s) => s.mobilePanel)
  const backgroundService = useUiStore((s) => s.backgroundService)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const hasSession = useAppStore((s) => !!s.active)
  const activeHostId = useAppStore((s) => s.active?.hostId ?? null)
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const activeUnread = useAppStore((s) => s.active?.summary?.unread ?? false)

  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const lastWidthRef = useRef<number | null>(null)
  const [drawerOffset, setDrawerOffset] = useState(0)
  const drawerStart = useRef<number | null>(null)
  const effectiveWidth = dragWidth ?? sidebarWidth

  useEffect(() => {
    useAppStore.getState().initialize()
    void initNativeBridge()
  }, [])

  // 安卓前台服务：设置开关或 Host 数量变化时同步常驻通知
  useEffect(() => {
    if (!initialized) return
    void syncBackgroundService(hosts.length)
  }, [initialized, hosts.length, backgroundService])

  useEffect(() => {
    if (!initialized) return
    const store = useAppStore.getState()
    if (route.kind === 'session') {
      if (!store.hosts.some((h) => h.id === route.hostId)) {
        navigate({ kind: 'home' })
        return
      }
      store.activateHost(route.hostId)
      const ui = useUiStore.getState()
      const key = `${route.hostId}:${route.sessionId}`
      if (
        ui.splitPanes.length >= 2 &&
        !ui.splitPanes.some((pane) => `${pane.hostId}:${pane.sessionId}` === key)
      ) {
        const current = store.active
        ui.replaceSplitPane(
          current ? { hostId: current.hostId, sessionId: current.sessionId } : null,
          { hostId: route.hostId, sessionId: route.sessionId },
        )
      }
      store.openSession(route.hostId, route.sessionId)
    } else if (route.kind === 'host') {
      if (!store.hosts.some((h) => h.id === route.hostId)) {
        navigate({ kind: 'home' })
        return
      }
      store.activateHost(route.hostId)
      useUiStore.getState().clearSplit()
      store.closeSession()
    } else if (route.kind === 'external') {
      if (!store.hosts.some((h) => h.id === route.hostId)) {
        navigate({ kind: 'home' })
        return
      }
      store.activateHost(route.hostId)
      useUiStore.getState().clearSplit()
      store.closeSession()
    } else {
      useUiStore.getState().clearSplit()
      store.closeSession()
    }
  }, [route, initialized, hosts])

  // Host 被移除后，清掉指向它的窗格，避免残留空白视图。
  useEffect(() => {
    if (!initialized) return
    const ids = new Set(hosts.map((host) => host.id))
    const ui = useUiStore.getState()
    for (const pane of ui.splitPanes) {
      if (!ids.has(pane.hostId)) ui.removePaneForSession(pane.hostId, pane.sessionId)
    }
  }, [hosts, initialized])

  // 刷新后恢复分屏：把所有窗格的会话视图重新订阅；当前路由决定聚焦窗格。
  const splitPanes = useUiStore((s) => s.splitPanes)
  useEffect(() => {
    if (!initialized || route.kind !== 'session' || splitPanes.length < 2) return
    for (const pane of splitPanes) {
      if (isBoardPane(pane)) continue
      useAppStore.getState().openSessionView(pane.hostId, pane.sessionId)
    }
  }, [initialized, route, splitPanes])

  useEffect(() => {
    const ui = useUiStore.getState()
    ui.setMobileSidebar(false)
    ui.setMobilePanel(false)
    ui.setChangesOpen(false)
    ui.closeFilePreview()
  }, [route])

  // 回合在后台完成（页面不可见）或切回前台时，当前会话视为已读。
  useEffect(() => {
    if (!activeUnread || !activeHostId || !activeSessionId) return
    const mark = () => {
      if (document.visibilityState !== 'visible') return
      void useAppStore.getState().markSessionRead(activeHostId, activeSessionId)
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [activeUnread, activeHostId, activeSessionId])

  useEffect(() => {
    applyTheme(theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState()
      if (e.key === 'Escape') {
        if (ui.mobileSidebar) {
          e.preventDefault()
          e.stopPropagation()
          ui.setMobileSidebar(false)
          return
        }
        if (ui.mobilePanel) {
          e.preventDefault()
          e.stopPropagation()
          ui.setMobilePanel(false)
          return
        }
      }
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        if (ui.settingsOpen) return
        e.preventDefault()
        ui.setSearchOpen(!ui.searchOpen)
        return
      }
      if (ui.settingsOpen || ui.searchOpen) return
      const splitPanes = ui.splitPanes
      if (!ui.splitPickerOpen) {
        if (splitPanes.length >= 2 && /^[1-4]$/.test(e.key)) {
          const pane = splitPanes[Number(e.key) - 1]
          if (pane) {
            e.preventDefault()
            e.stopPropagation()
            focusSplitPane(pane)
            return
          }
        }
        // 浏览器保留 Ctrl+W 关闭标签页；桌面壳里用它关闭当前窗格/会话。
        if (key === 'w' && (splitPanes.length >= 2 || isDesktop)) {
          e.preventDefault()
          e.stopPropagation()
          closeFocusedPane()
          return
        }
      }
      const command = commandForEvent(e)
      if (command) {
        e.preventDefault()
        void command.run()
        return
      }
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        const store = useAppStore.getState()
        const hostId = store.active?.hostId ?? store.activeHostId
        if (!hostId || ui.settingsOpen || ui.searchOpen) return
        const list = (store.runtimes[hostId]?.sessions ?? [])
          .filter((s) => !s.archived)
          .slice()
          .sort((a, b) => {
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
            return b.updatedAt - a.updatedAt
          })
        if (list.length === 0) return
        e.preventDefault()
        const dir = e.code === 'BracketRight' ? 1 : -1
        const current = store.active?.sessionId
        const index = list.findIndex((s) => s.id === current)
        const nextIndex =
          index < 0
            ? dir > 0
              ? 0
              : list.length - 1
            : Math.min(list.length - 1, Math.max(0, index + dir))
        if (nextIndex === index) return
        navigate({ kind: 'session', hostId, sessionId: list[nextIndex].id })
        ui.setMobileSidebar(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isMobile])

  useEffect(() => {
    const reconnect = () => {
      useAppStore.getState().checkConnections()
    }
    const goOffline = () => {
      useAppStore.getState().goOffline()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearAttention()
        reconnect()
      }
    }
    window.addEventListener('online', reconnect)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', reconnect)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth }
    lastWidthRef.current = sidebarWidth
    setDragWidth(sidebarWidth)
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.min(400, Math.max(220, d.startWidth + ev.clientX - d.startX))
      lastWidthRef.current = next
      setDragWidth(next)
    }
    const up = () => {
      dragRef.current = null
      const finalWidth = lastWidthRef.current
      if (finalWidth !== null) useUiStore.getState().setSidebarWidth(finalWidth)
      setDragWidth(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="app-root flex overflow-hidden bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-text">
      {!isMobile && (
        <aside
          aria-label="侧栏"
          className="relative h-full shrink-0 overflow-hidden"
          style={{
            width: sidebarCollapsed ? 0 : effectiveWidth,
            transition: dragWidth !== null ? 'none' : 'width 220ms var(--t-ease-out)',
          }}
          aria-hidden={sidebarCollapsed}
        >
          <div
            className="h-full overflow-hidden"
            style={{ width: effectiveWidth }}
            inert={sidebarCollapsed}
          >
            <Sidebar />
          </div>
          {!sidebarCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              onPointerDown={startResize}
              onDoubleClick={() => setSidebarWidth(272)}
              title="拖动调整宽度，双击复位"
              className="group absolute right-0 top-0 z-20 h-full w-2 cursor-col-resize touch-none"
            >
              <span
                className={cn(
                  'pointer-events-none absolute right-0 top-0 h-full w-px bg-transparent transition-colors duration-150',
                  'group-hover:bg-border-strong',
                  dragWidth !== null && 'bg-accent',
                )}
              />
            </div>
          )}
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex min-h-0 flex-1">
          {route.kind === 'dev-ui' ? (
            <UiGallery />
          ) : boardRoute ? (
            <BoardView route={boardRoute} />
          ) : route.kind === 'external' ? (
            <ExternalSessionView
              key={`${route.hostId}:${route.source}:${route.id}`}
              hostId={route.hostId}
              source={route.source}
              externalId={route.id}
            />
          ) : (
            <SplitWorkspace />
          )}
          {!isMobile && filePreview && (
            <div className="anim-fade-in flex min-h-0 shrink-0">
              <FilePreviewPanel onClose={closeFilePreview} />
            </div>
          )}
          {!isMobile && !filePreview && changesOpen && hasSession && (
            <div className="anim-fade-in flex min-h-0 shrink-0">
              <ChangeReviewPanel onClose={() => setChangesOpen(false)} />
            </div>
          )}
          {!isMobile && !filePreview && panelOpen && !changesOpen && hasSession && (
            <div className="anim-fade-in shrink-0">
              <RightPanel onClose={() => setPanelOpen(false)} />
            </div>
          )}
        </main>
      </div>

      {isMobile && mobileSidebar && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/35"
            style={{ opacity: Math.max(0.15, 1 + drawerOffset / 320) }}
            onClick={() => setMobileSidebar(false)}
          />
          <aside
            aria-label="侧栏"
            className="anim-drawer-left absolute inset-y-0 left-0 w-[87%] max-w-[330px] bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-lg"
            style={{
              transform: drawerOffset ? `translateX(${drawerOffset}px)` : undefined,
              transition: drawerOffset ? 'none' : 'transform 220ms var(--t-ease-out)',
              touchAction: 'pan-y',
            }}
            onTouchStart={(e) => {
              drawerStart.current = e.touches[0]?.clientX ?? null
            }}
            onTouchMove={(e) => {
              if (drawerStart.current === null) return
              const dx = (e.touches[0]?.clientX ?? drawerStart.current) - drawerStart.current
              setDrawerOffset(Math.min(0, Math.max(-340, dx)))
            }}
            onTouchEnd={() => {
              if (drawerOffset < -72) setMobileSidebar(false)
              setDrawerOffset(0)
              drawerStart.current = null
            }}
          >
            <Sidebar inDrawer onNavigate={() => setMobileSidebar(false)} />
          </aside>
        </div>
      )}

      {isMobile && changesOpen && hasSession && (
        <div className="fixed inset-0 z-40 bg-bg md:hidden">
          <ChangeReviewPanel onClose={() => setChangesOpen(false)} />
        </div>
      )}

      {isMobile && filePreview && (
        <div className="fixed inset-0 z-40 bg-bg md:hidden">
          <FilePreviewPanel onClose={closeFilePreview} />
        </div>
      )}

      {isMobile && mobilePanel && hasSession && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="anim-fade-in absolute inset-0 bg-black/35"
            onClick={() => setMobilePanel(false)}
          />
          <div className="anim-drawer-right absolute inset-y-0 right-0 w-[90%] max-w-[344px] bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-lg">
            <RightPanel onClose={() => setMobilePanel(false)} />
          </div>
        </div>
      )}

      <SettingsDialog />
      <JoinTeamDialog />
      <MemoryEditorDialog />
      <BackgroundTasksPanel />
      <BrowserPanel />
      <InboxDialog />
      <DispatchDialogHost />
      <DoctorDialog />
      <SearchDialog />
      <SplitOpenDialog />
      <FeatureTour />
      <Toasts />
      <FeedbackMode />
      <OverlayScrollbar />
    </div>
  )
}
