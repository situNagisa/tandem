import { useEffect, useState } from 'react'
import { Gauge, RotateCcw, Server } from 'lucide-react'
import {
  DEFAULT_CONTEXT_SETTINGS,
  type ContextSettings,
  type HostSettings,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { Input, SegmentedControl, Switch } from '../ui/Controls'

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
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted">
        <Server size={12} />
        {host ? `设置保存在 ${host.name} 的 config.json，同一 Host 的所有客户端共享。` : '请先选择一个 Host。'}
      </p>
    </div>
  )
}
