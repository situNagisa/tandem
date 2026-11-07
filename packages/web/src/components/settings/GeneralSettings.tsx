import { useEffect, useState } from 'react'
import { Bot, Gauge, RotateCcw, Server } from 'lucide-react'
import {
  DEFAULT_CONTEXT_SETTINGS,
  type AiReviewSettings,
  type ContextSettings,
  type HandoffSettings,
  type HostSettings,
  type ReasoningEffort,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { EFFORT_LABEL } from '../../lib/effort'
import { profileModelGroups } from '../../lib/profileModels'
import { Input, SegmentedControl, Select, Switch } from '../ui/Controls'

const OPTIONS = [
  {
    value: 'auto' as const,
    label: '自动继续',
    title: 'Host 重启后自动接着跑，不需要手动确认',
  },
  {
    value: 'pause' as const,
    label: '恢复为暂停',
    title: 'Host 重启后先在会话里显示「已暂停」，等你点继续运行',
  },
]

export function GeneralSettings() {
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtime = useAppStore((s) => (host ? s.runtimes[host.id] : undefined))
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const profiles = runtime?.profiles ?? []
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setError(null)
    if (!host) return
    api
      .settings(host)
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [host, activeHostId])

  useEffect(() => {
    if (!host) return
    if (!runtime?.profilesLoaded && !runtime?.profilesLoading) {
      void refreshProfiles(host.id)
    }
  }, [host?.id, runtime?.profilesLoaded, runtime?.profilesLoading, refreshProfiles])

  const aiReview = settings?.aiReview ?? {}
  const reviewProfile = profiles.find((item) => item.id === aiReview.profileId)
  const reviewGroups = profileModelGroups(reviewProfile)
  const reviewGroup = reviewGroups.find((item) => (item.groupId ?? '') === (aiReview.groupId ?? ''))
  const reviewModels = reviewGroup ? reviewGroup.models : reviewGroups.flatMap((item) => item.models)

  const handoff: HandoffSettings = settings?.handoff ?? { policy: 'ask' }
  const handoffProfile = profiles.find((item) => item.id === handoff.target?.profileId)
  const handoffGroups = profileModelGroups(handoffProfile)
  const handoffGroup = handoffGroups.find(
    (item) => (item.groupId ?? '') === (handoff.target?.groupId ?? ''),
  )
  const handoffModels = handoffGroup ? handoffGroup.models : handoffGroups.flatMap((item) => item.models)

  const persistSettings = (next: HostSettings) => {
    if (!host) return
    const previous = settings
    setSettings(next)
    setSaving(true)
    setError(null)
    api
      .updateSettings(host, next)
      .then((saved) => setSettings(saved))
      .catch((err: Error) => {
        setSettings(previous)
        setError(err.message || '保存失败')
      })
      .finally(() => setSaving(false))
  }

  const patchHandoff = (patch: Partial<HandoffSettings>) => {
    if (!settings) return
    const next: HandoffSettings = { ...handoff, ...patch }
    if (next.target && !next.target.profileId) delete next.target
    if (next.target) {
      for (const key of ['groupId', 'model'] as const) {
        if (!next.target[key]) delete next.target[key]
      }
    }
    persistSettings({ ...settings, handoff: next })
  }

  const patchAiReview = (patch: Partial<AiReviewSettings>) => {
    if (!settings) return
    const next: AiReviewSettings = { ...aiReview, ...patch }
    for (const key of ['profileId', 'groupId', 'model', 'effort'] as const) {
      if (!next[key]) delete next[key]
    }
    if (!next.blockOnBlocker) delete next.blockOnBlocker
    persistSettings({ ...settings, aiReview: next })
  }

  const update = async (value: HostSettings['resumeOnRestart']) => {
    if (!host || saving) return
    const previous = settings
    const nextSettings: HostSettings = {
      ...(previous ?? { resumeOnRestart: value }),
      resumeOnRestart: value,
    }
    setSettings(nextSettings)
    setSaving(true)
    setError(null)
    try {
      const next = await api.updateSettings(host, nextSettings)
      setSettings(next)
    } catch (err) {
      setSettings(previous ?? { resumeOnRestart: value })
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const context = settings?.context ?? DEFAULT_CONTEXT_SETTINGS

  const sanitizeContext = (input: ContextSettings): ContextSettings => ({
    ...input,
    autoCompactThreshold: Math.min(0.95, Math.max(0.5, input.autoCompactThreshold || 0.85)),
    autoCompactKeepTurns: Math.min(20, Math.max(1, Math.round(input.autoCompactKeepTurns || 4))),
    trimToolResultTokens: Math.min(
      200_000,
      Math.max(500, Math.round(input.trimToolResultTokens || 8000)),
    ),
    trimKeepTurns: Math.min(100, Math.max(1, Math.round(input.trimKeepTurns || 20))),
  })

  // 输入过程中只改本地状态，失焦/切换开关时再保存，避免每敲一个数字就请求
  const patchContext = (patch: Partial<ContextSettings>, persist = false) => {
    if (!settings) return
    const next = sanitizeContext({ ...context, ...patch })
    setSettings({ ...settings, context: next })
    if (persist && host && !saving) {
      const previous = settings
      setSaving(true)
      setError(null)
      api
        .updateSettings(host, { ...settings, context: next })
        .then((saved) => setSettings(saved))
        .catch((err: Error) => {
          setSettings(previous)
          setError(err.message || '保存失败')
        })
        .finally(() => setSaving(false))
    }
  }

  return (
    <div className="space-y-3">
      <section data-setting-id="general.resume-on-restart" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <RotateCcw size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">Host 重启后的会话恢复</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              Host 重启、进程崩溃或模型请求中途断网后，正在运行的任务会从断点接着跑。
              等待审批中的工具会重新回到待审批列表；正在执行的有副作用工具不会自动重放。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SegmentedControl
                options={OPTIONS}
                value={settings?.resumeOnRestart ?? 'auto'}
                onChange={(value) => void update(value)}
                disabled={!settings || saving}
                aria-label="Host 重启后的会话恢复方式"
              />
              {!settings && !error ? (
                <span className="text-[12px] text-muted">读取中…</span>
              ) : null}
            </div>
            {settings?.resumeOnRestart === 'auto' ? (
              <p className="mt-2 text-[12px] text-muted">
                自动继续：只读工具会重新执行，有副作用的工具会补一条错误结果请模型确认，然后继续。
              </p>
            ) : settings ? (
              <p className="mt-2 text-[12px] text-muted">
                恢复为暂停：会话顶部显示「重启后已暂停」，点「继续运行」后才续跑。
              </p>
            ) : null}
          </div>
        </div>
        {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
      </section>
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <Gauge size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">上下文自动管理</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              每次请求前估算输入占用：接近模型上下文上限时，先把较早的对话压成摘要，保留最近几轮原文，再发送请求；
              模型返回「上下文超长」错误时也会自动压缩后重试一次。旧的大工具输出只在发送时替换为占位，会话里的原文不会删除。
            </p>

            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px]">自动压缩</div>
                <div className="mt-0.5 text-[12px] text-muted">
                  默认在占用达到 85% 时触发，压缩前会把值得长期保留的事实写入项目记忆。
                </div>
              </div>
              <Switch
                checked={context.autoCompact}
                onChange={(checked) => patchContext({ autoCompact: checked }, true)}
                disabled={!settings || saving}
                label="自动压缩"
              />
            </div>

            {context.autoCompact ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
                <label htmlFor="context-threshold">触发阈值</label>
                <Input
                  id="context-threshold"
                  type="number"
                  size="sm"
                  min={50}
                  max={95}
                  step={1}
                  value={Math.round(context.autoCompactThreshold * 100)}
                  disabled={!settings || saving}
                  onChange={(event) =>
                    patchContext({ autoCompactThreshold: Number(event.target.value) / 100 })
                  }
                  onBlur={() => patchContext({}, true)}
                  className="w-[76px]"
                />
                <span className="text-muted">%</span>
                <label htmlFor="context-keep-turns" className="ml-3">
                  保留最近
                </label>
                <Input
                  id="context-keep-turns"
                  type="number"
                  size="sm"
                  min={1}
                  max={20}
                  step={1}
                  value={context.autoCompactKeepTurns}
                  disabled={!settings || saving}
                  onChange={(event) =>
                    patchContext({ autoCompactKeepTurns: Number(event.target.value) })
                  }
                  onBlur={() => patchContext({}, true)}
                  className="w-[64px]"
                />
                <span className="text-muted">轮原文</span>
              </div>
            ) : null}

            <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                <div className="text-[13px]">裁剪旧的大工具输出</div>
                <div className="mt-0.5 text-[12px] text-muted">
                  发送时把较早的大段 Bash / Read 结果换成「已省略」占位，减少输入占用；原文仍保留在会话里，可随时查看或重新读取。
                </div>
              </div>
              <Switch
                checked={context.trimLargeToolResults}
                onChange={(checked) => patchContext({ trimLargeToolResults: checked }, true)}
                disabled={!settings || saving}
                label="裁剪旧的大工具输出"
              />
            </div>

            {context.trimLargeToolResults ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
                <label htmlFor="trim-tokens">单条超过</label>
                <Input
                  id="trim-tokens"
                  type="number"
                  size="sm"
                  min={500}
                  max={200_000}
                  step={500}
                  value={context.trimToolResultTokens}
                  disabled={!settings || saving}
                  onChange={(event) =>
                    patchContext({ trimToolResultTokens: Number(event.target.value) })
                  }
                  onBlur={() => patchContext({}, true)}
                  className="w-[92px]"
                />
                <span className="text-muted">tokens</span>
                <label htmlFor="trim-keep-turns" className="ml-3">
                  且早于最近
                </label>
                <Input
                  id="trim-keep-turns"
                  type="number"
                  size="sm"
                  min={1}
                  max={100}
                  step={1}
                  value={context.trimKeepTurns}
                  disabled={!settings || saving}
                  onChange={(event) => patchContext({ trimKeepTurns: Number(event.target.value) })}
                  onBlur={() => patchContext({}, true)}
                  className="w-[64px]"
                />
                <span className="text-muted">轮</span>
              </div>
            ) : null}
            {settings && !settings.context ? (
              <p className="mt-2 text-[12px] text-muted">当前 Host 尚未保存过上下文设置，修改后会写入 config.json。</p>
            ) : null}
          </div>
        </div>
      </section>
      <section data-setting-id="general.ai-review" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <Bot size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">提交前 AI 评审</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              在提交或开 PR 前，用评审模型检查工作区改动，意见挂到具体行，可采纳为人工评论再发给 agent。
              留空时优先使用名为「审查」的子代理预设，没有则沿用当前会话的模型。
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                评审账号
                <Select
                  value={aiReview.profileId ?? ''}
                  onChange={(event) => patchAiReview({ profileId: event.target.value, groupId: '', model: '' })}
                  aria-label="AI 评审账号"
                  size="sm"
                  disabled={!settings || saving}
                >
                  <option value="">默认（审查预设 / 当前会话）</option>
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                分组
                <Select
                  value={aiReview.groupId ?? ''}
                  onChange={(event) => {
                    const group = reviewGroups.find((item) => (item.groupId ?? '') === event.target.value)
                    patchAiReview({
                      groupId: event.target.value,
                      model: group?.models[0] ?? '',
                    })
                  }}
                  aria-label="AI 评审分组"
                  size="sm"
                  disabled={!settings || saving || !reviewProfile}
                >
                  <option value="">账号默认</option>
                  {reviewGroups.map((group) => (
                    <option key={group.groupId ?? 'default'} value={group.groupId ?? ''}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                模型
                <Select
                  value={aiReview.model ?? ''}
                  onChange={(event) => patchAiReview({ model: event.target.value })}
                  aria-label="AI 评审模型"
                  size="sm"
                  disabled={!settings || saving || !reviewProfile}
                >
                  <option value="">账号默认模型</option>
                  {(aiReview.model && !reviewModels.includes(aiReview.model)
                    ? [aiReview.model, ...reviewModels]
                    : reviewModels
                  ).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                思考强度
                <Select
                  value={aiReview.effort ?? ''}
                  onChange={(event) =>
                    patchAiReview({ effort: (event.target.value || undefined) as ReasoningEffort | undefined })
                  }
                  aria-label="AI 评审思考强度"
                  size="sm"
                  disabled={!settings || saving}
                >
                  <option value="">继承 / 默认</option>
                  {(Object.keys(EFFORT_LABEL) as ReasoningEffort[]).map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_LABEL[effort]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                <div className="text-[13px]">有 blocker 时阻止提交</div>
                <div className="mt-0.5 text-[12px] text-muted">
                  默认只提示；开启后提交按钮在有阻塞问题时会禁用，需要先处理或忽略对应意见。
                </div>
              </div>
              <Switch
                checked={aiReview.blockOnBlocker === true}
                onChange={(checked) => patchAiReview({ blockOnBlocker: checked })}
                disabled={!settings || saving}
                label="有 blocker 时阻止提交"
              />
            </div>
            {!settings && !error ? <p className="mt-2 text-[12px] text-muted">读取中…</p> : null}
          </div>
        </div>
      </section>
      <section data-setting-id="general.handoff" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <Gauge size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">额度交接</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              长任务跑到一半额度/限流将尽时，不直接失败：会话会暂停并给出交接卡。
              自动切换会先保存检查点并压缩上下文，再在备用分组上继续当前回合。
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                默认策略
                <Select
                  value={handoff.policy}
                  onChange={(event) =>
                    patchHandoff({ policy: event.target.value as HandoffSettings['policy'] })
                  }
                  aria-label="额度交接默认策略"
                  size="sm"
                  disabled={!settings || saving}
                >
                  <option value="ask">询问（推荐）</option>
                  <option value="switch">自动切到备用分组</option>
                  <option value="wait">自动等待重置</option>
                </Select>
              </label>
              {handoff.policy === 'switch' && (
                <>
                  <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                    备用账号
                    <Select
                      value={handoff.target?.profileId ?? ''}
                      onChange={(event) =>
                        patchHandoff({
                          target: { profileId: event.target.value },
                        })
                      }
                      aria-label="交接备用账号"
                      size="sm"
                      disabled={!settings || saving}
                    >
                      <option value="">按分组备用链</option>
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                    备用分组
                    <Select
                      value={handoff.target?.groupId ?? ''}
                      onChange={(event) => {
                        const group = handoffGroups.find(
                          (item) => (item.groupId ?? '') === event.target.value,
                        )
                        patchHandoff({
                          target: {
                            profileId: handoff.target?.profileId ?? '',
                            ...(event.target.value ? { groupId: event.target.value } : {}),
                            ...(group?.models[0] ? { model: group.models[0] } : {}),
                          },
                        })
                      }}
                      aria-label="交接备用分组"
                      size="sm"
                      disabled={!settings || saving || !handoffProfile}
                    >
                      <option value="">账号默认</option>
                      {handoffGroups.map((group) => (
                        <option key={group.groupId ?? 'default'} value={group.groupId ?? ''}>
                          {group.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
                    备用模型
                    <Select
                      value={handoff.target?.model ?? ''}
                      onChange={(event) =>
                        patchHandoff({
                          target: {
                            profileId: handoff.target?.profileId ?? '',
                            ...(handoff.target?.groupId ? { groupId: handoff.target.groupId } : {}),
                            ...(event.target.value ? { model: event.target.value } : {}),
                          },
                        })
                      }
                      aria-label="交接备用模型"
                      size="sm"
                      disabled={!settings || saving || !handoffProfile}
                    >
                      <option value="">分组默认模型</option>
                      {(handoff.target?.model && !handoffModels.includes(handoff.target.model)
                        ? [handoff.target.model, ...handoffModels]
                        : handoffModels
                      ).map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </Select>
                  </label>
                </>
              )}
            </div>
            <p className="mt-2 text-[12px] leading-4 text-muted">
              未指定备用账号时，按「账号与模型」里每个分组配置的备用分组链选择第一个可用分组；
              子代理与任务看板卡片遵循同一策略。
            </p>
          </div>
        </div>
      </section>
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted">
        <Server size={12} />
        {host ? `设置保存在 ${host.name} 的 config.json，同一 Host 的所有客户端共享。` : '请先选择一个 Host。'}
      </p>
    </div>
  )
}
