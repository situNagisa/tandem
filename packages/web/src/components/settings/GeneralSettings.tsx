import { useEffect, useState } from 'react'
import { RotateCcw, Server } from 'lucide-react'
import type { HostSettings } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { SegmentedControl } from '../ui/Controls'

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
    setSettings({ resumeOnRestart: value })
    setSaving(true)
    setError(null)
    try {
      const next = await api.updateSettings(host, { resumeOnRestart: value })
      setSettings(next)
    } catch (err) {
      setSettings(previous ?? { resumeOnRestart: 'auto' })
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
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
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted">
        <Server size={12} />
        {host ? `设置保存在 ${host.name} 的 config.json，同一 Host 的所有客户端共享。` : '请先选择一个 Host。'}
      </p>
    </div>
  )
}
