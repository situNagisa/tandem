// 安卓 App 启动时接入本地通知：注册「允许/拒绝」操作、通知点击跳转，并按设置启停前台服务。
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from './router'
import {
  isNativeApp,
  onNativeNotificationAction,
  prepareLocalNotifications,
  startBackgroundService,
  stopBackgroundService,
  updateBackgroundService,
} from './native'

let started = false

export async function initNativeBridge(): Promise<void> {
  if (started || !isNativeApp()) return
  started = true
  if (useUiStore.getState().nativeNotifications) await prepareLocalNotifications()
  await onNativeNotificationAction((actionId, extra) => {
    const store = useAppStore.getState()
    if (actionId === 'allow' || actionId === 'deny') {
      if (extra.requestId) {
        store.decideInboxPermission(
          extra.hostId,
          extra.requestId,
          actionId === 'allow' ? 'allow' : 'deny',
        )
      }
      return
    }
    // 点通知本体：打开对应会话（或 Host 首页）
    if (extra.sessionId) navigate({ kind: 'session', hostId: extra.hostId, sessionId: extra.sessionId })
    else navigate({ kind: 'host', hostId: extra.hostId })
  })
}

/** 设置里的「后台保持连接」变化或 Host 数量变化时同步前台服务。 */
export async function syncBackgroundService(hostCount: number): Promise<void> {
  if (!isNativeApp()) return
  if (useUiStore.getState().backgroundService) {
    await startBackgroundService(hostCount)
    await updateBackgroundService(hostCount)
  } else {
    await stopBackgroundService()
  }
}
