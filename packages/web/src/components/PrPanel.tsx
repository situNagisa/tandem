import { useEffect, useMemo, useRef, useState } from 'react'
import type { PrCheck, PrMergeMethod, PullRequestInfo, VcsCapability } from '@tandem/protocol'
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useVcsStore, vcsKey } from '../lib/useVcs'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { Button, IconButton } from './ui/Button'
import { Input } from './ui/Controls'
import { Menu } from './ui/Menu'
import { Modal } from './ui/Modal'

const STATE_META: Record<string, { label: string; className: string }> = {
  OPEN: { label: '开放', className: 'text-[var(--t-git-plus)]' },
  DRAFT: { label: '草稿', className: 'text-muted' },
  MERGED: { label: '已合并', className: 'text-[var(--t-git-renamed)]' },
  CLOSED: { label: '已关闭', className: 'text-muted' },
  UNKNOWN: { label: '未知', className: 'text-muted' },
}

const MERGE_LABEL: Record<PrMergeMethod, string> = {
  squash: '压缩合并（squash）',
  merge: '创建合并提交（merge）',
  rebase: '变基合并（rebase）',
}

function stateDot(pr: PullRequestInfo): string {
  if (pr.state === 'MERGED') return 'bg-[var(--t-git-renamed)]'
  if (pr.state === 'DRAFT' || pr.state === 'CLOSED') return 'bg-muted'
  if (pr.checksState === 'failure') return 'bg-danger'
  if (pr.checksState === 'pending') return 'bg-accent'
  return 'bg-[var(--t-git-plus)]'
}

function checkIcon(check: PrCheck) {
  if (check.status === 'failure') return <XCircle size={14} className="text-danger" />
  if (check.status === 'cancelled' || check.status === 'skipped') {
    return <CircleDashed size={14} className="text-muted" />
  }
  if (check.status === 'success' || check.status === 'neutral') {
    return <CheckCircle2 size={14} className="text-[var(--t-git-plus)]" />
  }
  return <Clock3 size={14} className="text-accent" />
}

function durationText(ms?: number): string | undefined {
  if (ms === undefined || ms < 0) return undefined
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function providerLabel(vcs: VcsCapability): string {
  if (vcs.provider === 'github') return 'GitHub'
  if (vcs.provider === 'gitlab') return 'GitLab'
  if (vcs.provider === 'other') return vcs.remoteHost || '其他托管平台'
  return '未配置远程仓库'
}

function cliName(vcs: VcsCapability): string {
  return vcs.cli === 'glab' ? 'glab' : 'gh'
}

function CliGuide({ vcs }: { vcs: VcsCapability }) {
  if (vcs.provider === 'other') {
    return (
      <div className="rounded-lg border border-border bg-[var(--t-bg-hover)] p-3 text-[13px] leading-6 text-text-soft">
        远程主机 <span className="font-mono text-text">{vcs.remoteHost}</span>{' '}
        不是 GitHub / GitLab。PR 与 CI 集成目前只支持这两个平台。
      </div>
    )
  }
  if (vcs.provider === 'none') {
    return (
      <div className="rounded-lg border border-border bg-[var(--t-bg-hover)] p-3 text-[13px] leading-6 text-text-soft">
        当前仓库没有 <span className="font-mono text-text">origin</span> 远程仓库，无法创建 PR。
        先在 Host 机器上配置远程仓库：
        <code className="mt-2 block rounded bg-surface px-2 py-1 font-mono text-[12px]">
          git remote add origin &lt;仓库地址&gt;
        </code>
      </div>
    )
  }
  const glab = vcs.cli === 'glab'
  const bin = glab ? 'glab' : 'gh'
  return (
    <div className="rounded-lg border border-border bg-[var(--t-bg-hover)] p-3 text-[13px] leading-6 text-text-soft">
      <div className="flex items-center gap-1.5 font-medium text-text">
        <AlertTriangle size={14} className="text-warning" />
        {vcs.cliInstalled ? `${bin} 尚未登录` : `未安装 ${bin}`}
      </div>
      <p className="mt-1">
        PR 与 CI 集成使用 Host 机器上的 {providerLabel(vcs)} CLI 和你的本地登录状态，
        Tandem 不会保存平台令牌。
      </p>
      {!vcs.cliInstalled && (
        <div className="mt-2 space-y-1 font-mono text-[12px] text-text">
          <div className="rounded bg-surface px-2 py-1">
            {glab ? 'brew install glab（或 winget install glab.glab）' : 'brew install gh（或 winget install --id GitHub.cli）'}
          </div>
        </div>
      )}
      <div className="mt-2 rounded bg-surface px-2 py-1 font-mono text-[12px] text-text">
        {bin} auth login
      </div>
      <a
        href={vcs.docUrl ?? (glab ? 'https://gitlab.com/gitlab-org/cli' : 'https://cli.github.com/manual/')}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
      >
        {glab ? 'GitLab CLI 文档' : 'GitHub CLI 文档'}
        <ExternalLink size={11} />
      </a>
    </div>
  )
}

function RepoLine({ vcs }: { vcs: VcsCapability }) {
  if (!vcs.isRepo) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <span className="inline-flex min-w-0 items-center gap-1">
        <GitPullRequest size={12} />
        <span className="truncate font-mono text-[11.5px] text-text-soft">
          {vcs.branch || '（分离 HEAD）'}
        </span>
      </span>
      {vcs.upstream && (
        <span>
          上游 {vcs.upstream}
          {vcs.ahead || vcs.behind ? (
            <span className="ml-1 tabular-nums">
              {vcs.ahead ? `↑${vcs.ahead}` : ''}
              {vcs.ahead && vcs.behind ? ' ' : ''}
              {vcs.behind ? `↓${vcs.behind}` : ''}
            </span>
          ) : null}
        </span>
      )}
      {!vcs.upstream && <span>未设置上游</span>}
      <span>{providerLabel(vcs)}</span>
      {vcs.cliUser && <span>{vcs.cliUser}</span>}
    </div>
  )
}

function CheckRow({
  check,
  onFix,
  fixing,
}: {
  check: PrCheck
  onFix?: () => void
  fixing: boolean
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 px-2.5 py-2">
      <span className="shrink-0">{checkIcon(check)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-text">
          {check.workflow ? `${check.workflow} / ` : ''}
          {check.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <span>{check.status === 'failure' ? '失败' : check.status === 'success' ? '通过' : check.status === 'queued' ? '排队中' : check.status === 'in_progress' ? '运行中' : check.status === 'pending' ? '等待中' : check.status === 'skipped' ? '已跳过' : check.status === 'cancelled' ? '已取消' : check.status === 'neutral' ? '中性' : '未知'}</span>
          {durationText(check.durationMs) && <span>· {durationText(check.durationMs)}</span>}
        </span>
      </span>
      {check.url && (
        <IconButton
          size="sm"
          variant="ghost"
          label="打开检查详情"
          onClick={() => window.open(check.url!, '_blank', 'noopener,noreferrer')}
          className="text-text-soft"
        >
          <ExternalLink size={12} />
        </IconButton>
      )}
      {check.status === 'failure' && onFix && (
        <Button size="sm" variant="secondary" onClick={onFix} disabled={fixing}>
          {fixing && <Loader2 size={11} className="animate-spin" />}
          让 agent 修复
        </Button>
      )}
    </div>
  )
}

/** 顶栏 PR 按钮：无 PR 显示「PR」，有 PR 显示 #号与状态点。 */
export function PrButton() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const prOpen = useUiStore((s) => s.prOpen)
  const openPrPanel = useUiStore((s) => s.openPrPanel)
  const closePrPanel = useUiStore((s) => s.closePrPanel)
  const entry = useVcsStore((s) =>
    host && sessionId ? s.byKey[vcsKey(host.id, sessionId)] : undefined,
  )
  const refresh = useVcsStore((s) => s.refresh)
  const pr = entry?.state?.pr

  useEffect(() => {
    if (!host || !sessionId) return
    void refresh(host, sessionId)
    const timer = window.setInterval(() => void refresh(host, sessionId, true), 60_000)
    return () => window.clearInterval(timer)
  }, [host?.id, sessionId, refresh])

  if (!host || !sessionId) return null
  const label = pr ? `PR #${pr.number}` : 'PR'
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => (prOpen ? closePrPanel() : openPrPanel())}
      aria-label={label}
      tooltip={pr ? `${label} · ${STATE_META[pr.state]?.label ?? ''}` : 'PR 与 CI'}
      aria-pressed={prOpen}
      className={cn(
        'gap-1 px-1.5 text-text! max-md:h-8',
        prOpen && 'bg-[var(--t-bg-active)]',
      )}
    >
      <GitPullRequest size={13.5} className="shrink-0 text-text!" />
      <span className="hidden text-[12px] font-sans sm:inline">
        {pr ? `#${pr.number}` : 'PR'}
      </span>
      {pr && <span className={cn('size-1.5 shrink-0 rounded-full', stateDot(pr))} />}
    </Button>
  )
}

/** PR 面板：状态、检查、创建 / 合并 / 让 agent 修复。 */
export function PrPanel() {
  const open = useUiStore((s) => s.prOpen)
  const composeTitle = useUiStore((s) => s.prComposeTitle)
  const close = useUiStore((s) => s.closePrPanel)
  const toast = useUiStore((s) => s.toast)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const messages = useAppStore((s) => s.active?.messages)
  const send = useAppStore((s) => s.send)
  const entry = useVcsStore((s) =>
    host && sessionId ? s.byKey[vcsKey(host.id, sessionId)] : undefined,
  )
  const refresh = useVcsStore((s) => s.refresh)
  const apply = useVcsStore((s) => s.apply)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(false)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod | null>(null)
  const [merging, setMerging] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const draftBaseline = useRef(0)
  const sawRunning = useRef(false)

  const state = entry?.state
  const vcs = state?.vcs
  const pr = state?.pr

  useEffect(() => {
    if (!open || !host || !sessionId) return
    void refresh(host, sessionId, true)
  }, [open, host?.id, sessionId, refresh])

  // 每次打开面板重置表单；从「提交并创建 PR」进入时预填提交信息作为标题
  useEffect(() => {
    if (!open) return
    setTitle(composeTitle)
    setBody('')
    setBase('')
    setDraft(false)
  }, [open, sessionId, composeTitle])

  // 让 agent 起草：等待本轮结束，从最后一条 assistant 回复里解析 JSON
  useEffect(() => {
    if (!drafting) return
    if (running) {
      sawRunning.current = true
      return
    }
    if (!sawRunning.current) return
    sawRunning.current = false
    setDrafting(false)
    const recent = (messages ?? []).slice(draftBaseline.current)
    const reply = [...recent].reverse().find((message) => message.role === 'assistant')
    if (!reply) {
      toast('agent 没有返回内容，请重试', 'error')
      return
    }
    const text = reply.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1]
    const candidate = fenced ?? text.match(/\{[\s\S]*"title"[\s\S]*\}/)?.[0]
    try {
      const parsed = JSON.parse(candidate ?? '') as { title?: unknown; body?: unknown }
      if (typeof parsed.title !== 'string' || !parsed.title.trim()) throw new Error('no title')
      setTitle(parsed.title.trim())
      if (typeof parsed.body === 'string') setBody(parsed.body)
      toast('已填入 PR 标题与描述', 'success')
    } catch {
      toast('未能从 agent 回复中解析标题/描述，请重试', 'error')
    }
  }, [drafting, running, messages, toast])

  const failedChecks = useMemo(
    () => (pr?.checks ?? []).filter((check) => check.status === 'failure'),
    [pr],
  )

  const startDraft = () => {
    if (!sessionId) return
    draftBaseline.current = messages?.length ?? 0
    sawRunning.current = false
    setDrafting(true)
    const ok = send([
      {
        type: 'text',
        text: '请根据当前分支相对基线分支的 git diff，为这次改动写一个 Pull Request 标题和描述。不要修改文件、不要提交或推送。只输出一个 JSON 代码块，格式：\n```json\n{"title":"简洁的标题","body":"Markdown 描述，说明改了什么、为什么"}\n```',
      },
    ])
    if (!ok) {
      setDrafting(false)
      toast('Host 未连接，无法让 agent 起草', 'error')
    }
  }

  const doCreate = async () => {
    if (!host || !sessionId || creating) return
    if (!title.trim()) {
      toast('请先填写 PR 标题', 'error')
      setConfirmCreate(false)
      return
    }
    setCreating(true)
    try {
      const result = await api.createPr(host, sessionId, {
        title: title.trim(),
        body,
        ...(base.trim() ? { base: base.trim() } : {}),
        ...(draft ? { draft: true } : {}),
      })
      if (!result.ok) {
        toast(result.error || '创建 PR 失败', 'error')
        return
      }
      if (result.state) apply(host.id, sessionId, result.state)
      setConfirmCreate(false)
      toast(result.state?.pr ? `已创建 PR #${result.state.pr.number}` : '已创建 PR', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建 PR 失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  const doMerge = async () => {
    if (!host || !sessionId || !mergeMethod || merging) return
    setMerging(true)
    try {
      const result = await api.mergePr(host, sessionId, mergeMethod)
      if (!result.ok) {
        toast(result.error || '合并失败', 'error')
        return
      }
      if (result.state) apply(host.id, sessionId, result.state)
      toast(`已合并 PR #${pr?.number ?? ''}`, 'success')
      setMergeMethod(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '合并失败', 'error')
    } finally {
      setMerging(false)
    }
  }

  const fixCheck = async (check: PrCheck) => {
    if (!host || !sessionId || fixing) return
    setFixing(check.name)
    try {
      const result = await api.fixPrCheck(host, sessionId, {
        checkName: check.name,
        ...(check.runId ? { runId: check.runId } : {}),
        ...(check.url ? { url: check.url } : {}),
      })
      if (!result.ok || !result.sent) {
        toast(result.error || '读取失败日志失败', 'error')
        return
      }
      toast(`已把「${check.name}」的失败日志发给 agent`, 'success', {
        actionLabel: '查看会话',
        onClick: close,
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : '读取失败日志失败', 'error')
    } finally {
      setFixing(null)
    }
  }

  const canCreate =
    !!vcs && vcs.isRepo && vcs.cliInstalled && vcs.authenticated &&
    (vcs.provider === 'github' || vcs.provider === 'gitlab')
  const loading = entry?.loading && !state

  return (
    <>
      <Modal
        open={open && !!sessionId}
        onClose={close}
        title={
          <span className="flex items-center gap-2">
            <GitPullRequest size={16} />
            Pull Request
          </span>
        }
        description={vcs?.isRepo ? `${providerLabel(vcs)}${vcs.root ? ` · ${vcs.root}` : ''}` : undefined}
        className="max-w-2xl"
        bodyClassName="space-y-3"
      >
        {!sessionId ? null : loading ? (
          <div className="flex h-24 items-center justify-center gap-2 text-[13px] text-muted">
            <Loader2 size={14} className="animate-spin" />
            正在读取仓库与 PR 状态…
          </div>
        ) : entry?.error && !state ? (
          <div className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[13px] text-danger">
            {entry.error}
          </div>
        ) : !vcs ? null : !vcs.isRepo ? (
          <div className="rounded-lg border border-border bg-[var(--t-bg-hover)] px-3 py-3 text-[13px] text-text-soft">
            当前会话目录不是 git 仓库，无法创建 PR。
          </div>
        ) : (
          <>
            <RepoLine vcs={vcs} />

            {(!vcs.cliInstalled || !vcs.authenticated || (vcs.provider !== 'github' && vcs.provider !== 'gitlab')) && (
              <CliGuide vcs={vcs} />
            )}

            {pr ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-surface p-3">
                  <div className="flex items-start gap-2">
                    <span className={cn('mt-0.5 size-2 shrink-0 rounded-full', stateDot(pr))} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 font-mono text-[12px] text-muted">#{pr.number}</span>
                        <span className="min-w-0 truncate text-[13.5px] font-medium text-text">
                          {pr.title}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
                        <span className={STATE_META[pr.state]?.className}>
                          {STATE_META[pr.state]?.label ?? pr.state}
                        </span>
                        {pr.baseRefName && <span>→ {pr.baseRefName}</span>}
                        {pr.reviewDecision && <span>{pr.reviewDecision === 'APPROVED' ? '已批准' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '需修改' : '待审阅'}</span>}
                        {pr.mergeable === 'CONFLICTING' && <span className="text-danger">有冲突</span>}
                        {pr.checksState === 'failure' && (
                          <span className="text-danger">
                            {failedChecks.length} 个检查失败
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
                        icon={<ExternalLink size={12} />}
                      >
                        打开
                      </Button>
                      {(pr.state === 'OPEN' || pr.state === 'MERGED') && (
                        <Menu
                          align="end"
                          className="w-[210px]"
                          trigger={({ open: menuOpen }) => (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pr.state !== 'OPEN' || pr.mergeable === 'CONFLICTING'}
                              tooltip={pr.state !== 'OPEN' ? 'PR 已不是开放状态' : pr.mergeable === 'CONFLICTING' ? 'PR 存在冲突，无法合并' : undefined}
                              icon={<GitMerge size={12} />}
                              aria-expanded={menuOpen}
                            >
                              合并
                            </Button>
                          )}
                        >
                          {(Object.keys(MERGE_LABEL) as PrMergeMethod[]).map((method) => (
                            <Menu.Item key={method} onSelect={() => setMergeMethod(method)}>
                              {MERGE_LABEL[method]}
                            </Menu.Item>
                          ))}
                        </Menu>
                      )}
                    </div>
                  </div>
                </div>

                <section>
                  <div className="mb-1.5 flex items-center gap-2">
                    <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                      CI 检查
                    </h3>
                    <span className="text-[11.5px] text-muted">{pr.checks.length} 项</span>
                    <span className="flex-1" />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label="刷新 PR 状态"
                      onClick={() => host && sessionId && void refresh(host, sessionId, true)}
                      className="text-text-soft"
                    >
                      <RefreshCw size={12} className={entry?.loading ? 'animate-spin' : undefined} />
                    </IconButton>
                  </div>
                  {pr.checks.length === 0 ? (
                    <p className="rounded-lg border border-border/70 px-3 py-3 text-[12.5px] text-muted">
                      {pr.checksState === 'none' ? '这个 PR 还没有 CI 检查。' : '暂时没有检查详情。'}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {pr.checks.map((check) => (
                        <CheckRow
                          key={`${check.name}:${check.runId ?? ''}`}
                          check={check}
                          fixing={fixing === check.name}
                          onFix={check.status === 'failure' ? () => void fixCheck(check) : undefined}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            ) : canCreate ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                    创建 PR
                  </h3>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={startDraft}
                    disabled={drafting || running}
                    icon={drafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  >
                    {drafting ? '等待 agent…' : '让 agent 起草'}
                  </Button>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[12px] text-text-soft">标题</span>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：为会话列表增加分支筛选"
                    aria-label="PR 标题"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] text-text-soft">描述（可选）</span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={5}
                    placeholder="说明改了什么、为什么改、如何验证"
                    aria-label="PR 描述"
                    className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] leading-5 text-text outline-none transition-colors placeholder:text-muted focus:border-border-strong"
                  />
                </label>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="block w-40">
                    <span className="mb-1 block text-[12px] text-text-soft">目标分支（可选）</span>
                    <Input
                      value={base}
                      onChange={(e) => setBase(e.target.value)}
                      placeholder="默认远程默认分支"
                      aria-label="目标分支"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 pb-2 text-[12.5px] text-text-soft">
                    <input
                      type="checkbox"
                      checked={draft}
                      onChange={(e) => setDraft(e.target.checked)}
                      className="size-3.5 accent-[var(--t-text)]"
                    />
                    创建为草稿
                  </label>
                  <span className="flex-1" />
                  <Button
                    variant="primary"
                    onClick={() => setConfirmCreate(true)}
                    disabled={!title.trim() || creating}
                    icon={<GitPullRequest size={14} />}
                  >
                    创建 PR
                  </Button>
                </div>
                <p className="text-[11.5px] leading-5 text-muted">
                  创建前会先执行 <span className="font-mono">git push -u origin HEAD</span>，
                  把分支 {vcs.branch ?? 'HEAD'} 推送到 {vcs.remoteHost ?? 'origin'}。
                </p>
              </div>
            ) : null}
          </>
        )}
      </Modal>

      <Modal
        open={confirmCreate}
        onClose={() => setConfirmCreate(false)}
        title="确认创建 PR"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setConfirmCreate(false)} disabled={creating}>
              取消
            </Button>
            <Button size="lg" variant="primary" onClick={() => void doCreate()} disabled={creating}>
              {creating && <Loader2 size={14} className="animate-spin" />}
              推送并创建
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          将推送分支{' '}
          <span className="font-mono text-text">{vcs?.branch ?? 'HEAD'}</span> 到远程{' '}
          <span className="font-medium text-text">{vcs?.remoteHost ?? 'origin'}</span>，
          然后在 {vcs ? providerLabel(vcs) : '平台'} 创建 Pull Request。
          推送会更新远程分支，请确认没有不期望公开的内容。
        </p>
        <div className="mt-3 rounded-lg border border-border bg-bg/60 px-3 py-2">
          <p className="text-[12px] text-muted">标题</p>
          <p className="mt-0.5 text-[13px] font-medium text-text">{title.trim()}</p>
          {base.trim() && (
            <p className="mt-1 text-[12px] text-muted">目标分支：{base.trim()}</p>
          )}
        </div>
      </Modal>

      <Modal
        open={!!mergeMethod}
        onClose={() => setMergeMethod(null)}
        title="确认合并 PR"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setMergeMethod(null)} disabled={merging}>
              取消
            </Button>
            <Button size="lg" variant="primary" onClick={() => void doMerge()} disabled={merging}>
              {merging && <Loader2 size={14} className="animate-spin" />}
              确认合并
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          将把 PR <span className="font-mono text-text">#{pr?.number}</span> 以
          「{mergeMethod ? MERGE_LABEL[mergeMethod] : ''}」方式合并到{' '}
          <span className="font-mono text-text">{pr?.baseRefName ?? '目标分支'}</span>。
          合并后不可撤销。
        </p>
        <p className="mt-3 text-[12px] text-muted">操作在 Host 机器上通过 {vcs?.cli ?? 'gh'} 完成。</p>
      </Modal>
    </>
  )
}
