import { useEffect, useState } from 'react'
import { Bell, Check, MessageSquarePlus, Monitor, Moon, Smartphone, Sun } from 'lucide-react'
import type { Theme } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { modLabel } from '../../lib/format'
import { requestNotificationPermission } from '../../lib/attention'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Controls'
import { useFeedbackStore } from '../../store/useFeedbackStore'

const THEMES: Array<{ id: Theme; label: string; desc: string; icon: typeof Sun }> = [
  { id: 'light', label: '浅色', desc: '暖白纸面，白天更清爽', icon: Sun },
  { id: 'dark', label: '深色', desc: '低亮度暖黑，夜间更舒适', icon: Moon },
  { id: 'system', label: '跟随系统', desc: '随设备外观自动切换', icon: Monitor },
]

const PREVIEW = {
  light: { bg: '#FAF9F5', side: '#F5F4ED', surface: '#FFFFFF', text: '#1F1E1D', soft: '#E4E1D8' },
  dark: { bg: '#262624', side: '#1F1E1D', surface: '#30302E', text: '#F5F4EE', soft: '#3A3936' },
} as const

function ThemePreview({ mode }: { mode: Theme }) {
  const modes = mode === 'system' ? (['light', 'dark'] as const) : ([mode] as const)
  return (
    <div className="flex h-[62px] overflow-hidden rounded-lg border border-border">
      {modes.map((m) => {
        const p = PREVIEW[m]
        return (
          <div key={m} className="relative h-full flex-1" style={{ background: p.bg }}>
            <div className="absolute inset-y-0 left-0 w-[22%]" style={{ background: p.side }} />
            <div
              className="absolute left-[30%] top-3 h-1.5 w-[42%] rounded-full"
              style={{ background: p.text, opacity: 0.8 }}
            />
            <div
              className="absolute left-[30%] top-[22px] h-1.5 w-[28%] rounded-full"
              style={{ background: p.soft }}
            />
            <div
              className="absolute bottom-2 right-2 h-[18px] w-[38%] rounded-md border"
              style={{ background: p.surface, borderColor: p.soft }}
            />
          </div>
        )
      })}
    </div>
  )
}

export function AppearanceSection() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const notifications = useUiStore((s) => s.notifications)
  const setNotifications = useUiStore((s) => s.setNotifications)
  const toast = useUiStore((s) => s.toast)
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const current = Notification.permission
    setPermission(current)
    // 浏览器权限被拒后，持久化的开关不能继续显示为开启。
    if (current === 'denied' && notifications) setNotifications(false)
  }, [notifications, setNotifications])

  const toggleNotifications = async () => {
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">外观</h3>
        <span className="text-[11px] text-muted">切换即时生效</span>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {THEMES.map((t) => {
          const Icon = t.icon
          const selected = theme === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                'relative rounded-xl border p-2 text-left transition-colors duration-[120ms]',
                selected
                  ? 'border-[#5a5a5a] bg-[var(--t-surface-2)]'
                  : 'border-border bg-surface hover:border-[var(--t-border-strong)]',
              )}
              aria-pressed={selected}
            >
              {selected && (
                <span
                  className="absolute right-3.5 top-3.5 z-10 flex size-4 items-center justify-center rounded-full bg-[var(--t-text)] text-[var(--t-bg)]"
                  aria-hidden
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              )}
              <ThemePreview mode={t.id} />
              <div className="mt-2 flex items-center gap-1.5 px-0.5">
                <Icon size={13} className={selected ? 'text-text-soft' : 'text-muted'} />
                <span className="text-[12px] font-medium">{t.label}</span>
              </div>
              <p className="mt-0.5 px-0.5 text-[10px] leading-4 text-muted">{t.desc}</p>
            </button>
          )
        })}
      </div>

      <div className="mt-5 rounded-xl border border-border bg-surface p-3.5">
        <div className="text-[12px] font-medium">键盘快捷键</div>
        <dl className="mt-2 grid gap-x-6 sm:grid-cols-[repeat(2,minmax(0,380px))]">
          {[
            ['发送消息', 'Enter'],
            ['换行', 'Shift + Enter'],
            ['中断当前回合', 'Esc'],
            ['切换权限模式', 'Shift + Tab'],
            ['调出上一条发送', '↑（输入框为空）'],
            ['新会话', `${modLabel} N`],
            ['搜索会话', `${modLabel} K`],
            ['收起 / 展开侧栏', `${modLabel} B`],
            ['切换上 / 下一个会话', `${modLabel} ⇧ [ / ]`],
            ['侧栏内切换会话', '↑ / ↓'],
          ].map(([label, keys]) => (
            <div key={label} className="flex min-h-7 min-w-0 items-center gap-2 text-[12px]">
              <dt className="truncate text-text-soft">{label}</dt>
              <dd className="shrink-0">
                <kbd className="whitespace-nowrap rounded-[4px] border border-border bg-[var(--t-surface-2)] px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-text-soft">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-muted" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">桌面通知</div>
            <p className="mt-0.5 text-[11px] leading-5 text-muted">
              页面不可见时，回合结束与审批请求通过系统通知提醒；标题与 favicon 也会保留角标。
            </p>
          </div>
          <Switch
            checked={notifications}
            onChange={() => void toggleNotifications()}
            disabled={permission === 'denied'}
            label="桌面通知"
          />
        </div>
        {permission === 'denied' && (
          <p className="mt-2 text-[10.5px] leading-5 text-warning">
            浏览器已拒绝通知权限，可在地址栏的站点设置里重新允许。
          </p>
        )}
      </div>

      <div className="mt-3 rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium">
          <Smartphone size={14} className="text-muted" /> 安装到手机主屏
        </div>
        <p className="mt-1.5 text-[11.5px] leading-5 text-muted">
          用手机浏览器打开 Tandem，在分享菜单选择「添加到主屏幕」，即可像 App 一样使用。
          手机与电脑连接同一 Host 时，会话、审批与消息会实时同步。
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-[var(--t-bg)] p-3.5 text-[11px] leading-5 text-muted">
        Tandem 使用暖色中性灰与克制的陶土橙强调色，衬线字体只用于标题。所有字体来自系统，不加载外部资源。
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3.5">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium">反馈</div>
          <p className="mt-0.5 text-[11px] leading-5 text-muted">
            圈出界面问题并导出，附截图与上下文，发给我即可。
          </p>
        </div>
        <Button
          size="md"
          variant="secondary"
          icon={<MessageSquarePlus size={14} />}
          onClick={() => useFeedbackStore.getState().enter()}
        >
          进入反馈模式
        </Button>
      </div>
    </div>
  )
}
