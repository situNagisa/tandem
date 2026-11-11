import { useEffect, useRef, useState } from 'react'
import type { DeviceMount } from '@tandem/protocol'
import { ChevronDown, ChevronUp, Smartphone, Usb } from 'lucide-react'
import { cn } from '../../lib/cn'

const DEMO_ADB = 'adb:demo-pixel-8'
const DEMO_SERIAL = 'serial:demo-board'

function isDemo(mount: DeviceMount): boolean {
  return mount.deviceId === DEMO_ADB || mount.deviceId === DEMO_SERIAL
}

/** 演示安卓设备的模拟画面：状态栏 + 应用图标 + logcat 节拍。 */
function DemoPhone() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1800)
    return () => window.clearInterval(timer)
  }, [])
  const log = [
    'frame rendered in 6ms',
    'network request completed: /api/demo',
    'tick from demo provider',
    'cache hit: demo-entry',
  ][tick % 4]
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div
        data-demo-phone=""
        className="relative h-[132px] w-[66px] shrink-0 overflow-hidden rounded-[11px] border border-border-strong bg-[linear-gradient(160deg,#2a3550,#171c2a_58%,#202a3d)] p-1 shadow-md"
      >
        <div className="mx-auto mb-1 h-1 w-4 rounded-full bg-black/50" />
        <div className="flex items-center justify-between px-0.5 text-[6px] leading-none text-white/70">
          <span>12:00</span>
          <span>5G ▰</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 px-0.5">
          {Array.from({ length: 9 }, (_, i) => (
            <span
              key={i}
              className={cn(
                'aspect-square rounded-[3px]',
                ['bg-[#5b8def]', 'bg-[#4caf82]', 'bg-[#d98b4a]', 'bg-[#8f6fd6]'][i % 4],
                i === 0 && 'ring-1 ring-white/40',
              )}
            />
          ))}
        </div>
        <div className="absolute inset-x-1 bottom-1 rounded bg-black/35 px-1 py-0.5 text-center text-[6px] leading-none text-white/75">
          Tandem Demo
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1 text-[12px] leading-4">
        <div className="text-[13px] text-text">Pixel 8（演示）</div>
        <div className="text-muted">Android 15 · 1080×2400 · 电池 84%</div>
        <div className="truncate font-mono text-[11.5px] text-text-tertiary">
          logcat: {log}
        </div>
        <div className="text-[11.5px] text-text-tertiary">模拟画面，不依赖真实 adb；可在「设备」里卸载。</div>
      </div>
    </div>
  )
}

/** 演示串口板：自动滚动的启动日志 + 心跳。 */
function DemoSerial() {
  const [lines, setLines] = useState<string[]>([
    '[board] ESP32 demo board 1.4.0',
    '[board] wifi: connected (demo-ap)',
    '[board] sensors: ready',
    '[board] type `help` for commands',
  ])
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let tick = 0
    const timer = window.setInterval(() => {
      tick += 1
      const temp = (31 + Math.random() * 3).toFixed(1)
      setLines((prev) =>
        [...prev, `[board] tick ${tick} · temp=${temp}C · heap=${40000 - tick * 7}B`].slice(-40),
      )
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-1.5 text-[13px] text-text">
        演示串口板（ESP32）
        <span className="font-mono text-[11.5px] font-normal text-muted">115200</span>
      </div>
      <div
        ref={boxRef}
        data-demo-serial=""
        className="h-[86px] overflow-y-auto rounded-md border border-border bg-[var(--t-code-block-bg,var(--t-surface-2))] px-2 py-1.5 font-mono text-[11.5px] leading-4 text-text-soft"
      >
        {lines.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap break-all">
            {line}
          </div>
        ))}
      </div>
      <div className="text-[11.5px] text-text-tertiary">
        模拟日志自动滚动；点环境条里的设备胶囊可打开完整串口终端。
      </div>
    </div>
  )
}

function MountView({ mount }: { mount: DeviceMount }) {
  if (mount.deviceId === DEMO_SERIAL) return <DemoSerial />
  return <DemoPhone />
}

/**
 * 演示设备挂到会话后显示的画面卡片（反馈 #7-01）：让用户一眼看到设备已经生效，
 * 而不是只多出一个胶囊。只在演示设备挂载时出现，真实设备不渲染。
 */
export function DemoDeviceStage({ mounts }: { mounts: DeviceMount[] }) {
  const demoMounts = mounts.filter(isDemo)
  const [open, setOpen] = useState(true)
  if (demoMounts.length === 0) return null
  return (
    <section
      data-demo-stage=""
      className="mb-2 overflow-hidden rounded-xl border border-border bg-bg/60"
    >
      <header className="flex h-8 items-center gap-2 border-b border-border/70 px-2.5">
        <Smartphone size={13} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
          演示画面
          <span className="ml-1.5 text-muted">已挂到当前会话 · {demoMounts.length} 个演示设备</span>
        </span>
        <button data-raw-button
          type="button"
          aria-expanded={open}
          aria-label={open ? '收起演示画面' : '展开演示画面'}
          onClick={() => setOpen((value) => !value)}
          className="flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </header>
      {open && (
        <div className="grid gap-3 p-2.5 md:grid-cols-2">
          {demoMounts.map((mount) => (
            <div key={mount.id} className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0 text-text-tertiary">
                {mount.kind === 'adb' ? <Smartphone size={14} /> : <Usb size={14} />}
              </span>
              <MountView mount={mount} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
