import { useEffect, useState } from 'react'
import { Bell, BellRing, Smartphone, TriangleAlert, Wallet } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { requestNotificationPermission } from '../../lib/attention'
import { isAndroidApp, isNativeApp, prepareLocalNotifications, startBackgroundService, stopBackgroundService } from '../../lib/native'
import { Switch } from '../ui/Controls'

function Row({
  icon,
  title,
  desc,
  checked,
  onChange,
  disabled,
  warning,
  settingId,
}: {
  icon?: React.ReactNode
  title: string
  desc: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  warning?: string
  settingId?: string
}) {
  return (
    <div data-setting-id={settingId} className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-muted">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{title}</div>
          <p className="mt-0.5 text-[13px] leading-5 text-muted">{desc}</p>
        </div>
        <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
      </div>
      {warning ? (
        <p className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-5 text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ) : null}
    </div>
  )
}

const EVENT_ROWS = [
  { key: 'permission', label: '等待审批', desc: '工具需要允许/拒绝时提醒，通知上可直接操作', icon: BellRing },
  { key: 'turnEnd', label: '回合完成', desc: '会话跑完一轮后提醒', icon: Bell },
  { key: 'error', label: '回合出错', desc: '执行失败或中断时提醒', icon: TriangleAlert },
  { key: 'budget', label: '预算告警', desc: '达到 80% / 100% 时提醒', icon: Wallet },
] as const

export function NotificationsSection() {
  const notifications = useUiStore((s) => s.notifications)
  const setNotifications = useUiStore((s) => s.setNotifications)
  const nativeNotifications = useUiStore((s) => s.nativeNotifications)
  const setNativeNotifications = useUiStore((s) => s.setNativeNotifications)
  const backgroundService = useUiStore((s) => s.backgroundService)
  const setBackgroundService = useUiStore((s) => s.setBackgroundService)
  const notifyEvents = useUiStore((s) => s.notifyEvents)
  const setNotifyEvent = useUiStore((s) => s.setNotifyEvent)
  const toast = useUiStore((s) => s.toast)
  const hostCount = useAppStore((s) => s.hosts.length)
  const onlineCount = useAppStore(
    (s) => Object.values(s.runtimes).filter((rt) => rt.status === 'online').length,
  )
  const native = isNativeApp()
  const android = isAndroidApp()
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const current = Notification.permission
    setPermission(current)
    if (current === 'denied' && notifications) setNotifications(false)
  }, [notifications, setNotifications])

  const toggleDesktop = async () => {
    if (notifications) {
      setNotifications(false)
      return
    }
    if (typeof Notification === 'undefined') {
      toast('当前浏览器不支持系统通知', 'info')
      return
    }
    const result =
      Notification.permission === 'default'
        ? await requestNotificationPermission()
        : Notification.permission
    setPermission(result)
    if (result !== 'granted') {
      toast('浏览器没有授予通知权限，可在站点设置中开启', 'info')
      return
    }
    setNotifications(true)
  }

  const toggleNative = async () => {
    if (nativeNotifications) {
      setNativeNotifications(false)
      return
    }
    const ok = await prepareLocalNotifications()
    if (!ok) {
      toast('系统未授予通知权限，请在安卓系统设置中允许 Tandem 发送通知', 'info')
      return
    }
    setNativeNotifications(true)
  }

  const toggleBackground = async () => {
    if (backgroundService) {
      setBackgroundService(false)
      await stopBackgroundService()
      toast('已关闭后台保持连接', 'info')
      return
    }
    if (!android) {
      toast('后台保持连接仅安卓 App 支持', 'info')
      return
    }
    const started = await startBackgroundService(hostCount)
    if (!started) {
      toast('无法启动后台服务，请检查通知权限', 'error')
      return
    }
    setBackgroundService(true)
    toast('已开启后台保持连接，锁屏时也会收到审批通知', 'success')
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">通知</h3>
        <span className="text-[13px] text-muted">
          {native ? `已连接 ${onlineCount}/${hostCount} 台主机` : '跨会话提醒与审批'}
        </span>
      </div>

      <div className="space-y-2.5">
        <Row
          settingId="notifications.desktop"
          icon={<Bell size={14} />}
          title="桌面通知"
          desc="页面不可见时，回合结束、审批请求与预算告警通过系统通知提醒；标题与 favicon 保留角标。"
          checked={notifications}
          onChange={() => void toggleDesktop()}
          disabled={permission === 'denied'}
          {...(permission === 'denied'
            ? { warning: '浏览器已拒绝通知权限，可在地址栏的站点设置里重新允许。' }
            : {})}
        />
        <Row
          settingId="notifications.app"
          icon={<Smartphone size={14} />}
          title="App 通知（本地）"
          desc="安卓 App 收到审批或回合结束时弹出系统通知，审批通知带「允许 / 拒绝」按钮。全部在本机完成，不经过任何推送服务。"
          checked={nativeNotifications}
          onChange={() => void toggleNative()}
          {...(!native
            ? { warning: '仅安卓 App 生效；手机浏览器受系统限制，页面退到后台后无法实时提醒。' }
            : {})}
        />
        <Row
          settingId="notifications.background"
          icon={<Smartphone size={14} />}
          title="后台保持连接"
          desc="用 Android 前台服务常驻一条「Tandem 正在连接」通知，App 退到后台或锁屏后仍保持 WebSocket，审批可实时送达。"
          checked={backgroundService}
          onChange={() => void toggleBackground()}
          disabled={!android}
          warning={
            android
              ? '会增加耗电（常驻通知与网络保活）。关闭后 App 回到前台会立即重连并补齐期间的事件，只是后台期间收不到即时提醒。'
              : '仅安卓 App 支持。桌面与浏览器无需开启。'
          }
        />
      </div>

      <div data-setting-id="notifications.events" className="mt-5 rounded-xl border border-border bg-surface p-3.5">
        <div className="text-[13px] font-medium">提醒哪些事件</div>
        <p className="mt-0.5 text-[13px] leading-5 text-muted">
          只影响系统通知；收件箱始终记录全部事件。
        </p>
        <div className="mt-2 divide-y divide-border">
          {EVENT_ROWS.map(({ key, label, desc, icon: Icon }) => (
            <div key={key} className="flex items-center gap-2.5 py-2">
              <Icon size={13} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-text-soft">{label}</div>
                <div className="text-[12px] leading-5 text-muted">{desc}</div>
              </div>
              <Switch
                checked={notifyEvents[key]}
                onChange={(checked) => setNotifyEvent(key, checked)}
                label={label}
              />
            </div>
          ))}
        </div>
      </div>

      <p className="mt-3 rounded-xl border border-border bg-[var(--t-bg)] p-3.5 text-[12.5px] leading-5 text-muted">
        通知只在手机与 Host 处于同一局域网（或已加入同一 Tailscale 网络）且 App
        保持连接时送达。所有审批仍在主机上执行与记录，不依赖第三方推送服务。
      </p>
    </div>
  )
}
