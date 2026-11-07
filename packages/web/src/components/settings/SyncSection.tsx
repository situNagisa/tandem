import { useRef, useState } from 'react'
import {
  ArrowLeftRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Loader2,
  Share2,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import type { ConfigBundle, ConfigImportResult } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { collectClientSettings, type ClientSettingsBundle } from '../../lib/storage'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { MenuSelect } from '../ui/Menu'

function bundleText(bundle: ConfigBundle): string {
  return JSON.stringify(bundle, null, 2)
}

function downloadBundle(bundle: ConfigBundle): void {
  try {
    const blob = new Blob([bundleText(bundle)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'tandem-config.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch {
    /* 下载失败时仍可用复制 */
  }
}

type ShareNavigator = Navigator & {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>
}

function isBundle(value: unknown): value is ConfigBundle {
  if (!value || typeof value !== 'object') return false
  const b = value as Partial<ConfigBundle>
  return (
    b.version === 1 &&
    typeof b.encrypted === 'string' &&
    typeof b.salt === 'string' &&
    typeof b.iv === 'string' &&
    typeof b.createdAt === 'number'
  )
}

export function SyncSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const applyClientSettings = useAppStore((s) => s.applyClientSettings)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const refreshSessions = useAppStore((s) => s.refreshSessions)
  const toast = useUiStore((s) => s.toast)

  const [hostId, setHostId] = useState(activeHostId ?? hosts[0]?.id ?? '')
  const host = hosts.find((h) => h.id === hostId) ?? null

  const [exportPass, setExportPass] = useState('')
  const [showExportPass, setShowExportPass] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<ConfigBundle | null>(null)
  const [copied, setCopied] = useState(false)

  const [fileName, setFileName] = useState('')
  const [importBundle, setImportBundle] = useState<ConfigBundle | null>(null)
  const [importPass, setImportPass] = useState('')
  const [showImportPass, setShowImportPass] = useState(false)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ConfigImportResult | null>(null)
  const [replaceConfirm, setReplaceConfirm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const profileCount = useAppStore((s) => (hostId ? (s.runtimes[hostId]?.profiles?.length ?? 0) : 0))

  const exportConfig = async () => {
    if (!host) return
    if (!exportPass.trim()) {
      setExportError('请先输入一个导出用的口令')
      return
    }
    setExporting(true)
    setExportError(null)
    setCopied(false)
    try {
      const result = await api.exportConfig(host, {
        passphrase: exportPass,
        clientSettings: collectClientSettings(),
      })
      setBundle(result)
      downloadBundle(result)
      toast('配置文件已生成并开始下载', 'success')
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const copyBundle = async () => {
    if (!bundle) return
    if (await copyText(bundleText(bundle))) {
      setCopied(true)
      toast('配置内容已复制', 'success')
      window.setTimeout(() => setCopied(false), 1800)
    } else {
      toast('复制失败，请改用下载', 'error')
    }
  }

  const shareBundle = async () => {
    if (!bundle) return
    const nav = navigator as ShareNavigator
    const text = bundleText(bundle)
    const file = new File([text], 'tandem-config.json', { type: 'application/json' })
    try {
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({
          files: [file],
          title: 'Tandem 配置备份',
          text: 'Tandem 配置备份（含加密的账号 Key）',
        })
        return
      }
      if (nav.share) {
        await nav.share({ title: 'Tandem 配置备份', text })
        return
      }
    } catch {
      /* 用户取消或系统不支持时回退到复制 */
    }
    await copyBundle()
  }

  const pickFile = async (file: File | undefined) => {
    setFileName('')
    setImportBundle(null)
    setImportError(null)
    setImportResult(null)
    if (!file) return
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      if (!isBundle(parsed)) {
        setImportError('这不是有效的 Tandem 配置文件')
        return
      }
      setFileName(file.name)
      setImportBundle(parsed)
    } catch {
      setImportError('无法读取文件，请确认选择的是 tandem-config.json')
    }
  }

  const importConfig = async () => {
    if (!host) return
    if (!importBundle) {
      setImportError('先选择配置文件')
      return
    }
    if (!importPass.trim()) {
      setImportError('请输入导出时设置的口令')
      return
    }
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    try {
      const result = await api.importConfig(host, {
        passphrase: importPass,
        bundle: importBundle,
        mode,
      })
      setImportResult(result)
      if (result.clientSettings && typeof result.clientSettings === 'object') {
        applyClientSettings(result.clientSettings as ClientSettingsBundle, mode)
        const next = useAppStore.getState()
        const nextHosts = next.hosts
        setHostId((prev) =>
          nextHosts.some((h) => h.id === prev)
            ? prev
            : (next.activeHostId ?? nextHosts[0]?.id ?? ''),
        )
      } else {
        await refreshProfiles(host.id)
        await refreshSessions(host.id)
      }
      toast(
        `导入完成：新增 ${result.profilesAdded} 个账号，更新 ${result.profilesUpdated} 个`,
        'success',
      )
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const requestImport = () => {
    if (!importBundle) {
      setImportError('先选择配置文件')
      return
    }
    if (!importPass.trim()) {
      setImportError('请输入导出时设置的口令')
      return
    }
    setImportError(null)
    if (mode === 'replace') {
      setReplaceConfirm(true)
      return
    }
    void importConfig()
  }

  if (!host) {
    return (
      <div className="settings-empty">
        <span className="settings-empty-icon"><ShieldCheck size={17} /></span>
        <p className="settings-empty-title">还没有连接主机</p>
        <p className="settings-empty-hint">先添加一台主机，再同步配置。</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">同步与备份</h3>
        <span className="hidden text-[13px] text-muted sm:inline">
          换电脑不用重新配置账号与界面
        </span>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <MenuSelect
            value={hostId}
            onChange={(id) => {
              setHostId(id)
              setBundle(null)
              setImportResult(null)
            }}
            options={hosts.map((h) => ({ value: h.id, label: h.name }))}
            aria-label="选择主机"
            wrapperClassName="w-auto max-w-[180px]"
            className="text-[13px]"
          />
        )}
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-bg/40 px-3 py-2.5 text-[13px] leading-5 text-text-soft">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-muted" />
        <span>
          配置文件包含账号与分组里<strong className="font-medium text-text">加密的 API Key</strong>
          ，以及本机的主机列表、主题和侧栏偏好。请妥善保管文件和口令；口令忘记后无法恢复。
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div data-setting-id="sync.export" className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--t-bg-active)] text-text-soft">
              <Download size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-semibold">导出配置</h4>
              <p className="text-[13px] text-muted">
                账号（含分组）、主机列表、主题、侧栏偏好打包为一个文件
              </p>
            </div>
          </div>

          <div className="mt-3">
            <label className="settings-label">加密口令</label>
            <div className="relative">
              <Input
                value={exportPass}
                onChange={(e) => {
                  setExportPass(e.target.value)
                  setExportError(null)
                }}
                type={showExportPass ? 'text' : 'password'}
                placeholder="设置一个只有你知道的口令"
                autoComplete="new-password"
                className="pr-9"
              />
              <span className="absolute right-1 top-1/2 -translate-y-1/2">
                <IconButton
                  size="sm"
                  onClick={() => setShowExportPass((v) => !v)}
                  label={showExportPass ? '隐藏口令' : '显示口令'}
                  className="size-7 [&_svg]:size-[13px]"
                >
                  {showExportPass ? <EyeOff size={13} /> : <Eye size={13} />}
                </IconButton>
              </span>
            </div>
          </div>

          {exportError && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-1.5 text-[13px] text-danger">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              {exportError}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => void exportConfig()}
              disabled={exporting || !exportPass.trim()}
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              导出并下载
            </Button>
            {bundle && (
              <>
                <Button onClick={() => downloadBundle(bundle)}>
                  <FileJson size={12} /> 再次下载
                </Button>
                <Button onClick={() => void copyBundle()}>
                  {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                  {copied ? '已复制' : '复制内容'}
                </Button>
                <Button onClick={() => void shareBundle()}>
                  <Share2 size={12} /> 分享
                </Button>
              </>
            )}
          </div>
          {bundle && (
            <p className="mt-2 font-mono text-[13px] text-muted">
              tandem-config.json · {new Date(bundle.createdAt).toLocaleString()} · {bundle.hostName}
            </p>
          )}
          <p className="settings-help">
            手机或 App 里下载不便时，可用「分享」或「复制内容」把文件发到另一台设备。
          </p>
        </div>

        <div data-setting-id="sync.import" className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--t-bg-active)] text-text-soft">
              <Upload size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-semibold">导入配置</h4>
              <p className="text-[13px] text-muted">
                选择之前导出的 tandem-config.json，输入口令后合并或替换
              </p>
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              void pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <Button
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            className="mt-3 w-full justify-start border-dashed text-left font-normal"
          >
            <FileJson size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {fileName || '选择配置文件…'}
            </span>
            {importBundle && <Check size={12} className="shrink-0 text-success" />}
          </Button>

          <div className="mt-3">
            <label className="settings-label">口令</label>
            <div className="relative">
              <Input
                value={importPass}
                onChange={(e) => {
                  setImportPass(e.target.value)
                  setImportError(null)
                }}
                type={showImportPass ? 'text' : 'password'}
                placeholder="导出时设置的口令"
                autoComplete="off"
                className="pr-9"
              />
              <span className="absolute right-1 top-1/2 -translate-y-1/2">
                <IconButton
                  size="sm"
                  onClick={() => setShowImportPass((v) => !v)}
                  label={showImportPass ? '隐藏口令' : '显示口令'}
                  className="size-7 [&_svg]:size-[13px]"
                >
                  {showImportPass ? <EyeOff size={13} /> : <Eye size={13} />}
                </IconButton>
              </span>
            </div>
          </div>

          <div className="mt-3">
            <label className="settings-label">导入方式</label>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {(
                [
                  ['merge', '合并', '保留现有账号，同名账号以文件为准'],
                  ['replace', '替换', '清空现有账号与 Host 后按文件恢复'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  onClick={() => setMode(value)}
                  aria-pressed={mode === value}
                  className={cn(
                    'rounded-lg border px-2.5 py-2 text-left transition-colors',
                    mode === value
                      ? value === 'replace'
                        ? 'border-danger/50 bg-danger-soft/30'
                        : 'border-[var(--t-border-strong)] bg-[var(--t-bg-active)]'
                      : 'border-border bg-bg/40 hover:bg-[var(--t-bg-hover)]',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {label}
                    {mode === value && <Check size={11} className={cn(value === 'replace' ? 'text-danger' : 'text-text')} />}
                  </span>
                  <span
                    className={cn(
                      'mt-0.5 block text-[13px] leading-4',
                      value === 'replace' && mode === 'replace' ? 'text-danger' : 'text-muted',
                    )}
                  >
                    {hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {importError && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-1.5 text-[13px] leading-5 text-danger">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              {importError}
            </div>
          )}
          {importResult && (
            <div className="mt-2 rounded-lg border border-success/25 bg-success-soft/50 px-2.5 py-2 text-[13px] text-success">
              导入完成：新增 {importResult.profilesAdded} 个账号，更新 {importResult.profilesUpdated} 个
              {importResult.clientSettings ? '；本机 Host 与界面设置已应用' : ''}。
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <span className="flex items-center gap-1 text-[13px] text-muted">
              <ArrowLeftRight size={11} /> 应用到「{host.name}」
            </span>
            <span className="flex-1" />
            <Button
              variant="primary"
              onClick={requestImport}
              disabled={importing || !importBundle}
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              导入配置
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={replaceConfirm}
        onClose={() => setReplaceConfirm(false)}
        title="替换现有配置？"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setReplaceConfirm(false)}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={() => {
                setReplaceConfirm(false)
                void importConfig()
              }}
            >
              替换并导入
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          将清空「{host.name}」上的 <span className="font-medium text-text">{profileCount}</span> 个账号，
          并用文件内容覆盖本机的 <span className="font-medium text-text">{hosts.length}</span> 个主机记录。
          此操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
