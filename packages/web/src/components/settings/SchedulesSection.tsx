import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  CalendarClock,
  Clock,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type {
  PermissionMode,
  ReasoningEffort,
  Schedule,
  ScheduleInput,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useScheduleStore } from '../../store/useScheduleStore'
import { useUiStore } from '../../store/useUiStore'
import { defaultChoiceFor, profileModelGroups } from '../../lib/profileModels'
import { CRON_PRESETS, describeCron, formatNextRun, formatRunAt, presetFor } from '../../lib/schedule'
import { formatRelative } from '../../lib/format'
import { navigate } from '../../lib/router'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../ui/Button'
import { Input, Select, Switch } from '../ui/Controls'
import { Modal } from '../ui/Modal'

const EMPTY_SCHEDULES: Schedule[] = []

/** 跨挂载记忆已处理的 /schedule 次数，避免每次进入设置都弹新建表单。 */
let consumedComposeNonce = 0

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: '逐项询问（default）',
  acceptEdits: '自动接受编辑（acceptEdits）',
  plan: '计划模式（plan）',
  bypassPermissions: '绕过权限（bypassPermissions）',
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关',
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
}

interface Draft {
  name: string
  cron: string
  preset: string
  targetKind: 'new' | 'session'
  sessionId: string
  cwd: string
  profileId: string
  groupId: string
  model: string
  effort: ReasoningEffort
  permissionMode: PermissionMode
  prompt: string
  enabled: boolean
  catchUp: boolean
}

function draftFrom(schedule: Schedule | null, base: Partial<Draft>): Draft {
  if (!schedule) {
    return {
      name: '',
      cron: '0 9 * * 1-5',
      preset: 'weekdays',
      targetKind: 'new',
      sessionId: '',
      cwd: base.cwd ?? '',
      profileId: base.profileId ?? '',
      groupId: base.groupId ?? '',
      model: base.model ?? '',
      effort: base.effort ?? 'off',
      permissionMode: 'acceptEdits',
      prompt: '',
      enabled: true,
      catchUp: true,
    }
  }
  return {
    name: schedule.name,
    cron: schedule.cron,
    preset: presetFor(schedule.cron),
    targetKind: schedule.target.kind,
    sessionId: schedule.target.sessionId ?? '',
    cwd: schedule.cwd,
    profileId: schedule.profileId ?? '',
    groupId: schedule.groupId ?? '',
    model: schedule.model ?? '',
    effort: schedule.effort ?? 'off',
    permissionMode: schedule.permissionMode,
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    catchUp: schedule.catchUp === true,
  }
}

export function SchedulesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const active = useAppStore((s) => s.active)
  const runtimes = useAppStore((s) => s.runtimes)
  const toast = useUiStore((s) => s.toast)
  const nonce = useUiStore((s) => s.scheduleComposeNonce)
  const host = hosts.find((h) => h.id === (active?.hostId ?? activeHostId)) ?? hosts[0] ?? null
  const schedules = useScheduleStore((s) => (host ? s.byHost[host.id] ?? EMPTY_SCHEDULES : EMPTY_SCHEDULES))
  const loading = useScheduleStore((s) => (host ? s.loading[host.id] ?? false : false))
  const error = useScheduleStore((s) => (host ? s.error[host.id] : undefined))
  const refresh = useScheduleStore((s) => s.refresh)
  const createSchedule = useScheduleStore((s) => s.create)
  const updateSchedule = useScheduleStore((s) => s.update)
  const removeSchedule = useScheduleStore((s) => s.remove)
  const runNow = useScheduleStore((s) => s.runNow)

  const profiles = host ? runtimes[host.id]?.profiles ?? [] : []
  const sessions = host ? runtimes[host.id]?.sessions ?? [] : []
  const topSessions = useMemo(() => sessions.filter((s) => !s.parentId), [sessions])

  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null)
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(null), 5000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  useEffect(() => {
    if (host) void refresh(host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id])

  const openCreate = () => {
    const summary = active?.summary
    const firstProfile = profiles.find((p) => p.id === summary?.profileId) ?? profiles[0]
    const choice = defaultChoiceFor(firstProfile)
    setEditing({
      draft: draftFrom(null, {
        cwd: summary?.cwd ?? topSessions[0]?.cwd ?? '',
        profileId: firstProfile?.id ?? '',
        groupId: choice?.groupId ?? '',
        model: choice?.model ?? '',
        effort: summary?.effort ?? 'off',
      }),
    })
  }

  useEffect(() => {
    if (nonce > consumedComposeNonce) {
      consumedComposeNonce = nonce
      openCreate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  const changeDraft = (patch: Partial<Draft>) =>
    setEditing((prev) => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev))

  const selectedProfile = profiles.find((p) => p.id === editing?.draft.profileId)
  const modelGroups = selectedProfile ? profileModelGroups(selectedProfile) : []
  const activeGroup =
    modelGroups.find((g) => (g.groupId ?? '') === (editing?.draft.groupId ?? '')) ?? modelGroups[0]
  const modelOptions = activeGroup?.models ?? []

  const save = async () => {
    if (!host || !editing || saving) return
    const d = editing.draft
    if (!d.name.trim()) return toast('请填写任务名称', 'error')
    if (!d.prompt.trim()) return toast('请填写提示词', 'error')
    if (!d.cwd.trim()) return toast('请填写工作目录', 'error')
    if (!/^\s*\S+(\s+\S+){4,5}\s*$/.test(d.cron)) return toast('cron 需要 5 段（或 6 段测试模式）', 'error')
    if (d.targetKind === 'new' && !d.profileId) return toast('新建会话需要选择账号', 'error')
    if (d.targetKind === 'session' && !d.sessionId) return toast('请选择要追加的会话', 'error')
    const input: ScheduleInput = {
      name: d.name.trim(),
      cron: d.cron.trim(),
      enabled: d.enabled,
      target:
        d.targetKind === 'new'
          ? { kind: 'new' }
          : { kind: 'session', sessionId: d.sessionId },
      cwd: d.cwd.trim(),
      ...(d.targetKind === 'new' ? { profileId: d.profileId } : {}),
      ...(d.groupId ? { groupId: d.groupId } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.effort && d.effort !== 'off' ? { effort: d.effort } : {}),
      permissionMode: d.permissionMode,
      prompt: d.prompt.trim(),
      ...(d.catchUp ? { catchUp: true } : {}),
    }
    setSaving(true)
    try {
      if (editing.id) {
        await updateSchedule(host, editing.id, input)
        toast('定时任务已更新', 'success')
      } else {
        await createSchedule(host, input)
        toast('定时任务已创建', 'success')
      }
      setEditing(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存定时任务失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (schedule: Schedule, enabled: boolean) => {
    if (!host) return
    try {
      await updateSchedule(host, schedule.id, toInput(schedule, { enabled }))
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', 'error')
    }
  }

  const run = async (schedule: Schedule) => {
    if (!host || runningId) return
    setRunningId(schedule.id)
    try {
      const result = await runNow(host, schedule.id)
      if (result.ok) {
        toast(
          result.sessionId ? `已运行，结果在会话中查看` : '已运行',
          'success',
          result.sessionId
            ? {
                onClick: () => openSession(host.id, result.sessionId!),
                actionLabel: '查看会话',
              }
            : undefined,
        )
      } else {
        toast(result.error ?? '运行失败', 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '运行失败', 'error')
    } finally {
      setRunningId(null)
    }
  }

  const remove = async (schedule: Schedule) => {
    if (!host) return
    if (confirmDelete !== schedule.id) {
      setConfirmDelete(schedule.id)
      return
    }
    try {
      await removeSchedule(host, schedule.id)
      setConfirmDelete(null)
      toast('定时任务已删除', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const openSession = (hostId: string, sessionId: string) => {
    useUiStore.getState().closeSettings()
    navigate({ kind: 'session', hostId, sessionId })
  }

  return (
    <section data-setting-id="schedules.list" className="space-y-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[15px] font-medium text-text">
            <CalendarClock size={15} className="text-muted" />
            定时任务
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            在 Host 上按 cron 自动新建会话或向已有会话追加提示词。全部在本机运行，不依赖公网。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[12px] text-muted">{host?.name ?? '未连接 Host'}</span>
          <IconButton
            size="sm"
            label="刷新"
            tooltip="刷新"
            onClick={() => host && void refresh(host)}
            className="max-sm:size-11"
          >
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          </IconButton>
          <Button
            data-setting-id="schedules.new"
            variant="primary"
            size="sm"
            onClick={openCreate}
            disabled={!host}
            icon={<Plus size={13} />}
            className="max-sm:h-11"
          >
            新建任务
          </Button>
        </div>
      </header>

      {error && <p className="rounded-lg border border-danger/30 px-3 py-2 text-[12.5px] text-danger">{error}</p>}

      {!host ? (
        <p className="py-8 text-center text-[13px] text-muted">还没有连接 Host。</p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-12 text-center">
          <CalendarClock size={22} className="text-muted" />
          <p className="max-w-[420px] text-[12.5px] leading-5 text-muted">
            还没有定时任务。可以设置「每个工作日 09:00 汇总昨天的合并记录」这类例行工作。
          </p>
          <Button size="sm" variant="secondary" onClick={openCreate} icon={<Plus size={13} />}>
            新建第一个任务
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {schedules.map((schedule) => {
            const last = schedule.lastRun
            return (
              <div
                key={schedule.id}
                className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0 sm:flex-row sm:items-center"
              >
                <Switch
                  checked={schedule.enabled}
                  onChange={(enabled) => void toggle(schedule, enabled)}
                  label={`启用 ${schedule.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-text">{schedule.name}</span>
                    {!schedule.enabled && (
                      <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-muted">已暂停</span>
                    )}
                    <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px font-mono text-[12px] text-muted">
                      {schedule.cron}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
                    <span>{describeCron(schedule.cron)}</span>
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      下次 {formatNextRun(schedule.nextRunAt)}
                    </span>
                    <span className="truncate">
                      {schedule.target.kind === 'new' ? '新建会话' : '追加到已有会话'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px]">
                    <History size={10} className="shrink-0 text-muted" />
                    {last ? (
                      <span className={cn('truncate', last.ok ? 'text-muted' : 'text-danger')} title={last.error}>
                        {formatRunAt(last.at)} · {last.ok ? '成功' : `失败：${last.error ?? '未知错误'}`}
                        {last.sessionId && (
                          <button
                            type="button"
                            onClick={() => openSession(host.id, last.sessionId!)}
                            className="ml-1 text-text-soft underline-offset-2 hover:underline"
                          >
                            查看会话
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted">尚未运行</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={runningId === schedule.id}
                    onClick={() => void run(schedule)}
                    icon={runningId === schedule.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    className="max-sm:h-11"
                  >
                    立即运行
                  </Button>
                  <IconButton
                    size="sm"
                    label="编辑"
                    tooltip="编辑"
                    className="max-sm:size-11"
                    onClick={() =>
                      setEditing({
                        id: schedule.id,
                        draft: draftFrom(schedule, {}),
                      })
                    }
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => void remove(schedule)}
                    icon={<Trash2 size={12} />}
                    className={cn('min-w-[64px] max-sm:h-11', confirmDelete === schedule.id && 'text-danger')}
                  >
                    {confirmDelete === schedule.id ? '确认删除' : '删除'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={!!editing}
        onClose={() => (saving ? undefined : setEditing(null))}
        ariaLabel={editing?.id ? '编辑定时任务' : '新建定时任务'}
        title={editing?.id ? '编辑定时任务' : '新建定时任务'}
        className="w-[min(94vw,640px)] max-w-none"
        bodyClassName="max-h-[calc(85vh-56px)] overflow-y-auto p-4 sm:p-5"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditing(null)}
              disabled={saving}
              className="max-sm:h-11"
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={saving}
              className="max-sm:h-11"
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-3.5">
            <Field label="名称">
              <Input
                value={editing.draft.name}
                onChange={(e) => changeDraft({ name: e.target.value })}
                placeholder="例如：每日 PR 汇总"
                autoFocus
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="运行时间">
                <Select
                  value={editing.draft.preset}
                  onChange={(e) => {
                    const preset = CRON_PRESETS.find((p) => p.id === e.target.value)
                    changeDraft({
                      preset: e.target.value,
                      ...(preset?.cron ? { cron: preset.cron } : {}),
                    })
                  }}
                >
                  {CRON_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="cron 表达式" hint={describeCron(editing.draft.cron)}>
                <Input
                  value={editing.draft.cron}
                  onChange={(e) => changeDraft({ cron: e.target.value, preset: presetFor(e.target.value) })}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                />
              </Field>
            </div>

            <Field label="目标" as="div">
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant={editing.draft.targetKind === 'new' ? 'secondary' : 'ghost'}
                  onClick={() => changeDraft({ targetKind: 'new' })}
                >
                  新建会话
                </Button>
                <Button
                  size="sm"
                  variant={editing.draft.targetKind === 'session' ? 'secondary' : 'ghost'}
                  onClick={() => changeDraft({ targetKind: 'session' })}
                >
                  追加到已有会话
                </Button>
              </div>
            </Field>

            {editing.draft.targetKind === 'session' && (
              <Field label="目标会话">
                <Select
                  value={editing.draft.sessionId}
                  onChange={(e) => changeDraft({ sessionId: e.target.value })}
                >
                  <option value="">选择会话…</option>
                  {topSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title || '未命名会话'} · {session.cwd}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {editing.draft.targetKind === 'new' && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="账号">
                  <Select
                    value={editing.draft.profileId}
                    onChange={(e) => {
                      const profile = profiles.find((p) => p.id === e.target.value)
                      const choice = defaultChoiceFor(profile)
                      changeDraft({
                        profileId: e.target.value,
                        groupId: choice?.groupId ?? '',
                        model: choice?.model ?? '',
                      })
                    }}
                  >
                    <option value="">选择账号…</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {modelGroups.length > 1 && (
                  <Field label="分组">
                    <Select
                      value={activeGroup?.groupId ?? ''}
                      onChange={(e) => {
                        const group = modelGroups.find((g) => (g.groupId ?? '') === e.target.value)
                        changeDraft({
                          groupId: e.target.value,
                          model: group?.models[0] ?? '',
                        })
                      }}
                    >
                      {modelGroups.map((group) => (
                        <option key={group.groupId ?? 'default'} value={group.groupId ?? ''}>
                          {group.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label="模型">
                  <Select
                    value={editing.draft.model}
                    onChange={(e) => changeDraft({ model: e.target.value })}
                  >
                    {modelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="工作目录" className="sm:col-span-2">
                <Input
                  value={editing.draft.cwd}
                  onChange={(e) => changeDraft({ cwd: e.target.value })}
                  placeholder="/home/you/project"
                  className="font-mono text-[12px]"
                />
              </Field>
              <div data-setting-id="schedules.effort">
              <Field label="思考强度">
                <Select
                  value={editing.draft.effort}
                  onChange={(e) => changeDraft({ effort: e.target.value as ReasoningEffort })}
                >
                  {(Object.keys(EFFORT_LABEL) as ReasoningEffort[]).map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_LABEL[effort]}
                    </option>
                  ))}
                </Select>
              </Field>
              </div>
            </div>

            <div data-setting-id="schedules.permission">
            <Field
              label="权限模式"
              hint={editing.draft.permissionMode === 'bypassPermissions' ? '无人值守时会直接执行，请确认任务可信。' : undefined}
            >
              <Select
                value={editing.draft.permissionMode}
                onChange={(e) => changeDraft({ permissionMode: e.target.value as PermissionMode })}
              >
                {(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_LABEL[mode]}
                  </option>
                ))}
              </Select>
            </Field>
            </div>

            <Field label="提示词">
              <textarea
                value={editing.draft.prompt}
                onChange={(e) => changeDraft({ prompt: e.target.value })}
                placeholder="例如：查看昨天合并的 PR，按仓库汇总成一段简报。"
                rows={5}
                className="w-full min-w-0 resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] leading-5 text-text outline-none transition-[border-color] duration-[120ms] placeholder:text-muted focus:border-border-strong"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-[12.5px] text-text-soft">
                <Switch
                  checked={editing.draft.enabled}
                  onChange={(enabled) => changeDraft({ enabled })}
                  label="启用任务"
                />
                启用
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-text-soft">
                <Switch
                  checked={editing.draft.catchUp}
                  onChange={(catchUp) => changeDraft({ catchUp })}
                  label="错过补跑"
                />
                Host 关闭期间错过时，启动后补跑一次
              </label>
            </div>
          </div>
        )}
      </Modal>
    </section>
  )
}

function Field({
  label,
  hint,
  className,
  as: Tag = 'label',
  children,
}: {
  label: string
  hint?: string
  className?: string
  as?: 'label' | 'div'
  children: ReactNode
}) {
  return (
    <Tag className={cn('block min-w-0 space-y-1', className)}>
      <span className="block text-[12px] text-text-tertiary">{label}</span>
      {children}
      {hint && <span className="block text-[12px] leading-4 text-muted">{hint}</span>}
    </Tag>
  )
}

function toInput(schedule: Schedule, patch: Partial<ScheduleInput>): ScheduleInput {
  return {
    name: schedule.name,
    cron: schedule.cron,
    enabled: schedule.enabled,
    target: schedule.target,
    cwd: schedule.cwd,
    ...(schedule.profileId ? { profileId: schedule.profileId } : {}),
    ...(schedule.groupId ? { groupId: schedule.groupId } : {}),
    ...(schedule.model ? { model: schedule.model } : {}),
    ...(schedule.effort ? { effort: schedule.effort } : {}),
    permissionMode: schedule.permissionMode,
    prompt: schedule.prompt,
    ...(schedule.catchUp ? { catchUp: true } : {}),
    ...patch,
  }
}
