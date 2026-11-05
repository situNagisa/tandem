import { Monitor, Moon, Smartphone, Sun } from 'lucide-react'
import type { Theme } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'

const THEMES: Array<{ id: Theme; label: string; desc: string; icon: typeof Sun }> = [
  { id: 'light', label: '浅色', desc: '暖白纸面，白天更清爽', icon: Sun },
  { id: 'dark', label: '深色', desc: '低亮度暖黑，夜间更舒适', icon: Moon },
  { id: 'system', label: '跟随系统', desc: '随设备外观自动切换', icon: Monitor },
]

export function AppearanceSection() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)

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
                'rounded-xl border p-3 text-left transition-all duration-150',
                selected
                  ? 'border-accent/50 bg-accent-soft/40 shadow-[0_0_0_1px_var(--t-accent)]'
                  : 'border-border bg-surface hover:border-border-strong/70 hover:bg-surface-2/40',
              )}
              aria-pressed={selected}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg',
                    selected ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
                  )}
                >
                  <Icon size={15} />
                </span>
                <span className="text-[12.5px] font-medium">{t.label}</span>
                {selected && (
                  <span className="ml-auto size-1.5 rounded-full bg-accent" aria-hidden />
                )}
              </div>
              <p className="mt-2 text-[10.5px] leading-4 text-muted">{t.desc}</p>
            </button>
          )
        })}
      </div>

      <div className="mt-5 rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium">
          <Smartphone size={14} className="text-muted" /> 安装到手机主屏
        </div>
        <p className="mt-1.5 text-[11.5px] leading-5 text-muted">
          用手机浏览器打开 Tandem，在分享菜单选择「添加到主屏幕」，即可像 App 一样使用。
          手机与电脑连接同一 Host 时，会话、审批与消息会实时同步。
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-bg/30 p-3.5 text-[11px] leading-5 text-muted">
        Tandem 的配色参考 Claude：暖色中性灰、克制的陶土橙强调色与衬线标题。
        字体使用系统字体，不会加载外部字体文件。
      </div>
    </div>
  )
}
