import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiReviewFinding, AiReviewSeverity, DiffEmptyReason, FileChange } from '@tandem/protocol'
import {
  AlertTriangle,
  Bot,
  FileDiff,
  FolderGit2,
  GitPullRequest,
  Loader2,
  MessageSquare,
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
import { aiReviewKey, useAiReviewStore } from '../lib/useAiReview'
import { api } from '../lib/api'
import { useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { DiffView, type DiffCommentDraft } from './DiffView'
import { Modal } from './ui/Modal'
import { Button, IconButton } from './ui/Button'
import { Menu } from './ui/Menu'
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

/** 文件列表 / diff 的分栏比例，记住用户拖动过的位置。 */
const SPLIT_KEY = 'tandem.changesSplit.v1'
function loadSplitRatio(): number {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(n) && n >= 0.15 && n <= 0.85 ? n : 0.42
  } catch {
    return 0.42
  }
}
function saveSplitRatio(ratio: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(ratio))
  } catch {
    // localStorage 不可用时仅本次会话有效
  }
}

const SEVERITY_LABEL: Record<AiReviewSeverity, string> = {
  blocker: '阻塞',
  warn: '警告',
  nit: '细节',
}

const VERDICT_META: Record<string, { label: string; className: string }> = {
  commit: { label: '可以提交', className: 'text-[var(--t-git-plus)]' },
  suggest: { label: '建议修改', className: 'text-warning' },
  blocker: { label: '有阻塞问题', className: 'text-danger' },
}

function findingCommentText(finding: AiReviewFinding): string {
  return `[AI 评审·${SEVERITY_LABEL[finding.severity]}] ${finding.title}\n${finding.detail}${
    finding.suggestion ? `\n建议：${finding.suggestion}` : ''
  }`
}

function emptyReasonLabel(reason?: DiffEmptyReason): string | undefined {
  if (reason === 'mode') return '仅文件模式变化（无内容差异）'
  if (reason === 'eol') return '仅换行符或空白变化（无可见内容差异）'
  if (reason === 'rename') return '仅重命名（无内容差异）'
  return undefined
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
  const openPrPanel = useUiStore((s) => s.openPrPanel)
  const reviewEntry = useAiReviewStore((s) =>
    host && sessionId ? s.byKey[aiReviewKey(host.id, sessionId)] : undefined,
  )
  const startAiReview = useAiReviewStore((s) => s.start)
  const setReviewStatus = useAiReviewStore((s) => s.setStatus)
  const markFalsePositive = useAiReviewStore((s) => s.markFalsePositive)
  const clearReview = useAiReviewStore((s) => s.clear)

  const { changes, loading, error, reload, setChanges } = useSessionChanges(
    host,
    sessionId,
    changesNonce,
  )

  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffNote, setDiffNote] = useState<DiffEmptyReason | undefined>()
  const [diffTruncated, setDiffTruncated] = useState(false)
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
  const [splitRatio, setSplitRatio] = useState<number>(() => loadSplitRatio())
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const [blockOnBlocker, setBlockOnBlocker] = useState(false)
  const acceptedRef = useRef<{ reviewId?: string; ids: Set<string> }>({ ids: new Set() })
  const commentSeq = useRef(1)
  const diffCache = useRef(new Map<string, { diff: string; emptyReason?: DiffEmptyReason; truncated?: boolean }>())
  const splitBodyRef = useRef<HTMLDivElement>(null)
  const commitRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!commitMessage && commitRef.current) commitRef.current.style.height = ''
  }, [commitMessage])

  // 是否在设置里勾选「有 blocker 时阻止提交」
  useEffect(() => {
    if (!host) return
    let cancelled = false
    api
      .settings(host)
      .then((next) => {
        if (!cancelled) setBlockOnBlocker(next.aiReview?.blockOnBlocker === true)
      })
      .catch(() => {
        if (!cancelled) setBlockOnBlocker(false)
      })
    return () => {
      cancelled = true
    }
  }, [host?.id])

  const review = reviewEntry?.review
  const reviewStatuses = reviewEntry?.statuses ?? {}
  const activeFindings = useMemo(
    () =>
      (review?.findings ?? []).filter((item) => {
        const status = reviewStatuses[item.id]
        return status !== 'ignored' && status !== 'false_positive'
      }),
    [review, reviewStatuses],
  )
  const severityCounts = useMemo(() => {
    const counts: Record<AiReviewSeverity, number> = { blocker: 0, warn: 0, nit: 0 }
    for (const item of activeFindings) counts[item.severity]++
    return counts
  }, [activeFindings])
  const blockerCount = severityCounts.blocker

  // 采纳后转成人工评论，随「发送给 agent」一起发出。
  useEffect(() => {
    if (!review) return
    if (acceptedRef.current.reviewId !== review.id) {
      acceptedRef.current = { reviewId: review.id, ids: new Set() }
    }
    const fresh = review.findings.filter(
      (item) => reviewStatuses[item.id] === 'accepted' && !acceptedRef.current.ids.has(item.id),
    )
    if (fresh.length === 0) return
    for (const item of fresh) acceptedRef.current.ids.add(item.id)
    setComments((prev) => [
      ...prev,
      ...fresh.map((item) => ({
        id: commentSeq.current++,
        path: item.file,
        side: 'new' as const,
        startLine: item.line,
        endLine: item.endLine ?? item.line,
        text: findingCommentText(item),
      })),
    ])
    toast(`已采纳 ${fresh.length} 条 AI 意见到待发送评论`, 'success')
  }, [review, reviewStatuses, toast])

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
      setDiff(cached.diff)
      setDiffNote(cached.emptyReason)
      setDiffTruncated(!!cached.truncated)
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
        diffCache.current.set(selected, {
          diff: result.diff,
          emptyReason: result.emptyReason,
          truncated: result.truncated,
        })
        setDiff(result.diff)
        setDiffNote(result.emptyReason)
        setDiffTruncated(!!result.truncated)
      })
      .catch((err) => {
        if (cancelled) return
        setDiff(null)
        setDiffNote(undefined)
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

  const startSplit = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const body = splitBodyRef.current
    if (!body) return
    const rect = body.getBoundingClientRect()
    const initial = dragSplit ?? splitRatio
    setDragSplit(initial)
    const clamp = (v: number) => Math.min(0.8, Math.max(0.15, v))
    const move = (ev: PointerEvent) => {
      if (rect.height <= 0) return
      setDragSplit(clamp((ev.clientY - rect.top) / rect.height))
    }
    const up = (ev: PointerEvent) => {
      const ratio = clamp((ev.clientY - rect.top) / Math.max(1, rect.height))
      setSplitRatio(ratio)
      saveSplitRatio(ratio)
      setDragSplit(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const runAiReview = async () => {
    if (!host || !sessionId) return
    const result = await startAiReview(host, sessionId)
    if (result) {
      toast('AI 评审已开始，完成后意见会挂到对应行', 'info')
    }
  }

  const handleAiAction = (findingId: string, action: 'accept' | 'ignore' | 'false_positive') => {
    if (!host || !sessionId) return
    if (action === 'accept') {
      setReviewStatus(host.id, sessionId, findingId, 'accepted')
      return
    }
    if (action === 'ignore') {
      setReviewStatus(host.id, sessionId, findingId, 'ignored')
      return
    }
    if (!review) return
    void markFalsePositive(host, sessionId, review.id, findingId).then((ok) => {
      toast(
        ok ? '已标记为误报，下次评审会避免重复报告' : '已在本机忽略，但写入项目记忆失败',
        ok ? 'success' : 'error',
      )
    })
  }

  const dismissReview = () => {
    if (host && sessionId) clearReview(aiReviewKey(host.id, sessionId))
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
    if (blockOnBlocker && blockerCount > 0) {
      toast(`AI 评审还有 ${blockerCount} 个阻塞问题，已按设置阻止提交`, 'error')
      return
    }
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

  const commitAndCreatePr = async () => {
    if (!host || !sessionId || committing) return
    if (blockOnBlocker && blockerCount > 0) {
      toast(`AI 评审还有 ${blockerCount} 个阻塞问题，已按设置阻止提交`, 'error')
      return
    }
    const message = commitMessage.trim()
    if (!message) {
      toast('请先填写提交信息', 'error')
      return
    }
    setCommitting(true)
    try {
      const result = await api.commitChanges(host, sessionId, message)
      if (!result.ok) {
        toast(result.error || '提交失败', 'error')
        return
      }
      const short = result.commit?.slice(0, 7)
      toast(short ? `已提交 ${short}，正在准备 PR` : '已提交，正在准备 PR', 'success')
      setCommitMessage('')
      diffCache.current.clear()
      reload()
      bumpChanges()
      openPrPanel(message)
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
  const aiComments = useMemo(
    () =>
      activeFindings
        .filter((item) => item.file === selected && !reviewStatuses[item.id])
        .map((item) => ({
          id: item.id,
          side: 'new' as const,
          startLine: item.line,
          endLine: item.endLine ?? item.line,
          severity: item.severity,
          title: item.title,
          detail: item.detail,
          ...(item.suggestion ? { suggestion: item.suggestion } : {}),
        })),
    [activeFindings, reviewStatuses, selected],
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
        <h2 className="text-[13px] font-semibold">改动审阅</h2>
        {changes?.branch && (
          <span className="min-w-0 truncate font-mono text-[12px] text-muted">
            {changes.branch}
          </span>
        )}
        {files.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[12px]">
            <span className="text-[var(--t-git-plus)]">+{totalAdd}</span>
            <span className="text-[var(--t-git-minus)]">−{totalDel}</span>
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void runAiReview()}
          disabled={!host || !sessionId || reviewEntry?.starting || review?.status === 'running'}
          icon={
            reviewEntry?.starting || review?.status === 'running' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Bot size={13} />
            )
          }
          aria-label="AI 评审"
          tooltip="用评审模型检查当前改动"
          className="shrink-0 px-1.5 text-[12px]"
        >
          <span className="max-sm:hidden">AI 评审</span>
        </Button>
        <IconButton onClick={reload} label="刷新改动" tooltip="刷新" className="max-md:size-11">
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </IconButton>
        <IconButton onClick={onClose} label="关闭改动审阅" className="-mr-1 max-md:size-11">
          <X size={15} />
        </IconButton>
      </div>

      {(reviewEntry?.starting || reviewEntry?.error || review) && (
        <div className="shrink-0 border-b border-border/70 bg-[var(--t-bg-hover)]/40 px-3 py-2 text-[12px]">
          {review?.status === 'running' || reviewEntry?.starting ? (
            <div className="flex items-center gap-1.5 text-text-soft">
              <Loader2 size={12} className="animate-spin" />
              正在用 {review?.model ?? '评审模型'} 检查改动…
            </div>
          ) : reviewEntry?.error ? (
            <div className="flex items-center gap-1.5 text-danger">
              <AlertTriangle size={12} />
              <span className="min-w-0 flex-1">AI 评审失败：{reviewEntry.error}</span>
              <button
                type="button"
                className="shrink-0 rounded px-2 py-0.5 text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
                onClick={() => void runAiReview()}
              >
                重试
              </button>
            </div>
          ) : review?.status === 'error' ? (
            <div className="flex items-center gap-1.5 text-danger">
              <AlertTriangle size={12} />
              <span className="min-w-0 flex-1">AI 评审失败：{review.error ?? '未知错误'}</span>
            </div>
          ) : review ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Bot size={12} className="shrink-0 text-muted" />
                <span className={cn('font-medium', VERDICT_META[review.verdict ?? 'suggest']?.className)}>
                  {VERDICT_META[review.verdict ?? 'suggest']?.label ?? '评审完成'}
                </span>
                <span className="text-muted">
                  阻塞 {severityCounts.blocker} · 警告 {severityCounts.warn} · 细节 {severityCounts.nit}
                </span>
                {review.ignored > 0 && (
                  <span className="text-muted">· 已忽略 {review.ignored} 条指向不存在行的意见</span>
                )}
                {review.truncated && <span className="text-muted">· 改动过大，只评审了部分文件</span>}
                <span className="flex-1" />
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
                  onClick={() => void runAiReview()}
                >
                  重新评审
                </button>
                <IconButton
                  size="sm"
                  label="关闭 AI 评审结果"
                  onClick={dismissReview}
                  className="md:size-6 [&_svg]:size-3"
                >
                  <X size={12} />
                </IconButton>
              </div>
              {review.summary && (
                <p className="mt-1 whitespace-pre-wrap break-words leading-5 text-text-soft">
                  {review.summary}
                </p>
              )}
              {review.fallbackText && (
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-text-soft">
                  {review.fallbackText}
                </pre>
              )}
            </>
          ) : null}
        </div>
      )}

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
          <p className="text-[13px] text-danger">{error}</p>
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
          <p className="text-[13px] text-text-soft">工作区没有未提交的改动</p>
          <p className="text-[13px] text-muted">agent 修改文件后会出现在这里</p>
        </div>
      ) : (
        <>
        <div ref={splitBodyRef} className="flex min-h-0 flex-1 flex-col">
          <div
            className="min-h-[64px] shrink-0 overflow-y-auto"
            style={{ flex: `0 0 ${(dragSplit ?? splitRatio) * 100}%` }}
          >
            {files.map((file) => {
              const meta = STATUS_META[file.status] ?? STATUS_META.modified
              const { name, dir } = splitPath(file.path)
              return (
                <div
                  key={file.path}
                  className={cn(
                    'group flex h-7 w-full items-center border-l-2 transition-colors max-sm:h-11',
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
                    <span className={cn('w-3 shrink-0 text-center font-mono text-[12px] font-semibold', meta.className)}>
                      {meta.letter}
                    </span>
                    <span
                      className={cn(
                        'max-w-[62%] shrink-0 truncate font-mono text-[13px]',
                        selected === file.path ? 'text-text' : 'text-text-soft',
                      )}
                    >
                      {name}
                    </span>
                    {dir && (
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
                        {dir}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[12px] text-[var(--t-git-plus)]">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-[12px] text-[var(--t-git-minus)]">−{file.deletions}</span>
                  </button>
                  <IconButton
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => setRevertTarget(file)}
                    label={`丢弃 ${file.path} 的改动`}
                    tooltip="丢弃此文件的改动"
                    className="mr-0.5 max-sm:size-11! md:size-6 md:opacity-0 md:group-hover:opacity-100 [&_svg]:size-3"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              )
            })}
          </div>

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整文件列表高度"
            onPointerDown={startSplit}
            className="group relative h-2 shrink-0 cursor-row-resize touch-none border-b border-border"
          >
            <span
              className={cn(
                'pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors',
                dragSplit !== null ? 'bg-border-strong' : 'group-hover:bg-border-strong',
              )}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selectedFile && (
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-[12px] text-text-soft">
                  {selectedFile.path}
                </span>
                <span className="flex-1" />
                <span className="shrink-0 text-[12px] text-muted">点击或拖选行添加评论</span>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => setRevertTarget(selectedFile)}
                  className="px-1.5 text-[12px] max-sm:min-h-11 [&_svg]:size-3"
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
              <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[13px] text-danger">
                {diffError}
              </p>
            ) : diff !== null ? (
              <>
                {diffTruncated && (
                  <p className="mb-2 rounded-lg border border-border bg-[var(--t-bg-hover)] px-3 py-2 text-[12px] leading-5 text-muted">
                    diff 过大，已截断为前 1MB / 2 万行；完整内容可在终端用 git diff 查看。
                  </p>
                )}
              <DiffView
                unified={diff}
                fileName={selected ?? undefined}
                maxHeight={100000}
                emptyLabel={emptyReasonLabel(diffNote)}
                comments={fileComments}
                onAddComment={addComment}
                onEditComment={(id, text) =>
                  setComments((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)))
                }
                onDeleteComment={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
                aiComments={aiComments}
                onAiAction={handleAiAction}
              />
              </>
            ) : null}
          </div>
        </div>

          <div className="shrink-0 border-t border-border">
            {comments.length > 0 && (
              <div className="flex h-10 items-center gap-1.5 border-b border-border/60 px-2">
                <Popover
                  align="left"
                  side="top"
                  padded={false}
                  panelClassName="w-[340px]"
                  trigger={({ open, toggle }) => (
                    <button
                      type="button"
                      onClick={toggle}
                      className={cn(
                        'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text',
                        open && 'bg-[var(--t-bg-hover)] text-text',
                      )}
                      aria-label={`查看 ${comments.length} 条待发送评论`}
                    >
                      <MessageSquare size={12} className="shrink-0 text-[var(--t-comment-bar)]" />
                      <span>{comments.length} 条评论</span>
                    </button>
                  )}
                >
                  {() => (
                    <div className="max-h-64 overflow-y-auto p-1">
                      {comments.map((comment) => (
                        <div
                          key={comment.id}
                          className="group flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-[var(--t-bg-hover)]"
                        >
                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate font-mono text-[12px] text-muted"
                              title={comment.path}
                            >
                              {comment.path}:{comment.startLine}
                              {comment.endLine !== comment.startLine ? `-${comment.endLine}` : ''}
                            </p>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-soft">
                              {comment.text}
                            </p>
                          </div>
                          <IconButton
                            size="sm"
                            variant="danger-ghost"
                            label="删除这条评论"
                            onClick={() =>
                              setComments((prev) => prev.filter((c) => c.id !== comment.id))
                            }
                            className="md:size-6 [&_svg]:size-3"
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  )}
                </Popover>
                <span className="flex-1" />
                <Button size="sm" variant="primary" onClick={sendComments} disabled={sendingComments}>
                  发送给 agent
                </Button>
              </div>
            )}

            {untrackedCount > 0 && (
              <div className="flex h-6 items-center gap-1.5 border-b border-border/60 px-3 text-[12px] text-muted">
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
                className="min-h-7 max-h-24 min-w-0 flex-1 resize-none rounded-md border border-border bg-[var(--t-bg)] px-2 py-1.5 text-[12px] leading-4 text-text outline-none transition-[min-height] placeholder:text-muted focus:min-h-14 focus:border-[var(--t-border-strong)] max-sm:min-h-11"
              />
              {blockerCount > 0 && (
                <span
                  className="flex shrink-0 items-center gap-1 text-[12px] text-warning"
                  title={
                    blockOnBlocker
                      ? '设置已开启「有 blocker 时阻止提交」'
                      : '建议先处理阻塞问题；可在设置中改为阻止提交'
                  }
                >
                  <AlertTriangle size={12} />
                  {blockerCount} 个阻塞
                </span>
              )}
              <Button
                size="sm"
                variant="primary"
                onClick={requestCommit}
                disabled={!commitMessage.trim() || committing || (blockOnBlocker && blockerCount > 0)}
                title={
                  blockOnBlocker && blockerCount > 0
                    ? 'AI 评审有阻塞问题，已按设置阻止提交'
                    : untrackedCount > 0
                      ? `包含 ${untrackedCount} 个未跟踪文件`
                      : undefined
                }
                className="max-sm:min-h-11"
              >
                {committing && <Loader2 size={11} className="animate-spin" />}
                提交 {files.length} 个文件
              </Button>
              <Menu
                aria-label="更多提交操作"
                align="end"
                side="top"
                className="w-[200px]"
                trigger={({ open }) => (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label="更多提交操作"
                    tooltip={open ? '' : undefined}
                    className="max-sm:size-11!"
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                )}
              >
                <Menu.Item icon={<Bot />} onSelect={() => void runAiReview()}>
                  评审后再提交
                </Menu.Item>
                <Menu.Item icon={<Wand2 />} onSelect={askAgentCommit}>
                  让 agent 写提交信息
                </Menu.Item>
                <Menu.Item icon={<GitPullRequest />} onSelect={() => void commitAndCreatePr()}>
                  提交并创建 PR
                </Menu.Item>
                {comments.length > 0 && (
                  <Menu.Item icon={<MessageSquarePlus />} onSelect={() => setComments([])}>
                    清空 {comments.length} 条评论
                  </Menu.Item>
                )}
                <Menu.Item icon={<Trash2 />} danger onSelect={() => setDiscardAllOpen(true)}>
                  全部丢弃改动
                </Menu.Item>
              </Menu>
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
          <p className="text-[12px] text-muted">提交信息</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-text">
            {commitMessage.trim()}
          </p>
        </div>
        {untrackedCount > 0 && (
          <p className="mt-3 text-[13px] leading-5 text-warning">
            {untrackedCount} 个未跟踪文件会被一并提交；如果其中有临时文件，请先取消并丢弃。
          </p>
        )}
      </Modal>
    </aside>
  )
}
