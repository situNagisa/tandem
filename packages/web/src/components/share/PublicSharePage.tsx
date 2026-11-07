import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Eye, Loader2, TriangleAlert } from 'lucide-react'
import type { PublicShare } from '@tandem/protocol'
import type { ToolResultBlock, UiMessage } from '../../lib/types'
import { fetchPublicShare } from '../../lib/api'
import { useViewportHeight } from '../../lib/hooks'
import { BrandMark } from '../BrandMark'
import { Button } from '../ui/Button'
import { MessageList } from '../MessageList'
import '../../styles/chat.css'

function readShareId(): string {
  const match = window.location.pathname.match(/^\/s\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

function readToken(): string {
  const raw = window.location.hash.replace(/^#/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function PublicSharePage() {
  useViewportHeight()
  const shareId = readShareId()
  const token = readToken()
  const [data, setData] = useState<PublicShare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!shareId || !token) {
      setLoading(false)
      return
    }
    let cancelled = false
    let first = true
    const load = async () => {
      try {
        const next = await fetchPublicShare(shareId, token, !first)
        first = false
        if (cancelled) return
        setData(next)
        setError(null)
        setLoading(false)
        if (next.live) {
          timer.current = window.setTimeout(load, 3000)
        }
      } catch (err) {
        if (cancelled) return
        setLoading(false)
        const status = err instanceof Error && 'status' in err ? (err as { status?: number }).status : undefined
        // 已撤销 / 过期：立刻清掉页面上的旧内容，避免链接失效后仍能看到缓存。
        if (status === 404) {
          setData(null)
          setError('分享链接无效或已撤销')
          return
        }
        setError(err instanceof Error ? err.message : '无法读取分享内容')
        // 网络抖动时继续重试
        timer.current = window.setTimeout(load, 5000)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [shareId, token, nonce])

  useEffect(() => {
    if (data) document.title = `${data.title} · 只读分享`
  }, [data])

  const toolResults = useMemo(() => {
    const map: Record<string, ToolResultBlock> = {}
    for (const message of data?.messages ?? []) {
      for (const block of message.content) {
        if (block.type === 'tool_result') map[block.toolUseId] = block
      }
    }
    return map
  }, [data])

  const invalid = !shareId || !token

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/92 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-4 py-2.5 md:px-6">
          <BrandMark size={22} className="shrink-0 rounded-md" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[13px] font-medium leading-5">
              {data?.title || '会话分享'}
              <span className="text-muted"> · 只读分享</span>
            </h1>
            <p className="truncate text-[11px] leading-4 text-muted">
              {data?.hostName ? `来自 ${data.hostName}` : 'Tandem Host'}
              {data && !data.live ? ' · 创建时快照' : data ? ' · 实时' : ''}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] leading-4 text-muted">
            <Eye size={11} />
            只读
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-5 md:px-6">
        {invalid ? (
          <EmptyState
            title="链接不完整"
            desc="分享链接需要包含 # 后面的访问 token。请向分享者索取完整链接。"
          />
        ) : loading && !data ? (
          <MessageList showSkeleton />
        ) : error && !data ? (
          <EmptyState
            title={error}
            desc="链接可能已被撤销、已过期，或 Host 当前不可达。"
            action={
              <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
                重试
              </Button>
            }
          />
        ) : data ? (
          <>
            {error && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-2.5 py-2 text-[12px] text-warning">
                <TriangleAlert size={12} />
                连接中断，正在重试：{error}
              </div>
            )}
            <MessageList
              messages={data.messages as UiMessage[]}
              readOnly
              toolResults={toolResults}
            />
          </>
        ) : null}
      </main>

      <footer className="border-t border-border px-4 py-3 text-center text-[11px] leading-4 text-muted">
        {data?.live ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" />
            每 3 秒自动刷新
          </span>
        ) : (
          <span>只读链接 · 请勿转发到公网</span>
        )}
      </footer>
    </div>
  )
}

function EmptyState({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <TriangleAlert size={24} className="text-text-tertiary" />
      <p className="mt-3 text-[14px] font-medium">{title}</p>
      <p className="mt-1 max-w-[340px] text-[12px] leading-5 text-muted">{desc}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
