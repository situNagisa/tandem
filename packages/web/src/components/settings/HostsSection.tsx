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
  'h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[12.5px] text-text outline-none transition-colors focus:border-border-strong'
const labelCls = 'mb-1.5 block text-[11px] font-medium text-muted'

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
        <span className="text-[11px] text-muted">每台 Host 对应一个 WS 长连接</span>
        <span className="flex-1" />
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover sm:min-h-8"
        >
          {adding ? <X size={13} /> : <Plus size={13} />}
          {adding ? '收起' : '添加 Host'}
        </button>
      </div>

      {adding && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-3.5">
          <div>
            <label className={labelCls}>配对链接（直连或中继）</label>
            <div className="flex gap-1.5">
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://relay.example.com/h/…/#pair=… 或 http://…/?token=…"
                spellCheck={false}
                autoComplete="off"
                className={cn(inputCls, 'min-w-0 flex-1 font-mono text-[11.5px]')}
              />
              <button
                onClick={() => void connectLink(link)}
                disabled={saving || !link.trim()}
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                解析并连接
              </button>
              {canScan && (
                <button
                  onClick={() => setScanOpen(true)}
                  title="扫码"
                  aria-label="扫码添加 Host"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <ScanLine size={13} />
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-4 text-muted">
              中继配对链接里的指纹会一并带入；解析后自动创建 Host。
            </p>
          </div>

          <div className="my-3 flex items-center gap-2 text-[10px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

          <div className="mb-3 flex rounded-md bg-[var(--t-bg-subtle)] p-0.5">
            {(['direct', 'relay'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex h-7 flex-1 items-center justify-center rounded px-2 text-[11px] transition-colors',
                  mode === m
                    ? 'bg-[var(--t-bg-active)] text-text'
                    : 'text-muted hover:text-text-soft',
                )}
              >
                {m === 'direct' ? '直连' : '中继 · 加密'}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>名称（可选）</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：局域网工作站"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>访问 Token</label>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Host 启动日志或配对链接中的 Token"
                spellCheck={false}
                autoComplete="off"
                className={cn(inputCls, 'font-mono text-[11.5px]')}
              />
            </div>
            {mode === 'direct' ? (
              <div className="sm:col-span-2">
                <label className={labelCls}>Host 地址</label>
                <div className="flex gap-1.5">
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="http://192.168.1.10:7878"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[11.5px]')}
                  />
                  <button
                    onClick={() => setUrl(window.location.origin)}
                    title="使用当前地址"
                    className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-[10.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    <Laptop size={12} /> 本机
                  </button>
                </div>
                <p className="mt-1.5 text-[10.5px] leading-4 text-muted">
                  Token 只保存在本机浏览器里；远程 Host 请确保网络可达（局域网 / Tailscale / 端口转发）。
                </p>
              </div>
            ) : (
              <>
                <div className="sm:col-span-2">
                  <label className={labelCls}>中继地址</label>
                  <input
                    value={relayUrl}
                    onChange={(e) => setRelayUrl(e.target.value)}
                    placeholder="https://relay.example.com"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[11.5px]')}
                  />
                </div>
                <div>
                  <label className={labelCls}>Host ID</label>
                  <input
                    value={hostId}
                    onChange={(e) => setHostId(e.target.value)}
                    placeholder="中继上的 Host ID"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[11.5px]')}
                  />
                </div>
                <div>
                  <label className={labelCls}>公钥指纹（必填）</label>
                  <input
                    value={fingerprint}
                    onChange={(e) => setFingerprint(e.target.value)}
                    placeholder="SHA-256，64 位十六进制"
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[11.5px]')}
                  />
                </div>
                <p className="text-[10.5px] leading-4 text-muted sm:col-span-2">
                  指纹必须通过中继之外的渠道获得（Host 启动日志 / 本机配对二维码）。连接时指纹不符会拒绝连接。
                </p>
              </>
            )}
          </div>
          {mode === 'relay' && cryptoSupported === false && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warning">
              <TriangleAlert size={12} /> {RELAY_UNSUPPORTED_MESSAGE}
            </div>
          )}
          {addError && (
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-danger">
              <TriangleAlert size={12} /> {addError}
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setAdding(false)}
              className="min-h-11 rounded-lg border border-border bg-surface px-3 text-[12px] text-text-soft transition-colors hover:bg-surface-2 sm:min-h-9"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || (mode === 'relay' && cryptoSupported === false)}
              className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60 sm:min-h-9"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              添加
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {hosts.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-bg/30 px-4 py-8 text-center">
            <Server size={22} className="mx-auto text-muted" />
            <p className="mt-2 text-[12.5px] text-text-soft">还没有 Host</p>
            <p className="mt-1 text-[11.5px] text-muted">
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
              className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong/60"
            >
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-soft">
                  <Server size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold">{h.name}</span>
                    <ConnectionDot state={rt?.status ?? 'connecting'} />
                    <span className="text-[10px] text-muted">
                      {rt?.status === 'online'
                        ? '在线'
                        : rt?.status === 'connecting'
                          ? '连接中'
                          : '离线'}
                    </span>
                    {h.id === activeHostId && (
                      <span className="rounded border border-border px-1.5 py-px text-[9.5px] text-text-secondary">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 break-all font-mono text-[10.5px] text-muted">
                    <span>{h.url}</span>
                    <span className="font-sans">{h.mode === 'relay' ? '中继 · 加密' : '直连'}</span>
                  </div>
                  {h.mode === 'relay' && cryptoSupported === false && (
                    <div className="mt-0.5 text-[10.5px] leading-4 text-warning">{RELAY_UNSUPPORTED_MESSAGE}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
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
                    <div className="mt-1 flex items-center gap-1 text-[10.5px] text-danger">
                      <TriangleAlert size={11} /> {rt.authError}
                    </div>
                  )}
                  {rt?.error && h.mode === 'relay' && (
                    <div className="mt-1 flex items-start gap-1 text-[10.5px] leading-4 text-danger">
                      <TriangleAlert size={11} className="mt-0.5 shrink-0" /> {rt.error}
                    </div>
                  )}
                </div>
                <div className="hidden shrink-0 items-center gap-1 sm:flex">
                  <button
                    onClick={() => setPairHost(h.id)}
                    title="连接手机（扫码配对）"
                    aria-label="连接手机"
                    className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    <Smartphone size={12} />
                  </button>
                  <button
                    onClick={() => retryHost(h.id)}
                    title="重新连接"
                    aria-label="重新连接"
                    className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => (editing ? setEditId(null) : startEdit(h.id))}
                    title="编辑"
                    aria-label="编辑 Host"
                    className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    {editing ? <ChevronDown size={12} /> : <Pencil size={12} />}
                  </button>
                  <button
                    onClick={() => setRemoveTarget({ id: h.id, name: h.name })}
                    title="移除"
                    aria-label="移除 Host"
                    className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/60 pt-2 sm:hidden">
                <button
                  onClick={() => setPairHost(h.id)}
                  className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <Smartphone size={12} /> 连接手机
                </button>
                <button
                  onClick={() => retryHost(h.id)}
                  className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <RefreshCw size={12} /> 重连
                </button>
                <button
                  onClick={() => (editing ? setEditId(null) : startEdit(h.id))}
                  className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  {editing ? <ChevronDown size={12} /> : <Pencil size={12} />} 编辑
                </button>
                <button
                  onClick={() => setRemoveTarget({ id: h.id, name: h.name })}
                  aria-label="移除 Host"
                  className="flex min-h-10 items-center gap-1.5 rounded-lg border border-danger/25 px-2.5 text-[11px] text-danger transition-colors hover:bg-danger-soft"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {editing && (
                <div className="mt-3 grid gap-2.5 border-t border-border/70 pt-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>名称</label>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Token</label>
                    <input
                      value={editToken}
                      onChange={(e) => setEditToken(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={cn(inputCls, 'font-mono text-[11.5px]')}
                    />
                  </div>
                  {h.mode === 'relay' ? (
                    <>
                      <div className="sm:col-span-2">
                        <label className={labelCls}>中继地址</label>
                        <input
                          value={editRelayUrl}
                          onChange={(e) => setEditRelayUrl(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[11.5px]')}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Host ID</label>
                        <input
                          value={editHostId}
                          onChange={(e) => setEditHostId(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[11.5px]')}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>公钥指纹</label>
                        <input
                          value={editFingerprint}
                          onChange={(e) => setEditFingerprint(e.target.value)}
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[11.5px]')}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="sm:col-span-2">
                      <label className={labelCls}>地址</label>
                      <input
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        spellCheck={false}
                        className={cn(inputCls, 'font-mono text-[11.5px]')}
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 sm:col-span-2">
                    <button
                      onClick={() => setEditId(null)}
                      className="min-h-8 rounded-lg border border-border bg-surface px-3 text-[11.5px] text-text-soft transition-colors hover:bg-surface-2"
                    >
                      取消
                    </button>
                    <button
                      onClick={saveEdit}
                      className="flex min-h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
                    >
                      <Check size={12} /> 保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="mt-4 text-[10.5px] leading-4 text-muted">
        修改地址或 Token 会自动重连并重新订阅当前会话。多个标签页/手机可以同时连接同一 Host。
      </p>
      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title="移除 Host"
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setRemoveTarget(null)}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (!removeTarget) return
                removeHost(removeTarget.id)
                setEditId(null)
                setRemoveTarget(null)
              }}
              className="min-h-9 rounded-lg btn-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              移除
            </button>
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
