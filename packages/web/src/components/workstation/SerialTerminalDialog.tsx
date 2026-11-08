import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Pause, Play, RefreshCw, Search, Send, Unplug } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useDevicesStore } from '../../store/useDevicesStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Controls'

function stamp(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function SerialTerminalDialog() {
  const terminal = useDevicesStore((s) => s.terminal)
  const serial = useDevicesStore((s) => (terminal ? s.serial[`${terminal.hostId}:${terminal.sessionId}:${terminal.mountId}`] : undefined))
  const hideTerminal = useDevicesStore((s) => s.hideTerminal)
  const pollSerial = useDevicesStore((s) => s.pollSerial)
  const sendSerial = useDevicesStore((s) => s.sendSerial)
  const releaseSerial = useDevicesStore((s) => s.releaseSerial)
  const openTerminal = useDevicesStore((s) => s.openTerminal)
  const refreshSession = useDevicesStore((s) => s.refreshSession)
  const hosts = useAppStore((s) => s.hosts)
  const toast = useUiStore((s) => s.toast)

  const host = terminal ? hosts.find((h) => h.id === terminal.hostId) ?? null : null
  const [sendText, setSendText] = useState('')
  const [appendNewline, setAppendNewline] = useState(true)
  const [search, setSearch] = useState('')
  const [timestamps, setTimestamps] = useState(true)
  const [follow, setFollow] = useState(true)
  const [baud, setBaud] = useState('115200')
  const [reopening, setReopening] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const seenRef = useRef({ key: '', length: 0, stamped: [] as Array<{ at: number; text: string }> })

  const text = serial?.text ?? ''
  const key = terminal ? `${terminal.hostId}:${terminal.sessionId}:${terminal.mountId}` : ''

  // 按实际到达时间给新行打时间戳（轮询/WS 都可能一次送来多行）。
  if (seenRef.current.key !== key || text.length < seenRef.current.length) {
    seenRef.current = { key, length: 0, stamped: [] }
  }
  if (text.length > seenRef.current.length) {
    const delta = text.slice(seenRef.current.length)
    seenRef.current.length = text.length
    const pieces = delta.split('\n')
    for (let i = 0; i < pieces.length; i += 1) {
      const last = seenRef.current.stamped[seenRef.current.stamped.length - 1]
      const isContinuation = i < pieces.length - 1 && i === 0 && last && !last.text.endsWith('\n')
      if (isContinuation) last.text += pieces[i]!
      else seenRef.current.stamped.push({ at: Date.now(), text: `${pieces[i]!}${i < pieces.length - 1 ? '\n' : ''}` })
    }
    const stamped = seenRef.current.stamped
    if (stamped.length > 4000) seenRef.current.stamped = stamped.slice(-3000)
  }

  const lines = useMemo(() => {
    const raw = seenRef.current.stamped.map((entry) => entry.text).join('')
    const all = raw ? raw.split('\n') : []
    const needle = search.trim().toLowerCase()
    if (!needle) return seenRef.current.stamped
    return seenRef.current.stamped.filter((entry) => entry.text.toLowerCase().includes(needle))
  }, [text, search, timestamps])

  useEffect(() => {
    if (!terminal || !host) return
    setBaud(String(terminal.baud))
    const timer = window.setInterval(() => void pollSerial(host), 900)
    void pollSerial(host)
    return () => window.clearInterval(timer)
  }, [terminal?.hostId, terminal?.sessionId, terminal?.mountId, host?.id])

  useEffect(() => {
    if (!follow) return
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text, follow])

  if (!terminal) return null

  const reconnect = async () => {
    if (!host) return
    const value = Number(baud)
    if (!Number.isFinite(value) || value <= 0) {
      toast('波特率无效', 'error')
      return
    }
    setReopening(true)
    try {
      await releaseSerial(host)
      await openTerminal(
        host,
        terminal.sessionId,
        {
          id: terminal.mountId,
          sessionId: terminal.sessionId,
          deviceId: terminal.deviceId,
          kind: 'serial',
          name: terminal.name,
          source: { kind: 'local', hostId: host.id, hostName: host.name },
          mountedAt: Date.now(),
          state: 'online',
        },
        Math.floor(value),
      )
      await refreshSession(host, terminal.sessionId)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setReopening(false)
    }
  }

  const save = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `serial-${terminal.deviceId.replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal
      open
      onClose={hideTerminal}
      title={`串口 · ${terminal.name}`}
      className="max-w-[860px]"
      description={`${terminal.deviceId} @ ${terminal.baud} · ${host?.name ?? ''}${serial?.alive ? ' · 已连接' : serial?.alive === false ? ' · 未打开' : ''}`}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[12px] text-muted">
            {terminal.writable === false ? '只读共享租约' : '可写'} · 关闭面板不释放串口（agent 可继续使用）
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={<Download size={14} />} onClick={save} disabled={!text}>
              保存日志
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Unplug size={14} />}
              onClick={() => {
                void releaseSerial(host!).then(hideTerminal)
              }}
            >
              释放串口
            </Button>
            <Button variant="primary" onClick={hideTerminal}>
              关闭
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              size="sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索输出"
              className="pl-7"
            />
          </div>
          <Button
            size="sm"
            variant={timestamps ? 'secondary' : 'ghost'}
            onClick={() => setTimestamps((v) => !v)}
          >
            时间戳
          </Button>
          <Button
            size="sm"
            variant={follow ? 'secondary' : 'ghost'}
            icon={follow ? <Pause size={14} /> : <Play size={14} />}
            onClick={() => setFollow((v) => !v)}
          >
            {follow ? '暂停滚动' : '继续滚动'}
          </Button>
          <div className="flex items-center gap-1">
            <Input
              size="sm"
              value={baud}
              onChange={(e) => setBaud(e.target.value)}
              className="w-[92px] text-right tabular-nums"
              aria-label="波特率"
            />
            <IconButton label="按新波特率重连" size="sm" onClick={() => void reconnect()} disabled={reopening}>
              <RefreshCw size={14} className={reopening ? 'animate-spin' : undefined} />
            </IconButton>
          </div>
        </div>

        {terminal.error && (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-danger">{terminal.error}</div>
        )}

        <pre
          ref={preRef}
          className={cn(
            'h-[46vh] min-h-[220px] overflow-auto rounded-lg border border-border bg-[var(--t-surface-2)] p-2.5 font-mono text-[12px] leading-5 text-text',
            'whitespace-pre-wrap break-words',
          )}
          aria-label="串口输出"
        >
          {lines.length === 0 ? (
            <span className="text-muted">{serial?.alive ? '等待串口输出…' : '串口未打开'}</span>
          ) : (
            lines.map((entry, index) => (
              <div key={`${entry.at}-${index}`}>
                {timestamps && <span className="mr-1.5 select-none text-[11px] text-muted">{stamp(entry.at)}</span>}
                {entry.text}
              </div>
            ))
          )}
        </pre>

        <div className="flex items-center gap-2">
          <Input
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault()
              const payload = appendNewline ? `${sendText}\n` : sendText
              if (!payload || !host) return
              void sendSerial(host, payload)
                .then(() => setSendText(''))
                .catch((err) => toast((err as Error).message, 'error'))
            }}
            placeholder="发送到串口，回车发送"
            className="font-mono"
            aria-label="串口发送内容"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={appendNewline}
              onChange={(e) => setAppendNewline(e.target.checked)}
              className="accent-[var(--t-accent-strong)]"
            />
            换行
          </label>
          <Button
            variant="primary"
            icon={<Send size={14} />}
            disabled={!serial?.alive || (!sendText && !appendNewline)}
            onClick={() => {
              const payload = appendNewline ? `${sendText}\n` : sendText
              if (!payload || !host) return
              void sendSerial(host, payload)
                .then(() => setSendText(''))
                .catch((err) => toast((err as Error).message, 'error'))
            }}
          >
            发送
          </Button>
        </div>
      </div>
    </Modal>
  )
}
