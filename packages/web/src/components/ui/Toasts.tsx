import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { IconButton } from './Button'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
} as const

const ICON_COLOR = {
  info: 'text-muted',
  success: 'text-muted',
  error: 'text-danger',
} as const

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] z-[60] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-auto md:right-4 md:top-14 md:items-end">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            onClick={
              t.onClick
                ? () => {
                    t.onClick?.()
                    dismiss(t.id)
                  }
                : undefined
            }
            className={cn(
              'anim-toast-in group pointer-events-auto flex w-full max-w-md origin-top-right items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-[12.5px] leading-5 text-text shadow-[var(--t-shadow-md)]',
              t.onClick && 'cursor-pointer hover:bg-[var(--t-bg-hover)]',
            )}
          >
            <Icon size={15} className={cn('mt-0.5 shrink-0', ICON_COLOR[t.kind])} />
            <span
              className="line-clamp-2 min-w-0 flex-1 break-words group-hover:line-clamp-none"
              title={t.text}
            >
              {t.text}
            </span>
            <IconButton
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                dismiss(t.id)
              }}
              label="关闭提示"
              className="-mr-1 -mt-0.5 size-6 opacity-60 hover:opacity-100 [&_svg]:size-[13px]"
            >
              <X size={13} />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}
