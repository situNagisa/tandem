import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileChange } from '@tandem/protocol'
import {
  CornerDownLeft,
  FileDiff,
  FolderGit2,
  Loader2,
  MessageSquarePlus,
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
import { DiffView } from './DiffView'
import { Modal } from './ui/Modal'

interface LineComment {
  id: number
  path: string
  line: number
  side: 'old' | 'new'
  text: string
}

const STATUS_META: Record<FileChange['status'], { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-text-soft' },
  added: { letter: 'A', className: 'text-success' },
  deleted: { letter: 'D', className: 'text-danger' },
  renamed: { letter: 'R', className: 'text-accent' },
  untracked: { letter: 'U', className: 'text-warning' },
}

function InlineComment({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div className="flex w-[min(420px,78vw)] items-center gap-1.5 border-y border-accent/30 bg-accent-soft/40 px-2 py-1.5">
      <MessageSquarePlus size={12} className="shrink-0 text-accent" />
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="对这一行写审阅意见…"
        aria-label="行内评论"
        className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[12px] text-text outline-none focus:border-accent/60"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const next = text.trim()
            if (next) onSubmit(next)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <button
        onClick={() => {
          const next = text.trim()
          if (next) onSubmit(next)
        }}
        disabled={!text.trim()}
        className="flex h-7 shrink-0 items-center gap-1 rounded bg-accent px-2 text-[11.5px] font-medium text-on-accent disabled:opacity-50"
      >
        添加 <CornerDownLeft size={10} />
      </button>
      <button
        onClick={onCancel}
        className="h-7 shrink-0 rounded px-1.5 text-[11.5px] text-muted hover:bg-bg-hover hover:text-text"
      >
        取消
      </button>
    </div>
  )
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
  const [activeLine, setActiveLine] = useState<number | null>(null)
  const [sendingComments, setSendingComments] = useState(false)
  const [revertTarget, setRevertTarget] = useState<FileChange | null>(null)
  const [reverting, setReverting] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const commentSeq = useRef(1)
  const diffCache = useRef(new Map<string, string>())

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
    setActiveLine(null)
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

  const addComment = (line: number, side: 'old' | 'new', text: string) => {
    if (!selected) return
    setComments((prev) => [
      ...prev,
      { id: commentSeq.current++, path: selected, line, side, text },
    ])
    setActiveLine(null)
  }

  const sendComments = () => {
    if (comments.length === 0 || sendingComments) return
    const body = comments
      .map((c) => `- ${c.path} 第 ${c.line} 行：${c.text}`)
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
          className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-accent/30"
        />
      )}

      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileDiff size={15} className="shrink-0 text-accent" />
        <h2 className="text-[12.5px] font-semibold">改动审阅</h2>
        {changes?.branch && (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">
            {changes.branch}
          </span>
        )}
        {files.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
            <span className="text-success">+{totalAdd}</span>
            <span className="text-danger">−{totalDel}</span>
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={reload}
          aria-label="刷新改动"
          title="刷新"
          className="flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-7"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
        <button
          onClick={onClose}
          aria-label="关闭改动审阅"
          className="-mr-1 flex size-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-7"
        >
          <X size={15} />
        </button>
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
          <button
            onClick={reload}
            className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-text-soft hover:bg-bg-hover"
          >
            重试
          </button>
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
              return (
                <div
                  key={file.path}
                  className={cn(
                    'group flex w-full items-center border-l-2 transition-colors',
                    selected === file.path
                      ? 'border-accent bg-bg-active/60'
                      : 'border-transparent hover:bg-[var(--t-bg-hover)]',
                  )}
                >
                  <button
                    onClick={() => {
                      setSelected(file.path)
                      setActiveLine(null)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left"
                  >
                    <span className={cn('w-3.5 shrink-0 text-center font-mono text-[11px]', meta.className)}>
                      {meta.letter}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono text-[11.5px]',
                        selected === file.path ? 'text-text' : 'text-text-soft',
                      )}
                      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    >
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-success">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-danger">−{file.deletions}</span>
                  </button>
                  <button
                    onClick={() => setRevertTarget(file)}
                    aria-label={`丢弃 ${file.path} 的改动`}
                    title="丢弃此文件的改动"
                    className="mr-1 flex size-8 shrink-0 items-center justify-center rounded text-muted opacity-100 transition-opacity hover:bg-bg-hover hover:text-danger focus:opacity-100 md:size-6 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
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
                <span className="shrink-0 text-[10.5px] text-muted">点击行添加评论</span>
                <button
                  onClick={() => setRevertTarget(selectedFile)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={10} /> 丢弃改动
                </button>
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
                onLineClick={(info) => {
                  if (!info.line) return
                  setActiveLine((prev) => (prev === info.line ? null : info.line))
                }}
                rowExtra={(info) => {
                  const lineComments = fileComments.filter((c) => c.line === info.line)
                  const showInput = activeLine === info.line
                  if (lineComments.length === 0 && !showInput) return null
                  return (
                    <div className="border-y border-accent/15 bg-accent-soft/25">
                      {lineComments.map((c) => (
                        <div
                          key={c.id}
                          className="flex items-start gap-2 px-3 py-1.5 text-[11.5px] leading-5"
                        >
                          <MessageSquarePlus size={11} className="mt-1 shrink-0 text-accent" />
                          <span className="min-w-0 flex-1 break-words text-text-soft">{c.text}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setComments((prev) => prev.filter((x) => x.id !== c.id))
                            }}
                            aria-label={`删除第 ${c.line} 行评论`}
                            className="shrink-0 text-muted hover:text-danger"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                      {showInput && (
                        <InlineComment
                          onSubmit={(text) => addComment(info.line, info.side, text)}
                          onCancel={() => setActiveLine(null)}
                        />
                      )}
                    </div>
                  )
                }}
              />
            ) : null}
          </div>

          <div className="shrink-0 border-t border-border">
            {comments.length > 0 && (
              <div className="max-h-28 space-y-1 overflow-y-auto border-b border-border/70 px-3 py-2">
                {comments.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 text-[11.5px] leading-5">
                    <span className="shrink-0 font-mono text-[10.5px] text-muted">
                      {c.path}:{c.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-soft" title={c.text}>
                      {c.text}
                    </span>
                    <button
                      onClick={() => setComments((prev) => prev.filter((x) => x.id !== c.id))}
                      aria-label="删除评论"
                      className="shrink-0 text-muted hover:text-danger"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <div className="flex justify-end pt-1">
                  <button
                    onClick={sendComments}
                    disabled={sendingComments}
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                  >
                    <MessageSquarePlus size={12} />
                    把 {comments.length} 条评论发给 agent
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault()
                      requestCommit()
                    }
                  }}
                  placeholder="提交信息"
                  aria-label="提交信息"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-[12px] text-text outline-none placeholder:text-muted focus:border-accent/60"
                />
                <button
                  onClick={requestCommit}
                  disabled={!commitMessage.trim() || committing}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {committing && <Loader2 size={11} className="animate-spin" />}
                  提交全部
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-[10.5px] leading-4 text-muted">
                <span>
                  将暂存并提交全部 {files.length} 个文件
                  {untrackedCount > 0 ? `（含 ${untrackedCount} 个未跟踪）` : ''}
                </span>
                <span className="flex-1" />
                <button
                  onClick={askAgentCommit}
                  className="flex shrink-0 items-center gap-1 transition-colors hover:text-text"
                >
                  <Wand2 size={11} /> 让 agent 写提交信息
                </button>
              </div>
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
            <button
              onClick={() => setRevertTarget(null)}
              disabled={reverting}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => void doRevert()}
              disabled={reverting}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {reverting && <Loader2 size={13} className="animate-spin" />}
              丢弃改动
            </button>
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
        open={commitConfirmOpen}
        onClose={() => setCommitConfirmOpen(false)}
        title="提交全部改动"
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setCommitConfirmOpen(false)}
              disabled={committing}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => void doCommit()}
              disabled={committing}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {committing && <Loader2 size={13} className="animate-spin" />}
              提交并关闭
            </button>
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
