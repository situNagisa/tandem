import { useEffect, useMemo, useState } from 'react'
import {
  Columns2,
  Download,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type {
  EvalCase,
  EvalConfig,
  EvalResult,
  PromptTemplate,
  PromptTemplateKey,
  Profile,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store/useAppStore'
import { useEvalStore } from '../../store/useEvalStore'
import { useUiStore } from '../../store/useUiStore'
import { Button, IconButton } from '../ui/Button'
import { Input, Select, Switch } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { EvalConfigCard } from '../evals/EvalConfigCard'
import { EvalCompareDialog } from '../evals/EvalCompareDialog'
import { EvalPromptOverridesDialog } from '../evals/EvalPromptOverridesDialog'
import { EvalTraceDialog } from '../evals/EvalTraceDialog'
import {
  cellPassed,
  downloadText,
  findResult,
  formatCost,
  formatDuration,
  resultLabel,
  runCases,
  runToMarkdown,
} from '../evals/evalDisplay'

function configFromProfile(profile: Profile, index: number): EvalConfig {
  const group = profile.groups?.[0]
  return {
    id: `cfg-${Date.now().toString(36)}-${index}`,
    name: `配置 ${index + 1}`,
    profileId: profile.id,
    ...(group ? { groupId: group.id } : {}),
    model: group?.defaultModel || profile.defaultModel || group?.models[0] || profile.models[0] || '',
  }
}

function formatRunTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts)
}

function StatusPill({ result }: { result?: EvalResult | Omit<EvalResult, 'messages'> }) {
  const passed = cellPassed(result)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px]',
        passed === true
          ? 'bg-success-soft text-success'
          : passed === false
            ? 'bg-danger-soft text-danger'
            : 'bg-[var(--t-bg-hover)] text-muted',
      )}
    >
      {(result?.status === 'running' || result?.status === 'queued') && (
        <Loader2 size={10} className="animate-spin" />
      )}
      {resultLabel(result)}
    </span>
  )
}

export function EvalsSection() {
  const hosts = useAppStore((state) => state.hosts)
  const activeHostId = useAppStore((state) => state.activeHostId)
  const host = hosts.find((item) => item.id === activeHostId) ?? hosts[0] ?? null
  const runtime = useAppStore((state) => (host ? state.runtimes[host.id] : undefined))
  const refreshProfiles = useAppStore((state) => state.refreshProfiles)
  const hostState = useEvalStore((state) => (host ? state.byHost[host.id] : undefined))
  const selectedRunId = useEvalStore((state) => (host ? state.selectedRun[host.id] : undefined))
  const detail = useEvalStore((state) =>
    host && selectedRunId ? state.details[host.id]?.[selectedRunId] : undefined,
  )
  const refresh = useEvalStore((state) => state.refresh)
  const refreshRuns = useEvalStore((state) => state.refreshRuns)
  const startRun = useEvalStore((state) => state.startRun)
  const cancelRun = useEvalStore((state) => state.cancelRun)
  const loadRun = useEvalStore((state) => state.loadRun)
  const selectRun = useEvalStore((state) => state.selectRun)
  const deleteCase = useEvalStore((state) => state.deleteCase)
  const openSettings = useUiStore((state) => state.openSettings)
  const toast = useUiStore((state) => state.toast)

  const profiles = runtime?.profiles ?? []
  const suites = hostState?.suites ?? []
  const allCases = hostState?.cases ?? []
  const runs = hostState?.runs ?? []
  const running = runs.some((run) => run.status === 'running')
  const summary = runs.find((run) => run.id === selectedRunId)
  const run = detail && (!selectedRunId || detail.id === selectedRunId) ? detail : undefined

  const [suite, setSuite] = useState('')
  const [configs, setConfigs] = useState<EvalConfig[]>([])
  const [concurrency, setConcurrency] = useState(2)
  const [reviewer, setReviewer] = useState<{
    enabled: boolean
    profileId: string
    groupId?: string
    model: string
  }>({ enabled: false, profileId: '', model: '' })
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [promptTarget, setPromptTarget] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [trace, setTrace] = useState<{ caseName: string; configId: string } | null>(null)
  const [compareCase, setCompareCase] = useState<string | null>(null)
  const [caseToDelete, setCaseToDelete] = useState<EvalCase | null>(null)
  const [deleting, setDeleting] = useState(false)

  const cases = useMemo(
    () => allCases.filter((item) => item.suite === (suite || item.suite)),
    [allCases, suite],
  )

  useEffect(() => {
    if (!host) return
    void refresh(host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id])

  useEffect(() => {
    if (!host) return
    if (!runtime?.profilesLoaded && !runtime?.profilesLoading) {
      void refreshProfiles(host.id)
    }
  }, [host?.id, runtime?.profilesLoaded, runtime?.profilesLoading, refreshProfiles])

  useEffect(() => {
    if (!host) return
    let cancelled = false
    api
      .promptTemplates(host)
      .then((result) => {
        if (!cancelled) setTemplates(result.templates)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [host?.id])

  useEffect(() => {
    setConfigs([])
    setReviewer({ enabled: false, profileId: '', model: '' })
  }, [host?.id])

  useEffect(() => {
    if (configs.length > 0 || profiles.length === 0) return
    setConfigs([configFromProfile(profiles[0]!, 0)])
  }, [profiles, configs.length])

  useEffect(() => {
    if (suites.length === 0) {
      if (!suite) setSuite('default')
      return
    }
    if (!suite || !suites.includes(suite)) setSuite(suites[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suites.join('\n')])

  useEffect(() => {
    if (!host || selectedRunId || runs.length === 0) return
    selectRun(host.id, runs[0]!.id)
  }, [host?.id, selectedRunId, runs.length, selectRun])

  useEffect(() => {
    if (!host || !selectedRunId) return
    if (!run || run.status === 'running') {
      void loadRun(host, selectedRunId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, selectedRunId, run?.status])

  useEffect(() => {
    if (!host || !running) return
    const timer = window.setInterval(() => {
      void refreshRuns(host)
      const id = useEvalStore.getState().selectedRun[host.id]
      if (id) void loadRun(host, id)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [host?.id, running, refreshRuns, loadRun])

  const runnable =
    !!host &&
    cases.length > 0 &&
    configs.length > 0 &&
    configs.every((config) => config.profileId && config.model) &&
    (!reviewer.enabled || (reviewer.profileId && reviewer.model))

  const runCasesForTable = run ? runCases(run) : []
  const selectedCase = trace ? allCases.find((item) => item.name === trace.caseName) : undefined
  const compareCaseData = compareCase ? allCases.find((item) => item.name === compareCase) : undefined
  const promptConfig = configs.find((item) => item.id === promptTarget)

  const updateConfig = (id: string, next: EvalConfig) => {
    setConfigs((list) => list.map((item) => (item.id === id ? next : item)))
  }

  const addConfig = () => {
    const last = configs[configs.length - 1]
    if (last) {
      setConfigs((list) => [
        ...list,
        { ...structuredClone(last), id: `cfg-${Date.now().toString(36)}-${list.length}`, name: `配置 ${list.length + 1}` },
      ])
    } else if (profiles[0]) {
      setConfigs([configFromProfile(profiles[0], 0)])
    }
  }

  const toggleReviewer = (enabled: boolean) => {
    if (!enabled) {
      setReviewer({ enabled: false, profileId: '', model: '' })
      return
    }
    const profile = profiles.find((item) => item.id === reviewer.profileId) ?? profiles[0]
    const group = profile?.groups?.[0]
    setReviewer({
      enabled: true,
      profileId: profile?.id ?? '',
      ...(group ? { groupId: group.id } : {}),
      model: group?.defaultModel || profile?.defaultModel || group?.models[0] || profile?.models[0] || '',
    })
  }

  const changeReviewerProfile = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId)
    const group = profile?.groups?.[0]
    setReviewer((current) => ({
      ...current,
      profileId,
      groupId: group?.id,
      model: group?.defaultModel || profile?.defaultModel || group?.models[0] || profile?.models[0] || '',
    }))
  }

  const reviewerProfile = profiles.find((item) => item.id === reviewer.profileId)
  const reviewerGroup = reviewerProfile?.groups?.find((item) => item.id === reviewer.groupId)
  const reviewerModels = reviewerGroup?.models.length
    ? reviewerGroup.models
    : reviewerProfile?.models ?? []

  const doStart = async () => {
    if (!host || !runnable || starting) return
    setStarting(true)
    try {
      await startRun(host, {
        suite: suite || 'default',
        configs,
        concurrency,
        ...(reviewer.enabled
          ? {
              reviewer: {
                profileId: reviewer.profileId,
                ...(reviewer.groupId ? { groupId: reviewer.groupId } : {}),
                model: reviewer.model,
              },
            }
          : {}),
      })
      setConfirmOpen(false)
      toast('评测已开始，进度可在右上角评测入口查看', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '启动评测失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  if (!host) {
    return (
      <p className="rounded-lg border border-border px-3 py-4 text-[13px] leading-6 text-muted">
        还没有连接主机。先在设置 → 主机中添加一台主机，再使用评测。
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[15px] font-medium">
            <FlaskConical size={15} className="text-muted" />
            评测与轨迹回放
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-muted">
            把真实会话存成回归用例，换模型或改提示词前后对比效果。全部在本机运行。
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          onClick={() => void refresh(host)}
          disabled={hostState?.loading}
        >
          刷新
        </Button>
      </div>

      {hostState?.error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12.5px] leading-5 text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {hostState.error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <section data-setting-id="evals.cases" className="min-w-0 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[13px] font-medium">用例</h3>
            <span className="ml-auto text-[12px] text-muted">{cases.length}</span>
          </div>
          <Select
            value={suite}
            onChange={(event) => setSuite(event.target.value)}
            aria-label="用例集"
            size="sm"
          >
            {(suites.length ? suites : ['default']).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <div className="mt-2 max-h-[300px] space-y-1 overflow-y-auto">
            {cases.length === 0 ? (
              <p className="px-1 py-3 text-[12px] leading-5 text-muted">
                还没有用例。在会话列表的 ⋯ 菜单里选「存为评测用例」。
              </p>
            ) : (
              cases.map((item) => (
                <div
                  key={`${item.suite}/${item.name}`}
                  className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--t-bg-hover)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] leading-5 text-text" data-tip={item.title}>
                      {item.title}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted">
                      <span>{item.snapshot.mode === 'git' ? 'git 快照' : '目录快照'}</span>
                      {item.checkCommand && <span className="truncate font-mono">{item.checkCommand}</span>}
                    </div>
                  </div>
                  <IconButton
                    size="sm"
                    label="删除用例"
                    onClick={() => setCaseToDelete(item)}
                    className="size-6! opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              ))
            )}
          </div>
        </section>

        <section data-setting-id="evals.config" className="min-w-0 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[13px] font-medium">配置</h3>
            <span className="text-[12px] text-muted">每个配置独立运行全部用例</span>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={addConfig}
              className="ml-auto h-7 px-1.5 text-[12px]"
            >
              添加
            </Button>
          </div>
          {profiles.length === 0 ? (
            <div className="rounded-lg border border-border px-3 py-3 text-[12.5px] leading-5 text-muted">
              还没有账号。
              <Button size="sm" variant="ghost" className="ml-1 h-7 px-1.5" onClick={() => openSettings('profiles')}>
                去添加账号
              </Button>
            </div>
          ) : (
            <div className="grid gap-2 xl:grid-cols-2">
              {configs.map((config) => (
                <EvalConfigCard
                  key={config.id}
                  config={config}
                  profiles={profiles}
                  canRemove={configs.length > 1}
                  onChange={(next) => updateConfig(config.id, next)}
                  onRemove={() => setConfigs((list) => list.filter((item) => item.id !== config.id))}
                  onEditPrompts={() => setPromptTarget(config.id)}
                />
              ))}
            </div>
          )}

          <div data-setting-id="evals.reviewer" className="mt-3 rounded-lg border border-border bg-bg/40 p-2.5">
            <div className="flex items-center gap-2">
              <Switch checked={reviewer.enabled} onChange={toggleReviewer} label="评审模型" />
              <span className="text-[12.5px] text-text-soft">评审模型</span>
              <span className="text-[12px] text-muted">按用例的「通过标准」给结论</span>
            </div>
            {reviewer.enabled && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                  评审账号
                  <Select
                    value={reviewer.profileId}
                    onChange={(event) => changeReviewerProfile(event.target.value)}
                    aria-label="评审账号"
                    size="sm"
                  >
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                  评审模型
                  <Select
                    value={reviewer.model}
                    onChange={(event) => setReviewer((current) => ({ ...current, model: event.target.value }))}
                    aria-label="评审模型"
                    size="sm"
                  >
                    {(reviewerModels.includes(reviewer.model)
                      ? reviewerModels
                      : [reviewer.model, ...reviewerModels]
                    ).map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label data-setting-id="evals.concurrency" className="flex w-[120px] flex-col gap-1 text-[12px] text-muted">
              并发数
              <Input
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(event) =>
                  setConcurrency(Math.max(1, Math.min(8, Math.floor(Number(event.target.value) || 1))))
                }
                size="sm"
                aria-label="并发数"
              />
            </label>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[12px] text-muted">
                {cases.length} 个用例 × {configs.length} 个配置 = {cases.length * configs.length} 次
              </span>
              <Button
                variant="primary"
                size="sm"
                icon={<FlaskConical size={13} />}
                disabled={!runnable}
                onClick={() => setConfirmOpen(true)}
              >
                运行评测
              </Button>
            </div>
          </div>
        </section>
      </div>

      <section data-setting-id="evals.results" className="min-w-0 rounded-xl border border-border">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h3 className="text-[13px] font-medium">结果</h3>
          <MenuSelect
            value={selectedRunId ?? ''}
            onChange={(next) => selectRun(host.id, next)}
            options={runs.map((item) => ({
              value: item.id,
              label: `${item.suite} · ${formatRunTime(item.startedAt)} · ${item.finished}/${item.total}${
                item.status === 'running' ? ' 运行中' : item.status === 'cancelled' ? ' 已取消' : ''
              }`,
            }))}
            size="sm"
            placeholder="选择运行"
            wrapperClassName="w-[min(420px,70vw)]"
            aria-label="选择评测运行"
          />
          {summary && (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[12px]',
                summary.status === 'running'
                  ? 'bg-[var(--t-bg-hover)] text-muted'
                  : summary.status === 'cancelled'
                    ? 'bg-warning-soft text-warning'
                    : 'bg-success-soft text-success',
              )}
            >
              {summary.status === 'running' ? '运行中' : summary.status === 'cancelled' ? '已取消' : '已完成'}
            </span>
          )}
          {summary && (
            <span className="text-[12px] text-muted">
              {summary.finished}/{summary.total}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {summary?.status === 'running' && (
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Square size={11} />}
                onClick={() => void cancelRun(host, summary.id)}
                className="h-7"
              >
                取消
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Download size={12} />}
              disabled={!run}
              onClick={() => {
                if (!run) return
                const stamp = new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
                downloadText(`tandem-eval-${run.suite}-${stamp}.md`, runToMarkdown(run))
                toast('已导出评测结果 Markdown', 'success')
              }}
              className="h-7"
            >
              导出 Markdown
            </Button>
          </div>
        </div>

        {!summary ? (
          <p className="px-3 py-10 text-center text-[12.5px] text-muted">
            还没有评测运行。选好用例与配置后点「运行评测」。
          </p>
        ) : !run ? (
          <div className="flex items-center justify-center gap-2 px-3 py-12 text-[12.5px] text-muted">
            <Loader2 size={14} className="animate-spin" /> 加载评测结果…
          </div>
        ) : (
          <>
            {run.status === 'running' && (
              <div className="border-b border-border px-3 py-2">
                <div className="mb-1 flex items-center justify-between text-[12px] text-muted">
                  <span>运行中，已完成 {run.finished}/{run.total}</span>
                  <span>{Math.round((run.finished / Math.max(1, run.total)) * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--t-bg-hover)]">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${(run.finished / Math.max(1, run.total)) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[12px] text-muted">
                    <th className="min-w-[180px] px-3 py-2 font-medium">用例</th>
                    {run.configs.map((config) => (
                      <th key={config.id} className="min-w-[150px] px-2 py-2 font-medium">
                        <div className="truncate">{config.name}</div>
                        <div className="truncate text-[12px] font-normal text-muted">{config.model}</div>
                      </th>
                    ))}
                    <th className="w-16 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {runCasesForTable.map((testCase) => (
                    <tr key={testCase.name} className="border-b border-border last:border-0">
                      <td className="max-w-[280px] px-3 py-2 align-top">
                        <div className="truncate text-text" data-tip={testCase.title}>
                          {testCase.title}
                        </div>
                        <div className="text-[12px] text-muted">{testCase.name}</div>
                      </td>
                      {run.configs.map((config) => {
                        const result = findResult(run, testCase.name, config.id)
                        return (
                          <td key={config.id} className="px-2 py-2 align-top">
                            <button
                              type="button"
                              onClick={() => setTrace({ caseName: testCase.name, configId: config.id })}
                              className="flex w-full flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
                            >
                              <StatusPill result={result} />
                              <span className="text-[12px] tabular-nums text-muted">
                                {formatCost(result?.costUsd)} · {formatDuration(result?.durationMs ?? 0)}
                              </span>
                            </button>
                          </td>
                        )
                      })}
                      <td className="px-2 py-2 align-top">
                        {run.configs.length >= 2 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Columns2 size={11} />}
                            onClick={() => setCompareCase(testCase.name)}
                            className="h-7 px-1.5 text-[12px]"
                          >
                            并排
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <EvalPromptOverridesDialog
        open={!!promptConfig}
        onClose={() => setPromptTarget(null)}
        templates={templates}
        value={promptConfig?.promptOverrides ?? {}}
        onChange={(next: Partial<Record<PromptTemplateKey, string>>) => {
          if (!promptConfig) return
          updateConfig(promptConfig.id, { ...promptConfig, promptOverrides: next })
        }}
      />

      <EvalTraceDialog
        open={!!trace}
        onClose={() => setTrace(null)}
        run={run}
        testCase={selectedCase}
        result={
          trace && run
            ? (findResult(run, trace.caseName, trace.configId) as EvalResult | undefined)
            : undefined
        }
      />

      <EvalCompareDialog
        open={!!compareCase}
        onClose={() => setCompareCase(null)}
        run={run}
        testCase={compareCaseData}
      />

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!starting) setConfirmOpen(false)
        }}
        title="运行评测"
        className="max-w-lg"
        footer={
          <>
            <Button size="lg" onClick={() => setConfirmOpen(false)} disabled={starting}>
              取消
            </Button>
            <Button size="lg" variant="primary" onClick={() => void doStart()} disabled={starting}>
              {starting && <Loader2 size={14} className="animate-spin" />}
              确认并运行
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-6 text-text-soft">
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/50 px-2.5 py-2 text-[12.5px] leading-5 text-warning">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">以 bypassPermissions 运行，模型可以执行任意命令</div>
              <div className="mt-0.5">
                只应运行你信任的用例。每次 用例×配置 都在独立临时 worktree / 临时目录中执行，
                结束后自动删除，不会改动原项目目录。
              </div>
            </div>
          </div>
          <div>
            <span className="text-muted">用例集：</span>
            {suite || 'default'} · {cases.length} 个用例
          </div>
          <div>
            <span className="text-muted">配置：</span>
            {configs.map((config) => config.name).join('、')}
          </div>
          <div>
            <span className="text-muted">运行次数：</span>
            {cases.length} × {configs.length} = {cases.length * configs.length}（并发 {concurrency}）
          </div>
          <div className="rounded-lg bg-[var(--t-bg-hover)] px-2.5 py-2 text-[12px] leading-5 text-muted">
            git 用例会在保存时的 commit 上检出临时 worktree；非 git 用例复制保存时的目录快照。
            运行结束后临时目录删除，结果和完整轨迹保存在 ~/.tandem/evals/runs。
          </div>
        </div>
      </Modal>

      <Modal
        open={!!caseToDelete}
        onClose={() => {
          if (!deleting) setCaseToDelete(null)
        }}
        title="删除评测用例"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setCaseToDelete(null)} disabled={deleting}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              disabled={deleting}
              onClick={async () => {
                if (!caseToDelete || !host) return
                setDeleting(true)
                try {
                  await deleteCase(host, caseToDelete.suite, caseToDelete.name)
                  toast('已删除评测用例', 'success')
                  setCaseToDelete(null)
                } catch (err) {
                  toast(err instanceof Error ? err.message : '删除失败', 'error')
                } finally {
                  setDeleting(false)
                }
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          确定删除「{caseToDelete?.title}」？用例文件和目录快照会一并删除，历史评测结果保留。
        </p>
      </Modal>
    </div>
  )
}
