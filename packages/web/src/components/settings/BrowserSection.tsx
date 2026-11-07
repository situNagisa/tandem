import { useEffect, useState } from 'react'
import { Globe2, Info, MousePointerClick, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BrowserSettings, BrowserStatus } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { Button } from '../ui/Button'
import { SegmentedControl, Switch, Textarea } from '../ui/Controls'

const DEFAULT_SETTINGS: BrowserSettings = { enabled: false, allowedHosts: [], headless: true }
const HEADLESS_OPTIONS = [
  { value: 'headless' as const, label: '无头模式', title: '不显示窗口，适合远程主机' },
  { value: 'headed' as const, label: '有头模式', title: '在主机桌面弹出可见的浏览器窗口' },
]

function parseHosts(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  )
}

/** 设置 → 浏览器：启用开关、域名允许列表、无头/有头。 */
export function BrowserSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = hosts.find((h) => h.id === activeHostId) ?? null
  const toast = useUiStore((s) => s.toast)
  const [settings, setSettings] = useState<BrowserSettings | null>(null)
  const [saved, setSaved] = useState<BrowserSettings | null>(null)
  const [allowText, setAllowText] = useState('')
  const [savedAllowText, setSavedAllowText] = useState('')
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setSaved(null)
    setStatus(null)
    setError(null)
    if (!host) return
    api
      .browserSettings(host)
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setSaved(next)
        setAllowText(next.allowedHosts.join('\n'))
        setSavedAllowText(next.allowedHosts.join('\n'))
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    api
      .browserStatus(host)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus({ available: false, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [host, activeHostId])

  const persist = async (next: BrowserSettings) => {
    if (!host || saving) return
    const previous = settings
    setSettings(next)
    setSaving(true)
    setError(null)
    try {
      const result = await api.updateBrowserSettings(host, next)
      setSettings(result)
      setSaved(result)
      setAllowText(result.allowedHosts.join('\n'))
      setSavedAllowText(result.allowedHosts.join('\n'))
    } catch (err) {
      setSettings(previous ?? DEFAULT_SETTINGS)
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = (enabled: boolean) => {
    if (!settings) return
    void persist({ ...settings, enabled })
  }

  const updateAllowlist = () => {
    if (!settings) return
    const allowedHosts = parseHosts(allowText)
    void persist({ ...settings, allowedHosts })
    toast('浏览器允许列表已保存')
  }

  const dirty = allowText !== savedAllowText
  const enabled = settings?.enabled ?? false
  const headless = settings?.headless ?? true

  return (
    <div className="space-y-3">
      <section data-setting-id="browser.enabled" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <MousePointerClick size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-medium">浏览器操作</h3>
              <Switch
                checked={enabled}
                onChange={toggleEnabled}
                disabled={!settings || saving}
                label="启用浏览器操作"
              />
            </div>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              让 agent 在主机本机打开页面、复现 bug、截图回传。每个会话独立浏览器上下文，空闲 10 分钟自动关闭。
            </p>
            {!settings && !error ? <p className="mt-2 text-[12px] text-muted">读取中…</p> : null}
            {!enabled && settings ? (
              <p className="mt-2 text-[12px] text-muted">默认关闭。开启后工具才会出现在 agent 的工具列表里。</p>
            ) : null}
          </div>
        </div>
        {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
      </section>

      <section data-setting-id="browser.display" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Globe2 size={14} className="text-muted" />
          <h3 className="text-[13px] font-medium">显示模式</h3>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          无头模式不弹窗口，适合远程主机；有头模式会在主机桌面打开可见窗口，方便本机观察。
        </p>
        <div className="mt-3">
          <SegmentedControl
            options={HEADLESS_OPTIONS}
            value={headless ? 'headless' : 'headed'}
            onChange={(value) => {
              if (!settings) return
              void persist({ ...settings, headless: value === 'headless' })
            }}
            disabled={!settings || saving}
            aria-label="浏览器显示模式"
          />
        </div>
      </section>

      <section data-setting-id="browser.allowlist" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-muted" />
          <h3 className="text-[13px] font-medium">域名允许列表</h3>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          默认只允许 localhost、127.0.0.1、[::1] 和 file://。其它地址需要加到这里，支持内网网段与域名通配：
          <code className="mx-1 rounded bg-[var(--t-bg-active)] px-1 py-0.5 font-mono text-[12px]">10.*</code>
          <code className="mx-1 rounded bg-[var(--t-bg-active)] px-1 py-0.5 font-mono text-[12px]">192.168.*</code>
          <code className="mx-1 rounded bg-[var(--t-bg-active)] px-1 py-0.5 font-mono text-[12px]">*.corp.example.com</code>
          每行一个。
        </p>
        <Textarea
          value={allowText}
          onChange={(e) => setAllowText(e.target.value)}
          rows={5}
          disabled={!settings || saving}
          placeholder={'例如：\n192.168.1.20\ndev.corp.example.com\n10.*'}
          className="mt-3 font-mono text-[12px]"
          aria-label="允许访问的域名列表"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={updateAllowlist}
            disabled={!settings || saving || !dirty}
          >
            保存允许列表
          </Button>
          {dirty ? <span className="text-[12px] text-warning">有未保存的修改</span> : null}
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-5 text-muted">
          <Info size={12} className="mt-1 shrink-0" />
          <span>
            不在列表里的域名会被直接拒绝，不会发出任何网络请求。列表里的域名第一次访问时仍会在审批卡上确认，
            选「始终允许」只记住该域名（会话内）。
          </span>
        </p>
      </section>

      <section data-setting-id="browser.tools" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <RefreshCw size={14} className="text-muted" />
          <h3 className="text-[13px] font-medium">浏览器组件</h3>
        </div>
        {status === null ? (
          <p className="mt-2 text-[12px] text-muted">检测中…</p>
        ) : status.available ? (
          <p className="mt-2 break-all text-[12px] leading-5 text-muted">
            可用：{status.browser}
          </p>
        ) : (
          <div className="mt-2 rounded-lg border border-warning/30 bg-warning-soft/40 p-2.5 text-[12px] leading-5 text-warning">
            <p className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>{status.error || '浏览器组件不可用'}</span>
            </p>
            <p className="mt-1.5 font-mono text-[12px] text-text-soft">
              npm i playwright && npx playwright install chromium
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
