import { useMemo, useState } from 'react'
import type { DivisionPlanRequest, DivisionPlanTaskEdit, DivisionTaskDraft } from '@tandem/protocol'
import { Bot, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { profileModelGroups } from '../../lib/profileModels'
import { formatCost } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { ROUTE_MODE_META } from '../../lib/routeLabels'

/** 分工前确认卡：列出子任务、模型与预计花费；可改模型、删除子任务或整单改成直接做。 */
export function DivisionPlanCard({
  request,
  hostId,
  sessionId,
}: {
  request: DivisionPlanRequest
  hostId: string | null
  sessionId: string | null
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const profiles = useAppStore((s) => (hostId ? s.runtimes[hostId]?.profiles ?? [] : []))
  const toast = useUiStore((s) => s.toast)
  const [tasks, setTasks] = useState<Array<DivisionTaskDraft & { deleted?: boolean }>>(request.tasks)
  const [busy, setBusy] = useState<'approve' | 'direct' | 'cheap' | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const modelOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const profile of profiles) {
      for (const group of profileModelGroups(profile)) {
        for (const model of group.models) {
          map.set(`${profile.id}\u0000${group.groupId ?? ''}\u0000${model}`, `${profile.name} › ${group.name} › ${model}`)
        }
      }
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [profiles])

  const optionsFor = (task: DivisionTaskDraft) => {
    const owner = profiles.find((profile) =>
      profileModelGroups(profile).some((group) => group.models.includes(task.model ?? '')),
    )
    const rows = owner
      ? modelOptions.filter((option) => option.value.startsWith(`${owner.id}\u0000`))
      : modelOptions
    if (task.model && !rows.some((row) => row.value.endsWith(`\u0000${task.model}`))) {
      return [...rows, { value: task.model, label: task.model }]
    }
    return rows
  }

  const submit = async (action: 'approve' | 'direct' | 'cheap') => {
    if (!host || !sessionId || busy || done) return
    setBusy(action)
    try {
      const edits: DivisionPlanTaskEdit[] = tasks.map((task) => ({
        id: task.id,
        ...(task.model ? { model: task.model } : {}),
        ...(task.deleted ? { deleted: true } : {}),
      }))
      await api.resolveDivisionPlan(host, sessionId, request.id, { action, tasks: edits })
      setDone(
        action === 'direct'
          ? `已改为${ROUTE_MODE_META.direct.label}`
          : action === 'cheap'
            ? `已改为${ROUTE_MODE_META.cheap.label}`
            : '已开始执行',
      )
      toast(action === 'approve' ? '多代理协作计划已确认' : '已按你的选择继续', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '提交分工计划失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const visible = tasks.filter((task) => !task.deleted)
  return (
    <div
      className="msg-row rounded-xl border border-border bg-surface p-3"
      data-division-plan={request.id}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--t-bg-active)] text-text-soft">
          <Bot size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-medium text-text">多代理协作计划待确认</span>
            <span className="text-[12px] text-muted">
              {visible.length} 个子任务 · 预计 {formatCost(request.estimatedCostUsd)}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] leading-4 text-muted">{request.reason}</p>
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {visible.map((task) => (
          <div key={task.id} className="rounded-lg border border-border/70 px-2 py-1.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text" title={task.description}>
                  {task.description}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-muted" title={task.prompt}>
                  {task.prompt}
                </div>
              </div>
              <IconButton
                size="sm"
                label="删除子任务"
                tooltip="删除这个子任务"
                disabled={!!done || !!busy}
                onClick={() =>
                  setTasks((prev) =>
                    prev.map((item) => (item.id === task.id ? { ...item, deleted: true } : item)),
                  )
                }
                className="text-muted hover:text-danger"
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="shrink-0 text-[12px] text-muted">
                {task.role === 'specialist' ? '专长执行' : '执行'}
                {task.domain && task.domain !== 'general' ? ` · ${task.domain}` : ''}
              </span>
              <Select
                size="sm"
                value={task.model ?? ''}
                disabled={!!done || !!busy}
                onChange={(event) =>
                  setTasks((prev) =>
                    prev.map((item) =>
                      item.id === task.id ? { ...item, model: event.target.value } : item,
                    ),
                  )
                }
                aria-label={`${task.description} 使用的模型`}
                className="min-w-0 flex-1"
              >
                {!task.model && <option value="">选择模型…</option>}
                {optionsFor(task).map((option) => (
                  <option key={option.value} value={option.value.split('\u0000').pop()}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <span className="shrink-0 font-mono text-[12px] text-muted">
                {task.model ?? '—'}
              </span>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="py-1 text-[12px] text-muted">所有子任务都已删除；可以改为{ROUTE_MODE_META.direct.label}。</p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        {done ? (
          <span className="text-[12px] text-text-soft">{done}</span>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!!busy || visible.length === 0}
              onClick={() => void submit('approve')}
            >
              {busy === 'approve' ? '开始中…' : '开始'}
            </Button>
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void submit('direct')}>
              改为{ROUTE_MODE_META.direct.label}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void submit('cheap')}>
              改为{ROUTE_MODE_META.cheap.label}
            </Button>
          </>
        )}
        <span className={cn('ml-auto text-[12px] text-muted')}>改模型后按计划执行；删除的子任务不会派发</span>
      </div>
    </div>
  )
}
