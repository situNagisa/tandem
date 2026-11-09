// 安卓 App 原生能力：纯本地通知（不经 FCM/APNs）与可选的常驻前台服务。
// 浏览器/桌面端 Capacitor.isNativePlatform() 为 false，所有函数都不生效。
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import type { ActionPerformed, LocalNotificationSchema } from '@capacitor/local-notifications'

/** 手机预览窗口：Capacitor 插件不真正加载，原生能力走下面的桩。 */
function mobilePreview(): boolean {
  try {
    return document.documentElement.dataset.mobilePreview === '1'
  } catch {
    return false
  }
}

export function isNativeApp(): boolean {
  if (mobilePreview()) return true
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export function isAndroidApp(): boolean {
  if (mobilePreview()) return true
  try {
    return Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** 通知 id 必须是 32 位整数：把 requestId/会话 id 稳定映射成正整数。 */
export function notificationId(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 2147483000 || 1
}

const APPROVAL_ACTIONS = 'TANDEM_APPROVAL'
let actionsReady = false

async function plugin() {
  const mod = await import('@capacitor/local-notifications')
  return mod.LocalNotifications
}

/** 注册「允许 / 拒绝」通知操作并请求系统通知权限（Android 13+）。 */
export async function prepareLocalNotifications(): Promise<boolean> {
  if (mobilePreview()) return true
  if (!isNativeApp()) return false
  try {
    const LocalNotifications = await plugin()
    const status = await LocalNotifications.checkPermissions()
    let granted = status.display === 'granted'
    if (!granted) {
      const asked = await LocalNotifications.requestPermissions()
      granted = asked.display === 'granted'
    }
    if (!actionsReady) {
      await LocalNotifications.registerActionTypes({
        types: [
          {
            id: APPROVAL_ACTIONS,
            actions: [
              { id: 'allow', title: '允许' },
              { id: 'deny', title: '拒绝', destructive: true },
            ],
          },
        ],
      })
      actionsReady = true
    }
    return granted
  } catch {
    return false
  }
}

export interface NativeNotificationInput {
  id: number
  title: string
  body: string
  /** 仅审批通知带「允许 / 拒绝」按钮。 */
  approval?: boolean
  extra: {
    hostId: string
    sessionId?: string
    requestId?: string
    kind: 'permission' | 'turn_end' | 'error' | 'budget'
  }
}

export async function postNativeNotification(input: NativeNotificationInput): Promise<void> {
  if (mobilePreview()) {
    console.info('[tandem] 预览环境：本地通知（模拟）', input.title)
    return
  }
  if (!isNativeApp()) return
  try {
    const LocalNotifications = await plugin()
    const notification: LocalNotificationSchema = {
      id: input.id,
      title: input.title,
      body: input.body,
      smallIcon: 'ic_stat_tandem',
      ...(input.approval ? { actionTypeId: APPROVAL_ACTIONS } : {}),
      extra: input.extra,
    }
    await LocalNotifications.schedule({ notifications: [notification] })
  } catch {
    /* 权限未授予或插件不可用时静默失败 */
  }
}

export async function cancelNativeNotification(id: number): Promise<void> {
  if (mobilePreview()) return
  if (!isNativeApp()) return
  try {
    const LocalNotifications = await plugin()
    await LocalNotifications.cancel({ notifications: [{ id }] })
  } catch {
    /* 忽略 */
  }
}

/** 监听通知按钮/点击；返回移除函数。 */
export async function onNativeNotificationAction(
  handler: (actionId: string, extra: NativeNotificationInput['extra']) => void,
): Promise<(() => void) | undefined> {
  if (mobilePreview()) return undefined
  if (!isNativeApp()) return undefined
  try {
    const LocalNotifications = await plugin()
    const handle: PluginListenerHandle = await LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action: ActionPerformed) => {
        const extra = action.notification.extra as NativeNotificationInput['extra'] | undefined
        if (!extra) return
        handler(action.actionId, extra)
      },
    )
    return () => void handle.remove()
  } catch {
    return undefined
  }
}

async function foregroundPlugin() {
  const mod = await import('@capawesome-team/capacitor-android-foreground-service')
  return mod.ForegroundService
}

/** 常驻通知「Tandem 正在连接 X 台主机」：让 WS 在 App 退到后台后继续保留。 */
export async function startBackgroundService(hostCount: number): Promise<boolean> {
  if (mobilePreview()) {
    console.info('[tandem] 预览环境：前台服务（模拟）', hostCount)
    return true
  }
  if (!isAndroidApp()) return false
  try {
    const ForegroundService = await foregroundPlugin()
    const perm = await ForegroundService.checkPermissions()
    if (perm.display !== 'granted') {
      const asked = await ForegroundService.requestPermissions()
      if (asked.display !== 'granted') return false
    }
    await ForegroundService.startForegroundService({
      id: 7301,
      title: 'Tandem 正在保持连接',
      body:
        hostCount > 0
          ? `正在连接 ${hostCount} 台主机，审批可以随时送达`
          : '等待添加主机',
      smallIcon: 'ic_stat_tandem',
      silent: true,
    })
    return true
  } catch {
    return false
  }
}

export async function updateBackgroundService(hostCount: number): Promise<void> {
  if (mobilePreview()) return
  if (!isAndroidApp()) return
  try {
    const ForegroundService = await foregroundPlugin()
    await ForegroundService.updateForegroundService({
      id: 7301,
      title: 'Tandem 正在保持连接',
      body:
        hostCount > 0
          ? `正在连接 ${hostCount} 台主机，审批可以随时送达`
          : '等待添加主机',
      smallIcon: 'ic_stat_tandem',
      silent: true,
    })
  } catch {
    /* 服务未运行时忽略 */
  }
}

export async function stopBackgroundService(): Promise<void> {
  if (mobilePreview()) return
  if (!isAndroidApp()) return
  try {
    const ForegroundService = await foregroundPlugin()
    await ForegroundService.stopForegroundService()
  } catch {
    /* 忽略 */
  }
}
