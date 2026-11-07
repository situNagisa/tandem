import { useUiStore } from '../store/useUiStore'
import { navigate } from './router'
import {
  cancelNativeNotification,
  isNativeApp,
  notificationId,
  postNativeNotification,
  type NativeNotificationInput,
} from './native'

interface AttentionInput {
  title: string
  body: string
  tag: string
  hostId?: string
  sessionId?: string
  route?: 'session' | 'host'
  /** App 本地通知的分类与操作按钮。 */
  kind?: NativeNotificationInput['extra']['kind']
  requestId?: string
  approval?: boolean
}

let flashTimer: number | null = null
let flashBaseTitle = ''
let flashOn = false
let flashLabel = ''
let badgeLink: HTMLLinkElement | null = null
let badgeOriginal: string | null = null
let badgeInstalled = false

function makeBadge(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#262624'
  ctx.beginPath()
  ctx.roundRect(4, 4, 56, 56, 14)
  ctx.fill()
  ctx.fillStyle = '#d97757'
  ctx.beginPath()
  ctx.arc(32, 32, 18, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff8f4'
  ctx.font = '600 24px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('!', 32, 33)
  return canvas.toDataURL('image/png')
}

function setBadge(active: boolean): void {
  if (active) {
    if (!badgeInstalled) {
      badgeInstalled = true
      badgeLink = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
      badgeOriginal = badgeLink?.getAttribute('href') ?? null
      if (!badgeLink) {
        badgeLink = document.createElement('link')
        badgeLink.rel = 'icon'
        document.head.appendChild(badgeLink)
      }
      const url = makeBadge()
      if (url) badgeLink.href = url
    }
  } else if (badgeInstalled) {
    badgeInstalled = false
    if (badgeLink) {
      if (badgeOriginal !== null) badgeLink.setAttribute('href', badgeOriginal)
      else badgeLink.remove()
    }
    badgeLink = null
    badgeOriginal = null
  }
}

/** 页面不可见时闪烁标签页标题并挂上 favicon 角标。 */
export function flashAttention(label: string): void {
  if (typeof document === 'undefined' || !document.hidden) return
  flashLabel = label
  setBadge(true)
  if (flashTimer !== null) return
  flashBaseTitle = document.title
  flashOn = false
  const tick = () => {
    if (!document.hidden) {
      clearAttention()
      return
    }
    flashOn = !flashOn
    document.title = flashOn ? `● ${flashLabel} · ${flashBaseTitle}` : flashBaseTitle
  }
  tick()
  flashTimer = window.setInterval(tick, 1100)
}

export function clearAttention(): void {
  if (flashTimer !== null) {
    window.clearInterval(flashTimer)
    flashTimer = null
  }
  if (flashBaseTitle) document.title = flashBaseTitle
  flashBaseTitle = ''
  flashLabel = ''
  flashOn = false
  setBadge(false)
}

export function notificationsEnabled(): boolean {
  return useUiStore.getState().notifications
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/** 同一事件可能同时经会话通道和收件箱通道到达：短时间内按 tag 去重。 */
const recentNotifications = new Map<string, number>()
const NOTIFICATION_DEDUPE_MS = 4000

async function postNotification({
  title,
  body,
  tag,
  hostId,
  sessionId,
  kind = 'turn_end',
  requestId,
  approval,
}: AttentionInput) {
  const native = isNativeApp()
  if (native) {
    if (!useUiStore.getState().nativeNotifications) return
  } else if (!notificationsEnabled()) {
    return
  }
  const now = Date.now()
  for (const [key, at] of recentNotifications) {
    if (now - at >= NOTIFICATION_DEDUPE_MS) recentNotifications.delete(key)
  }
  if (recentNotifications.has(tag)) return
  recentNotifications.set(tag, now)

  // 安卓 App：纯本地通知（带允许/拒绝操作），不经过任何推送服务
  if (native) {
    if (!hostId) return
    await postNativeNotification({
      id: notificationId(tag),
      title,
      body,
      approval,
      extra: {
        hostId,
        ...(sessionId ? { sessionId } : {}),
        ...(requestId ? { requestId } : {}),
        kind,
      },
    })
    return
  }

  if (typeof Notification === 'undefined') return
  let permission = Notification.permission
  if (permission === 'default') permission = await requestNotificationPermission()
  if (permission !== 'granted') return
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: '/icons/icon.svg',
      silent: false,
    })
    n.onclick = () => {
      window.focus()
      if (hostId && sessionId) navigate({ kind: 'session', hostId, sessionId })
      else if (hostId) navigate({ kind: 'host', hostId })
      clearAttention()
      n.close()
    }
  } catch {
    /* 部分浏览器在非 PWA 环境拒绝构造通知 */
  }
}

/** 审批已在任意一端处理：撤掉手机通知上的操作按钮。 */
export function cancelPermissionNotification(requestId: string): void {
  if (!isNativeApp()) return
  void cancelNativeNotification(notificationId(`tandem-permission-${requestId}`))
}

/** 回合结束：只在页面不可见时提醒。 */
export function notifyTurnEnd(input: {
  hostId: string
  sessionId: string
  sessionTitle: string
  hostName: string
  reason: 'done' | 'interrupted' | 'error'
  error?: string
}): void {
  if (typeof document === 'undefined' || !document.hidden) return
  const label = input.reason === 'error' ? '回合出错' : '回合完成'
  flashAttention(label)
  const body =
    input.reason === 'error'
      ? input.error ?? '回合执行出错'
      : input.reason === 'interrupted'
        ? '已在后台停止'
        : '可以回来查看结果了'
  void postNotification({
    title: `${label} · ${input.sessionTitle || '未命名会话'}`,
    body: `${input.hostName} · ${body}`,
    tag: `tandem-turn-${input.sessionId}`,
    hostId: input.hostId,
    sessionId: input.sessionId,
    kind: input.reason === 'error' ? 'error' : 'turn_end',
  })
}

/** 审批请求：页面不可见时提醒。 */
export function notifyPermission(input: {
  hostId: string
  sessionId: string
  sessionTitle: string
  hostName: string
  requestId: string
  description: string
}): void {
  if (typeof document === 'undefined' || !document.hidden) return
  flashAttention('等待审批')
  void postNotification({
    title: `等待审批 · ${input.sessionTitle || '未命名会话'}`,
    body: `${input.hostName} · ${input.description}`,
    tag: `tandem-permission-${input.requestId}`,
    hostId: input.hostId,
    sessionId: input.sessionId,
    kind: 'permission',
    requestId: input.requestId,
    approval: true,
  })
}

/** 预算告警：仅在 App 不可见时提醒（Host 级事件）。 */
export function notifyBudget(input: {
  hostId: string
  hostName: string
  text: string
  level: '80' | '100'
  ruleId: string
}): void {
  if (typeof document === 'undefined' || !document.hidden) return
  flashAttention('预算提醒')
  void postNotification({
    title: input.level === '100' ? '预算已达上限' : '预算接近上限',
    body: `${input.hostName} · ${input.text}`,
    tag: `tandem-budget-${input.hostId}-${input.ruleId}-${input.level}`,
    hostId: input.hostId,
    kind: 'budget',
  })
}
