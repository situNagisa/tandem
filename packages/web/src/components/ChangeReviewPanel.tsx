import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileChange } from '@tandem/protocol'
import {
  AlertTriangle,
  FileDiff,
  FolderGit2,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useSessionChanges } from '../lib/useChanges'
import { api } from '../lib/api'
import { useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { DiffView, type DiffCommentDraft } from './DiffView'
import { Modal } from './ui/Modal'
import { Button, IconButton } from './ui/Button'
import { Popover } from './ui/Popover'

interface LineComment extends DiffCommentDraft {
  id: number
  path: string
}

const STATUS_META: Record<FileChange['status'], { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-[var(--t-git-modified)]' },
  added: { letter: 'A', className: 'text-[var(--t-git-added)]' },
  deleted: { letter: 'D', className: 'text-[var(--t-git-deleted)]' },
  renamed: { letter: 'R', className: 'text-[var(--t-git-renamed)]' },
  untracked: { letter: 'U', className: 'text-[var(--t-git-added)]' },
}

function splitPath(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0
    ? { name: path, dir: '' }
    : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

function commentLineLabel(comment: LineComment) {
  return comment.startLine === comment.endLine
    ? `第 ${comment.startLine} 行`
    : `第 ${comment.startLine}–${comment.endLine} 行`
}

export function ChangeReviewPanel({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile()
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const changesNonce = useAppStore((s) => s.changesNonce)
  const bumpChanges = useAppStore((s) => s.bumpChanges)
  const changesWidth = useUiStore((s) => s.changesWidth)
  const setChangesWidth = useUiStore((s) => s.setChangesWidth)
  const toast = useUiStore((s) => s.toast)

  const { changes, loading, error, reload, setChanges } = useSessionChanges(
    host,
    sessionId,
    changesNonce,
  )

  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | undefined>()
  const [comments, setComments] = useState<LineComment[]>([])
  const [sendingComments, setSendingComments] = useState(false)
  const [revertTarget, setRevertTarget] = useState<FileChange | null>(null)
  const [reverting, setReverting] = useState(false)
  const [discardAllOpen, setDiscardAllOpen] = useState(false)
  const [discardingAll, setDiscardingAll] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const commentSeq = useRef(1)
  const diffCache = useRef(new Map<string, string>())
  const commitRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!commitMessage && commitRef.current) commitRef.current.style.height = ''
  }, [commitMessage])

  const files = changes?.files ?? []
  const totalAdd = files.reduce((n, f) => n + f.additions, 0)
  const totalDel = files.reduce((n, f) => n + f.deletions, 0)
  const untrackedCount = files.filter((f) => f.status === 'untracked').length

  // 文件列表变化时保持一个有效选中项
  useEffect(() => {
    if (files.length === 0) {
      setSelected(null)
      return
    }
    setSelected((prev) =>
      prev && files.some((f) => f.path === prev) ? prev : files[0].path,
    )
  }, [changes])

  // 回合结束后缓存失效
  useEffect(() => {
    diffCache.current.clear()
  }, [changesNonce])

  useEffect(() => {
    if (!host || !sessionId || !selected) {
      setDiff(null)
      return
    }
    const cached = diffCache.current.get(selected)
    if (cached !== undefined) {
      setDiff(cached)
      setDiffError(undefined)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(undefined)
    api
      .changesDiff(host, sessionId, selected)
      .then((result) => {
        if (cancelled) return
        diffCache.current.set(selected, result.diff)
        setDiff(result.diff)
      })
      .catch((err) => {
        if (cancelled) return
        setDiff(null)
        setDiffError(err instanceof Error ? err.message : '读取 diff 失败')
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, sessionId, selected, changesNonce])

  const width = dragWidth ?? changesWidth

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0 || isMobile) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = changesWidth
    setDragWidth(startWidth)
    const move = (ev: PointerEvent) => setDragWidth(startWidth - (ev.clientX - startX))
    const up = (ev: PointerEvent) => {
      setChangesWidth(startWidth - (ev.clientX - startX))
      setDragWidth(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addComment = (draft: DiffCommentDraft) => {
    if (!selected) return
    setComments((prev) => [
      ...prev,
      { id: commentSeq.current++, path: selected, ...draft },
    ])
  }

  const sendComments = () => {
    if (comments.length === 0 || sendingComments) return
    const body = comments
      .map((c) => `- ${c.path} ${commentLineLabel(c)}：${c.text}`)
      .join('\n')
    const text = `请根据以下审阅意见修改：\n${body}`
    const ok = useAppStore.getState().send([{ type: 'text', text }])
    if (!ok) return
    setSendingComments(true)
    setComments([])
    toast(`已发送 ${comments.length} 条审阅意见`, 'success')
    setSendingComments(false)
  }

  const doRevert = async () => {
    if (!host || !sessionId || !revertTarget || reverting) return
    setReverting(true)
    try {
      const result = await api.revertChanges(host, sessionId, [revertTarget.path])
      diffCache.current.delete(revertTarget.path)
      setChanges(result)
      setComments((prev) => prev.filter((c) => c.path !== revertTarget.path))
      setDiff(null)
      setRevertTarget(null)
      bumpChanges()
      toast('已丢弃改动', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '丢弃改动失败', 'error')
    } finally {
      setReverting(false)
    }
  }

  const doRevertAll = async () => {
    if (!host || !sessionId || discardingAll || files.length === 0) return
    setDiscardingAll(true)
    try {
      const result = await api.revertChanges(host, sessionId, files.map((f) => f.path))
      diffCache.current.clear()
      setChanges(result)
      setComments([])
      setDiff(null)
      setDiscardAllOpen(false)
      bumpChanges()
      toast('已丢弃全部改动', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '丢弃改动失败', 'error')
    } finally {
      setDiscardingAll(false)
    }
  }

  const requestCommit = () => {
    if (committing || !commitMessage.trim() || files.length === 0) return
    setCommitConfirmOpen(true)
  }

  const doCommit = async () => {
    if (!host || !sessionId || committing) return
    const message = commitMessage.trim()
    if (!message) return
    setCommitConfirmOpen(false)
    setCommitting(true)
    try {
      const result = await api.commitChanges(host, sessionId, message)
      if (!result.ok) {
        toast(result.error || '提交失败', 'error')
        return
      }
      const short = result.commit?.slice(0, 7)
      toast(short ? `已提交 ${short}` : '已提交', 'success')
      setCommitMessage('')
      diffCache.current.clear()
      reload()
      bumpChanges()
    } catch (err) {
      toast(err instanceof Error ? err.message : '提交失败', 'error')
    } finally {
      setCommitting(false)
    }
  }

  const askAgentCommit = () => {
    const ok = useAppStore
      .getState()
      .send([
        {
          type: 'text',
          text: '请检查当前工作区的改动，写一条简洁的提交信息并执行 git commit（不要推送）。',
        },
      ])
    if (ok) toast('已请 agent 写提交信息并提交', 'info')
  }

  const selectedFile = files.find((f) => f.path === selected) ?? null
  const fileComments = useMemo(
    () => comments.filter((c) => c.path === selected),
    [comments, selected],
  )

  return (
    <aside
      className="relative flex h-full min-h-0 w-full flex-col border-l border-border bg-sidebar"
      style={{ width: isMobile ? '100%' : width, transition: dragWidth !== null ? 'none' : undefined }}
    >
      {!isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          onPointerDown={startResize}
          className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-[var(--t-border-strong)]/30"
        />
      )}

      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileDiff size={15} className="shrink-0 text-text-soft" />
        <h2 className="text-[12.5px] font-semibold">改动审阅</h2>
        {changes?.branch && (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">
            {changes.branch}
          </span>
        )}
        {files.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
            <span className="text-[var(--t-git-plus)]">+{totalAdd}</span>
            <span className="text-[var(--t-git-minus)]">−{totalDel}</span>
          </span>
        )}
        <span className="flex-1" />
        <IconButton onClick={reload} label="刷新改动" tooltip="刷新" className="max-md:size-9">
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </IconButton>
        <IconButton onClick={onClose} label="关闭改动审阅" className="-mr-1 max-md:size-10">
          <X size={15} />
        </IconButton>
      </div>

      {changes && !changes.isRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <FolderGit2 size={28} className="text-muted/60" />
          <p className="text-[13px] font-medium text-text-soft">当前目录不是 git 仓库</p>
          <p className="max-w-[300px] text-[12px] leading-5 text-muted">
            改动审阅依赖 git 记录工作区变化。请在 git 仓库中开始会话，或让 agent 先初始化仓库。
          </p>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[12.5px] text-danger">{error}</p>
          <Button size="sm" onClick={reload}>
            重试
          </Button>
        </div>
      ) : loading && !changes ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <FileDiff size={24} className="text-muted/50" />
          <p className="text-[12.5px] text-text-soft">工作区没有未提交的改动</p>
          <p className="text-[11.5px] text-muted">agent 修改文件后会出现在这里</p>
        </div>
      ) : (
        <>
          <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-border">
            {files.map((file) => {
              const meta = STATUS_META[file.status] ?? STATUS_META.modified
              const { name, dir } = splitPath(file.path)
              return (
                <div
                  key={file.path}
                  className={cn(
                    'group flex h-7 w-full items-center border-l-2 transition-colors',
                    selected === file.path
                      ? 'border-[var(--t-border-strong)] bg-bg-active/60'
                      : 'border-transparent hover:bg-[var(--t-bg-hover)]',
                  )}
                >
                  <button
                    onClick={() => setSelected(file.path)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 pr-1 text-left"
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  >
                    <span className={cn('w-3 shrink-0 text-center font-mono text-[10.5px] font-semibold', meta.className)}>
                      {meta.letter}
                    </span>
                    <span
                      className={cn(
                        'max-w-[62%] shrink-0 truncate font-mono text-[11.5px]',
                        selected === file.path ? 'text-text' : 'text-text-soft',
                      )}
                    >
                      {name}
                    </span>
                    {dir && (
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
                        {dir}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--t-git-plus)]">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--t-git-minus)]">−{file.deletions}</span>
                  </button>
                  <IconButton
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => setRevertTarget(file)}
                    label={`丢弃 ${file.path} 的改动`}
                    tooltip="丢弃此文件的改动"
                    className="mr-0.5 md:size-6 md:opacity-0 md:group-hover:opacity-100 [&_svg]:size-3"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              )
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selectedFile && (
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-[11px] text-text-soft">
                  {selectedFile.path}
                </span>
                <span className="flex-1" />
                <span className="shrink-0 text-[10.5px] text-muted">点击或拖选行添加评论</span>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => setRevertTarget(selectedFile)}
                  className="px-1.5 text-[10.5px] [&_svg]:size-3"
                >
                  <Trash2 size={10} /> 丢弃改动
                </Button>
              </div>
            )}
            {diffLoading ? (
              <div className="flex items-center justify-center py-10 text-muted">
                <Loader2 size={15} className="animate-spin" />
              </div>
            ) : diffError ? (
              <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[11.5px] text-danger">
                {diffError}
              </p>
            ) : diff !== null ? (
              <DiffView
                unified={diff}
                fileName={selected ?? undefined}
                maxHeight={100000}
                comments={fileComments}
                onAddComment={addComment}
                onEditComment={(id, text) =>
                  setComments((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)))
                }
                onDeleteComment={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
              />
            ) : null}
          </div>

          <div className="shrink-0 border-t border-border">
            {comments.length > 0 && (
              <button
                type="button"
                onClick={sendComments}
                disabled={sendingComments}
                className="flex h-8 w-full items-center gap-1.5 border-b border-border/70 px-3 text-left text-[11px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
              >
                <MessageSquarePlus size={12} className="shrink-0 text-[var(--t-accent)]" />
                <span>{comments.length} 条评论</span>
                <span className="text-muted">·</span>
                <span className="font-medium text-text">发给 agent</span>
              </button>
            )}

            {untrackedCount > 0 && (
              <div className="flex h-6 items-center gap-1.5 border-b border-border/60 px-3 text-[10.5px] text-muted">
                <AlertTriangle size={10} className="shrink-0" />
                含 {untrackedCount} 个未跟踪文件，提交时会一并加入版本库
              </div>
            )}

            <div className="flex items-end gap-1.5 px-2.5 py-2">
              <textarea
                ref={commitRef}
                rows={1}
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                onInput={(e) => {
                  const el = e.currentTarget
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(el.scrollHeight, 96)}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    requestCommit()
                  }
                }}
                placeholder="提交信息"
                aria-label="提交信息"
                className="min-h-7 max-h-24 min-w-0 flex-1 resize-none rounded-md border border-border bg-[var(--t-bg)] px-2 py-1.5 text-[12px] leading-4 text-text outline-none transition-[min-height] placeholder:text-muted focus:min-h-14 focus:border-[var(--t-border-strong)]"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={requestCommit}
                disabled={!commitMessage.trim() || committing}
                title={untrackedCount > 0 ? `包含 ${untrackedCount} 个未跟踪文件` : undefined}
              >
                {committing && <Loader2 size={11} className="animate-spin" />}
                提交 {files.length} 个文件
              </Button>
              <Popover
                align="right"
                side="top"
                panelClassName="w-52"
                trigger={({ toggle }) => (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label="更多提交操作"
                    onClick={toggle}
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div className="py-0.5">
                    <button
                      type="button"
                      className="menu-item text-[11.5px]"
                      onClick={() => {
                        close()
                        askAgentCommit()
                      }}
                    >
                      <Wand2 size={12} /> 让 agent 写提交信息
                    </button>
                    {comments.length > 0 && (
                      <button
                        type="button"
                        className="menu-item text-[11.5px]"
                        onClick={() => {
                          close()
                          setComments([])
                        }}
                      >
                        <MessageSquarePlus size={12} /> 清空 {comments.length} 条评论
                      </button>
                    )}
                    <button
                      type="button"
                      className="menu-item text-[11.5px] text-danger"
                      onClick={() => {
                        close()
                        setDiscardAllOpen(true)
                      }}
                    >
                      <Trash2 size={12} /> 全部丢弃改动
                    </button>
                  </div>
                )}
              </Popover>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!revertTarget}
        onClose={() => setRevertTarget(null)}
        title="丢弃改动"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setRevertTarget(null)} disabled={reverting}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={() => void doRevert()}
              disabled={reverting}
            >
              {reverting && <Loader2 size={14} className="animate-spin" />}
              丢弃改动
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          确定丢弃 <span className="font-mono text-[12px] text-text">{revertTarget?.path}</span> 的改动？
          此操作不可撤销。
        </p>
        {revertTarget?.status === 'untracked' && (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[12px] leading-5 text-danger">
            这是未跟踪文件，丢弃会直接删除该文件（及其内容）。
          </p>
        )}
      </Modal>

      <Modal
        open={discardAllOpen}
        onClose={() => setDiscardAllOpen(false)}
        title="丢弃全部改动"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setDiscardAllOpen(false)} disabled={discardingAll}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={() => void doRevertAll()}
              disabled={discardingAll}
            >
              {discardingAll && <Loader2 size={14} className="animate-spin" />}
              全部丢弃
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          确定丢弃全部 <span className="font-medium text-text">{files.length}</span>{' '}
          个文件的改动？此操作不可撤销。
        </p>
        {untrackedCount > 0 && (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[12px] leading-5 text-danger">
            其中 {untrackedCount} 个未跟踪文件会被直接删除（及其内容）。
          </p>
        )}
      </Modal>

      <Modal
        open={commitConfirmOpen}
        onClose={() => setCommitConfirmOpen(false)}
        title="提交全部改动"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setCommitConfirmOpen(false)} disabled={committing}>
              取消
            </Button>
            <Button
              size="lg"
              variant="primary"
              onClick={() => void doCommit()}
              disabled={committing}
            >
              {committing && <Loader2 size={14} className="animate-spin" />}
              提交并关闭
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          将暂存并提交全部 <span className="font-medium text-text">{files.length}</span> 个文件
          {untrackedCount > 0 ? `，其中 ${untrackedCount} 个未跟踪文件会首次加入版本库` : ''}。
        </p>
        <div className="mt-3 rounded-lg border border-border bg-bg/60 px-3 py-2">
          <p className="text-[10.5px] text-muted">提交信息</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-text">
            {commitMessage.trim()}
          </p>
        </div>
        {untrackedCount > 0 && (
          <p className="mt-3 text-[11.5px] leading-5 text-warning">
            {untrackedCount} 个未跟踪文件会被一并提交；如果其中有临时文件，请先取消并丢弃。
          </p>
        )}
      </Modal>
    </aside>
  )
}
