import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  FileText,
  KeyRound,
  Laptop,
  MoreHorizontal,
  Pencil,
  Plus,
  PowerOff,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Server,
  Smartphone,
  Stethoscope,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { RemoteSshHost, SshJob } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { normalizeHostUrl, isLocalHostUrl, isSameOrigin } from '../../lib/hostUrl'
import { APP_VERSION } from '../../lib/changelog'
import { useUiStore } from '../../store/useUiStore'
import { ConnectionDot } from '../StatusDot'
import { PairDialog } from './PairDialog'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl, Switch } from '../ui/Controls'
import { Menu } from '../ui/Menu'
import { RemoteSshDialog, SshJobProgress } from './RemoteSshDialog'
import { cn } from '../../lib/cn'
import { loginGateEnabled } from '../../lib/loginGate'
import { QrScanDialog, scannerSupported } from '../QrScanDialog'
import { parsePairLink } from '../../lib/pairLink'
import { parseInviteLink } from '../../lib/inviteLink'
import {
  RELAY_UNSUPPORTED_MESSAGE,
  isValidFingerprint,
  normalizeFingerprint,
  relayHostUrl,
  useRelayCryptoSupport,
} from '../../lib/relay'
import type { HostConfig } from '../../lib/types'

const inputCls =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-text outline-none transition-colors placeholder:text-muted focus:border-border-strong'

export function HostsSection() {
  const gateOn = loginGateEnabled()
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const addHost = useAppStore((s) => s.addHost)
  const updateHost = useAppStore((s) => s.updateHost)
  const removeHost = useAppStore((s) => s.removeHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const toast = useUiStore((s) => s.toast)
  const openDoctor = useUiStore((s) => s.openDoctor)

  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<'direct' | 'relay'>('direct')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [hostId, setHostId] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [link, setLink] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const cryptoSupported = useRelayCryptoSupport()
  const canScan = scannerSupported()

  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editToken, setEditToken] = useState('')
  const [editRelayUrl, setEditRelayUrl] = useState('')
  const [editHostId, setEditHostId] = useState('')
  const [editFingerprint, setEditFingerprint] = useState('')
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null)
  const [pairHost, setPairHost] = useState<string | null>(null)
  const [sshController, setSshController] = useState<HostConfig | null>(null)
  const [sshRecords, setSshRecords] = useState<Record<string, RemoteSshHost[]>>({})
  const [sshJobView, setSshJobView] = useState<{
    controller: HostConfig
    title: string
    job: SshJob
    removeClientId?: string
  } | null>(null)
  const [sshLogView, setSshLogView] = useState<{
    controller: HostConfig
    record: RemoteSshHost
    lines: string[]
    loading: boolean
    error?: string
  } | null>(null)
  const [sshUninstall, setSshUninstall] = useState<{
    controller: HostConfig
    record: RemoteSshHost
    clientHostId: string
    keepData: boolean
  } | null>(null)
  const [sshPasswordView, setSshPasswordView] = useState<{
    controller: HostConfig
    record: RemoteSshHost
    password: string
    saving: boolean
    error?: string
  } | null>(null)

  const resetAdd = () => {
    setName('')
    setUrl('')
    setToken('')
    setRelayUrl('')
    setHostId('')
    setFingerprint('')
    setLink('')
  }

  const sshControllers = hosts.filter((item) => (item.mode ?? 'direct') !== 'ssh')
  const controllerFor = (host: HostConfig): HostConfig | undefined =>
    hosts.find((item) => item.id === host.sshControllerId) ??
    hosts.find(
      (item) =>
        (item.mode ?? 'direct') !== 'ssh' &&
        (isLocalHostUrl(item.url) || isSameOrigin(item.url)),
    ) ??
    hosts.find((item) => item.id === activeHostId && (item.mode ?? 'direct') !== 'ssh')
  const recordFor = (host: HostConfig): { controller: HostConfig; record: RemoteSshHost } | undefined => {
    const controller = controllerFor(host)
    if (!controller || !host.sshHostId) return undefined
    const record = sshRecords[controller.id]?.find((item) => item.id === host.sshHostId)
    return record ? { controller, record } : undefined
  }

  const refreshSshHosts = useCallback(async () => {
    if (sshControllers.length === 0) return
    const pairs = await Promise.all(
      sshControllers.map(async (controller) => {
        try {
          return [controller.id, await api.sshHosts(controller)] as const
        } catch {
          return undefined
        }
      }),
    )
    const next: Record<string, RemoteSshHost[]> = {}
    for (const pair of pairs) {
      if (pair) next[pair[0]] = pair[1]
    }
    if (Object.keys(next).length > 0) {
      setSshRecords((prev) => ({ ...prev, ...next }))
    }
  }, [sshControllers.map((item) => item.id).join(','), hosts])

  useEffect(() => {
    void refreshSshHosts()
    const timer = window.setInterval(() => void refreshSshHosts(), 10_000)
    return () => window.clearInterval(timer)
  }, [refreshSshHosts])

  // 隧道换端口后，客户端的旧地址会自动跟随（只改一次，避免重连循环）。
  useEffect(() => {
    for (const host of hosts) {
      if (host.mode !== 'ssh') continue
      const found = recordFor(host)
      if (found && found.record.localUrl && host.url !== found.record.localUrl) {
        updateHost(host.id, { url: found.record.localUrl })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshRecords, hosts])

  useEffect(() => {
    const view = sshJobView
    if (!view || view.job.status !== 'running') return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const job = await api.sshJob(view.controller, view.job.id)
        if (cancelled) return
        setSshJobView((current) => (current ? { ...current, job } : current))
        if (job.status === 'ok') {
          if (view.removeClientId) removeHost(view.removeClientId)
          toast(`${view.title}完成`, 'success')
          void refreshSshHosts()
        } else if (job.status === 'fail') {
          toast(job.error ? `${view.title}失败：${job.error}` : `${view.title}失败`, 'error')
          void refreshSshHosts()
        }
      } catch (err) {
        if (!cancelled) toast(err instanceof Error ? err.message : '任务状态获取失败', 'error')
      }
    }, 700)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sshJobView, removeHost, toast, refreshSshHosts])

  const pickController = (): HostConfig | null => {
    const active = hosts.find((item) => item.id === activeHostId && (item.mode ?? 'direct') !== 'ssh')
    const local = hosts.find(
      (item) =>
        (item.mode ?? 'direct') !== 'ssh' &&
        (isLocalHostUrl(item.url) || isSameOrigin(item.url)),
    )
    return active ?? local ?? sshControllers[0] ?? null
  }

  const startSshJob = async (
    controller: HostConfig,
    title: string,
    starter: () => Promise<SshJob>,
    removeClientId?: string,
  ) => {
    try {
      const job = await starter()
      setSshJobView({ controller, title, job, ...(removeClientId ? { removeClientId } : {}) })
    } catch (err) {
      toast(err instanceof Error ? err.message : `${title}失败`, 'error')
    }
  }

  const openSshLogs = async (controller: HostConfig, record: RemoteSshHost) => {
    setSshLogView({ controller, record, lines: [], loading: true })
    try {
      const result = await api.sshLogs(controller, record.id, 200)
      setSshLogView((current) =>
        current && current.record.id === record.id
          ? { ...current, lines: result.lines, loading: false }
          : current,
      )
    } catch (err) {
      setSshLogView((current) =>
        current && current.record.id === record.id
          ? { ...current, loading: false, error: err instanceof Error ? err.message : '读取日志失败' }
          : current,
      )
    }
  }

  const submitSshPassword = async () => {
    if (!sshPasswordView) return
    setSshPasswordView({ ...sshPasswordView, saving: true, error: undefined })
    try {
      await api.sshSetPassword(
        sshPasswordView.controller,
        sshPasswordView.record.id,
        sshPasswordView.password,
      )
      toast('已重新连接', 'success')
      setSshPasswordView(null)
      void refreshSshHosts()
    } catch (err) {
      setSshPasswordView({
        ...sshPasswordView,
        saving: false,
        error: err instanceof Error ? err.message : '连接失败',
      })
    }
  }

  const handleAdd = () => {
    setAddError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setAddError('请填写主机名称')
      return
    }
    if (
      hosts.some((h) => h.name.trim().toLowerCase() === trimmedName.toLowerCase())
    ) {
      setAddError('名称已被使用，请换一个唯一的名称')
      return
    }
    if (!token.trim()) {
      setAddError('请填写主机 Token')
      return
    }
    setSaving(true)
    try {
      if (mode === 'relay') {
        if (cryptoSupported === false) throw new Error(RELAY_UNSUPPORTED_MESSAGE)
        if (!relayUrl.trim()) throw new Error('请填写中继地址')
        if (!hostId.trim()) throw new Error('请填写主机 ID')
        if (!isValidFingerprint(fingerprint)) {
          throw new Error('必须填写主机公钥指纹（64 位十六进制）')
        }
        const base = normalizeHostUrl(relayUrl)
        addHost({
          name: name.trim(),
          url: relayHostUrl(base, hostId.trim()),
          token: token.trim(),
          mode: 'relay',
          relayUrl: base,
          hostId: hostId.trim(),
          fingerprint: normalizeFingerprint(fingerprint),
        })
      } else {
        if (!url.trim()) throw new Error('请填写主机地址')
        addHost({ name: name.trim(), url: url.trim(), token: token.trim() })
      }
      toast('主机已添加', 'success')
      resetAdd()
      setAdding(false)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setSaving(false)
    }
  }

  const connectLink = async (raw: string) => {
    setAddError(null)
    const invite = parseInviteLink(raw)
    if (invite) {
      useUiStore.getState().openJoinInvite(invite)
      resetAdd()
      setAdding(false)
      return
    }
    setSaving(true)
    try {
      const target = parsePairLink(raw)
      if (!target) throw new Error('不是有效的 Tandem 配对链接')
      if (target.kind === 'relay' && cryptoSupported === false) {
        throw new Error(RELAY_UNSUPPORTED_MESSAGE)
      }
      const probe: HostConfig = {
        id: 'probe',
        name: 'probe',
        url: target.url,
        token: target.token,
        addedAt: Date.now(),
        ...(target.kind === 'relay'
          ? {
              mode: 'relay' as const,
              relayUrl: target.relayUrl,
              hostId: target.hostId,
              fingerprint: target.fingerprint,
            }
          : {}),
      }
      const info = await api.host(probe)
      const host = addHost({
        name: info.name || new URL(target.url).host,
        url: target.url,
        token: target.token,
        ...(target.kind === 'relay'
          ? {
              mode: 'relay' as const,
              relayUrl: target.relayUrl,
              hostId: target.hostId,
              fingerprint: target.fingerprint,
            }
          : {}),
      })
      toast(`已连接 ${host.name}`, 'success')
      resetAdd()
      setAdding(false)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : '连接失败')
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (id: string) => {
    const h = hosts.find((x) => x.id === id)
    if (!h) return
    setEditId(id)
    setEditName(h.name)
    setEditUrl(h.url)
    setEditToken(h.token)
    setEditRelayUrl(h.relayUrl ?? '')
    setEditHostId(h.hostId ?? '')
    setEditFingerprint(h.fingerprint ?? '')
  }

  const saveEdit = () => {
    if (!editId) return
    const host = hosts.find((x) => x.id === editId)
    if (!host) return
    const nextName = editName.trim()
    if (!nextName) {
      toast('名称不能为空', 'error')
      return
    }
    if (hosts.some((h) => h.id !== editId && h.name.trim().toLowerCase() === nextName.toLowerCase())) {
      toast('名称已被使用，请换一个唯一的名称', 'error')
      return
    }
    try {
      if (host.mode === 'relay') {
        if (!isValidFingerprint(editFingerprint)) throw new Error('必须填写主机公钥指纹（64 位十六进制）')
        updateHost(editId, {
          name: editName,
          token: editToken,
          relayUrl: editRelayUrl,
          hostId: editHostId,
          fingerprint: normalizeFingerprint(editFingerprint),
        })
      } else {
        normalizeHostUrl(editUrl)
        updateHost(editId, { name: editName, url: editUrl, token: editToken })
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '主机配置无效', 'error')
      return
    }
    setEditId(null)
    toast('主机已更新', 'success')
  }

  return (
    <div>
      <div data-setting-id="hosts.list" className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">主机</h3>
        <span className="text-[13px] text-muted">每台主机对应一个 WS 长连接</span>
        <span className="flex-1" />
        {!gateOn && (
        <Button
          data-setting-id="hosts.ssh.add"
          onClick={() => {
            const controller = pickController()
            if (!controller) {
              toast('请先连接一台 Host 作为部署控制端', 'error')
              return
            }
            setSshController(controller)
          }}
          className="max-sm:min-h-11"
        >
          <Terminal size={13} />
          远程主机
        </Button>
        )}
        <Button
          data-setting-id="hosts.add"
          variant="primary"
          onClick={() => {
            // 登录门开启时主机只来自账号：添加主机 = 复制一行命令到目标机器执行。
            if (gateOn) useUiStore.getState().setAddHostOpen(true)
            else setAdding((v) => !v)
          }}
          className="max-sm:min-h-11"
        >
          {adding && !gateOn ? <X size={13} /> : <Plus size={13} />}
          {adding && !gateOn ? '收起' : '添加主机'}
        </Button>
      </div>

      {adding && !gateOn && (
        <div data-setting-id="hosts.mode" className="mb-4 rounded-xl border border-border bg-surface p-3.5">
          <div>
            <label className="settings-label">配对链接（直连或中继）</label>
            <div className="flex gap-1.5">
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://relay.example.com/h/…/#pair=… 或 http://…/?token=…"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 font-mono text-[13px]"
              />
              <Button
                onClick={() => void connectLink(link)}
                disabled={saving || !link.trim()}
                className="shrink-0"
              >
                {saving && <Spinner size={12} />}
                解析并连接
              </Button>
              {canScan && (
                <IconButton
                  onClick={() => setScanOpen(true)}
                  label="扫码添加主机"
                  tooltip="扫码"
                  className="size-9"
                >
                  <ScanLine size={13} />
                </IconButton>
              )}
            </div>
            <p className="mt-1.5 text-[13px] leading-4 text-muted">
              中继配对链接里的指纹会一并带入；解析后自动创建主机。
            </p>
          </div>

          <div className="my-3 flex items-center gap-2 text-[13px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

          <SegmentedControl
            aria-label="连接方式"
            className="mb-3 flex w-full"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'direct', label: '直连' },
              { value: 'relay', label: '中继 · 加密' },
            ]}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="settings-label">名称（必填）</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="唯一名称，例如：局域网工作站"
              />
            </div>
            <div>
              <label className="settings-label">访问 Token</label>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="主机启动日志或配对链接中的 Token"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[13px]"
              />
            </div>
            {mode === 'direct' ? (
              <div className="sm:col-span-2">
                <label className="settings-label">主机地址</label>
                <div className="flex gap-1.5">
                  <Input
                        value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="http://192.168.1.10:7878"
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                  <Button
                        onClick={() => setUrl(window.location.origin)}
                    tooltip="使用当前地址"
                    className="shrink-0 px-2 text-[13px]"
                  >
                    <Laptop size={12} /> 本机
                  </Button>
                </div>
                <p className="mt-1.5 text-[13px] leading-4 text-muted">
                  Token 只保存在本机浏览器里；远程主机请确保网络可达（局域网 / Tailscale / 端口转发）。
                </p>
              </div>
            ) : (
              <>
                <div className="sm:col-span-2">
                  <label className="settings-label">中继地址</label>
                  <input
                    value={relayUrl}
                    onChange={(e) => setRelayUrl(e.target.value)}
                    placeholder="https://relay.example.com"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[13px]')}
                  />
                </div>
                <div>
                  <label className="settings-label">主机 ID</label>
                  <input
                    value={hostId}
                    onChange={(e) => setHostId(e.target.value)}
                    placeholder="中继上的主机 ID"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[13px]')}
                  />
                </div>
                <div>
                  <label className="settings-label">公钥指纹（必填）</label>
                  <input
                    value={fingerprint}
                    onChange={(e) => setFingerprint(e.target.value)}
                    placeholder="SHA-256，64 位十六进制"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[13px]')}
                  />
                </div>
                <p className="text-[13px] leading-4 text-muted sm:col-span-2">
                  指纹必须通过中继之外的渠道获得（主机启动日志 / 本机配对二维码）。连接时指纹不符会拒绝连接。
                </p>
              </>
            )}
          </div>
          {mode === 'relay' && cryptoSupported === false && (
            <div className="mt-2 flex items-center gap-1.5 text-[13px] text-warning">
              <TriangleAlert size={12} /> {RELAY_UNSUPPORTED_MESSAGE}
            </div>
          )}
          {addError && (
            <div className="mt-2 flex items-center gap-1.5 text-[13px] text-danger">
              <TriangleAlert size={12} /> {addError}
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={saving || (mode === 'relay' && cryptoSupported === false)}
            >
              {saving && <Spinner size={14} />}
              添加
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {hosts.length === 0 && (
          <div className="settings-empty">
            <span className="settings-empty-icon"><Server size={17} /></span>
            <p className="settings-empty-title">还没有 Host</p>
            <p className="settings-empty-hint">
              {gateOn
                ? '点「添加主机」，复制一行命令到目标机器执行即可。'
                : '在目标机器启动 Tandem Host，然后添加它的地址与 Token。'}
            </p>
          </div>
        )}
        {hosts.map((h) => {
          const rt = runtimes[h.id]
          const editing = editId === h.id
          const ssh = h.mode === 'ssh' ? recordFor(h) : undefined
          const hostVersion = rt?.info?.version
          const versionMismatch = rt?.status === 'online' && !!hostVersion && hostVersion !== APP_VERSION
          return (
            <div
              key={h.id}
              className="settings-item p-3"
            >
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-soft">
                  <Server size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold">{h.name}</span>
                    <ConnectionDot state={rt?.status ?? 'connecting'} />
                    <span className="text-[13px] text-muted">
                      {rt?.status === 'online'
                        ? '在线'
                        : rt?.status === 'connecting'
                          ? '连接中'
                          : '离线'}
                    </span>
                    {h.id === activeHostId && (
                      <span className="rounded border border-border px-1.5 py-px text-[12px] text-text-secondary">
                        当前
                      </span>
                    )}
                    {versionMismatch && (
                      <span
                        data-tip={`主机 ${hostVersion} · 客户端 ${APP_VERSION}。请把两端升级到同一版本，避免协议不一致。`}
                        className="inline-flex items-center gap-1 rounded border border-warning/40 px-1.5 py-px text-[12px] text-warning"
                      >
                        <TriangleAlert size={10} /> 版本不一致
                      </span>
                    )}
                    {h.mode === 'ssh' && (
                      <span
                        data-setting-id="hosts.ssh.badge"
                        className="rounded border border-border px-1.5 py-px text-[12px] text-text-secondary"
                      >
                        SSH
                      </span>
                    )}
                    {ssh?.record.upgradeAvailable && (
                      <span className="rounded border border-warning/40 px-1.5 py-px text-[12px] text-warning">
                        可升级
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 break-all font-mono text-[13px] text-muted">
                    <span>{h.url}</span>
                    <span className="font-sans">
                      {h.mode === 'relay'
                        ? '中继 · 加密'
                        : h.mode === 'ssh'
                          ? `SSH${ssh?.record.latencyMs !== undefined ? ` · ${ssh.record.latencyMs}ms` : ''}`
                          : '直连'}
                    </span>
                  </div>
                  {h.mode === 'ssh' && (
                    <div className="mt-0.5 text-[12px] leading-4 text-muted">
                      {ssh?.record.needsPassword
                        ? '需要重新输入 SSH 密码（密码不会保存）'
                        : ssh?.record.state === 'online'
                          ? `经 SSH 隧道连接 ${ssh.record.target.user}@${ssh.record.target.host} · 延迟 ${ssh.record.latencyMs ?? '—'}ms`
                          : ssh?.record.lastError
                            ? `隧道：${ssh.record.lastError}`
                            : 'SSH 隧道连接中…'}
                      {ssh?.record.upgradeAvailable && ` · 远程 ${ssh.record.remoteVersion}，本机 ${ssh.record.localVersion}`}
                    </div>
                  )}
                  {h.mode === 'relay' && cryptoSupported === false && (
                    <div className="mt-0.5 text-[13px] leading-4 text-warning">{RELAY_UNSUPPORTED_MESSAGE}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
                    <span className="font-mono">{h.token ? '•••• 已保存' : '无 Token'}</span>
                    {rt?.info?.platform && (
                      <>
                        <span>·</span>
                        <span>
                          {rt.info.platform} {rt.info.version}
                        </span>
                      </>
                    )}
                    {rt?.info?.homeDir && (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="hidden max-w-[220px] truncate font-mono sm:inline">
                          {rt.info.homeDir}
                        </span>
                      </>
                    )}
                  </div>
                  {rt?.authError && (
                    <div className="mt-1 flex items-center gap-1 text-[13px] text-danger">
                      <TriangleAlert size={11} /> {rt.authError}
                    </div>
                  )}
                  {rt?.error && h.mode === 'relay' && (
                    <div className="mt-1 flex items-start gap-1 text-[13px] leading-4 text-danger">
                      <TriangleAlert size={11} className="mt-0.5 shrink-0" /> {rt.error}
                    </div>
                  )}
                  {(rt?.authError || rt?.error || rt?.status === 'offline') &&
                    (isLocalHostUrl(h.url) || isSameOrigin(h.url)) && (
                      <Button
                        onClick={() => openDoctor(h.id)}
                        className="mt-1 min-h-8 px-2 text-[12px]"
                      >
                        <Stethoscope size={11} /> 运行诊断
                      </Button>
                    )}
                </div>
                <div className="settings-actions hidden sm:flex" data-desktop-only="" data-open={editing || undefined}>
                  {h.mode === 'ssh' && ssh && (
                    <Menu
                      side="bottom"
                      align="end"
                      aria-label="远程主机操作"
                      trigger={
                        <IconButton
                          size="sm"
                          data-setting-id="hosts.ssh.menu"
                          label="远程主机操作"
                          tooltip="更多操作"
                          className="size-7 [&_svg]:size-3"
                        >
                          <MoreHorizontal size={12} />
                        </IconButton>
                      }
                    >
                      <Menu.Item
                        icon={<RotateCcw size={13} />}
                        onSelect={() =>
                          void startSshJob(ssh.controller, '重启', () =>
                            api.sshRestart(ssh.controller, ssh.record.id),
                          )
                        }
                      >
                        重启
                      </Menu.Item>
                      <Menu.Item
                        icon={<FileText size={13} />}
                        onSelect={() => void openSshLogs(ssh.controller, ssh.record)}
                      >
                        查看日志
                      </Menu.Item>
                      <Menu.Item
                        icon={<ArrowUpCircle size={13} />}
                        disabled={!ssh.record.upgradeAvailable}
                        disabledReason="当前已是最新版本"
                        onSelect={() =>
                          void startSshJob(ssh.controller, '升级', () =>
                            api.sshUpgrade(ssh.controller, ssh.record.id),
                          )
                        }
                      >
                        升级到本机版本
                      </Menu.Item>
                      {ssh.record.needsPassword && (
                        <Menu.Item
                          icon={<KeyRound size={13} />}
                          onSelect={() =>
                            setSshPasswordView({
                              controller: ssh.controller,
                              record: ssh.record,
                              password: '',
                              saving: false,
                            })
                          }
                        >
                          重新输入密码
                        </Menu.Item>
                      )}
                      <Menu.Separator />
                      <Menu.Item icon={<Stethoscope size={13} />} onSelect={() => openDoctor(h.id)}>
                        诊断
                      </Menu.Item>
                      <Menu.Item
                        danger
                        icon={<PowerOff size={13} />}
                        onSelect={() =>
                          setSshUninstall({
                            controller: ssh.controller,
                            record: ssh.record,
                            clientHostId: h.id,
                            keepData: true,
                          })
                        }
                      >
                        卸载…
                      </Menu.Item>
                    </Menu>
                  )}
                  <IconButton
                    size="sm"
                    data-setting-id="hosts.doctor"
                    onClick={() => openDoctor(h.id)}
                    label="诊断"
                    tooltip="诊断这台主机"
                    className="size-7 [&_svg]:size-3"
                  >
                    <Stethoscope size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    data-setting-id="hosts.pair"
                    onClick={() => setPairHost(h.id)}
                    label="连接手机"
                    tooltip="连接手机（扫码配对）"
                    className="size-7 [&_svg]:size-3"
                  >
                    <Smartphone size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={() => retryHost(h.id)}
                    label="重新连接"
                    tooltip="重新连接"
                    className="size-7 [&_svg]:size-3"
                  >
                    <RefreshCw size={12} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={() => (editing ? setEditId(null) : startEdit(h.id))}
                    label="编辑 Host"
                    tooltip="编辑"
                    className="size-7 [&_svg]:size-3"
                  >
                    {editing ? <ChevronDown size={12} /> : <Pencil size={12} />}
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => setRemoveTarget({ id: h.id, name: h.name })}
                    label="移除 Host"
                    tooltip="移除"
                    className="size-7 [&_svg]:size-3"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 pt-2 sm:hidden">
                {h.mode === 'ssh' && ssh && (
                  <Menu
                    side="top"
                    align="end"
                    aria-label="远程主机操作"
                    trigger={
                      <Button size="md" className="min-h-10 px-2.5 text-[13px]">
                        <MoreHorizontal size={12} /> 管理
                      </Button>
                    }
                  >
                    <Menu.Item
                      icon={<RotateCcw size={13} />}
                      onSelect={() =>
                        void startSshJob(ssh.controller, '重启', () =>
                          api.sshRestart(ssh.controller, ssh.record.id),
                        )
                      }
                    >
                      重启
                    </Menu.Item>
                    <Menu.Item
                      icon={<FileText size={13} />}
                      onSelect={() => void openSshLogs(ssh.controller, ssh.record)}
                    >
                      查看日志
                    </Menu.Item>
                    <Menu.Item
                      icon={<ArrowUpCircle size={13} />}
                      disabled={!ssh.record.upgradeAvailable}
                      disabledReason="当前已是最新版本"
                      onSelect={() =>
                        void startSshJob(ssh.controller, '升级', () =>
                          api.sshUpgrade(ssh.controller, ssh.record.id),
                        )
                      }
                    >
                      升级
                    </Menu.Item>
                    {ssh.record.needsPassword && (
                      <Menu.Item
                        icon={<KeyRound size={13} />}
                        onSelect={() =>
                          setSshPasswordView({
                            controller: ssh.controller,
                            record: ssh.record,
                            password: '',
                            saving: false,
                          })
                        }
                      >
                        重新输入密码
                      </Menu.Item>
                    )}
                    <Menu.Separator />
                    <Menu.Item icon={<Stethoscope size={13} />} onSelect={() => openDoctor(h.id)}>
                      诊断
                    </Menu.Item>
                    <Menu.Item
                      danger
                      icon={<PowerOff size={13} />}
                      onSelect={() =>
                        setSshUninstall({
                          controller: ssh.controller,
                          record: ssh.record,
                          clientHostId: h.id,
                          keepData: true,
                        })
                      }
                    >
                      卸载…
                    </Menu.Item>
                  </Menu>
                )}
                <Button
                  size="md"
                  onClick={() => openDoctor(h.id)}
                  className="min-h-10 px-2.5 text-[13px]"
                >
                  <Stethoscope size={12} /> 诊断
                </Button>
                <Button
                  size="md"
                  onClick={() => setPairHost(h.id)}
                  className="min-h-10 px-2.5 text-[13px]"
                >
                  <Smartphone size={12} /> 连接手机
                </Button>
                <Button
                  size="md"
                  onClick={() => retryHost(h.id)}
                  className="min-h-10 px-2.5 text-[13px]"
                >
                  <RefreshCw size={12} /> 重连
                </Button>
                <Button
                  size="md"
                  onClick={() => (editing ? setEditId(null) : startEdit(h.id))}
                  className="min-h-10 px-2.5 text-[13px]"
                >
                  {editing ? <ChevronDown size={12} /> : <Pencil size={12} />} 编辑
                </Button>
                <IconButton
                  variant="danger-ghost"
                  onClick={() => setRemoveTarget({ id: h.id, name: h.name })}
                  label="移除 Host"
                  className="size-10!"
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>

              {editing && (
                <div className="mt-3 grid gap-2.5 border-t border-border/70 pt-3 sm:grid-cols-2">
                  <div>
                    <label className="settings-label">名称（必填）</label>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="settings-label">Token</label>
                    <input
                      value={editToken}
                      onChange={(e) => setEditToken(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={cn(inputCls, 'font-mono text-[13px]')}
                    />
                  </div>
                  {h.mode === 'relay' ? (
                    <>
                      <div className="sm:col-span-2">
                        <label className="settings-label">中继地址</label>
                        <input
                          value={editRelayUrl}
                          onChange={(e) => setEditRelayUrl(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[13px]')}
                        />
                      </div>
                      <div>
                        <label className="settings-label">主机 ID</label>
                        <input
                          value={editHostId}
                          onChange={(e) => setEditHostId(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[13px]')}
                        />
                      </div>
                      <div>
                        <label className="settings-label">公钥指纹</label>
                        <input
                          value={editFingerprint}
                          onChange={(e) => setEditFingerprint(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[13px]')}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="sm:col-span-2">
                      <label className="settings-label">地址</label>
                      <input
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        spellCheck={false}
                        className={cn(inputCls, 'font-mono text-[13px]')}
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 sm:col-span-2">
                    <Button onClick={() => setEditId(null)}>
                      取消
                    </Button>
                    <Button variant="primary" onClick={saveEdit}>
                      <Check size={12} /> 保存
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="settings-note">
        修改地址或 Token 会自动重连并重新订阅当前会话。多个标签页/手机可以同时连接同一主机。
      </p>
      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title="移除 Host"
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger-ghost"
              onClick={() => {
                if (!removeTarget) return
                removeHost(removeTarget.id)
                setEditId(null)
                setRemoveTarget(null)
              }}
            >
              移除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          移除 Host「{removeTarget?.name}」？这不会影响 主机上的数据。
        </p>
        {hosts.find((item) => item.id === removeTarget?.id)?.mode === 'ssh' && (
          <p className="mt-2 text-[12px] leading-5 text-warning">
            这是 SSH 远程主机：仅移除客户端条目不会停止远程服务与隧道。请先用 ⋯ → 卸载 停止远程 Host。
          </p>
        )}
      </Modal>

      {pairHost && (() => {
        const host = hosts.find((x) => x.id === pairHost)
        return host ? <PairDialog host={host} onClose={() => setPairHost(null)} /> : null
      })()}

      {scanOpen && (
        <QrScanDialog
          onClose={() => setScanOpen(false)}
          onResult={(raw) => {
            setScanOpen(false)
            setLink(raw)
            void connectLink(raw)
          }}
        />
      )}

      {sshController && (
        <RemoteSshDialog controller={sshController} onClose={() => setSshController(null)} />
      )}

      {sshJobView && (
        <Modal
          open
          onClose={() => {
            if (sshJobView.job.status !== 'running') setSshJobView(null)
          }}
          title={sshJobView.title}
          description={`由「${sshJobView.controller.name}」通过 SSH 执行`}
          className="max-w-lg"
          footer={
            <Button
              onClick={() => setSshJobView(null)}
              disabled={sshJobView.job.status === 'running'}
            >
              关闭
            </Button>
          }
        >
          <div data-setting-id="hosts.ssh.job">
            <SshJobProgress job={sshJobView.job} />
          </div>
        </Modal>
      )}

      {sshLogView && (
        <Modal
          open
          onClose={() => setSshLogView(null)}
          title={`远程日志 · ${sshLogView.record.name}`}
          description={`${sshLogView.record.target.user}@${sshLogView.record.target.host} · 最近 200 行`}
          className="max-w-3xl"
          footer={
            <>
              <Button
                onClick={() => void openSshLogs(sshLogView.controller, sshLogView.record)}
                disabled={sshLogView.loading}
              >
                {sshLogView.loading && <Spinner size={13} />}
                刷新
              </Button>
              <Button onClick={() => setSshLogView(null)}>关闭</Button>
            </>
          }
        >
          <div data-setting-id="hosts.ssh.logs">
            {sshLogView.error ? (
              <div className="text-[13px] text-danger">{sshLogView.error}</div>
            ) : (
              <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-surface-2 p-2.5 font-mono text-[12px] leading-5 text-text-soft">
                {sshLogView.loading
                  ? '读取中…'
                  : sshLogView.lines.length > 0
                    ? sshLogView.lines.join('\n')
                    : '（暂无日志）'}
              </pre>
            )}
          </div>
        </Modal>
      )}

      <Modal
        open={!!sshUninstall}
        onClose={() => setSshUninstall(null)}
        title="卸载远程主机"
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setSshUninstall(null)}>取消</Button>
            <Button
              variant="danger-ghost"
              data-setting-id="hosts.ssh.uninstall.confirm"
              onClick={() => {
                const view = sshUninstall
                if (!view) return
                setSshUninstall(null)
                void startSshJob(
                  view.controller,
                  '卸载',
                  () => api.sshUninstall(view.controller, view.record.id, view.keepData),
                  view.clientHostId,
                )
              }}
            >
              停止并卸载
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          将停止远程 Host 服务并删除 <span className="font-mono">~/.tandem-host</span>（程序文件）。
          客户端里的这台主机也会被移除。
        </p>
        <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px]">
          <span>
            保留远程数据 <span className="font-mono text-[12px] text-muted">~/.tandem</span>
            <span className="block text-[12px] leading-4 text-muted">含会话、账号 Key、设置；关闭则一并删除。</span>
          </span>
          <Switch
            checked={sshUninstall?.keepData ?? true}
            onChange={(checked) =>
              setSshUninstall((current) => (current ? { ...current, keepData: checked } : current))
            }
            label="保留远程数据"
          />
        </label>
      </Modal>

      <Modal
        open={!!sshPasswordView}
        onClose={() => setSshPasswordView(null)}
        title="重新输入 SSH 密码"
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setSshPasswordView(null)} disabled={sshPasswordView?.saving}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitSshPassword()}
              disabled={sshPasswordView?.saving || !sshPasswordView?.password}
            >
              {sshPasswordView?.saving && <Spinner size={13} />}
              连接
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-5 text-text-soft">
          Host 重启后内存中的密码已清空。密码只用于这次连接，不会保存。
        </p>
        <Input
          type="password"
          value={sshPasswordView?.password ?? ''}
          onChange={(e) =>
            setSshPasswordView((current) =>
              current ? { ...current, password: e.target.value, error: undefined } : current,
            )
          }
          autoComplete="new-password"
          className="mt-2 font-mono text-[13px]"
          placeholder="SSH 登录密码"
        />
        {sshPasswordView?.error && (
          <div className="mt-2 text-[12px] leading-4 text-danger">{sshPasswordView.error}</div>
        )}
      </Modal>
    </div>
  )
}
