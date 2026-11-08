import type { DelegationStrategy, PermissionMode } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useFeedbackStore } from '../store/useFeedbackStore'
import { useUiStore } from '../store/useUiStore'
import { navigateBoard } from './boardRoute'
import { navigate, parseHash } from './router'
import { PERMISSION_MODE_LABELS } from './types'
import { profileModelGroups } from './profileModels'
import { matchShortcut } from './shortcut'

export interface AppCommand {
  id: string
  title: string
  keywords: string[]
  defaultShortcut?: string
  run: () => void | Promise<void>
}

const SHORTCUT_KEY = 'tandem.commandShortcuts.v1'
const RECENT_KEY = 'tandem.recentCommands.v1'
const RECENT_LIMIT = 8

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
const DELEGATIONS: Array<{ value: DelegationStrategy; label: string }> = [
  { value: 'less', label: '少派' },
  { value: 'more', label: '多派' },
  { value: 'orchestrate', label: '编排' },
  { value: 'none', label: '不派' },
]

function toast(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  useUiStore.getState().toast(text, kind)
}

function requireActive(): ReturnType<typeof useAppStore.getState>['active'] {
  const active = useAppStore.getState().active
  if (!active?.summary) {
    toast('当前没有打开的会话', 'info')
    return null
  }
  return active
}

export const COMMANDS: AppCommand[] = [
  {
    id: 'session.new',
    title: '新会话',
    keywords: ['新建', '聊天', 'new session'],
    defaultShortcut: 'mod+n',
    run: () => {
      const ui = useUiStore.getState()
      // 已经在新会话页时导航不会重新挂载，需要显式清空输入并聚焦。
      if (parseHash().kind === 'home') ui.resetComposer()
      ui.setShowArchived(false)
      ui.setMobileSidebar(false)
      navigate({ kind: 'home' })
    },
  },
  {
    id: 'board.open',
    title: '打开任务看板',
    keywords: ['看板', '任务', '并行', 'board', 'kanban'],
    run: () => {
      const hostId = useAppStore.getState().activeHostId
      if (!hostId) {
        toast('请先连接一个 Host', 'info')
        return
      }
      const ui = useUiStore.getState()
      ui.setMobileSidebar(false)
      navigateBoard(hostId)
    },
  },
  {
    id: 'split.open',
    title: '分屏打开…',
    keywords: ['分屏', '多会话', '窗格', 'split', 'pane'],
    run: () => {
      useUiStore.getState().setSplitPickerOpen(true)
    },
  },
  {
    id: 'session.background-tasks',
    title: '后台任务',
    keywords: ['后台', '任务', '终端', 'background', 'terminal'],
    run: () => {
      const active = requireActive()
      if (!active) return
      useUiStore.getState().openBackgroundTasks(active.hostId, active.sessionId)
    },
  },
  {
    id: 'session.subagents',
    title: '子代理',
    keywords: ['子代理', '代理', 'agent', 'subagent'],
    run: () => {
      const active = requireActive()
      if (!active) return
      useUiStore.getState().setPanelOpen(true)
      useUiStore.getState().toast('子代理列表在右侧信息栏', 'info')
    },
  },
  {
    id: 'session.browser',
    title: '浏览器',
    keywords: ['浏览器', '网页', 'browser'],
    run: () => {
      const active = requireActive()
      if (!active) return
      useUiStore.getState().openBrowserPanel(active.hostId, active.sessionId)
    },
  },
  {
    id: 'session.files',
    title: '文件',
    keywords: ['文件', '目录', 'files', 'browser'],
    run: () => {
      useAppStore.getState().openFileBrowser()
    },
  },
  {
    id: 'session.pr',
    title: 'PR 与 CI',
    keywords: ['PR', 'CI', '拉取请求', '合并', 'checks'],
    run: () => {
      useUiStore.getState().openPrPanel()
    },
  },
  {
    id: 'session.evals',
    title: '评测与轨迹',
    keywords: ['评测', '轨迹', 'eval', '对比', '用例'],
    run: () => {
      useUiStore.getState().openSettings('evals')
    },
  },
  {
    id: 'app.whats-new',
    title: '新功能导览',
    keywords: ['新功能', '更新', 'changelog', 'whats new', '导览'],
    run: () => {
      useUiStore.getState().setTourOpen(true)
    },
  },
  {
    id: 'app.demo',
    title: '打开演示工作区',
    keywords: ['演示', '场景', 'demo', '造数', '体验'],
    run: () => {
      useUiStore.getState().setDemoOpen(true)
    },
  },
  {
    id: 'app.checklist',
    title: '打开体验清单',
    keywords: ['体验清单', '测试要点', 'checklist', '回归', '增量测试'],
    run: () => {
      useUiStore.getState().setChecklistOpen(true)
    },
  },
  {
    id: 'app.onboarding',
    title: '重新看上手引导',
    keywords: ['上手', '引导', '新手', 'onboarding', '帮助'],
    run: () => {
      useUiStore.getState().setOnboardingOpen(true)
    },
  },
  {
    id: 'session.dispatch',
    title: '派单到其他主机',
    keywords: ['派单', '任务', 'dispatch'],
    defaultShortcut: 'mod+alt+d',
    run: () => {
      const store = useAppStore.getState()
      useUiStore.getState().setDispatchOpen(true, store.active?.hostId ?? store.activeHostId ?? undefined)
    },
  },
  {
    id: 'app.toggle-theme',
    title: '切换主题',
    keywords: ['外观', '深色', '浅色', '主题', 'theme'],
    defaultShortcut: 'mod+alt+t',
    run: () => {
      const ui = useUiStore.getState()
      const next = ui.theme === 'light' ? 'dark' : ui.theme === 'dark' ? 'system' : 'light'
      ui.setTheme(next)
      toast(next === 'light' ? '已切换到浅色主题' : next === 'dark' ? '已切换到深色主题' : '主题跟随系统')
    },
  },
  {
    id: 'app.toggle-sidebar',
    title: '切换侧栏',
    keywords: ['侧栏', '收起', '展开', 'sidebar'],
    defaultShortcut: 'mod+b',
    run: () => {
      const ui = useUiStore.getState()
      if (window.matchMedia('(max-width: 767px)').matches) ui.setMobileSidebar(!ui.mobileSidebar)
      else ui.toggleSidebar()
    },
  },
  {
    id: 'app.feedback',
    title: '进入反馈模式',
    keywords: ['反馈', '标注', '问题', 'feedback'],
    defaultShortcut: 'mod+shift+f',
    run: () => {
      useFeedbackStore.getState().enter()
    },
  },
  {
    id: 'app.inbox',
    title: '打开收件箱',
    keywords: ['收件箱', '审批', '提醒', 'inbox'],
    defaultShortcut: 'mod+alt+i',
    run: () => {
      useUiStore.getState().setInboxOpen(true)
    },
  },
  {
    id: 'app.settings',
    title: '打开设置',
    keywords: ['设置', '偏好', 'settings'],
    defaultShortcut: 'mod+alt+s',
    run: () => {
      useUiStore.getState().openSettings()
    },
  },
  {
    id: 'session.changes',
    title: '打开改动审阅',
    keywords: ['改动', 'diff', '审阅', '提交'],
    defaultShortcut: 'mod+alt+g',
    run: () => {
      const active = requireActive()
      if (!active) return
      useUiStore.getState().setChangesOpen(true)
    },
  },
  {
    id: 'session.permission-mode',
    title: '切换权限模式',
    keywords: ['权限', '审批', '自动接受', '计划模式'],
    defaultShortcut: 'mod+alt+p',
    run: () => {
      const active = requireActive()
      if (!active?.summary) return
      const current = active.summary.permissionMode ?? 'default'
      const next = MODES[(MODES.indexOf(current) + 1) % MODES.length]
      void useAppStore.getState().setPermissionMode(next)
      toast(`权限模式：${PERMISSION_MODE_LABELS[next]}`)
    },
  },
  {
    id: 'session.model',
    title: '切换模型',
    keywords: ['模型', 'model', '下一个'],
    defaultShortcut: 'mod+alt+m',
    run: () => {
      const active = requireActive()
      if (!active?.summary) return
      const store = useAppStore.getState()
      const profile = store.runtimes[active.hostId]?.profiles.find(
        (item) => item.id === active.summary?.profileId,
      )
      const groups = profileModelGroups(profile)
      const group = groups.find((item) => (item.groupId ?? '') === (active.summary?.groupId ?? ''))
      const models = group?.models ?? groups[0]?.models ?? []
      if (!profile || models.length === 0) {
        toast('当前账号没有可用模型', 'info')
        return
      }
      const index = models.indexOf(active.summary.model ?? '')
      const next = models[(index + 1) % models.length]
      const groupId = (group ?? groups[0])?.groupId
      void store.setModel(profile.id, groupId, next)
      toast(`模型：${next}`)
    },
  },
  {
    id: 'session.delegation',
    title: '切换委派策略',
    keywords: ['委派', '子代理', 'delegation'],
    defaultShortcut: 'mod+alt+l',
    run: () => {
      const active = requireActive()
      if (!active?.summary) return
      const store = useAppStore.getState()
      const current = active.summary.delegation ?? 'less'
      const index = DELEGATIONS.findIndex((item) => item.value === current)
      const next = DELEGATIONS[(index + 1) % DELEGATIONS.length]
      void store.updateSession(active.hostId, active.sessionId, { delegation: next.value })
      toast(`委派策略：${next.label}`)
    },
  },
  {
    id: 'session.compact',
    title: '压缩上下文',
    keywords: ['上下文', '压缩', 'compact'],
    defaultShortcut: 'mod+alt+c',
    run: () => {
      const active = requireActive()
      if (!active) return
      if (active.running) {
        toast('会话正在运行，结束后才能压缩', 'info')
        return
      }
      useUiStore.getState().openCompactConfirm({ hostId: active.hostId, sessionId: active.sessionId })
    },
  },
]

export const COMMAND_MAP = new Map(COMMANDS.map((command) => [command.id, command]))

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* localStorage 不可用时只影响自定义持久化 */
  }
}

export function loadCommandShortcutOverrides(): Record<string, string> {
  const raw = readJson<Record<string, unknown>>(SHORTCUT_KEY, {})
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (COMMAND_MAP.has(id) && typeof value === 'string' && value) out[id] = value
  }
  return out
}

export function getCommandShortcut(id: string): string | undefined {
  return loadCommandShortcutOverrides()[id] ?? COMMAND_MAP.get(id)?.defaultShortcut
}

export function getShortcutBindings(): Array<{ id: string; shortcut: string }> {
  const overrides = loadCommandShortcutOverrides()
  return COMMANDS.flatMap((command) => {
    const shortcut = overrides[command.id] ?? command.defaultShortcut
    return shortcut ? [{ id: command.id, shortcut }] : []
  })
}

export function setCommandShortcut(id: string, shortcut: string | null): void {
  const overrides = loadCommandShortcutOverrides()
  if (shortcut === null) delete overrides[id]
  else overrides[id] = shortcut
  writeJson(SHORTCUT_KEY, overrides)
}

export function resetCommandShortcuts(): void {
  writeJson(SHORTCUT_KEY, {})
}

/** 找到与 spec 冲突的命令（排除 exceptId）。 */
export function shortcutConflict(spec: string, exceptId: string): AppCommand | undefined {
  const hit = getShortcutBindings().find(
    (binding) => binding.id !== exceptId && binding.shortcut === spec,
  )
  return hit ? COMMAND_MAP.get(hit.id) : undefined
}

export function loadRecentCommands(): string[] {
  const raw = readJson<unknown>(RECENT_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && COMMAND_MAP.has(id))
}

export function pushRecentCommand(id: string): void {
  if (!COMMAND_MAP.has(id)) return
  const next = [id, ...loadRecentCommands().filter((item) => item !== id)].slice(0, RECENT_LIMIT)
  writeJson(RECENT_KEY, next)
}

export function commandForEvent(event: KeyboardEvent): AppCommand | undefined {
  for (const { id, shortcut } of getShortcutBindings()) {
    if (matchShortcut(event, shortcut)) return COMMAND_MAP.get(id)
  }
  return undefined
}
