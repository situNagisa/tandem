import { useEffect, useRef } from 'react'
import { Clock, MoreHorizontal, Pin, PinOff } from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import type { AppState } from '../../store/appStore/types'
import { formatRelative } from '../../lib/format'
import { cn } from '../../lib/cn'
import { SessionStatusDot } from '../StatusDot'
import { IconButton } from '../ui/Button'

type UpdateSession = AppState['updateSession']

interface SessionRowProps {
  hostId: string
  s: SessionSummary
  depth?: number
  section?: 'recent' | 'pinned'
  nested?: boolean
  /** 点击打开哪个会话：分叉与原会话共用一行时，打开树内最近活动的那个。 */
  openId?: string
  /** 当前打开的是分叉时，行内小字显示的所在分叉名。 */
  branchTitle?: string
  /** 树内全部会话 id：取消置顶时整棵树一起取消。 */
  treeIds?: string[]
  activeSessionId: string | null
  renaming: boolean
  renameDraft: string
  setRenameDraft: (value: string) => void
  setRenaming: (renaming: boolean) => void
  updateSession: UpdateSession
  openSession: (hostId: string, sessionId: string, split?: boolean) => void
  openMenu: (e: React.MouseEvent, hostId: string, session: SessionSummary) => void
  setMenu: (menu: { hostId: string; session: SessionSummary; x: number; y: number } | null) => void
  runningElapsed: (hostId: string, s: SessionSummary) => string | null
}

export function SessionRow({
  hostId,
  s,
  depth = 0,
  section = 'recent',
  nested = false,
  openId,
  branchTitle,
  treeIds,
  activeSessionId,
  renaming,
  renameDraft,
  setRenameDraft,
  setRenaming,
  updateSession,
  openSession,
  openMenu,
  setMenu,
  runningElapsed,
}: SessionRowProps) {
    const isActive = s.id === activeSessionId || !!branchTitle
    const renamingThis = renaming
    const renameRef = useRef<HTMLInputElement>(null)
    const renameDoneRef = useRef(false)
    const renameCancelRef = useRef(false)
    useEffect(() => {
      if (!renaming) return
      renameDoneRef.current = false
      renameCancelRef.current = false
      renameRef.current?.focus()
      renameRef.current?.select()
    }, [renaming])
    const commitRename = async () => {
      if (renameDoneRef.current) return
      renameDoneRef.current = true
      const title = renameDraft.trim()
      setRenaming(false)
      if (!title || title === s.title) return
      await updateSession(hostId, s.id, { title })
    }
    const pinState = section === 'pinned' ? !!s.pinned : !!s.pinnedInProject
    const togglePin = () => {
      // 一行代表整棵会话树：取消置顶时把树内所有会话一起取消，否则分叉仍留在置顶区。
      const ids = pinState && treeIds?.length ? treeIds : [s.id]
      for (const id of ids) {
        void updateSession(hostId, id, {
          ...(section === 'pinned' ? { pinned: !pinState } : { pinnedInProject: !pinState }),
        })
      }
    }
    const pinLabel =
      section === 'pinned'
        ? pinState
          ? '取消置顶'
          : '置顶'
        : pinState
          ? '取消项目置顶'
          : '在项目中置顶'
    const elapsed = runningElapsed(hostId, s)
    const runningLabel =
      s.status === 'waiting_permission' ? '待审批' : s.status === 'retrying' ? '等待网络' : '运行中'
    return (
      <div
        data-session-row="true"
        data-session-id={s.id}
        data-host-id={hostId}
        data-nested={nested || undefined}
        data-session-pinned={pinState || undefined}
        onContextMenu={(e) => openMenu(e, hostId, s)}
        draggable={!renamingThis}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            'application/x-tandem-split',
            JSON.stringify({ hostId, sessionId: s.id }),
          )
          e.dataTransfer.effectAllowed = 'copy'
        }}
        data-tip={
          s.forkedFrom
            ? `分叉自 ${s.forkedFrom.title || '父会话'}${s.title ? ` · ${s.title}` : ''}`
            : s.worktree
              ? `${s.title || '未命名会话'} · worktree ${s.worktree.branch}（基于 ${s.worktree.baseBranch}）`
              : s.title || '未命名会话'
        }
        className={cn(
          'anim-row-in group relative flex h-11 items-center rounded-lg text-[14px] transition-colors duration-[120ms] md:h-[34px]',
          depth > 0 && 'ml-5',
          isActive
            ? 'bg-[var(--t-bg-active)] text-text'
            : 'text-text hover:bg-[var(--t-bg-hover)]',
        )}
      >
        {renamingThis ? (
          <>
            <span className="pointer-events-none ml-2 flex size-4 shrink-0 items-center justify-center">
              {s.status !== 'idle' ? (
                <SessionStatusDot status={s.status} />
              ) : (
                <span className="size-1.5 rounded-full border border-current opacity-35" />
              )}
            </span>
            <input
              ref={renameRef}
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => {
                if (renameCancelRef.current) {
                  renameCancelRef.current = false
                  return
                }
                void commitRename()
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  renameCancelRef.current = true
                  setRenaming(false)
                }
              }}
              className="mr-1 h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-1.5 text-[13px] outline-none"
              aria-label="重命名会话"
            />
          </>
        ) : (
          <button data-raw-button
            type="button"
            data-session-open="true"
            onClick={(e) => openSession(hostId, openId ?? s.id, !!(e.metaKey || e.ctrlKey))}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--t-focus-ring)]',
              // 反馈12#08：会话标题与项目标题左对齐（项目 6px + 图标/间距 36px；会话自身状态点 16px + 间距 8px）。
              nested ? 'pl-[18px]' : 'pl-2',
            )}
          >
            <span className="pointer-events-none flex size-4 shrink-0 items-center justify-center">
              {s.status !== 'idle' ? (
                <SessionStatusDot status={s.status} />
              ) : (
                <span className="size-1.5 rounded-full border border-current opacity-35" />
              )}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[14px] leading-5',
                s.unread && 'font-semibold',
              )}
              data-tip={s.title || '未命名会话'}
            >
              {s.scheduledBy && (
                <span data-tip={`定时任务：${s.scheduledBy.name}`} className="mr-1 inline-block align-[-1px] text-muted">
                  <Clock size={12} />
                </span>
              )}
              {s.title || '未命名会话'}
            </span>
            {branchTitle && (
              <span
                data-session-branch
                className="min-w-0 max-w-[38%] shrink truncate text-[12px] leading-5 text-text-tertiary"
                data-tip={`当前所在分叉：${branchTitle}`}
              >
                {/* 行内空间有限：只显示分叉名的最后一段，完整标题在 tooltip 与会话图里。 */}
                {branchTitle.split('·').map((part) => part.trim()).filter(Boolean).pop() ??
                  branchTitle}
              </span>
            )}
            {s.unread && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-accent-strong"
                data-tip="未读"
                aria-label="未读"
                data-unread-dot="true"
              />
            )}
            <span className="relative flex h-full w-11 shrink-0 items-center justify-end md:w-[62px]">
              <span
                className={cn(
                  'hidden max-w-full truncate text-[12px] tabular-nums transition-opacity md:inline',
                  elapsed && 'text-[12px]',
                  s.status === 'waiting_permission' ? 'text-accent-text' : 'text-text-tertiary',
                  isActive ? 'opacity-0' : 'group-hover:opacity-0',
                )}
                data-tip={elapsed ? `${runningLabel} · ${elapsed}` : undefined}
              >
                {elapsed ? `${runningLabel} · ${elapsed}` : formatRelative(s.updatedAt)}
              </span>
            </span>
          </button>
        )}
        {!renamingThis && (
          <IconButton
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              togglePin()
            }}
            label={pinLabel}
            tooltip={pinLabel}
            tooltipSide="top"
            aria-pressed={pinState}
            className={cn(
              'absolute right-8 top-1/2 size-7! -translate-y-1/2 focus-visible:opacity-100 max-sm:right-12 max-sm:size-11! [&_svg]:size-[14px]',
              'opacity-100 md:opacity-0 md:group-hover:opacity-100',
            )}
          >
            {pinState ? <PinOff size={14} /> : <Pin size={14} />}
          </IconButton>
        )}
        {!renamingThis && (
          <IconButton
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({ hostId, session: s, x: rect.right - 4, y: rect.bottom + 4 })
            }}
            label="会话操作"
            tooltip=""
            className={cn(
              'absolute right-1 top-1/2 size-7! -translate-y-1/2 focus-visible:opacity-100 max-sm:size-11! [&_svg]:size-[15px]',
              isActive
                ? 'opacity-100'
                : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
            )}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        )}
      </div>
    )
}
