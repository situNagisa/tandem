import { useEffect, useMemo } from 'react'
import { ShieldAlert } from 'lucide-react'
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

function Kbd({ children, inverse }: { children: React.ReactNode; inverse?: boolean }) {
  return (
    <kbd
      className={cn(
        'ml-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded border px-1 text-[10px] font-normal leading-none',
        inverse
          ? 'border-white/25 text-white/70'
          : 'border-border/90 text-muted',
      )}
    >
      {children}
    </kbd>
  )
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
      if (
        ui.settingsOpen ||
        ui.newSessionOpen ||
        ui.searchOpen ||
        ui.mobileSidebar ||
        ui.mobilePanel
      ) {
        return
      }
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
      <div className="max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[color-mix(in_srgb,var(--t-bg)_55%,transparent)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-text">
        <span className="select-none text-muted">$ </span>
        {command}
      </div>
    )
  } else if (toolName === 'Edit' && (oldString || newString)) {
    preview = (
      <DiffView
        oldText={oldString}
        newText={newString}
        fileName={filePath || 'Edit'}
        maxHeight={240}
      />
    )
  } else if (toolName === 'Write' && content) {
    preview = <CodeBlock code={content} fileName={filePath} maxHeight={180} />
  } else if (filePath) {
    preview = (
      <div className="truncate rounded-lg bg-[color-mix(in_srgb,var(--t-surface-2)_60%,transparent)] px-3 py-2 font-mono text-[12px] text-text-soft">
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
    <div className="permission-card mb-2.5">
      <div className="flex items-start gap-2.5 px-4 pb-2 pt-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <ShieldAlert size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-text">需要你的许可</span>
            <span className="rounded border border-border bg-[color-mix(in_srgb,var(--t-surface-2)_55%,transparent)] px-1.5 py-px font-mono text-[10.5px] text-text-soft">
              {toolName}
            </span>
            {more > 0 && (
              <span className="text-[11px] text-muted">另有 {more} 个待审批</span>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-text-soft">
            {request.description}
          </p>
        </div>
      </div>
      {preview && (
        <div className="max-h-[min(34dvh,320px)] overflow-y-auto px-4 pb-2.5">{preview}</div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/70 px-3 py-2.5">
        <button
          onClick={() => handle('deny')}
          className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-[12.5px] text-text-soft transition-colors hover:bg-bg-hover hover:text-text sm:min-h-8"
        >
          拒绝
          <Kbd>3</Kbd>
        </button>
        <button
          onClick={() => handle('allow_always')}
          className="flex min-h-11 items-center gap-1 rounded-lg border border-border bg-surface px-3 text-[12.5px] text-text-soft transition-colors hover:bg-bg-hover hover:text-text sm:min-h-8"
        >
          总是允许
          <Kbd>2</Kbd>
        </button>
        <button
          onClick={() => handle('allow')}
          className="flex min-h-11 items-center gap-1 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover sm:min-h-8"
        >
          允许
          <Kbd inverse>1</Kbd>
        </button>
      </div>
    </div>
  )
}
