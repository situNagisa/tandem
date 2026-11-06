import { useUiStore } from '../store/useUiStore'
import { navigate } from './router'

interface AttentionInput {
  title: string
  body: string
  tag: string
  hostId?: string
  sessionId?: string
  route?: 'session' | 'host'
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

async function postNotification({ title, body, tag, hostId, sessionId }: AttentionInput) {
  if (!notificationsEnabled()) return
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
  })
}
