import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Download, ListChecks, Play, RotateCcw } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import {
  buildChecklist,
  loadChecklistProgress,
  saveChecklistProgress,
  checklistMarkdown,
  setChecklistPoint,
  type ChecklistProgress,
  type ChecklistStatus,
} from '../../lib/checklist'
import { featureOfPoint } from '../../lib/checklist'
import { openChecklistAction, openDemoById } from '../../lib/demoOpen'
import { saveFeedbackFile } from '../../lib/feedback'
import { Button } from '../ui/Button'
import { ConfirmAction } from '../ui/ConfirmAction'
import { Modal } from '../ui/Modal'
import { cn } from '../../lib/cn'
import { Card } from '../ui/Card'

const STATUS_OPTIONS: Array<{ value: ChecklistStatus; label: string }> = [
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '有问题' },
  { value: 'skip', label: '跳过' },
]

export function ChecklistDialog() {
  const open = useUiStore((s) => s.checklistOpen)
  const setOpen = useUiStore((s) => s.setChecklistOpen)
  const toast = useUiStore((s) => s.toast)
  const hostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((item) => item.id === hostId))
  const [progress, setProgress] = useState<ChecklistProgress>(() => loadChecklistProgress())
  const [onlyUntested, setOnlyUntested] = useState(false)

  useEffect(() => {
    if (open) setProgress(loadChecklistProgress())
  }, [open])

  const groups = useMemo(() => buildChecklist(progress), [progress])
  const totals = useMemo(() => {
    const out = { total: 0, pass: 0, fail: 0, skip: 0, untested: 0 }
    for (const group of groups) {
      out.total += group.counts.total
      out.pass += group.counts.pass
      out.fail += group.counts.fail
      out.skip += group.counts.skip
      out.untested += group.counts.untested
    }
    return out
  }, [groups])

  const mark = (pointId: string, status: ChecklistStatus) => {
    const next = setChecklistPoint(progress, pointId, status)
    setProgress(next)
  }

  const problematic = (pointId: string) => {
    const point = groups.flatMap((group) => group.features.flatMap((feature) => feature.points)).find((item) => item.id === pointId)
    if (!point) return
    const feature = featureOfPoint(point)
    mark(pointId, 'fail')
    useFeedbackStore.getState().setPendingFeature(
      feature ? { featureId: feature.id, featureName: feature.title } : null,
    )
    useFeedbackStore.getState().enter()
    setOpen(false)
    toast(`已进入反馈模式，功能标签：${feature?.title ?? '未归类'}`, 'info')
  }

  const exportReport = async () => {
    const markdown = checklistMarkdown(progress)
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const name = `tandem-checklist-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`
    const result = await saveFeedbackFile(markdown, name)
    if (result === 'failed') toast('导出失败，请重试', 'error')
    else toast('体验清单报告已导出；导出反馈包时也会自动附带', 'success')
  }

  const [resetOpen, setResetOpen] = useState(false)
  const reset = () => {
    setProgress({})
    saveChecklistProgress({})
    setResetOpen(false)
    toast('体验清单进度已重置', 'success')
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="体验清单"
      title={
        <span className="flex items-center gap-2">
          <ListChecks size={16} className="text-[#F97316]" />
          体验清单
          <span className="rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[11px] font-normal text-[#F97316]">
            增量测试
          </span>
        </span>
      }
      description="按功能分组列出测试要点；未测项排在前面。点「有问题」会直接进入反馈模式并自动带上功能标签。"
      className="w-[min(96vw,900px)]"
      bodyClassName="max-h-[min(76vh,720px)] overflow-y-auto"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">
            通过 {totals.pass} · 有问题 {totals.fail} · 跳过 {totals.skip} · 未测 {totals.untested} / 共 {totals.total}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => setResetOpen(true)}>
            重置进度
          </Button>
          <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => void exportReport()}>
            导出测试报告
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-[var(--t-bg-subtle)] px-3 py-2">
          <Button
            size="sm"
            variant={onlyUntested ? 'primary' : 'secondary'}
            onClick={() => setOnlyUntested((value) => !value)}
            aria-pressed={onlyUntested}
          >
            {onlyUntested ? '只看未测' : '显示全部'}
          </Button>
          <span className="text-[12px] text-muted">
            新版本功能标「新」；报告会随反馈包一起发送，解包后得到「体验清单.md」。
          </span>
        </div>

        {groups.map((group) => {
          const features = group.features
            .map((feature) => ({
              ...feature,
              points: onlyUntested ? feature.points.filter((point) => !point.status) : feature.points,
            }))
            .filter((feature) => feature.points.length > 0)
          if (features.length === 0) return null
          return (
            <section key={group.id}>
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{group.title}</h3>
                <span className="text-[11px] text-muted">
                  未测 {group.counts.untested} / {group.counts.total}
                </span>
              </div>
              <div className="space-y-2">
                {features.map((feature) => (
                  <Card key={feature.feature.id}>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
                      <span className="text-[13px] font-medium text-text">{feature.feature.title}</span>
                      {feature.isNew && (
                        <span className="rounded bg-[#F97316]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[#F97316]">
                          新
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-muted">
                        通过 {feature.counts.pass} · 有问题 {feature.counts.fail} · 未测 {feature.counts.untested}
                      </span>
                    </div>
                    <div className="divide-y divide-border">
                      {feature.points.map((point) => (
                        <div key={point.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                          <span
                            className={cn(
                              'min-w-0 flex-1 text-[12.5px] leading-5',
                              point.status === 'pass' ? 'text-muted line-through' : 'text-text-soft',
                            )}
                          >
                            {point.text}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Play size={11} />}
                            onClick={() => {
                              setOpen(false)
                              if (point.demo) void openDemoById(point.demo)
                              else void openChecklistAction(point, host)
                            }}
                          >
                            在演示中打开
                          </Button>
                          {STATUS_OPTIONS.map((option) => (
                            <Button
                              key={option.value}
                              size="sm"
                              variant={
                                point.status === option.value
                                  ? option.value === 'fail'
                                    ? 'danger-ghost'
                                    : 'primary'
                                  : 'ghost'
                              }
                              onClick={() => {
                                if (option.value === 'fail') problematic(point.id)
                                else mark(point.id, option.value)
                              }}
                              aria-pressed={point.status === option.value}
                              icon={option.value === 'fail' ? <AlertCircle size={11} /> : undefined}
                            >
                              {option.label}
                            </Button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )
        })}
        {groups.every((group) => group.features.every((feature) => feature.points.length === 0)) && (
          <p className="py-8 text-center text-[12.5px] text-muted">全部测完了。可以关闭「只看未测」回顾结果。</p>
        )}
      </div>
      <ConfirmAction
        open={resetOpen}
        title="重置体验清单进度"
        description="只清除本地的测试状态，不影响演示数据与反馈条目。"
        confirmLabel="重置进度"
        onConfirm={reset}
        onClose={() => setResetOpen(false)}
        testId="checklist-reset-confirm"
      />
    </Modal>
  )
}
