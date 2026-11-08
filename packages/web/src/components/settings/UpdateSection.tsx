import { useEffect, useState } from 'react'
import { Download, FolderOpen, RefreshCw } from 'lucide-react'
import type { HostSettings } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { desktop } from '../../lib/desktop'
import { APP_VERSION } from '../../lib/changelog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'

interface UpdateStatus {
  state: string
  version?: string
  message?: string
  percent?: number
}

const STATE_TEXT: Record<string, string> = {
  idle: '自动更新已关闭（未配置更新源）',
  checking: '正在检查更新…',
  available: '发现新版本，正在后台下载…',
  downloading: '正在后台下载…',
  downloaded: '新版本已下载，重启后完成更新',
  current: '当前已是最新版本',
  disabled: '开发模式不检查更新，请用安装版验证',
  error: '检查更新失败',
}

function statusText(status: UpdateStatus): string {
  const base = STATE_TEXT[status.state] ?? status.state
  if (status.state === 'downloading' && status.percent !== undefined) {
    return `${base} ${status.percent}%`
  }
  if (status.version && status.state === 'downloaded') {
    return `新版本 ${status.version} 已下载，重启后完成更新`
  }
  if (status.version && status.state === 'available') {
    return `发现新版本 ${status.version}，正在后台下载…`
  }
  return status.message && status.state === 'error' ? `${base}：${status.message}` : base
}

export function UpdateSection() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const updater = desktop?.updater
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [shareDir, setShareDir] = useState('')
  const [savingShare, setSavingShare] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [savedSource, setSavedSource] = useState('')
  const [savingSource, setSavingSource] = useState(false)
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    if (!host) return
    let cancelled = false
    setSettings(null)
    setShareError(null)
    api
      .settings(host)
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setShareDir(next.updateShareDir ?? '')
      })
      .catch((err: Error) => {
        if (!cancelled) setShareError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [host])

  useEffect(() => {
    if (!updater) return
    let cancelled = false
    void updater.getConfig().then((config) => {
      if (cancelled) return
      setSource(config.source)
      setSavedSource(config.source)
    })
    void updater.status().then((next) => {
      if (!cancelled) setStatus(next)
    })
    return updater.onStatus((next) => setStatus(next))
  }, [updater])

  const saveShareDir = async () => {
    if (!host || !settings || savingShare) return
    setSavingShare(true)
    setShareError(null)
    try {
      const saved = await api.updateSettings(host, { ...settings, updateShareDir: shareDir.trim() })
      setSettings(saved)
      setShareDir(saved.updateShareDir ?? '')
    } catch (err) {
      setShareError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingShare(false)
    }
  }

  const saveSource = async () => {
    if (!updater || savingSource) return
    setSavingSource(true)
    try {
      const saved = await updater.setConfig({ source: source.trim() })
      setSource(saved.source)
      setSavedSource(saved.source)
    } finally {
      setSavingSource(false)
    }
  }

  const check = async () => {
    if (!updater) return
    setStatus(await updater.check())
  }

  const updatesUrl = host ? `${host.url.replace(/\/+$/, '')}/updates/` : ''

  return (
    <div className="space-y-3">
      {updater && (
        <section data-setting-id="general.updates" className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 text-muted">
              <Download size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-medium">桌面更新</h3>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                当前版本 {APP_VERSION}。填写内网更新源后，桌面端会在启动 15 秒后及每 6 小时检查一次；
                留空则完全关闭，不会发起任何请求。更新源是放置 latest.yml 与安装包的静态目录，
                可以是 HTTP 地址或共享目录。
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="http://192.168.1.10:8080/updates 或 \\nas\share\tandem"
                  className="min-w-0 flex-1 font-mono"
                  aria-label="桌面更新源"
                />
                <Button onClick={() => void saveSource()} disabled={savingSource || source.trim() === savedSource}>
                  保存
                </Button>
                <Button onClick={() => void check()} disabled={!savedSource}>
                  <RefreshCw size={13} /> 立即检查
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-muted">{statusText(status)}</p>
              {status.state === 'downloaded' && status.version && (
                <Button className="mt-2" variant="primary" onClick={() => void updater.install()}>
                  重启并安装 {status.version}
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      <section data-setting-id="general.update-share" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <FolderOpen size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">Host 托管更新文件</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              让这台 Host 把本地目录公开为 <span className="font-mono">/updates/</span> 静态路径，
              方便内网桌面端直接从 Host 更新。留空即关闭；目录里放入 latest.yml、安装包与 blockmap 即可。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                value={shareDir}
                onChange={(event) => setShareDir(event.target.value)}
                placeholder="例如 /home/me/tandem-updates 或 D:\tandem-updates"
                className="min-w-0 flex-1 font-mono"
                aria-label="Host 更新文件目录"
              />
              <Button onClick={() => void saveShareDir()} disabled={!settings || savingShare}>
                保存
              </Button>
            </div>
            {settings?.updateShareDir && updatesUrl && (
              <p className="mt-2 break-all font-mono text-[12px] text-muted">{updatesUrl}</p>
            )}
            {shareError && <p className="mt-2 text-[12px] text-danger">{shareError}</p>}
          </div>
        </div>
      </section>
    </div>
  )
}
