import { useEffect, useMemo, useRef } from 'react'
import { Bot, ChevronRight, Lock } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { useIsMobile } from '../../lib/hooks'
import { MessageList } from '../MessageList'
import { TurnRail } from './TurnRail'

/**
 * 反馈12#05：Task 子代理会话的只读视图。沿用正常会话的消息列表与轮次大纲，
 * 顶部面包屑「主会话 › 子代理 › …」逐层返回；不提供输入框。
 */
export function SubagentSessionView({ hostId, id }: { hostId: string; id: string }) {
  // 子代理数据挂在它所属树根会话的视图上：从分叉等不含它的会话进入时，取真正持有它的视图。
  const view = useAppStore((s) => {
    if (s.active?.subagents[id]) return s.active
    return Object.values(s.sessionViews).find((item) => item.subagents[id]) ?? s.active
  })
  const closeAgentSession = useUiStore((s) => s.closeAgentSession)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const ensureSubagent = useAppStore((s) => s.ensureSubagent)
  const sessionCount = useAppStore((s) => (s.runtimes[hostId]?.sessions.length ?? 0))
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const sub = view?.subagents[id]
  // 当前打开的会话里还没有这个子代理（例如从分叉视图点子代理节点）：补开树根视图并订阅快照。
  useEffect(() => {
    if (!sub) ensureSubagent(hostId, id)
  }, [sub, ensureSubagent, hostId, id, sessionCount])
  const chain = useMemo(() => {
    const all = view?.subagents ?? {}
    const list: Array<{ id: string; title: string }> = []
    let cursor = all[id]
    const seen = new Set<string>()
    while (cursor?.summary && !seen.has(cursor.summary.id)) {
      seen.add(cursor.summary.id)
      list.unshift({
        id: cursor.summary.id,
        title: cursor.summary.title || '未命名子代理',
      })
      const parent = cursor.summary.parentId
      if (!parent || parent === view?.sessionId) break
      cursor = all[parent]
    }
    return list
  }, [view?.subagents, view?.sessionId, id])
  const mainTitle = view?.summary?.title || '主会话'
  const status = sub?.summary?.status
  const statusText = sub?.running
    ? '运行中'
    : status === 'waiting_permission'
      ? '待审批'
      : status === 'retrying'
        ? '等待网络'
        : status === 'error'
          ? '出错'
          : sub
            ? '已结束'
            : '未加载'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        data-agent-breadcrumb=""
        className="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border/70 px-3 text-[12px] text-muted"
      >
        <Lock size={11} className="shrink-0" />
        <span className="shrink-0">只读</span>
        <span className="mx-0.5 shrink-0 opacity-60">·</span>
        <Button
          size="inline"
          variant="ghost"
          onClick={closeAgentSession}
          data-tip={`返回主会话：${mainTitle}`}
          className="max-w-[180px] truncate px-0"
        >
          {mainTitle}
        </Button>
        {chain.map((item, index) => {
          const current = index === chain.length - 1
          return (
            <span key={item.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={11} className="shrink-0 opacity-60" />
              {current ? (
                <span
                  className="flex min-w-0 items-center gap-1 text-text"
                  data-tip={item.title}
                  aria-current="page"
                >
                  <Bot size={11} className="shrink-0 text-muted" />
                  <span className="min-w-0 truncate">{item.title}</span>
                </span>
              ) : (
                <Button
                  size="inline"
                  variant="ghost"
                  onClick={() => openAgentSession(hostId, item.id)}
                  data-tip={item.title}
                  className="max-w-[180px] truncate px-0"
                >
                  {item.title}
                </Button>
              )}
            </span>
          )
        })}
        <span className="flex-1" />
        <span className={cn('shrink-0', sub?.running && 'text-text-secondary')}>
          {statusText}
          {sub?.loading && <Spinner size={11} className="ml-1 inline" />}
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="chat-scroll h-full w-full overflow-y-auto overscroll-contain"
        >
          <div
            className={cn(
              'mx-auto flex min-h-full w-full max-w-[808px] flex-col pb-8',
              isMobile ? 'px-2.5 pt-2' : 'px-4 pt-3 md:px-6 md:pt-5',
            )}
          >
            {!sub ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-[13px] leading-5 text-muted">
                <Bot size={16} />
                <p>这个子代理会话还没有加载或已被清理。</p>
                <p className="text-[12px]">
                  子会话只出现在派发它的主会话里；旧版本会话可能没有记录子会话 id。
                </p>
              </div>
            ) : (
              <MessageList
                showSkeleton={sub.loading && sub.messages.length === 0}
                messages={sub.messages}
                readOnly
                toolResults={sub.toolResults}
                cwd={view?.summary?.cwd}
                subagentId={id}
              />
            )}
          </div>
        </div>
        {sub && !isMobile && (
          <TurnRail
            scrollRef={scrollRef}
            sessionId={`agent:${id}`}
            messages={sub.messages}
            readOnly
            alwaysActive
          />
        )}
      </div>
    </div>
  )
}
