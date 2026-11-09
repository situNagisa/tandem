import { useState } from 'react'
import {
  Check,
  ChevronDown,
  Laptop,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Server,
  Smartphone,
  Stethoscope,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { normalizeHostUrl, isLocalHostUrl, isSameOrigin } from '../../lib/hostUrl'
import { APP_VERSION } from '../../lib/changelog'
import { useUiStore } from '../../store/useUiStore'
import { ConnectionDot } from '../StatusDot'
import { PairDialog } from './PairDialog'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { loginGateEnabled } from '../../lib/loginGate'
import { QrScanDialog, scannerSupported } from '../QrScanDialog'
import { parsePairLink } from '../../lib/pairLink'
import { parseInviteLink } from '../../lib/inviteLink'
import { isValidFingerprint, normalizeFingerprint } from '../../lib/relay'
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
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [link, setLink] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const canScan = scannerSupported()

  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editToken, setEditToken] = useState('')
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null)
  const [pairHost, setPairHost] = useState<string | null>(null)

  const resetAdd = () => {
    setName('')
    setUrl('')
    setToken('')
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
      setAddError('请填写主机 Token')
      return
    }
    setSaving(true)
    try {
      if (!url.trim()) throw new Error('请填写主机地址')
      addHost({ name: name.trim(), url: url.trim(), token: token.trim() })
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
      const probe: HostConfig = {
        id: 'probe',
        name: 'probe',
        url: target.url,
        token: target.token,
        addedAt: Date.now(),
      }
      const info = await api.host(probe)
      const host = addHost({
        name: info.name || new URL(target.url).host,
        url: target.url,
        token: target.token,
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
        updateHost(editId, { name: editName, token: editToken })
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
            <label className="settings-label">配对链接</label>
            <div className="flex gap-1.5">
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="http://192.168.1.10:7878/?token=…"
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
              解析后自动创建主机；地址与 Token 可在下方修改。
            </p>
          </div>

          <div className="my-3 flex items-center gap-2 text-[13px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

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
          </div>
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
              disabled={saving}
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
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 break-all font-mono text-[13px] text-muted">
                    <span>{h.url}</span>
                    <span className="font-sans">
                      {h.mode === 'relay' ? '加密隧道' : '直连'}
                    </span>
                  </div>
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
                  {rt?.error && (
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
                  <div className="sm:col-span-2">
                    <label className="settings-label">地址</label>
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      readOnly={h.mode === 'relay'}
                      spellCheck={false}
                      className={cn(inputCls, 'font-mono text-[13px]')}
                    />
                  </div>
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
