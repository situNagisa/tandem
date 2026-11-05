import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { applyTheme, useUiStore } from './store/useUiStore'
import { navigate, useRoute } from './lib/router'
import { useIsMobile, useViewportHeight } from './lib/hooks'
import { cn } from './lib/cn'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ChatView } from './components/ChatView'
import { RightPanel } from './components/RightPanel'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { SearchDialog } from './components/SearchDialog'
import { Toasts } from './components/ui/Toasts'

export default function App() {
  useViewportHeight()
  const isMobile = useIsMobile()
  const route = useRoute()
  const initialized = useAppStore((s) => s.initialized)
  const hosts = useAppStore((s) => s.hosts)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const setPanelOpen = useUiStore((s) => s.setPanelOpen)
  const theme = useUiStore((s) => s.theme)
  const mobileSidebar = useUiStore((s) => s.mobileSidebar)
  const mobilePanel = useUiStore((s) => s.mobilePanel)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const hasSession = useAppStore((s) => !!s.active)

  useEffect(() => {
    useAppStore.getState().initialize()
  }, [])

  useEffect(() => {
    if (!initialized) return
    const store = useAppStore.getState()
    if (route.kind === 'session') {
      if (!store.hosts.some((h) => h.id === route.hostId)) {
        navigate({ kind: 'home' })
        return
      }
      store.activateHost(route.hostId)
      store.openSession(route.hostId, route.sessionId)
    } else if (route.kind === 'host') {
      if (!store.hosts.some((h) => h.id === route.hostId)) {
        navigate({ kind: 'home' })
        return
      }
      store.activateHost(route.hostId)
      store.closeSession()
    } else {
      store.closeSession()
    }
  }, [route, initialized, hosts])

  useEffect(() => {
    const ui = useUiStore.getState()
    ui.setMobileSidebar(false)
    ui.setMobilePanel(false)
  }, [route])

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
        if (ui.settingsOpen || ui.newSessionOpen) return
        e.preventDefault()
        ui.setSearchOpen(!ui.searchOpen)
      } else if (key === 'n') {
        if (ui.settingsOpen || ui.newSessionOpen) return
        e.preventDefault()
        ui.setNewSessionOpen(true)
      } else if (key === 'b') {
        e.preventDefault()
        if (isMobile) ui.setMobileSidebar(!ui.mobileSidebar)
        else ui.toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isMobile])

  useEffect(() => {
    const reconnect = () => {
      const store = useAppStore.getState()
      for (const h of store.hosts) {
        if (store.runtimes[h.id]?.status === 'offline') store.retryHost(h.id)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnect()
    }
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return (
    <div className="app-root flex overflow-hidden bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-text">
      {!isMobile && (
        <div
          className={cn(
            'h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
            sidebarCollapsed ? 'w-0' : 'w-[276px]',
          )}
        >
          <div className="h-full w-[276px]">
            <Sidebar />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <ChatView />
          {!isMobile && panelOpen && hasSession && (
            <div className="anim-fade-in shrink-0">
              <RightPanel onClose={() => setPanelOpen(false)} />
            </div>
          )}
        </div>
      </div>

      {isMobile && mobileSidebar && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="anim-fade-in absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={() => setMobileSidebar(false)}
          />
          <div className="anim-drawer-left absolute inset-y-0 left-0 w-[87%] max-w-[330px] bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl">
            <Sidebar inDrawer onNavigate={() => setMobileSidebar(false)} />
          </div>
        </div>
      )}

      {isMobile && mobilePanel && hasSession && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="anim-fade-in absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={() => setMobilePanel(false)}
          />
          <div className="anim-drawer-right absolute inset-y-0 right-0 w-[90%] max-w-[344px] bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl">
            <RightPanel onClose={() => setMobilePanel(false)} />
          </div>
        </div>
      )}

      <NewSessionDialog />
      <SettingsDialog />
      <SearchDialog />
      <Toasts />
    </div>
  )
}
