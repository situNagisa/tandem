import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Loader2, TriangleAlert } from 'lucide-react'
import type { ExternalSource, Message, Session } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { basename, formatRelative } from '../lib/format'
import { defaultChoiceFor } from '../lib/profileModels'
import type { ToolResultBlock } from '../lib/types'
import { cn } from '../lib/cn'
import { MessageList } from './MessageList'

const SOURCE_LABEL: Record<ExternalSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

function collectToolResults(messages: Message[]): Record<string, ToolResultBlock> {
  const map: Record<string, ToolResultBlock> = {}
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_result') map[block.toolUseId] = block
    }
  }
  return map
}

/**
 * 外部会话只读页：直接复用对话区渲染，输入框位置换成“导入后继续”的说明。
 * 原始文件只读，导入才会复制出 Tandem 会话。
 */
export function ExternalSessionView({
  hostId,
  source,
  externalId,
}: {
  hostId: string
  source: ExternalSource
  externalId: string
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const runtime = useAppStore((s) => s.runtimes[hostId])
  const item = useAppStore(
    (s) =>
      s.externalSessions[hostId]?.find((x) => x.source === source && x.id === externalId) ??
      s.runtimes[hostId]?.externalSessions.find(
        (x) => x.source === source && x.id === externalId,
      ) ??
      null,
  )
  const refreshExternalSessions = useAppStore((s) => s.refreshExternalSessions)
  const importExternalSession = useAppStore((s) => s.importExternalSession)
  const toast = useUiStore((s) => s.toast)
  const openSettings = useUiStore((s) => s.openSettings)

  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!runtime?.externalLoaded && !runtime?.externalLoading) {
      void refreshExternalSessions(hostId)
    }
  }, [hostId, runtime?.externalLoaded, runtime?.externalLoading, refreshExternalSessions])

  useEffect(() => {
    if (!host) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSession(null)
    api
      .externalSession(host, source, externalId)
      .then((value) => {
        if (cancelled) return
        setSession(value)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取外部会话失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, source, externalId])

  const toolResults = useMemo(
    () => (session ? collectToolResults(session.messages) : {}),
    [session],
  )
  const importedSessionId = item?.importedSessionId
  const profiles = runtime?.profiles ?? []
  const label = SOURCE_LABEL[source]
  const title = session?.title || item?.title || '外部会话'
  const cwd = session?.cwd || item?.cwd || ''
  const updatedAt = session?.updatedAt ?? item?.updatedAt ?? 0
  const messageCount = session?.messages.length ?? item?.messageCount ?? 0

  const continueInTandem = async () => {
    if (importedSessionId) {
      navigate({ kind: 'session', hostId, sessionId: importedSessionId })
      return
    }
    if (importing) return
    const profile = profiles[0]
    if (!profile) {
      toast('先在设置里添加一个账号，再导入会话', 'error')
      openSettings('profiles')
      return
    }
    const choice = defaultChoiceFor(profile)
    setImporting(true)
    await importExternalSession(hostId, source, externalId, {
      profileId: profile.id,
      ...(choice?.groupId ? { groupId: choice.groupId } : {}),
      ...(choice?.model ? { model: choice.model } : {}),
    })
    setImporting(false)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3 md:px-6">
        <div className="mx-auto w-full max-w-[808px]">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-muted">
            <span>{label} · 只读</span>
            {updatedAt > 0 && (
              <>
                <span>·</span>
                <span>{formatRelative(updatedAt)}</span>
              </>
            )}
            {messageCount > 0 && (
              <>
                <span>·</span>
                <span>{messageCount} 条消息</span>
              </>
            )}
          </div>
          <h1 className="mt-0.5 truncate text-[15px] font-medium leading-6">{title}</h1>
          {cwd && (
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted" title={cwd}>
              {basename(cwd) || cwd}
              <span className="ml-1.5 font-sans">{cwd}</span>
            </p>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-[808px] flex-col px-4 pb-8 pt-4 md:px-6 md:pt-5">
          <div className="flex flex-1 flex-col">
            {loading ? (
              <MessageList showSkeleton />
            ) : error ? (
              <div className="mx-auto mt-10 flex max-w-[340px] items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[11.5px] leading-5 text-danger">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                {error}
              </div>
            ) : session && session.messages.length > 0 ? (
              <MessageList
                messages={session.messages}
                readOnly
                toolResults={toolResults}
                cwd={session.cwd}
              />
            ) : (
              <p className="py-12 text-center text-[12px] text-muted">这个会话没有可显示的消息。</p>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-bg px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 md:px-6 md:pb-5">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
          <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-text-soft">
            {label} 原始会话，仅只读查看。导入后可在 Tandem 中继续对话，原文件不会被修改。
          </p>
          <button
            onClick={() => void continueInTandem()}
            disabled={importing}
            className={cn(
              'flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium transition-colors sm:min-h-8',
              importedSessionId
                ? 'border border-border bg-surface text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text'
                : 'bg-accent text-on-accent hover:bg-accent-hover',
              importing && 'opacity-60',
            )}
          >
            {importing && <Loader2 size={13} className="animate-spin" />}
            {importedSessionId ? '已在 Tandem 中继续 · 打开' : '在 Tandem 中继续'}
            {!importing && <ArrowUpRight size={13} />}
          </button>
        </div>
      </div>
    </div>
  )
}
