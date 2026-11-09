import { useState } from 'react'
import { isUserTurnMessage } from '@tandem/protocol'
import type { ContentBlock, InjectionChange, InjectionSegment, InjectionSource } from '@tandem/protocol'
import { ChevronRight, ScrollText } from 'lucide-react'
import { useSessionView } from '../session/SessionScope'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import type { UiMessage } from '../../lib/types'
import { openFileRef } from '../Markdown'

export function TypingIndicator() {
  return (
    <div className="thinking-dots flex items-center gap-1 py-2" aria-label="正在回复">
      <span />
      <span />
      <span />
    </div>
  )
}

export function dataUrl(block: Extract<ContentBlock, { type: 'image' }>): string {
  return `data:${block.mediaType};base64,${block.dataBase64}`
}

/** 注入上下文不算一轮对话，只有用户真正写的文字或图片才计轮次。 */
export function hasUserContent(message: UiMessage): boolean {
  return isUserTurnMessage(message)
}


export function ContextNote({ kind, text }: { kind: string; text: string }) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  return (
    <div className="my-0.5 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setMounted(true)
          setOpen((v) => !v)
        }}
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] leading-none text-muted transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-soft max-sm:min-h-11"
      >
        <ScrollText size={12} className="shrink-0 opacity-70" />
        <span className="min-w-0 truncate">注入上下文 · {kind}</span>
        <ChevronRight
          size={11}
          className={cn(
            'shrink-0 opacity-60 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      </button>
      {mounted && (
        <div className="collapse-grid" data-open={open}>
          <div className="collapse-inner">
            <pre className="my-1 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 font-mono text-[12px] leading-5 text-text-soft">
              {text}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

/** 系统提示注入段落：会话开头默认折叠成一行灰字，展开看每段来源与全文。 */
const INJECTION_SOURCE_LABEL: Record<InjectionSource, string> = {
  builtin: '内置',
  user: '用户修改',
  project: '项目覆盖',
  memory: '记忆',
  skill: 'Skill',
  generated: '自动生成',
  hook: 'Hook',
  session: '会话设置',
}

function InjectionSegments({
  segments,
  cwd,
}: {
  segments: InjectionSegment[]
  cwd?: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <div className="my-1 space-y-0.5 rounded-lg border border-border/60 bg-[var(--t-bg-subtle)]/60 p-1.5">
      {segments.map((seg) => {
        const open = openId === seg.id
        return (
          <div key={seg.id} className="min-w-0">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : seg.id)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] leading-none text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              <ChevronRight
                size={11}
                className={cn('shrink-0 opacity-60 transition-transform', open && 'rotate-90')}
              />
              <span className="min-w-0 truncate">{seg.name}</span>
              <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-muted">
                {INJECTION_SOURCE_LABEL[seg.source] ?? seg.source}
              </span>
              {seg.sourcePath && (
                <span
                  role="link"
                  tabIndex={0}
                  data-tip={`打开 ${seg.sourcePath}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (seg.sourcePath) openFileRef({ path: seg.sourcePath }, cwd)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && seg.sourcePath) {
                      e.stopPropagation()
                      openFileRef({ path: seg.sourcePath }, cwd)
                    }
                  }}
                  className="min-w-0 shrink truncate rounded px-1 text-[12px] text-accent-text underline-offset-2 hover:underline"
                >
                  {seg.sourcePath.split('/').slice(-1)[0]}
                </span>
              )}
              <span className="flex-1" />
              <span className="shrink-0 font-mono text-[12px] text-muted">
                {formatTokens(seg.tokens)}
              </span>
            </button>
            {open && (
              <pre className="my-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 font-mono text-[12.5px] leading-5 text-text-soft">
                {seg.content}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function InjectionsNote({ cwd }: { cwd?: string }) {
  const injections = useSessionView((s) => s?.injections)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  if (!injections || injections.segments.length === 0) return null
  return (
    <div className="msg-row mb-1 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setMounted(true)
          setOpen((v) => !v)
        }}
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] leading-none text-muted transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
      >
        <ScrollText size={12} className="shrink-0 opacity-70" />
        <span className="min-w-0 truncate">
          系统提示 · {injections.segments.length} 段 · {formatTokens(injections.totalTokens)} tokens
        </span>
        <ChevronRight
          size={11}
          className={cn('shrink-0 opacity-60 transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {mounted && (
        <div className="collapse-grid" data-open={open}>
          <div className="collapse-inner">
            <InjectionSegments segments={injections.segments} cwd={cwd} />
          </div>
        </div>
      )}
    </div>
  )
}

/** 中途上下文变化：在发生变化的那一轮前插一行灰字。 */
export function InjectionChangeNote({ change }: { change: InjectionChange }) {
  return (
    <div className="mb-1 px-1 text-[12px] leading-4 text-muted">
      上下文已更新：{change.summary}
    </div>
  )
}
