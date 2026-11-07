import { useEffect, useMemo, useState } from 'react'
import { Check, FolderOpen, Loader2, Sparkles, Trash2 } from 'lucide-react'
import type { Board, BoardCard, BoardCardInput, BoardExec, BoardPlanDraft, PermissionMode, Profile, SubagentPreset } from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { dependencyCandidates } from '../../lib/board'
import { loadRecentDirs, rememberDir } from '../../lib/storage'
import type { HostConfig } from '../../lib/types'
import { Button, IconButton } from '../ui/Button'
import { Input, Select, Switch, Textarea } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { Popover } from '../ui/Popover'
import { FolderBrowser } from '../EnvBar'

const MOBILE_FULL =
  'max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]'
const BODY = 'flex min-h-0 flex-1 flex-col overflow-y-auto p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]'

const MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'acceptEdits', label: '自动接受编辑（推荐）' },
  { value: 'default', label: '默认（按规则审批）' },
  { value: 'plan', label: '计划模式' },
  { value: 'bypassPermissions', label: '跳过审批' },
]

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[12px] text-muted">{children}</div>
}

export function CreateBoardDialog({
  open,
  host,
  profiles,
  onClose,
  onCreated,
}: {
  open: boolean
  host: HostConfig
  profiles: Profile[]
  onClose: () => void
  onCreated: (board: Board) => void
}) {
  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('')
  const [profileId, setProfileId] = useState('')
  const [parallel, setParallel] = useState('2')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recents = useMemo(() => loadRecentDirs(host.id), [host.id, open])

  useEffect(() => {
    if (!open) return
    setCwd(loadRecentDirs(host.id)[0] ?? '')
    setName('')
    setError(null)
    setProfileId((current) => (profiles.some((p) => p.id === current) ? current : profiles[0]?.id ?? ''))
  }, [open, host.id, profiles])

  const submit = async () => {
    if (!cwd.trim()) {
      setError('请选择项目目录')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const board = await api.createBoard(host, {
        cwd: cwd.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        maxParallel: Number(parallel),
        defaults: { ...(profileId ? { profileId } : {}), permissionMode: 'acceptEdits' },
      })
      rememberDir(host.id, cwd.trim())
      onCreated(board)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="创建看板"
      title="创建看板"
      className={cn('max-h-[min(560px,88dvh)] w-[min(520px,94vw)]', MOBILE_FULL)}
      bodyClassName={BODY}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()} icon={busy ? <Loader2 className="animate-spin" /> : undefined}>
            创建
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <FieldLabel>项目目录</FieldLabel>
          <div className="flex min-w-0 items-center gap-1.5">
            <Input aria-label="项目目录" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/you/project" className="min-w-0 flex-1" />
            <Popover
              panelClassName="w-[320px] max-w-[92vw] p-0"
              trigger={({ toggle }) => (
                <Button size="sm" variant="secondary" icon={<FolderOpen size={13} />} onClick={toggle}>
                  浏览
                </Button>
              )}
            >
              {(close) => (
                <div className="max-h-[360px] overflow-y-auto">
                  <FolderBrowser
                    hostId={host.id}
                    initial={cwd}
                    onUse={(path) => {
                      setCwd(path)
                      close()
                    }}
                  />
                </div>
              )}
            </Popover>
          </div>
          {recents.length > 0 && (
            <div className="no-scrollbar mt-1.5 flex items-center gap-1 overflow-x-auto pb-0.5">
              {recents.slice(0, 5).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setCwd(dir)}
                  className="max-w-[200px] shrink-0 truncate rounded-md bg-[var(--t-surface-2)] px-2 py-1 text-[12px] text-text-secondary hover:text-text"
                >
                  {dir}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <FieldLabel>看板名称（可选）</FieldLabel>
          <Input aria-label="看板名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="默认用目录名" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>默认账号</FieldLabel>
            <Select aria-label="默认账号" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel>并发上限</FieldLabel>
            <Select aria-label="并发上限" value={parallel} onChange={(e) => setParallel(e.target.value)}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={String(n)}>
                  {n} 张
                </option>
              ))}
            </Select>
          </div>
        </div>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

export function CardEditorDialog({
  open,
  host,
  board,
  card,
  onClose,
  onSaved,
}: {
  open: boolean
  host: HostConfig
  board: Board
  /** 缺省 = 新建。 */
  card?: BoardCard
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [deps, setDeps] = useState<string[]>([])
  const [preset, setPreset] = useState('')
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  const [worktree, setWorktree] = useState(true)
  const [gate, setGate] = useState(false)
  const [budget, setBudget] = useState('')
  const [presets, setPresets] = useState<SubagentPreset[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidates = useMemo(() => dependencyCandidates(card ?? { id: '' }, board.cards), [card, board.cards])

  useEffect(() => {
    if (!open) return
    setTitle(card?.title ?? '')
    setPrompt(card?.prompt ?? '')
    setDeps(card?.deps ?? [])
    setPreset(card?.exec.preset ?? '')
    setMode(card?.exec.permissionMode ?? board.defaults.permissionMode ?? 'acceptEdits')
    setWorktree(card?.exec.worktree ?? board.defaults.worktree ?? true)
    setGate(card?.exec.gate ?? false)
    setBudget(card?.exec.budgetUsd ? String(card.exec.budgetUsd) : '')
    setError(null)
    api
      .subagentPresets(host, board.cwd)
      .then((res) => setPresets(res.presets))
      .catch(() => setPresets([]))
  }, [open, card, board, host])

  const save = async (release: boolean) => {
    if (!prompt.trim()) {
      setError('提示词不能为空')
      return
    }
    const exec: BoardExec = {
      permissionMode: mode,
      worktree,
      gate,
      ...(preset ? { preset } : {}),
      ...(Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
    }
    setBusy(true)
    setError(null)
    try {
      const input: BoardCardInput = { title: title.trim(), prompt: prompt.trim(), deps, exec }
      if (card) {
        await api.updateBoardCard(host, board.id, card.id, input)
        if (release && card.status === 'todo') await api.boardCardAction(host, board.id, card.id, 'start')
      } else {
        await api.createBoardCard(host, board.id, { ...input, status: release ? 'queued' : 'todo' })
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const releasable = !card || card.status === 'todo'
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={card ? '编辑卡片' : '新建卡片'}
      title={card ? '编辑卡片' : '新建卡片'}
      className={cn('max-h-[min(720px,90dvh)] w-[min(580px,94vw)]', MOBILE_FULL)}
      bodyClassName={BODY}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant={releasable ? 'secondary' : 'primary'} disabled={busy} onClick={() => void save(false)}>
            {card ? '保存' : '保存到待办'}
          </Button>
          {releasable ? (
            <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
              {card ? '保存并放行' : '创建并放行'}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <FieldLabel>标题（可留空，取提示词开头）</FieldLabel>
          <Input aria-label="卡片标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <FieldLabel>提示词</FieldLabel>
          <Textarea aria-label="卡片提示词" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="写清范围与验收标准" />
        </div>
        {candidates.length > 0 && (
          <div>
            <FieldLabel>依赖（这些卡完成后才会运行）</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((item) => {
                const on = deps.includes(item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDeps(on ? deps.filter((id) => id !== item.id) : [...deps, item.id])}
                    className={cn(
                      'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[13px] transition-colors',
                      on ? 'border-border-strong bg-[var(--t-bg-active)] text-text' : 'border-border text-text-secondary hover:bg-[var(--t-bg-hover)]',
                    )}
                  >
                    {on ? <Check size={12} aria-hidden /> : null}
                    <span className="truncate">{item.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>子代理预设</FieldLabel>
            <Select aria-label="子代理预设" value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">默认（看板账号与模型）</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel>权限模式</FieldLabel>
            <Select aria-label="权限模式" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center justify-between gap-2 text-[13px] text-text-secondary">
            独立 worktree
            <Switch checked={worktree && board.isGit} disabled={!board.isGit} onChange={setWorktree} label="独立 worktree" />
          </label>
          <label className="flex items-center justify-between gap-2 text-[13px] text-text-secondary">
            完成后需我确认
            <Switch checked={gate} onChange={setGate} label="审批门" />
          </label>
        </div>
        <div>
          <FieldLabel>单卡预算上限（美元，留空不限）</FieldLabel>
          <Input aria-label="单卡预算" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} placeholder="例如 2" />
        </div>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

export function PlanDialog({
  open,
  host,
  board,
  onClose,
  onCreated,
}: {
  open: boolean
  host: HostConfig
  board: Board
  onClose: () => void
  onCreated: (count: number) => void
}) {
  const [goal, setGoal] = useState('')
  const [drafts, setDrafts] = useState<BoardPlanDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setGoal('')
    setDrafts(null)
    setError(null)
  }, [open])

  const generate = async () => {
    if (!goal.trim()) {
      setError('先写下目标')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setDrafts((await api.planBoard(host, board.id, goal.trim())).drafts)
    } catch (err) {
      setError(err instanceof Error ? err.message : '规划失败')
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!drafts || drafts.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const { cards } = await api.applyBoardPlan(host, board.id, drafts)
      onCreated(cards.length)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const patch = (ref: string, next: Partial<BoardPlanDraft>) =>
    setDrafts((list) => list?.map((d) => (d.ref === ref ? { ...d, ...next } : d)) ?? null)
  const remove = (ref: string) =>
    setDrafts((list) => list?.filter((d) => d.ref !== ref).map((d) => ({ ...d, deps: d.deps.filter((dep) => dep !== ref) })) ?? null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="AI 拆分"
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={14} className="text-muted" /> AI 拆分
        </span>
      }
      className={cn('max-h-[min(760px,92dvh)] w-[min(680px,94vw)]', MOBILE_FULL)}
      bodyClassName={BODY}
      footer={
        <div className="flex items-center justify-end gap-2">
          {drafts ? <Button onClick={() => setDrafts(null)}>重写目标</Button> : <Button onClick={onClose}>取消</Button>}
          {drafts ? (
            <Button variant="primary" disabled={busy || drafts.length === 0} onClick={() => void create()}>
              创建 {drafts.length} 张卡到待办
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void generate()} icon={busy ? <Loader2 className="animate-spin" /> : undefined}>
              生成草稿
            </Button>
          )}
        </div>
      }
    >
      {drafts ? (
        <div className="space-y-3">
          <p className="text-[12px] text-muted">草稿不会自动运行。可修改标题与提示词，确认后创建到待办，再逐张或批量放行。</p>
          {drafts.map((draft) => (
            <div key={draft.ref} className="space-y-1.5 rounded-lg border border-border p-2.5">
              <div className="flex items-center gap-1.5">
                <Input aria-label="草稿标题" value={draft.title} onChange={(e) => patch(draft.ref, { title: e.target.value })} className="min-w-0 flex-1" />
                <IconButton label="删除草稿" size="sm" onClick={() => remove(draft.ref)}>
                  <Trash2 />
                </IconButton>
              </div>
              <Textarea aria-label="草稿提示词" value={draft.prompt} onChange={(e) => patch(draft.ref, { prompt: e.target.value })} rows={3} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-tertiary">
                {draft.deps.length > 0 ? (
                  <span>依赖：{draft.deps.map((ref) => drafts.find((d) => d.ref === ref)?.title ?? ref).join('、')}</span>
                ) : (
                  <span>无依赖，可并行</span>
                )}
                {draft.preset ? <span>预设：{draft.preset}</span> : null}
                <label className="ml-auto flex items-center gap-1.5">
                  完成后需确认
                  <Switch checked={!!draft.gate} onChange={(v) => patch(draft.ref, { gate: v })} label={`${draft.title} 审批门`} />
                </label>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <FieldLabel>写一句目标，协调者会拆成带依赖的卡片草稿</FieldLabel>
          <Textarea aria-label="拆分目标" value={goal} onChange={(e) => setGoal(e.target.value)} rows={5} placeholder="例如：给设置页加导出功能，需要后端接口、前端按钮和测试" />
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  )
}

export function NoteDialog({
  open,
  title,
  label,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  label: string
  confirmLabel: string
  onClose: () => void
  onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) setNote('')
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title}
      title={title}
      className="w-[min(460px,94vw)]"
      bodyClassName="p-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onConfirm(note.trim())}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <FieldLabel>{label}</FieldLabel>
      <Textarea aria-label={label} value={note} onChange={(e) => setNote(e.target.value)} rows={4} autoFocus />
    </Modal>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title}
      title={title}
      className="w-[min(440px,94vw)]"
      bodyClassName="p-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed text-text-secondary">{body}</p>
    </Modal>
  )
}
