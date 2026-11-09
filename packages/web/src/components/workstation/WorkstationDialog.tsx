import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Copy,
  HardDrive,
  Plug,
  RefreshCw,
  Smartphone,
  Terminal,
  Unplug,
  Usb,
  Wrench,
} from 'lucide-react'
import type { DeviceAccess, DeviceInfo, DeviceListResult, DeviceMount } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useDevicesStore } from '../../store/useDevicesStore'
import { useUiStore } from '../../store/useUiStore'
import type { HostConfig } from '../../lib/types'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { ListRow } from '../ui/ListRow'
import { Tip } from '../ui/Tooltip'

const EMPTY_MOUNTS: DeviceMount[] = []
import { Button, IconButton } from '../ui/Button'

// 虚拟串口只是开发/回归开关，发布版不显示提示，server 也不会启用。
const MOCK_SERIAL_HINT = __TANDEM_DEBUG__
  ? '\n开发或回归时可用 TANDEM_MOCK_SERIAL=1 启用内置虚拟串口。'
  : ''

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

function KindTag({ kind }: { kind: DeviceInfo['kind'] }) {
  return (
    <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 py-px text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
      {kind === 'adb' ? 'ADB' : 'SERIAL'}
    </span>
  )
}

function accessLabel(access: DeviceAccess | undefined): string | undefined {
  if (access?.state === 'denied') return '无权限'
  if (access?.state === 'occupied') return '被占用'
  return undefined
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
    <ListRow
      as="div"
      size="sm"
      icon={<KindIcon kind={mount.kind} />}
      title={mount.name}
      detail={`${mount.deviceId.replace(/^(?:adb|serial):/, '')} · ${mount.source.hostName}${
        mount.source.kind === 'peer' ? ' · 跨主机' : ''
      }${mount.busy ? ` · ${mount.busy}` : ''}`}
      trailing={
        <span className="flex items-center gap-1">
          {mount.kind === 'serial' && (
            <IconButton label="打开终端" size="sm" onClick={onTerminal}>
              <Terminal size={14} />
            </IconButton>
          )}
          <IconButton
            label="卸载设备"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void unmount(sessionHost, sessionId, mount.id).finally(() => setBusy(false))
            }}
          >
            <Unplug size={14} />
          </IconButton>
        </span>
      }
    />
  )
}

type HelpPlatform = 'win32' | 'darwin' | 'linux'
const PLATFORM_ORDER: HelpPlatform[] = ['win32', 'darwin', 'linux']
const PLATFORM_LABEL: Record<HelpPlatform, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

function helpPlatform(platform: string | undefined): HelpPlatform | undefined {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return undefined
}

function BackendNote({
  icon,
  title,
  help,
  platform,
}: {
  icon: ReactNode
  title: string
  help: Record<HelpPlatform, string>
  /** Host 的平台；优先展开对应平台，其他平台折叠可展开。 */
  platform?: string
}) {
  const [open, setOpen] = useState(false)
  const primary = helpPlatform(platform)
  const others = PLATFORM_ORDER.filter((item) => item !== primary)
  return (
    <div className="rounded-lg px-2 py-1 text-[12px] text-muted">
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
        <div className="mt-1.5 rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] leading-5 text-text-soft">
          {primary ? (
            <div>
              <div className="mb-1 text-[11.5px] font-medium text-text-secondary">
                {PLATFORM_LABEL[primary]}（当前 Host）
              </div>
              <div className="whitespace-pre-line">{help[primary]}</div>
            </div>
          ) : (
            <div className="mb-1 text-[11.5px] text-muted">没有读到 Host 平台，请选择对应系统：</div>
          )}
          {others.map((item) => (
            <details key={item} open={!primary && item === PLATFORM_ORDER[0]} className="mt-1.5 border-t border-border/60 pt-1.5">
              <summary className="cursor-pointer list-none text-[11.5px] text-text-tertiary transition-colors hover:text-text-soft [&::-webkit-details-marker]:hidden">
                {PLATFORM_LABEL[item]} 安装方法
              </summary>
              <div className="mt-1 whitespace-pre-line">{help[item]}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

/** 串口无权限/被占用时的修复说明：只给命令，不自动执行 sudo。 */
function AccessFix({
  access,
  checking,
  onRecheck,
}: {
  access: DeviceAccess
  checking: boolean
  onRecheck: () => void
}) {
  const toast = useUiStore((s) => s.toast)
  const copy = async (command: string) => {
    toast((await copyText(command)) ? '命令已复制' : '复制失败，请手动选择', 'success')
  }
  return (
    <div className="mx-1 mb-1 rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px]">
      <div className="text-text-soft">
        {access.reason ?? (access.state === 'denied' ? '当前用户没有访问权限' : '端口被其他程序占用')}
      </div>
      {access.fix && <div className="mt-0.5 leading-5 text-muted">{access.fix}</div>}
      {access.commands?.map((command) => (
        <div key={command} className="mt-1.5 flex items-center gap-1.5 rounded bg-[var(--t-surface-2)] py-0.5 pl-2 pr-0.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-soft" data-tip={command}>
            {command}
          </code>
          <IconButton label="复制命令" size="sm" onClick={() => void copy(command)}>
            <Copy size={12} />
          </IconButton>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={checking} onClick={onRecheck}>
          {checking ? '检测中…' : '我已处理，重新检测'}
        </Button>
        <span className="text-[11.5px] text-muted">Host 不会自动执行 sudo，请在终端里执行上面的命令。</span>
      </div>
    </div>
  )
}

function backendSummary(list: DeviceListResult | undefined): { short: string; full: string } {
  if (!list) return { short: '正在枚举设备…', full: '' }
  const adbShort = list.adb.available ? 'ADB 就绪' : list.adb.missing ? 'ADB 未检测' : 'ADB 不可用'
  const serialShort = list.serial.available
    ? list.serial.mock
      ? '串口 虚拟'
      : '串口 serialport'
    : list.serial.missing
      ? '串口未安装'
      : '串口不可用'
  const adbFull = list.adb.available ? `ADB：${list.adb.path ?? '可用'}` : `ADB：${list.adb.hint ?? '不可用'}`
  const serialFull = list.serial.available
    ? list.serial.mock
      ? '串口：虚拟串口（开发）'
      : '串口：serialport'
    : `串口：${list.serial.hint ?? list.serial.error ?? '不可用'}`
  const hostFull = list.host ? `Host：${list.host.name}` : ''
  return {
    short: `${adbShort} · ${serialShort}`,
    full: [adbFull, serialFull, hostFull].filter(Boolean).join('\n'),
  }
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
  const checkAccess = useDevicesStore((s) => s.checkAccess)
  const mountsKey = activeHost && sessionId ? `${activeHost.id}:${sessionId}` : ''
  const mounts = useDevicesStore((s) => (mountsKey ? s.sessionMounts[mountsKey] ?? EMPTY_MOUNTS : EMPTY_MOUNTS))
  const toast = useUiStore((s) => s.toast)
  const platform = useAppStore((s) => s.runtimes[host.id]?.info?.platform)
  const [busy, setBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [fixOpen, setFixOpen] = useState<string | null>(null)
  const [showBuiltin, setShowBuiltin] = useState(false)

  useEffect(() => {
    if (activeHost && sessionId) void refreshSession(activeHost, sessionId)
  }, [activeHost?.id, sessionId])

  const serverHostId = list?.host?.id
  const mounted = (deviceId: string) =>
    mounts.find(
      (m) => m.deviceId === deviceId && (!serverHostId || m.source.hostId === serverHostId),
    )

  const recheck = async (device: DeviceInfo) => {
    setChecking(device.id)
    try {
      const access = await checkAccess(host, device.id)
      if (access.state === 'ok') {
        toast(`${device.name} 已可访问`, 'success')
        setFixOpen(null)
      } else {
        toast(access.reason ?? '仍然无法访问该串口', 'info')
      }
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setChecking(null)
    }
  }

  const renderDevice = (device: DeviceInfo) => {
    const mount = mounted(device.id)
    const isRemote = !!activeHost && activeHost.id !== host.id
    const detail = [
      device.detail && device.detail !== device.name ? device.detail : '',
      device.ownerLabel && device.ownerSessionId !== sessionId ? `占用：${device.ownerLabel}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const issue = accessLabel(device.access)
    const canMount = !!activeHost && !!sessionId
    const offline = device.state === 'offline'
    const mountTip = !canMount
      ? '先打开一个会话，再挂载设备'
      : offline
        ? '设备离线，重新检测后再挂载'
        : `挂到当前会话${isRemote ? `（来自 ${host.name}）` : ''}`
    return (
      <div key={device.id}>
        <ListRow
          as="div"
          size="sm"
          data-device-row={device.id}
          icon={<KindIcon kind={device.kind} />}
          title={
            <span className="flex min-w-0 items-center gap-1.5">
              <StateDot state={device.state} />
              <span className="min-w-0 truncate">{device.name}</span>
              <KindTag kind={device.kind} />
              {__TANDEM_DEBUG__ && device.demo && (
                <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[10px] text-text-tertiary">
                  演示设备
                </span>
              )}
            </span>
          }
          detail={detail || undefined}
          tooltip={!detail && device.detail && device.detail !== device.name ? device.detail : undefined}
          trailing={
            <span className="flex items-center gap-1">
              {issue && (
                <button
                  type="button"
                  onClick={() => setFixOpen((open) => (open === device.id ? null : device.id))}
                  className={cn(
                    'shrink-0 rounded px-1 text-[11px] leading-4 transition-colors hover:bg-[var(--t-bg-hover)]',
                    device.access?.state === 'denied' ? 'text-warning' : 'text-text-soft',
                  )}
                  aria-label={`${issue}：查看修复方法`}
                >
                  {issue}
                </button>
              )}
              {issue && (
                <IconButton
                  label="修复权限"
                  size="sm"
                  onClick={() => setFixOpen((open) => (open === device.id ? null : device.id))}
                >
                  <Wrench size={13} />
                </IconButton>
              )}
              {mount ? (
                <>
                  {mount.kind === 'serial' && (
                    <IconButton
                      label="打开终端"
                      size="sm"
                      onClick={() => void openTerminal(activeHost!, sessionId!, mount)}
                    >
                      <Terminal size={14} />
                    </IconButton>
                  )}
                  <span className="shrink-0 px-1 text-[11.5px] text-success">已挂载</span>
                </>
              ) : !canMount || offline ? (
                <span className="inline-flex items-center">
                  <IconButton label="挂到当前会话" size="sm" disabled>
                    <Plug size={14} />
                  </IconButton>
                  <Tip label={mountTip} />
                </span>
              ) : (
                <IconButton
                  label="挂到当前会话"
                  tooltip={mountTip}
                  size="sm"
                  disabled={busy === device.id}
                  onClick={() => {
                    setBusy(device.id)
                    void mountDevice(activeHost!, sessionId!, device.id, host, device.name)
                      .then(() => toast(`已把 ${device.name} 挂到当前会话`, 'success'))
                      .catch((err) => toast((err as Error).message, 'error'))
                      .finally(() => setBusy(null))
                  }}
                >
                  <Plug size={14} />
                </IconButton>
              )}
            </span>
          }
        />
        {fixOpen === device.id && issue && device.access && (
          <AccessFix
            access={device.access}
            checking={checking === device.id}
            onRecheck={() => void recheck(device)}
          />
        )}
      </div>
    )
  }

  const devices = list?.devices ?? []
  const realDevices = devices.filter((device) => !device.builtin)
  const builtinDevices = devices.filter((device) => device.builtin)
  const builtinDenied = builtinDevices.filter(
    (device) => device.access?.state === 'denied' || device.access?.state === 'occupied',
  ).length
  const status = backendSummary(list)

  return (
    <section className="rounded-xl border border-border bg-bg/40" data-host-section={host.id}>
      <header className="flex min-h-[32px] items-center gap-2 border-b border-border px-2.5 py-0.5">
        <HardDrive size={15} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 shrink truncate text-[13px] font-medium text-text" data-tip={host.name}>
          {host.name}
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-muted" data-tip={host.url}>
          {host.url}
        </span>
        <span
          className="ml-auto shrink-0 truncate text-[11.5px] text-muted"
          data-tip={status.full || undefined}
          data-host-status
        >
          {status.short}
        </span>
        <IconButton
          label="刷新设备"
          size="sm"
          onClick={() => void refreshHost(host)}
          className={loading ? 'animate-spin' : undefined}
        >
          <RefreshCw size={14} />
        </IconButton>
      </header>
      <div className="p-1">
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
                platform={platform}
                help={{
                  win32:
                    'winget install --id Google.PlatformTools -e，或下载 platform-tools 后在 Host 配置里把 devices.adbPath 指向 adb.exe。\n也可以设置环境变量 TANDEM_ADB_BIN 后重启 Host。\n串口与其他设备不受影响。',
                  darwin:
                    'brew install --cask android-platform-tools；adb 通常在 /opt/homebrew/bin/adb 或 /usr/local/bin/adb。\n已装 Android Studio 时可用 ~/Library/Android/sdk/platform-tools/adb。\n也可以在 Host 配置里把 devices.adbPath 指向 adb，或设置 TANDEM_ADB_BIN 后重启 Host。\n串口与其他设备不受影响。',
                  linux:
                    'Debian/Ubuntu：sudo apt install adb；Arch：sudo pacman -S android-tools；Fedora：sudo dnf install android-tools。\nUSB 权限：sudo usermod -aG plugdev $USER（Arch 用 uucp）后重新登录；Debian/Ubuntu 可安装 android-sdk-platform-tools-common 获得 udev 规则，或添加 /etc/udev/rules.d/51-android.rules 后执行 sudo udevadm control --reload-rules && sudo udevadm trigger。\n也可以在 Host 配置里把 devices.adbPath 指向 adb，或设置 TANDEM_ADB_BIN 后重启 Host。',
                }}
              />
            )}
            {!list.serial.available && (
              <BackendNote
                icon={<Usb size={13} />}
                title={list.serial.missing ? '串口组件未安装（serialport）' : '串口不可用'}
                platform={platform}
                help={{
                  win32:
                    '在 Host 的工作目录执行 npm install serialport 后重启 Host。\nUSB 串口驱动：CH340 / CP210x / FTDI 芯片需安装厂商驱动；设备管理器里应出现 COM 端口。' + MOCK_SERIAL_HINT,
                  darwin:
                    '在 Host 的工作目录执行 npm install serialport 后重启 Host。\nCH340 / CP210x / FTDI 大多由 macOS 自带驱动（旧系统装厂商驱动）；设备出现在 /dev/tty.usbserial-* 或 /dev/tty.usbmodem*。' + MOCK_SERIAL_HINT,
                  linux:
                    '在 Host 的工作目录执行 npm install serialport 后重启 Host。\n串口驱动通常已在内核（ch341 / cp210x / ftdi_sio）。没有权限时执行 sudo usermod -aG dialout $USER 后重新登录（Arch 用 uucp）；\n或添加 /etc/udev/rules.d/99-tandem-serial.rules：SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0666", GROUP="dialout"，然后 sudo udevadm control --reload-rules && sudo udevadm trigger。' + MOCK_SERIAL_HINT,
                }}
              />
            )}
            {devices.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-muted">没有发现设备。</div>
            )}
            {realDevices.map(renderDevice)}
            {builtinDevices.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowBuiltin((open) => !open)}
                  aria-expanded={showBuiltin}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
                >
                  <ChevronRight
                    size={13}
                    className={cn('shrink-0 transition-transform', showBuiltin && 'rotate-90')}
                  />
                  <span className="min-w-0 truncate">
                    另有 {builtinDevices.length} 个板载串口
                    {builtinDenied > 0 ? ` · ${builtinDenied} 个无权限` : ''}
                  </span>
                </button>
                {showBuiltin && builtinDevices.map(renderDevice)}
              </>
            )}
          </>
        )}
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
      <div className="space-y-2.5">
        {active && sessionHost ? (
          <section className="rounded-xl border border-border bg-bg/40">
            <header className="flex min-h-[32px] items-center gap-2 border-b border-border px-2.5 py-0.5 text-[13px] font-medium text-text">
              <Plug size={15} className="text-text-tertiary" />
              已挂载到当前会话
              <span className="text-[12px] font-normal text-muted">{mounts.length} 个</span>
            </header>
            <div className="p-1">
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
