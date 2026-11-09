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
import { SegmentedControl } from '../ui/Controls'
import { Tip } from '../ui/Tooltip'
import { CodeBlock } from '../CodeBlock'

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
type LinuxDistro = 'debian' | 'arch' | 'fedora'
const PLATFORM_ORDER: HelpPlatform[] = ['win32', 'darwin', 'linux']
const PLATFORM_LABEL: Record<HelpPlatform, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}
const DISTRO_ORDER: LinuxDistro[] = ['debian', 'arch', 'fedora']
const DISTRO_LABEL: Record<LinuxDistro, string> = {
  debian: 'Debian / Ubuntu',
  arch: 'Arch',
  fedora: 'Fedora',
}

function helpPlatform(platform: string | undefined): HelpPlatform | undefined {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return undefined
}

interface GuideStep {
  title: string
  body?: ReactNode
  commands?: string[]
  note?: ReactNode
}

type PlatformGuide = Record<HelpPlatform, GuideStep[]>

/** Linux 三个发行版的安装与权限步骤不同，顶部用二级分段切换。 */
type LinuxGuide = Record<LinuxDistro, GuideStep[]>

const CODE = 'rounded bg-[var(--t-bg-hover)] px-1 py-px font-mono text-[11.5px]'

const ADB_GUIDE: PlatformGuide & { linuxDistro: LinuxGuide } = {
  win32: [
    {
      title: '安装 adb',
      body: '用 winget 安装 Google 官方 platform-tools，或从 Android 开发者网站下载 zip 解压到固定目录。',
      commands: ['winget install --id Google.PlatformTools -e'],
    },
    {
      title: '连接与驱动',
      body: 'Windows 10/11 通常自动装好驱动；设备管理器里出现未知 Android 设备时，安装手机厂商的 USB 驱动。',
      note: '首次连接需在手机上允许 USB 调试。',
    },
    {
      title: '设置路径',
      body: (
        <>
          任选一种让 Host 找到 adb：加入 PATH；在 Host 配置{' '}
          <code className={CODE}>devices.adbPath</code> 指向 <code className={CODE}>adb.exe</code>；
          或设置环境变量 <code className={CODE}>TANDEM_ADB_BIN</code> 后重启 Host。
        </>
      ),
      commands: ['setx TANDEM_ADB_BIN "C:\\Android\\platform-tools\\adb.exe"'],
      note: '改完环境变量要重新打开终端并重启 Host。',
    },
  ],
  darwin: [
    {
      title: '安装 adb',
      body: '用 Homebrew 安装 Android 官方 platform-tools；已装 Android Studio 时也可以直接用 SDK 自带的 adb。',
      commands: ['brew install --cask android-platform-tools'],
    },
    {
      title: '连接与驱动',
      body: 'macOS 通常无需额外驱动；首次连接时在手机上允许 USB 调试。',
    },
    {
      title: '设置路径',
      body: (
        <>
          brew 安装后 adb 已在 PATH；Android Studio 的默认路径是{' '}
          <code className={CODE}>~/Library/Android/sdk/platform-tools/adb</code>。也可以在 Host 配置{' '}
          <code className={CODE}>devices.adbPath</code> 指向它，或设置{' '}
          <code className={CODE}>TANDEM_ADB_BIN</code>。
        </>
      ),
      commands: ['export TANDEM_ADB_BIN="$HOME/Library/Android/sdk/platform-tools/adb"'],
      note: 'export 只对当前终端生效；长期生效请写进 shell 配置或在 Host 配置里指定。',
    },
  ],
  linux: [
    {
      title: '安装 adb 与 udev 规则',
      body: 'Debian / Ubuntu 可直接安装 adb 与 common udev 规则包。',
      commands: ['sudo apt install adb android-sdk-platform-tools-common'],
    },
    {
      title: 'USB 权限',
      body: (
        <>
          把当前用户加入 <code className={CODE}>plugdev</code> 组后重新登录，让 udev 规则的权限生效。
        </>
      ),
      commands: ['sudo usermod -aG plugdev $USER'],
      note: '重新登录后运行 adb devices 确认不再提示 no permissions。',
    },
    {
      title: '设置路径',
      body: (
        <>
          发行版包通常已把 adb 放进 PATH。也可以在 Host 配置{' '}
          <code className={CODE}>devices.adbPath</code> 或环境变量{' '}
          <code className={CODE}>TANDEM_ADB_BIN</code> 里显式指定。
        </>
      ),
      commands: ['export TANDEM_ADB_BIN="$(command -v adb)"'],
    },
  ],
  linuxDistro: {
    debian: [
      {
        title: '安装 adb 与 udev 规则',
        body: 'Debian / Ubuntu 可直接安装 adb 与 common udev 规则包。',
        commands: ['sudo apt install adb android-sdk-platform-tools-common'],
      },
      {
        title: 'USB 权限',
        body: (
          <>
            把当前用户加入 <code className={CODE}>plugdev</code> 组后重新登录，让 udev 规则的权限生效。
          </>
        ),
        commands: ['sudo usermod -aG plugdev $USER'],
        note: '重新登录后运行 adb devices 确认不再提示 no permissions。',
      },
      {
        title: '设置路径',
        body: (
          <>
            发行版包通常已把 adb 放进 PATH。也可以在 Host 配置{' '}
            <code className={CODE}>devices.adbPath</code> 或环境变量{' '}
            <code className={CODE}>TANDEM_ADB_BIN</code> 里显式指定。
          </>
        ),
        commands: ['export TANDEM_ADB_BIN="$(command -v adb)"'],
      },
    ],
    arch: [
      {
        title: '安装 adb',
        body: 'Arch 的 android-tools 包包含 adb、fastboot 与 udev 规则。',
        commands: ['sudo pacman -S android-tools'],
      },
      {
        title: 'USB 权限',
        body: (
          <>
            Arch 使用 <code className={CODE}>uucp</code> 组管理 USB 设备权限；加入后重新登录。
          </>
        ),
        commands: ['sudo usermod -aG uucp $USER'],
      },
      {
        title: '设置路径',
        body: (
          <>
            adb 在 <code className={CODE}>/usr/bin/adb</code>，通常已在 PATH。也可以在 Host 配置{' '}
            <code className={CODE}>devices.adbPath</code> 或{' '}
            <code className={CODE}>TANDEM_ADB_BIN</code> 里指定。
          </>
        ),
        commands: ['export TANDEM_ADB_BIN="$(command -v adb)"'],
      },
    ],
    fedora: [
      {
        title: '安装 adb',
        body: 'Fedora 的 android-tools 包包含 adb 与 fastboot。',
        commands: ['sudo dnf install android-tools'],
      },
      {
        title: 'USB 权限',
        body: (
          <>
            把当前用户加入 <code className={CODE}>plugdev</code> 组；若仍提示无权限，参照 Debian 的{' '}
            <code className={CODE}>51-android.rules</code> 添加设备 vendor id 的 udev 规则。
          </>
        ),
        commands: ['sudo usermod -aG plugdev $USER'],
        note: '重新登录后生效。',
      },
      {
        title: '设置路径',
        body: (
          <>
            adb 通常已在 PATH。也可以在 Host 配置 <code className={CODE}>devices.adbPath</code>{' '}
            或 <code className={CODE}>TANDEM_ADB_BIN</code> 里指定。
          </>
        ),
        commands: ['export TANDEM_ADB_BIN="$(command -v adb)"'],
      },
    ],
  },
}

const SERIAL_GUIDE: PlatformGuide & { linuxDistro: LinuxGuide } = {
  win32: [
    {
      title: '安装串口组件',
      body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
      commands: ['npm install serialport'],
    },
    {
      title: '串口驱动',
      body: 'CH340 / CP210x / FTDI 芯片需安装厂商驱动；装好后设备管理器里应出现 COM 端口。',
    },
    {
      title: '确认设备路径',
      body: (
        <>
          在设备管理器的「端口 (COM 和 LPT)」查看编号（如 <code className={CODE}>COM3</code>）。
          Host 会自动枚举串口，无需手动填路径。
        </>
      ),
    },
  ],
  darwin: [
    {
      title: '安装串口组件',
      body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
      commands: ['npm install serialport'],
    },
    {
      title: '串口驱动',
      body: 'CH340 / CP210x / FTDI 大多由 macOS 自带驱动；旧系统或特殊芯片再安装厂商驱动。',
    },
    {
      title: '确认设备路径',
      body: (
        <>
          设备会出现在 <code className={CODE}>/dev/tty.usbserial-*</code> 或{' '}
          <code className={CODE}>/dev/tty.usbmodem*</code>。
        </>
      ),
      commands: ['ls /dev/tty.usb*'],
    },
  ],
  linux: [
    {
      title: '安装串口组件',
      body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
      commands: ['npm install serialport'],
    },
    {
      title: '串口权限',
      body: (
        <>
          串口驱动通常已在内核（ch341 / cp210x / ftdi_sio）。没有权限时把用户加入{' '}
          <code className={CODE}>dialout</code> 组后重新登录。
        </>
      ),
      commands: ['sudo usermod -aG dialout $USER'],
    },
    {
      title: '确认设备路径',
      body: (
        <>
          设备一般是 <code className={CODE}>/dev/ttyUSB*</code> 或 <code className={CODE}>/dev/ttyACM*</code>。
        </>
      ),
      commands: ['ls /dev/ttyUSB* /dev/ttyACM*'],
    },
  ],
  linuxDistro: {
    debian: [
      {
        title: '安装串口组件',
        body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
        commands: ['npm install serialport'],
      },
      {
        title: '串口权限',
        body: (
          <>
            串口驱动通常已在内核（ch341 / cp210x / ftdi_sio）。没有权限时把用户加入{' '}
            <code className={CODE}>dialout</code> 组后重新登录。
          </>
        ),
        commands: ['sudo usermod -aG dialout $USER'],
      },
      {
        title: '确认设备路径',
        body: (
          <>
            设备一般是 <code className={CODE}>/dev/ttyUSB*</code> 或 <code className={CODE}>/dev/ttyACM*</code>。
          </>
        ),
        commands: ['ls /dev/ttyUSB* /dev/ttyACM*'],
      },
    ],
    arch: [
      {
        title: '安装串口组件',
        body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
        commands: ['npm install serialport'],
      },
      {
        title: '串口权限',
        body: (
          <>
            Arch 用 <code className={CODE}>uucp</code> 组管理串口权限；加入后重新登录。
          </>
        ),
        commands: ['sudo usermod -aG uucp $USER'],
      },
      {
        title: '确认设备路径',
        body: (
          <>
            设备一般是 <code className={CODE}>/dev/ttyUSB*</code> 或 <code className={CODE}>/dev/ttyACM*</code>。
          </>
        ),
        commands: ['ls /dev/ttyUSB* /dev/ttyACM*'],
      },
    ],
    fedora: [
      {
        title: '安装串口组件',
        body: '在 Host 的工作目录安装 serialport 后重启 Host；串口与其他设备不受影响。',
        commands: ['npm install serialport'],
      },
      {
        title: '串口权限',
        body: (
          <>
            串口驱动通常已在内核。没有权限时把用户加入 <code className={CODE}>dialout</code> 组后重新登录。
          </>
        ),
        commands: ['sudo usermod -aG dialout $USER'],
      },
      {
        title: '确认设备路径',
        body: (
          <>
            设备一般是 <code className={CODE}>/dev/ttyUSB*</code> 或 <code className={CODE}>/dev/ttyACM*</code>。
          </>
        ),
        commands: ['ls /dev/ttyUSB* /dev/ttyACM*'],
      },
    ],
  },
}

function InstallGuide({
  guide,
  platform,
  note,
}: {
  guide: PlatformGuide & { linuxDistro: LinuxGuide }
  /** Host 的平台；默认选中，其他系统可切换查看。 */
  platform?: string
  note?: string
}) {
  const detected = helpPlatform(platform)
  const [selected, setSelected] = useState<HelpPlatform>(detected ?? 'win32')
  const [distro, setDistro] = useState<LinuxDistro>('debian')
  const steps = selected === 'linux' ? guide.linuxDistro[distro] : guide[selected]
  return (
    <div className="space-y-2.5 text-[12px] leading-5">
      <SegmentedControl
        size="sm"
        aria-label="选择系统"
        className="w-full"
        itemClassName="flex-1"
        value={selected}
        onChange={setSelected}
        options={PLATFORM_ORDER.map((item) => ({
          value: item,
          label: PLATFORM_LABEL[item],
        }))}
      />
      {selected === 'linux' && (
        <SegmentedControl
          size="sm"
          aria-label="选择 Linux 发行版"
          className="w-full"
          itemClassName="flex-1"
          value={distro}
          onChange={setDistro}
          options={DISTRO_ORDER.map((item) => ({ value: item, label: DISTRO_LABEL[item] }))}
        />
      )}
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={`${selected}:${index}:${step.title}`} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
            <span className="mt-0.5 flex size-[18px] items-center justify-center rounded-full bg-[var(--t-bg-active)] font-mono text-[10.5px] tabular-nums text-text-secondary">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-secondary">{step.title}</div>
              {step.body && (
                <div className="mt-0.5 break-words text-text-soft">{step.body}</div>
              )}
              {step.commands?.length ? (
                <CodeBlock
                  code={step.commands.join('\n')}
                  language="bash"
                  fileName="终端"
                  toolsAlwaysVisible
                  maxHeight={null}
                  className="mt-1.5"
                />
              ) : null}
              {step.note && (
                <div className="mt-1 text-[11.5px] leading-4 text-muted">{step.note}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {note && <div className="border-t border-border/60 pt-2 text-[11.5px] leading-4 text-muted">{note}</div>}
    </div>
  )
}

function BackendNote({
  icon,
  title,
  guide,
  platform,
  note,
}: {
  icon: ReactNode
  title: string
  guide: PlatformGuide & { linuxDistro: LinuxGuide }
  /** Host 的平台；优先展开对应平台，其他平台可切换查看。 */
  platform?: string
  note?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg px-2 py-1 text-[12px] text-muted">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-text-tertiary">{icon}</span>
        <span className="min-w-0 flex-1">{title}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 rounded px-1 text-[12px] text-text-soft underline-offset-2 hover:bg-[var(--t-bg-hover)] hover:underline"
        >
          如何安装 / 设置路径
        </button>
      </div>
      {open && (
        <div className="mt-1.5 rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2.5">
          <InstallGuide guide={guide} platform={platform} note={note} />
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
                guide={ADB_GUIDE}
                note="串口与其他设备不受影响。"
              />
            )}
            {!list.serial.available && (
              <BackendNote
                icon={<Usb size={13} />}
                title={list.serial.missing ? '串口组件未安装（serialport）' : '串口不可用'}
                platform={platform}
                guide={SERIAL_GUIDE}
                note={`CH340 / CP210x / FTDI 的驱动或权限处理完成后，Host 会自动重新枚举设备。${MOCK_SERIAL_HINT}`}
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
