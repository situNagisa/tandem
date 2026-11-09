import { useEffect, useState } from 'react'
import { FlaskConical, Play, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import type { DemoScenarioInfo } from '@tandem/protocol'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { useDemoStore } from '../../store/useDemoStore'
import { openDemoScenario } from '../../lib/demoOpen'
import { Button, IconButton } from '../ui/Button'
import { ConfirmAction } from '../ui/ConfirmAction'
import { Modal } from '../ui/Modal'
import { cn } from '../../lib/cn'
import { Card } from '../ui/Card'

const GROUP_LABELS: Record<DemoScenarioInfo['group'], string> = {
  conversation: '对话与自动化',
  review: '审阅与看板',
  workspace: '工作区',
  settings: '设置',
}

export function DemoDialog() {
  const open = useUiStore((s) => s.demoOpen)
  const setOpen = useUiStore((s) => s.setDemoOpen)
  const hostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((item) => item.id === hostId))
  const state = useDemoStore((s) => (hostId ? s.byHost[hostId] : undefined))
  const loading = useDemoStore((s) => (hostId ? s.loading[hostId] : false))
  const error = useDemoStore((s) => (hostId ? s.error[hostId] : undefined))
  const toast = useUiStore((s) => s.toast)
  const [clearOpen, setClearOpen] = useState(false)

  useEffect(() => {
    if (!open || !host) return
    void useDemoStore.getState().load(host)
  }, [open, host])

  const create = async () => {
    if (!host) return
    const next = await useDemoStore.getState().create(host)
    if (next) toast('演示工作区已创建；所有场景都标注为演示数据', 'success')
  }

  const clear = async () => {
    if (!host) return
    const ok = await useDemoStore.getState().clear(host)
    if (ok) {
      toast('演示数据已清除', 'success')
      setOpen(false)
    }
  }

  const replay = async (scenario: DemoScenarioInfo) => {
    if (!host) return
    const next = await useDemoStore.getState().replay(host, scenario.id)
    if (next) toast(`已重新播放：${scenario.title}`, 'success')
  }

  const openScenario = async (scenario: DemoScenarioInfo) => {
    if (!host) return
    setOpen(false)
    await openDemoScenario(scenario, host)
  }

  const hasTarget = (scenario: DemoScenarioInfo) =>
    scenario.kind === 'board'
      ? !!scenario.boardId
      : scenario.kind === 'settings' || scenario.kind === 'inbox' || scenario.kind === 'wiki' || scenario.kind === 'eval'
        ? true
        : !!scenario.sessionIds?.length

  const scenarios = state?.scenarios ?? []
  const groups = (['conversation', 'review', 'workspace'] as const).map((group) => ({
    group,
    items: scenarios.filter((scenario) => scenario.group === group),
  })).filter((entry) => entry.items.length > 0)

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="演示工作区"
      title={
        <span className="flex items-center gap-2">
          <FlaskConical size={16} className="text-[#F97316]" />
          演示工作区
          <span className="rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[11px] font-normal text-[#F97316]">
            演示数据
          </span>
        </span>
      }
      description="一键造场景：独立演示仓库 + 内置演示模型。演示模型按固定剧本流式输出，不发出任何网络请求，也不消耗真实账号额度。"
      className="w-[min(94vw,760px)]"
      bodyClassName="max-h-[min(72vh,680px)] overflow-y-auto"
    >
      {!host ? (
        <p className="text-[13px] text-muted">请先连接一个主机。</p>
      ) : !state?.active ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-[var(--t-bg-subtle)] p-4">
            <p className="text-[13px] font-medium text-text">还没有演示工作区</p>
            <p className="mt-1 text-[12.5px] leading-5 text-muted">
              会在 Host 上创建 <code className="rounded bg-surface px-1 py-0.5">~/.tandem/demo/</code>{' '}
              下的小 git 仓库、一个隐藏的演示模型，以及 17 个可直接打开的场景。清除后不会留下会话、记忆、用量、看板或索引。
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => void create()} disabled={loading}>
                {loading ? '正在创建…' : '创建演示工作区'}
              </Button>
              {error && <span className="text-[12px] text-danger">{error}</span>}
            </div>
          </div>
          <p className="text-[12px] text-muted">
            所有场景都会标明「演示数据」；其中的工具调用只作用于演示仓库。演示模型只在这 17 个场景里可用，不会出现在正常模型列表里。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-[var(--t-bg-subtle)] px-3 py-2 text-[12px] text-muted">
            <span className="font-medium text-text">演示数据</span>
            <span className="truncate font-mono" data-tip={state.root}>
              {state.root}
            </span>
            <span className="ml-auto whitespace-nowrap">
              网络请求 {state.networkRequests} 次 · 可随时清除
            </span>
            <Button size="sm" variant="danger-ghost" icon={<Trash2 size={12} />} onClick={() => setClearOpen(true)} disabled={loading}>
              清除全部演示数据
            </Button>
          </div>
          {error && <p className="text-[12px] text-danger">{error}</p>}
          {groups.map(({ group, items }) => (
            <section key={group}>
              <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-muted">
                {GROUP_LABELS[group]}
              </h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {items.map((scenario) => (
                  <Card key={scenario.id} className="flex min-h-[92px] flex-col p-2.5">
                    <div className="flex items-start gap-1.5">
                      <span className="min-w-0 flex-1 text-[13px] font-medium text-text">
                        {scenario.title}
                      </span>
                      <span className="shrink-0 rounded bg-[#F97316]/12 px-1.5 py-0.5 text-[10px] text-[#F97316]">
                        演示数据
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-[12px] leading-4 text-muted">{scenario.summary}</p>
                    <div className="mt-auto flex items-center gap-1 pt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Play size={12} />}
                        onClick={() => void openScenario(scenario)}
                        disabled={!hasTarget(scenario)}
                      >
                        打开
                      </Button>
                      <IconButton
                        label={`重新播放：${scenario.title}`}
                        tooltip="重新播放"
                        size="sm"
                        onClick={() => void replay(scenario)}
                        disabled={loading}
                      >
                        <RefreshCw size={12} />
                      </IconButton>
                      {!hasTarget(scenario) && (
                        <span className="text-[11px] text-muted">请先重新播放</span>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <ConfirmAction
        open={clearOpen}
        title="清除全部演示数据"
        description="会话、记忆、用量、看板、Wiki、评测与索引都不会留下；真实数据不受影响。"
        confirmLabel="清除演示数据"
        danger
        onConfirm={() => void clear()}
        onClose={() => setClearOpen(false)}
        testId="demo-clear-confirm"
      />
    </Modal>
  )
}
