import { useState } from 'react'
import {
  Check,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import type { Todo } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { ApiError } from '../lib/api'
import {
  formatCost,
  formatRelative,
  formatTime,
  formatTokens,
} from '../lib/format'
import { PERMISSION_MODE_LABELS } from '../lib/types'
import { ConnectionDot, SessionStatusDot } from './StatusDot'
import { Modal } from './ui/Modal'

const EMPTY_TODOS: Todo[] = []

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  waiting_permission: '等待审批',
  error: '出错',
}

const TODO_ICONS = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-3.5 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-medium text-text-secondary">{title}</h3>
        <span className="flex-1" />
        {extra}
      </div>
      {children}
    </section>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[60px_minmax(0,1fr)] items-start gap-3 py-1.5 text-[13px] leading-5">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-text-soft">{children}</span>
    </div>
  )
}

export function RightPanel({ onClose }: { onClose: () => void }) {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const todos = useAppStore((s) => s.active?.todos ?? EMPTY_TODOS)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const hostStatus = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.status ?? 'offline') : 'offline',
  )
  const profileName = useAppStore((s) => {
    if (!hostId || !summary?.profileId) return null
    return s.runtimes[hostId]?.profiles.find((p) => p.id === summary.profileId)?.name ?? null
  })
  const deleteSession = useAppStore((s) => s.deleteSession)
  const toast = useUiStore((s) => s.toast)
  const [copied, setCopied] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dirtyWorktree, setDirtyWorktree] = useState(false)

  const completed = todos.filter((t) => t.status === 'completed').length
  const progress = todos.length ? Math.round((completed / todos.length) * 100) : 0
  const usage = summary?.usage

  const copyCwd = async () => {
    if (!summary?.cwd) return
    if (await copyText(summary.cwd)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      toast('复制失败', 'error')
    }
  }

  const onDelete = async () => {
    if (!hostId || !sessionId || !summary || deleting) return
    setDeleting(true)
    try {
      await deleteSession(hostId, sessionId, dirtyWorktree)
      setConfirmDelete(false)
      setDirtyWorktree(false)
    } catch (err) {
      if ((err instanceof ApiError && err.status === 409) || (err instanceof Error && /未提交改动/.test(err.message))) {
        setDirtyWorktree(true)
      } else {
        toast(err instanceof Error ? err.message : '删除会话失败', 'error')
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-sidebar md:w-[300px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3.5">
        <h2 className="text-[12.5px] font-semibold">会话信息</h2>
        {summary && (
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <SessionStatusDot status={summary.status} />
            {STATUS_TEXT[summary.status] ?? summary.status}
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={onClose}
          aria-label="关闭信息面板"
          className="-mr-1 flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-8"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Section
          title="待办"
          extra={
            todos.length > 0 && (
              <span className="text-[11px] tabular-nums text-muted">
                {completed}/{todos.length}
              </span>
            )
          }
        >
          {todos.length === 0 ? (
            <p className="text-[11.5px] text-muted">暂无待办</p>
          ) : (
            <>
              <div className="mb-2 h-0.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent/70 transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <ul className="space-y-1.5">
                {todos.map((t, i) => {
                  const Icon = TODO_ICONS[t.status] ?? Circle
                  return (
                    <li key={i} className="flex items-start gap-2 text-[12.5px] leading-5">
                      <Icon
                        size={13}
                        className={cn(
                          'mt-0.5 shrink-0',
                          t.status === 'in_progress' ? 'text-text-secondary' : 'text-muted',
                        )}
                      />
                      <span
                        className={cn(
                          'min-w-0',
                          t.status === 'completed'
                            ? 'text-muted line-through'
                            : t.status === 'in_progress'
                              ? 'text-text'
                              : 'text-text-soft',
                        )}
                      >
                        {t.content}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </Section>

        <Section title="用量">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-text-soft">
            <span>
              输入{' '}
              <span className="font-mono tabular-nums text-text">
                {formatTokens(usage?.inputTokens ?? 0)}
              </span>
            </span>
            <span className="text-muted">·</span>
            <span>
              输出{' '}
              <span className="font-mono tabular-nums text-text">
                {formatTokens(usage?.outputTokens ?? 0)}
              </span>
            </span>
            {usage?.costUsd !== undefined && (
              <>
                <span className="text-muted">·</span>
                <span>
                  花费{' '}
                  <span className="font-mono tabular-nums text-text">
                    ${usage?.costUsd.toFixed(2)}
                  </span>
                </span>
              </>
            )}
          </div>
        </Section>

        <Section title="详情">
          <div className="divide-y divide-[var(--t-border)] border-y border-border">
            <DetailRow label="模型">
              <span className="font-mono text-[12px]">{summary?.model ?? '—'}</span>
            </DetailRow>
            <DetailRow label="账号">{profileName ?? summary?.profileId ?? '—'}</DetailRow>
            <DetailRow label="权限">
              {summary ? PERMISSION_MODE_LABELS[summary.permissionMode] : '—'}
            </DetailRow>
            <DetailRow label="工作目录">
              <span className="group/cwd flex items-start gap-1">
                <span className="min-w-0 flex-1 break-all font-mono text-[11.5px]">
                  {summary?.cwd ?? '—'}
                </span>
                {summary?.cwd && (
                  <button
                    onClick={copyCwd}
                    aria-label="复制工作目录"
                    title="复制"
                    className="mt-0.5 shrink-0 text-muted opacity-60 transition-opacity hover:opacity-100"
                  >
                    {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                  </button>
                )}
              </span>
            </DetailRow>
            {summary?.env?.repoName && (
              <DetailRow label="仓库">
                <span className="flex items-center gap-1">
                  <FolderGit2 size={11} className="text-muted" />
                  {summary.env.repoName}
                </span>
              </DetailRow>
            )}
            {summary?.env?.branch && (
              <DetailRow label="分支">
                <span className="flex items-center gap-1">
                  <GitBranch size={11} className="text-muted" />
                  {summary.env.branch}
                </span>
              </DetailRow>
            )}
            {summary?.worktree && (
              <DetailRow label="worktree">
                <span className="block space-y-0.5">
                  <span className="flex items-center gap-1 text-text">
                    <GitFork size={11} className="text-accent/80" />
                    <span className="font-mono text-[11.5px]">{summary.worktree.branch}</span>
                  </span>
                  <span className="block text-[10.5px] text-muted">
                    基于 {summary.worktree.baseBranch}
                  </span>
                  <span className="block break-all font-mono text-[10px] text-muted">
                    {summary.worktree.path}
                  </span>
                </span>
              </DetailRow>
            )}
            <DetailRow label="Host">
              <span className="flex items-center gap-1.5">
                <ConnectionDot state={hostStatus} />
                <span className="truncate">{host?.name ?? '—'}</span>
              </span>
            </DetailRow>
            <DetailRow label="更新">
              {summary ? (
                <span title={formatTime(summary.updatedAt)}>
                  {formatRelative(summary.updatedAt)}
                </span>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="创建">
              {summary ? (
                <span title={formatTime(summary.createdAt)}>
                  {formatRelative(summary.createdAt)}
                </span>
              ) : (
                '—'
              )}
            </DetailRow>
          </div>
        </Section>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-2.5">
        <button
          onClick={() => {
            setDirtyWorktree(false)
            setConfirmDelete(true)
          }}
          disabled={deleting || !summary}
          className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[12px] text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          删除会话
        </button>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={dirtyWorktree ? 'worktree 有未提交改动' : '删除会话'}
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => void onDelete()}
              disabled={deleting}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {deleting && <Loader2 size={13} className="animate-spin" />}
              {dirtyWorktree ? '仍然删除' : '删除'}
            </button>
          </>
        }
      >
        {dirtyWorktree ? (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
            <span className="min-w-0 flex-1">
              有未提交改动，仍然删除？worktree 目录与分支会被一并清除，改动将无法恢复。
            </span>
          </div>
        ) : (
          <p className="text-[13px] leading-6 text-text-soft">
            确定删除「{summary?.title || '未命名会话'}」？该操作不可撤销。
          </p>
        )}
      </Modal>
    </aside>
  )
}
