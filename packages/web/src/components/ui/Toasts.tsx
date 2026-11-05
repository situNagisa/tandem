import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
} as const

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] z-[60] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-4 md:top-16 md:bottom-auto md:items-end">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <div
            key={t.id}
            className={cn(
              'anim-slide-up pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-lg backdrop-blur',
              t.kind === 'error'
                ? 'border-danger/30 bg-danger-soft/95 text-danger'
                : t.kind === 'success'
                  ? 'border-success/30 bg-success-soft/95 text-success'
                  : 'border-border bg-surface/95 text-text',
            )}
            role="status"
          >
            <Icon size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="-mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:opacity-100"
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
