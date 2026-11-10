import type { Dispatch, SetStateAction } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { api, ApiError } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

type StoreState = ReturnType<typeof useAppStore.getState>

interface DeleteConfirm {
  hostId: string
  session: SessionSummary
  busy: boolean
  dirty?: boolean
  detail?: string
}

interface MergeState {
  hostId: string
  session: SessionSummary
  strategy: 'merge' | 'squash'
  busy: boolean
  error?: string
}

export function DeleteSessionDialog({
  confirm,
  setConfirm,
  deleteSession,
}: {
  confirm: DeleteConfirm | null
  setConfirm: Dispatch<SetStateAction<DeleteConfirm | null>>
  deleteSession: StoreState['deleteSession']
}) {
  return (
      <Modal
        open={!!confirm}
        onClose={() => {
          if (!confirm?.busy) setConfirm(null)
        }}
        title={confirm?.dirty ? 'worktree 有未提交改动' : '删除会话'}
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setConfirm(null)} disabled={confirm?.busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={async () => {
                if (!confirm) return
                setConfirm({ ...confirm, busy: true })
                try {
                  await deleteSession(confirm.hostId, confirm.session.id, !!confirm.dirty)
                  setConfirm(null)
                } catch (err) {
                  const dirty =
                    (err instanceof ApiError && err.status === 409) ||
                    (err instanceof Error && /未提交改动/.test(err.message))
                  if (dirty)
                    setConfirm((c) =>
                      c
                        ? {
                            ...c,
                            busy: false,
                            dirty: true,
                            detail: err instanceof Error ? err.message : undefined,
                          }
                        : c,
                    )
                  else {
                    useUiStore.getState().toast(
                      err instanceof Error ? err.message : '删除会话失败',
                      'error',
                    )
                    setConfirm((c) => (c ? { ...c, busy: false } : c))
                  }
                }
              }}
              disabled={confirm?.busy}
            >
              {confirm?.busy && <Spinner size={14} />}
              {confirm?.dirty ? '仍然删除' : '删除'}
            </Button>
          </>
        }
      >
        {confirm?.dirty ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>
              {confirm.detail ? (
                <span className="mb-1 block break-words">{confirm.detail}</span>
              ) : null}
              仍然删除？worktree 目录与分支会被一并清除，改动将无法恢复。
            </span>
          </div>
        ) : (
          <p className="text-[13px] leading-6 text-text-soft">
            确定删除「{confirm?.session.title || '未命名会话'}」？会话记录将从主机上移除，且无法恢复。
          </p>
        )}
        <p className="mt-1.5 break-all font-mono text-[12px] text-muted">{confirm?.session.cwd}</p>
      </Modal>
  )
}

export function MergeWorktreeDialog({
  merge,
  setMerge,
  hosts,
}: {
  merge: MergeState | null
  setMerge: Dispatch<SetStateAction<MergeState | null>>
  hosts: StoreState['hosts']
}) {
  return (
      <Modal
        open={!!merge}
        onClose={() => {
          if (!merge?.busy) setMerge(null)
        }}
        title="合并 worktree"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setMerge(null)} disabled={merge?.busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="primary"
              onClick={async () => {
                if (!merge) return
                const host = hosts.find((h) => h.id === merge.hostId)
                if (!host) return
                setMerge({ ...merge, busy: true, error: undefined })
                try {
                  const res = await api.mergeWorktree(host, merge.session.id, merge.strategy)
                  if (!res.ok) throw new Error(res.error || '合并失败')
                  useUiStore.getState().toast('已合并回基准分支', 'success')
                  setMerge(null)
                  void useAppStore.getState().refreshSessions(merge.hostId)
                } catch (err) {
                  setMerge((m) =>
                    m ? { ...m, busy: false, error: err instanceof Error ? err.message : '合并失败' } : m,
                  )
                }
              }}
              disabled={merge?.busy}
            >
              {merge?.busy && <Spinner size={14} />}
              合并
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-5 text-text-soft">
          <p>
            把 <span className="font-mono text-text">{merge?.session.worktree?.branch}</span> 合回{' '}
            <span className="font-mono text-text">{merge?.session.worktree?.baseBranch}</span>。
          </p>
          <div className="flex gap-2">
            {(['merge', 'squash'] as const).map((strategy) => (
              <button data-raw-button
                key={strategy}
                onClick={() => merge && setMerge({ ...merge, strategy, error: undefined })}
                className={cn(
                  'flex-1 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors',
                  merge?.strategy === strategy
                    ? 'border-[var(--t-border-strong)] bg-[var(--t-bg-active)] text-text'
                    : 'border-border bg-surface text-muted hover:border-border-strong',
                )}
              >
                <span className="block font-medium">
                  {strategy === 'merge' ? 'Merge' : 'Squash'}
                </span>
                <span className="mt-0.5 block text-[12px] leading-4">
                  {strategy === 'merge' ? '保留分支提交记录' : '压缩为一个提交'}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] leading-5 text-muted">
            只合并已提交的改动；worktree 里未提交或未跟踪的文件会留在原目录，不会带回基准分支。
          </p>
          {merge?.error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {merge.error}
                {/冲突|conflict/i.test(merge.error) &&
                  ' 请先在 worktree 中解决冲突（或在会话里让助手处理）后重试。'}
              </span>
            </div>
          )}
        </div>
      </Modal>
  )
}
