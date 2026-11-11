import { useEffect, useState } from 'react'
import {
  Check,
  Pencil,
  RefreshCw,
  Server,
  ShieldCheck,
  Stethoscope,
  Trash2,
  TriangleAlert,
  Usb,
  UserPlus,
} from 'lucide-react'
import type { WorkspaceHostInfo } from '@tandem/protocol'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from '../ui/SettingRow'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { ConnectionDot } from '../StatusDot'
import { useAppStore } from '../../store/useAppStore'
import { useDevicesStore } from '../../store/useDevicesStore'
import { useUiStore } from '../../store/useUiStore'
import { toast } from '../../store/appStore/helpers'
import { workstationApi } from '../../lib/api'
import { withWorkstationSession } from '../../lib/workspaceSession'
import { isLocalHostUrl, normalizeHostUrl } from '../../lib/hostUrl'
import { APP_VERSION } from '../../lib/changelog'
import { formatDateTime } from '../../lib/format'
import type { HostConfig } from '../../lib/types'
import { cn } from '../../lib/cn'

/** 主机详情：列表行只留状态，改名、设备、诊断、授权、移除都收在这里。 */
export function HostDetailDrawer({
  host,
  remote,
  onClose,
  onGrant,
  onRemoved,
}: {
  host: HostConfig
  remote?: WorkspaceHostInfo
  onClose: () => void
  onGrant: (remote: WorkspaceHostInfo) => void
  onRemoved: () => void
}) {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const account = useAppStore((s) => s.account)
  const updateHost = useAppStore((s) => s.updateHost)
  const removeHost = useAppStore((s) => s.removeHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const openDoctor = useUiStore((s) => s.openDoctor)
  const setWorkstationOpen = useDevicesStore((s) => s.setWorkstationOpen)
  const rt = runtimes[host.id]

  const [name, setName] = useState(host.name)
  const [url, setUrl] = useState(host.url)
  const [token, setToken] = useState(host.token)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(host.name)
    setUrl(host.url)
    setToken(host.token)
    setConfirmRemove(false)
  }, [host.id, host.name, host.url, host.token])

  const relay = host.mode === 'relay'
  const mine = !remote?.ownerId || remote.ownerId === account?.account.id
  const versionMismatch = rt?.status === 'online' && !!rt.info?.version && rt.info.version !== APP_VERSION
  const fingerprint = remote?.fingerprint ?? host.fingerprint
  const address = relay && host.hostId ? `${account?.centerUrl ?? host.relayUrl ?? ''}/h/${host.hostId}` : host.url

  const save = () => {
    const nextName = name.trim()
    if (!nextName) {
      toast('名称不能为空', 'error')
      return
    }
    if (hosts.some((h) => h.id !== host.id && h.name.trim().toLowerCase() === nextName.toLowerCase())) {
      toast('名称已被使用，请换一个唯一的名称', 'error')
      return
    }
    try {
      if (relay) {
        updateHost(host.id, { name: nextName })
      } else {
        normalizeHostUrl(url)
        updateHost(host.id, { name: nextName, url, token })
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '主机配置无效', 'error')
      return
    }
    toast('主机已更新', 'success')
  }

  const remove = async () => {
    setBusy(true)
    try {
      if (relay && host.hostId && mine) {
        await withWorkstationSession((base, accessToken) =>
          workstationApi.removeHost(base, accessToken, host.hostId!),
        )
        onRemoved()
      }
      removeHost(host.id)
      toast(`已移除主机「${host.name}」`, 'success')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '移除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        ariaLabel="主机详情"
        layer={70}
        className="max-w-[520px]"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Server size={14} className="shrink-0 text-muted" />
            <span className="truncate">{host.name}</span>
          </span>
        }
        description="主机执行任务；会话与模型在工作站。"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {(!relay || mine) && (
              <Button
                variant="danger-ghost"
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
              >
                <Trash2 size={13} /> 移除主机
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <ConnectionDot state={rt?.status ?? 'connecting'} />
            <span className="text-[13px] text-text-secondary">
              {rt?.status === 'online'
                ? '在线'
                : rt?.status === 'connecting'
                  ? '连接中'
                  : '离线'}
            </span>
            {host.id === activeHostId && <Badge tone="neutral">当前</Badge>}
            <Badge tone="neutral">{mine ? '我的' : '获授权'}</Badge>
            {!relay && isLocalHostUrl(host.url) && <Badge tone="neutral">本机</Badge>}
            {versionMismatch && (
              <Badge tone="warn" icon={<TriangleAlert size={10} />}>
                版本不一致
              </Badge>
            )}
          </div>

          <div className="grid gap-2.5 rounded-xl border border-border bg-[var(--t-bg-subtle)] p-3 text-[12.5px] leading-5">
            <InfoLine label="地址" value={address} mono />
            <InfoLine label="状态" value={rt?.status === 'online' ? '在线' : rt?.status === 'connecting' ? '连接中' : '离线'} />
            <InfoLine
              label="版本"
              value={[rt.info?.platform, rt.info?.version].filter(Boolean).join(' ') || '—'}
              mono
            />
            <InfoLine label="指纹" value={fingerprint ? `${fingerprint.slice(0, 24)}…` : '—'} mono />
            <InfoLine
              label="最近在线"
              value={remote?.lastSeenAt ? formatDateTime(remote.lastSeenAt, { year: true }) : '—'}
            />
          </div>

          {(rt?.authError || rt?.error) && (
            <div className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              {rt.authError || rt.error}
            </div>
          )}

          <div className="grid gap-2.5">
            <SettingRow label="名称" stacked wide>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </SettingRow>
            {relay ? (
              <p className="text-[12px] leading-5 text-muted">
                地址与访问令牌由工作站管理；改名只影响本机显示。
              </p>
            ) : (
              <>
                <SettingRow label="地址" stacked wide>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </SettingRow>
                <SettingRow label="Token" stacked wide>
                  <Input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    className={cn('font-mono text-[13px]')}
                  />
                </SettingRow>
              </>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" onClick={save}>
                <Check size={12} /> 保存
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              variant="secondary"
              onClick={() => {
                setWorkstationOpen(true)
                onClose()
              }}
            >
              <Usb size={13} /> 设备
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                openDoctor(host.id)
                onClose()
              }}
            >
              <Stethoscope size={13} /> 诊断
            </Button>
            <Button variant="secondary" onClick={() => retryHost(host.id)}>
              <RefreshCw size={13} /> 重新连接
            </Button>
            {mine && remote && (
              <Button variant="secondary" onClick={() => onGrant(remote)}>
                <UserPlus size={13} /> 授权
              </Button>
            )}
          </div>

          {!mine && (
            <p className="flex items-start gap-1.5 text-[12px] leading-5 text-muted">
              <ShieldCheck size={12} className="mt-0.5 shrink-0" />
              这台主机由 {remote?.ownerId ? '其他账号' : '工作站'} 授权给你；改名、授权与移除由主人操作。
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        layer={80}
        title="移除主机"
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setConfirmRemove(false)}>取消</Button>
            <Button variant="danger-ghost" onClick={() => void remove()} disabled={busy}>
              {busy && <Spinner size={12} />} 移除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          移除主机「{host.name}」？主机将从账号下线，执行器需要重新安装或重新加入；不会删除主机上的数据。
        </p>
      </Modal>
    </>
  )
}

function InfoLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className={cn('min-w-0 flex-1 break-all text-text-secondary', mono && 'font-mono text-[12px]')}>
        {value}
      </span>
    </div>
  )
}
