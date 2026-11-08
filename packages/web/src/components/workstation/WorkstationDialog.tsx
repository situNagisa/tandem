import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  HardDrive,
  Plug,
  RefreshCw,
  Smartphone,
  Terminal,
  Unplug,
  Usb,
} from 'lucide-react'
import type { DeviceInfo, DeviceMount } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useDevicesStore } from '../../store/useDevicesStore'
import { useUiStore } from '../../store/useUiStore'
import type { HostConfig } from '../../lib/types'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'

const EMPTY_MOUNTS: DeviceMount[] = []
import { Button, IconButton } from '../ui/Button'

function StateDot({ state }: { state: DeviceInfo['state'] }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        state === 'online' && 'bg-success',
        state === 'busy' && 'bg-warning',
        state === 'offline' && 'bg-text-tertiary/50',
        state === 'error' && 'bg-danger',
      )}
    />
  )
}

function KindIcon({ kind }: { kind: DeviceInfo['kind'] }) {
  return kind === 'adb' ? <Smartphone size={15} /> : <Usb size={15} />
}

function MountRow({
  mount,
  sessionHost,
  sessionId,
  onTerminal,
}: {
  mount: DeviceMount
  sessionHost: HostConfig
  sessionId: string
  onTerminal: () => void
}) {
  const unmount = useDevicesStore((s) => s.unmountDevice)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <KindIcon kind={mount.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-text">
          <span className="truncate">{mount.name}</span>
          <span className="shrink-0 text-[12px] text-muted">{mount.deviceId}</span>
        </div>
        <div className="truncate text-[12px] text-muted">
          {mount.source.hostName}
          {mount.source.kind === 'peer' ? ' · 跨主机' : ' · 本机'}
          {mount.busy ? ` · ${mount.busy}` : ''}
        </div>
      </div>
      {mount.kind === 'serial' && (
        <Button size="sm" variant="secondary" icon={<Terminal size={14} />} onClick={onTerminal}>
          终端
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        icon={<Unplug size={14} />}
        onClick={() => {
          setBusy(true)
          void unmount(sessionHost, sessionId, mount.id).finally(() => setBusy(false))
        }}
      >
        卸载
      </Button>
    </div>
  )
}

function BackendNote({
  icon,
  title,
  help,
}: {
  icon: ReactNode
  title: string
  help: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg px-3 py-2 text-[12px] text-muted">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-text-tertiary">{icon}</span>
        <span className="min-w-0 flex-1">{title}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded px-1 text-[12px] text-text-soft underline-offset-2 hover:bg-[var(--t-bg-hover)] hover:underline"
        >
          如何安装 / 设置路径
        </button>
      </div>
      {open && (
        <div className="mt-1.5 whitespace-pre-line rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] leading-5 text-text-soft">
          {help}
        </div>
      )}
    </div>
  )
}

function HostSection({
  host,
  activeHost,
  sessionId,
}: {
  host: HostConfig
  activeHost: HostConfig | null
  sessionId: string | null
}) {
  const list = useDevicesStore((s) => s.byHost[host.id])
  const error = useDevicesStore((s) => s.errors[host.id])
  const loading = useDevicesStore((s) => s.loading[host.id])
  const refreshHost = useDevicesStore((s) => s.refreshHost)
  const mountDevice = useDevicesStore((s) => s.mountDevice)
  const openTerminal = useDevicesStore((s) => s.openTerminal)
  const refreshSession = useDevicesStore((s) => s.refreshSession)
  const mountsKey = activeHost && sessionId ? `${activeHost.id}:${sessionId}` : ''
  const mounts = useDevicesStore((s) => (mountsKey ? s.sessionMounts[mountsKey] ?? EMPTY_MOUNTS : EMPTY_MOUNTS))
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (activeHost && sessionId) void refreshSession(activeHost, sessionId)
  }, [activeHost?.id, sessionId])

  const serverHostId = list?.host?.id
  const mounted = (deviceId: string) =>
    mounts.find(
      (m) => m.deviceId === deviceId && (!serverHostId || m.source.hostId === serverHostId),
    )

  return (
    <section className="rounded-xl border border-border bg-bg/40">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <HardDrive size={15} className="text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text">{host.name}</div>
          <div className="truncate text-[12px] text-muted">{host.url}</div>
        </div>
        <IconButton
          label="刷新设备"
          size="sm"
          onClick={() => void refreshHost(host)}
          className={loading ? 'animate-spin' : undefined}
        >
          <RefreshCw size={14} />
        </IconButton>
      </header>
      <div className="space-y-1.5 p-2">
        {error ? (
          <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-[12px] text-danger">
            <AlertTriangle size={14} />
            {error}
          </div>
        ) : !list ? (
          <div className="px-3 py-2 text-[12px] text-muted">{loading ? '正在枚举设备…' : '暂无设备'}</div>
        ) : (
          <>
            {!list.adb.available && (
              <BackendNote
                icon={<Smartphone size={13} />}
                title={list.adb.missing ? '未检测到 adb' : 'ADB 不可用'}
                help={
                  'Windows：winget install --id Google.PlatformTools -e，或下载 platform-tools 后在 Host 配置里把 devices.adbPath 指向 adb.exe。\n也可以设置环境变量 TANDEM_ADB_BIN 后重启 Host。\n串口与其他设备不受影响。'
                }
              />
            )}
            {!list.serial.available && (
              <BackendNote
                icon={<Usb size={13} />}
                title={list.serial.missing ? '串口组件未安装（serialport）' : '串口不可用'}
                help={
                  '在 Host 的工作目录执行 npm install serialport 后重启 Host；\n开发或回归时可用 TANDEM_MOCK_SERIAL=1 启用内置虚拟串口。'
                }
              />
            )}
            {list.devices.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-muted">没有发现设备。</div>
            )}
            {list.devices.map((device) => {
              const mount = mounted(device.id)
              const isRemote = !!activeHost && activeHost.id !== host.id
              return (
                <div
                  key={device.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--t-bg-hover)]"
                >
                  <span className="text-text-tertiary">
                    <KindIcon kind={device.kind} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] text-text">
                      <StateDot state={device.state} />
                      <span className="truncate">{device.name}</span>
                      {__TANDEM_DEBUG__ && device.demo && (
                        <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[11px] text-text-tertiary">
                          演示设备
                        </span>
                      )}
                      <span className="shrink-0 text-[11.5px] uppercase text-muted">{device.kind}</span>
                    </div>
                    <div className="truncate text-[12px] text-muted">
                      {device.detail || device.id}
                      {device.ownerSessionId && device.ownerSessionId === sessionId
                        ? ' · 当前会话占用'
                        : device.ownerLabel
                          ? ` · 占用：${device.ownerLabel}`
                          : ''}
                      {isRemote ? ' · 将挂到另一台主机' : ''}
                    </div>
                  </div>
                  {mount ? (
                    <div className="flex items-center gap-1.5">
                      {mount.kind === 'serial' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Terminal size={14} />}
                          onClick={() => void openTerminal(activeHost!, sessionId!, mount)}
                        >
                          终端
                        </Button>
                      )}
                      <span className="text-[12px] text-success">已挂载</span>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Plug size={14} />}
                      disabled={!activeHost || !sessionId || busy === device.id || device.state === 'offline'}
                      onClick={() => {
                        if (!activeHost || !sessionId) {
                          toast('先打开一个会话，再把设备挂进去', 'info')
                          return
                        }
                        setBusy(device.id)
                        void mountDevice(activeHost, sessionId, device.id, host, device.name)
                          .then(() => toast(`已把 ${device.name} 挂到当前会话`, 'success'))
                          .catch((err) => toast((err as Error).message, 'error'))
                          .finally(() => setBusy(null))
                      }}
                    >
                      {busy === device.id ? '挂载中…' : '挂到当前会话'}
                    </Button>
                  )}
                </div>
              )
            })}
          </>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-1 pt-0.5 text-[11.5px] text-muted">
          <span>
            ADB：
            {list?.adb.available
              ? list.adb.path
              : list?.adb.missing
                ? '未检测到'
                : list?.adb.error
                  ? '不可用'
                  : '未检测'}
          </span>
          <span>
            串口：
            {list?.serial.available
              ? list.serial.mock
                ? '虚拟串口'
                : 'serialport'
              : list?.serial.missing
                ? '未安装 serialport'
                : list?.serial.error
                  ? '不可用'
                  : '未检测'}
          </span>
          {list?.host ? <span>Host：{list.host.name}</span> : null}
        </div>
      </div>
    </section>
  )
}

export function WorkstationDialog() {
  const open = useDevicesStore((s) => s.workstationOpen)
  const setOpen = useDevicesStore((s) => s.setWorkstationOpen)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const active = useAppStore((s) => s.active)
  const refreshAll = useDevicesStore((s) => s.refreshAll)
  const refreshSession = useDevicesStore((s) => s.refreshSession)
  const openTerminal = useDevicesStore((s) => s.openTerminal)
  const mountsKey = active ? `${active.hostId}:${active.sessionId}` : ''
  const mounts = useDevicesStore((s) => (mountsKey ? s.sessionMounts[mountsKey] ?? EMPTY_MOUNTS : EMPTY_MOUNTS))
  const sessionHost = active ? hosts.find((h) => h.id === active.hostId) ?? null : null

  useEffect(() => {
    if (!open) return
    void refreshAll(hosts)
    if (sessionHost && active) void refreshSession(sessionHost, active.sessionId)
  }, [open, hosts.length])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="工作站"
      className="max-w-[900px]"
      description="所有主机的 ADB / 串口设备。挂载后，会话里的 agent 与终端即可使用，即使会话跑在另一台主机上。"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {sessionHost && active ? `当前会话：${sessionHost.name} · ${active.sessionId.slice(0, 8)}` : '未打开会话'}
          </span>
          <Button variant="primary" onClick={() => setOpen(false)}>
            完成
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {active && sessionHost ? (
          <section className="rounded-xl border border-border bg-bg/40">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-medium text-text">
              <Plug size={15} className="text-text-tertiary" />
              已挂载到当前会话
              <span className="text-[12px] font-normal text-muted">{mounts.length} 个</span>
            </header>
            <div className="space-y-1.5 p-2">
              {mounts.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-muted">还没有挂载设备。从下方各主机列表里选择。</div>
              ) : (
                mounts.map((mount) => (
                  <MountRow
                    key={mount.id}
                    mount={mount}
                    sessionHost={sessionHost}
                    sessionId={active.sessionId}
                    onTerminal={() => void openTerminal(sessionHost, active.sessionId, mount)}
                  />
                ))
              )}
            </div>
          </section>
        ) : (
          <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-[12px] text-muted">
            打开一个会话后，就能把任意主机的设备挂进去。
          </div>
        )}

        {hosts.map((host) => (
          <HostSection
            key={host.id}
            host={host}
            activeHost={sessionHost}
            sessionId={active?.sessionId ?? null}
          />
        ))}
        {hosts.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-muted">还没有添加主机。</div>}
        <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              runtimes[hosts[0]?.id ?? '']?.status === 'online' ? 'bg-success' : 'bg-text-tertiary/40',
            )}
          />
          设备只在可信内网共享；跨主机挂载要求会话主机能直连设备主机。
        </div>
      </div>
    </Modal>
  )
}
