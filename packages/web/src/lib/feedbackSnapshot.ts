/** 反馈条目的应用状态快照：只取白名单字段，绝不包含 key/token/配置内容。 */
import type { UiMessage } from './types'
import type { FeedbackSnapshot } from './feedback'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'

function redactPath(path: string | undefined, hide: boolean): string | undefined {
  if (!path) return undefined
  return hide ? '（已隐藏）' : path
}

function messageText(message: UiMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 800)
}

export function captureFeedbackSnapshot(
  includeMessages: boolean,
  hidePaths: boolean,
): FeedbackSnapshot {
  const app = useAppStore.getState()
  const ui = useUiStore.getState()
  const active = app.active
  const hostId = active?.hostId ?? app.activeHostId ?? undefined
  const runtime = hostId ? app.runtimes[hostId] : undefined
  const hostInfo = runtime?.info
  const summary =
    active?.summary ??
    (active ? runtime?.sessions.find((entry) => entry.id === active.sessionId) : undefined) ??
    null
  const messages = includeMessages ? (active?.messages ?? []).slice(-5) : []

  return {
    capturedAt: Date.now(),
    route: window.location.hash || '#/',
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    theme: ui.theme,
    hidePaths,
    client: {
      platform:
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ||
        navigator.platform ||
        '',
      language: navigator.language,
      ua: navigator.userAgent,
    },
    ui: {
      sidebarCollapsed: ui.sidebarCollapsed,
      panelOpen: ui.panelOpen,
      changesOpen: ui.changesOpen,
      showArchived: ui.showArchived,
      showSubagents: ui.showSubagents,
      showExternalSessions: ui.showExternalSessions,
      notifications: ui.notifications,
      nativeNotifications: ui.nativeNotifications,
      backgroundService: ui.backgroundService,
    },
    host: hostInfo
      ? {
          id: hostInfo.id,
          name: hostInfo.name,
          platform: hostInfo.platform,
          version: hostInfo.version,
          status: runtime?.status,
          homeDir: redactPath(hostInfo.homeDir, hidePaths),
        }
      : hostId
        ? { id: hostId, status: runtime?.status }
        : undefined,
    session: summary
      ? {
          id: summary.id,
          title: summary.title,
          status: summary.status,
          model: summary.model,
          effort: summary.effort,
          permissionMode: summary.permissionMode,
          profileId: summary.profileId,
          groupId: summary.groupId,
          cwd: redactPath(summary.cwd, hidePaths),
          worktree: summary.worktree
            ? {
                path: redactPath(summary.worktree.path, hidePaths),
                branch: summary.worktree.branch,
                baseBranch: summary.worktree.baseBranch,
              }
            : undefined,
          messageCount: active?.messages.length ?? 0,
          running: active?.running ?? false,
          pendingApprovals: active?.pending.length ?? 0,
        }
      : undefined,
    messages: messages.map((message) => ({
      role: message.role,
      createdAt: message.createdAt,
      text: messageText(message),
    })),
  }
}
