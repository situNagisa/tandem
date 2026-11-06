import { useState } from 'react'
import {
  Check,
  ChevronDown,
  Laptop,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Server,
  Smartphone,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { normalizeHostUrl } from '../../lib/hostUrl'
import { useUiStore } from '../../store/useUiStore'
import { ConnectionDot } from '../StatusDot'
import { PairDialog } from './PairDialog'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { QrScanDialog, scannerSupported } from '../QrScanDialog'
import { parsePairLink } from '../../lib/pairLink'
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
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const addHost = useAppStore((s) => s.addHost)
  const updateHost = useAppStore((s) => s.updateHost)
  const removeHost = useAppStore((s) => s.removeHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const toast = useUiStore((s) => s.toast)

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

  const resetAdd = () => {
    setName('')
    setUrl('')
    setToken('')
    setRelayUrl('')
    setHostId('')
    setFingerprint('')
    setLink('')
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
      setAddError('请填写 Host Token')
      return
    }
    setSaving(true)
    try {
      if (mode === 'relay') {
        if (cryptoSupported === false) throw new Error(RELAY_UNSUPPORTED_MESSAGE)
        if (!relayUrl.trim()) throw new Error('请填写中继地址')
        if (!hostId.trim()) throw new Error('请填写 Host ID')
        if (!isValidFingerprint(fingerprint)) {
          throw new Error('必须填写 Host 公钥指纹（64 位十六进制）')
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
        if (!url.trim()) throw new Error('请填写 Host 地址')
        addHost({ name: name.trim(), url: url.trim(), token: token.trim() })
      }
      toast('Host 已添加', 'success')
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
        if (!isValidFingerprint(editFingerprint)) throw new Error('必须填写 Host 公钥指纹（64 位十六进制）')
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
      toast(err instanceof Error ? err.message : 'Host 配置无效', 'error')
      return
    }
    setEditId(null)
    toast('Host 已更新', 'success')
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">Host 管理</h3>
        <span className="text-[13px] text-muted">每台 Host 对应一个 WS 长连接</span>
        <span className="flex-1" />
        <Button
          variant="secondary"
          onClick={() => setAdding((v) => !v)}
          className="max-sm:min-h-11"
        >
          {adding ? <X size={13} /> : <Plus size={13} />}
          {adding ? '收起' : '添加 Host'}
        </Button>
      </div>

      {adding && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-3.5">
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
                {saving && <Loader2 size={12} className="animate-spin" />}
                解析并连接
              </Button>
              {canScan && (
                <IconButton
                  onClick={() => setScanOpen(true)}
                  label="扫码添加 Host"
                  tooltip="扫码"
                  className="size-9"
                >
                  <ScanLine size={13} />
                </IconButton>
              )}
            </div>
            <p className="mt-1.5 text-[13px] leading-4 text-muted">
              中继配对链接里的指纹会一并带入；解析后自动创建 Host。
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
                placeholder="Host 启动日志或配对链接中的 Token"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[13px]"
              />
            </div>
            {mode === 'direct' ? (
              <div className="sm:col-span-2">
                <label className="settings-label">Host 地址</label>
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
                  Token 只保存在本机浏览器里；远程 Host 请确保网络可达（局域网 / Tailscale / 端口转发）。
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
                  <label className="settings-label">Host ID</label>
                  <input
                    value={hostId}
                    onChange={(e) => setHostId(e.target.value)}
                    placeholder="中继上的 Host ID"
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
                  指纹必须通过中继之外的渠道获得（Host 启动日志 / 本机配对二维码）。连接时指纹不符会拒绝连接。
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
              {saving && <Loader2 size={14} className="animate-spin" />}
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
              在目标机器启动 Tandem Host，然后添加它的地址与 Token。
            </p>
          </div>
        )}
        {hosts.map((h) => {
          const rt = runtimes[h.id]
          const editing = editId === h.id
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
                      <span className="rounded border border-border px-1.5 py-px text-[11px] text-text-secondary">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 break-all font-mono text-[13px] text-muted">
                    <span>{h.url}</span>
                    <span className="font-sans">{h.mode === 'relay' ? '中继 · 加密' : '直连'}</span>
                  </div>
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
                </div>
                <div className="settings-actions hidden sm:flex" data-desktop-only="" data-open={editing || undefined}>
                  <IconButton
                    size="sm"
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
                        <label className="settings-label">Host ID</label>
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
        修改地址或 Token 会自动重连并重新订阅当前会话。多个标签页/手机可以同时连接同一 Host。
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
          移除 Host「{removeTarget?.name}」？这不会影响 Host 机器上的数据。
        </p>
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
    </div>
  )
}
