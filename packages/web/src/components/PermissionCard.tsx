import { useEffect, useMemo } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import type { PermissionDecision, PermissionRequest } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { cn } from '../lib/cn'
import { CodeBlock } from './CodeBlock'
import { DiffView } from './DiffView'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function PermissionCard({
  request,
  more,
}: {
  request: PermissionRequest
  more: number
}) {
  const decide = useAppStore((s) => s.decidePermission)
  const input = useMemo(() => asRecord(request.input), [request.input])
  const toolName = request.toolName
  const command = str(input.command)
  const filePath = str(input.file_path)
  const oldString = str(input.old_string)
  const newString = str(input.new_string)
  const content = str(input.content)

  const handle = (decision: PermissionDecision) => decide(request.id, decision)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen || ui.mobileSidebar || ui.mobilePanel) return
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.key === '1') {
        e.preventDefault()
        decide(request.id, 'allow')
      } else if (e.key === '2') {
        e.preventDefault()
        decide(request.id, 'allow_always')
      } else if (e.key === '3') {
        e.preventDefault()
        decide(request.id, 'deny')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request.id, decide])

  let preview: React.ReactNode = null
  if (toolName === 'Bash' && command) {
    preview = (
      <CodeBlock code={`$ ${command}`} language="bash" showHeader={false} maxHeight={150} />
    )
  } else if (toolName === 'Edit' && (oldString || newString)) {
    preview = (
      <DiffView oldText={oldString} newText={newString} fileName={filePath || 'Edit'} />
    )
  } else if (toolName === 'Write' && content) {
    preview = <CodeBlock code={content} fileName={filePath} showHeader maxHeight={180} />
  } else if (filePath) {
    preview = (
      <div className="rounded-lg border border-border/70 bg-surface-2/30 px-3 py-2 font-mono text-[11.5px] text-text-soft">
        {filePath}
      </div>
    )
  } else if (Object.keys(input).length > 0) {
    preview = (
      <CodeBlock
        code={JSON.stringify(input, null, 2)}
        language="json"
        showHeader={false}
        maxHeight={150}
      />
    )
  }

  return (
    <div className="anim-slide-up mb-2 overflow-hidden rounded-xl border border-warning/40 bg-surface shadow-[0_10px_30px_-16px_rgba(40,30,20,0.35)]">
      <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
          <ShieldAlert size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-text">需要你的批准</span>
            <span className="rounded-md border border-border bg-surface-2/60 px-1.5 py-px font-mono text-[10px] text-text-soft">
              {toolName}
            </span>
            {more > 0 && (
              <span className="text-[10.5px] text-muted">另有 {more} 个待审批</span>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-text-soft">
            {request.description}
          </p>
        </div>
      </div>
      {preview && (
        <div className="max-h-[min(36dvh,340px)] overflow-y-auto px-3.5 pb-2.5">{preview}</div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-bg/30 px-3 py-2.5">
        <button
          onClick={() => handle('deny')}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text sm:min-h-9"
        >
          拒绝
          <kbd className="rounded border border-border px-1 text-[10px] text-muted">3</kbd>
        </button>
        <button
          onClick={() => handle('allow_always')}
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface-2/70 px-3 text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text sm:min-h-9"
        >
          总是允许
          <kbd className="rounded border border-border px-1 text-[10px] text-muted">2</kbd>
        </button>
        <button
          onClick={() => handle('allow')}
          className={cn(
            'flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover sm:min-h-9',
          )}
        >
          允许
          <kbd className="rounded border border-white/30 px-1 text-[10px] opacity-80">1</kbd>
        </button>
      </div>
    </div>
  )
}

export function PermissionLoading() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <Loader2 size={13} className="animate-spin" /> 等待审批信息…
    </div>
  )
}
