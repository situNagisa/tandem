import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, Loader2, RefreshCw, Smartphone, Unplug, TriangleAlert, Wifi } from 'lucide-react'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import type { RelayPairInfo } from '@tandem/protocol'
import type { HostConfig } from '../../lib/types'
import { buildRelayPairLink } from '../../lib/pairLink'
import { Modal } from '../ui/Modal'

export function PairDialog({ host, onClose }: { host: HostConfig; onClose: () => void }) {
  const [urls, setUrls] = useState<string[]>([])
  const [token, setToken] = useState('')
  const [hint, setHint] = useState<string | undefined>()
  const [loopback, setLoopback] = useState(false)
  const [relay, setRelay] = useState<RelayPairInfo | undefined>()
  const [source, setSource] = useState<'direct' | 'relay'>('direct')
  const [nonce, setNonce] = useState(0)
  const [active, setActive] = useState(0)
  const [svg, setSvg] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .pair(host)
      .then((data) => {
        if (cancelled) return
        setUrls(data.urls)
        setToken(data.token)
        setHint(data.hint)
        setLoopback(!!data.loopback)
        setRelay(data.relay)
        setSource(data.relay && (data.relay.requireE2E || data.loopback) ? 'relay' : 'direct')
        setActive(0)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '无法获取配对地址')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, nonce])

  const url = urls[active] ?? ''
  const directContent = useMemo(
    () => (url && token ? `${url}/?token=${encodeURIComponent(token)}` : ''),
    [url, token],
  )
  const relayContent = useMemo(
    () => (relay && token ? buildRelayPairLink(relay, token) : ''),
    [relay, token],
  )
  const content = source === 'relay' ? relayContent : directContent

  useEffect(() => {
    if (!content) {
      setSvg('')
      return
    }
    let cancelled = false
    QRCode.toString(content, {
      type: 'svg',
      margin: 1,
      width: 224,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f1e1d', light: '#ffffff' },
    })
      .then((data) => {
        if (!cancelled) setSvg(data)
      })
      .catch(() => {
        if (!cancelled) setSvg('')
      })
    return () => {
      cancelled = true
    }
  }, [content])

  const copy = async () => {
    if (!content) return
    if (await copyText(content)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="连接手机"
      description={
        relay
          ? '经中继连接无需同一局域网；二维码携带 Host 公钥指纹，扫码后走端到端加密。'
          : loopback
            ? 'Host 目前只监听本机回环地址，手机无法扫码连接。'
            : '手机与 Host 在同一局域网或 Tailscale 网络时，用 Tandem App 扫码即可连接。'
      }
      className="max-w-md"
    >
      <div className="space-y-3">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-[12px] text-muted">
            <Loader2 size={13} className="animate-spin" /> 正在获取本机地址…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11.5px] text-danger">
            <TriangleAlert size={12} /> {error}
          </div>
        )}

        {!loading && loopback && !relay && (
          <div className="rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-5 text-center">
            <Unplug size={26} className="mx-auto text-warning" />
            <p className="mt-2 text-[13px] font-medium text-text">手机暂时连不上这台 Host</p>
            <p className="mx-auto mt-1 max-w-[300px] text-[11.5px] leading-5 text-text-soft">
              Host 只监听 <code className="rounded bg-[var(--t-bg-active)] px-1 font-mono text-[10.5px]">127.0.0.1</code>，
              二维码里的地址在手机上会指向手机自己。请让 Host 监听局域网地址后重新检测。
            </p>
            <div className="mt-3 rounded-lg border border-border bg-surface/70 px-2.5 py-2 text-left font-mono text-[10.5px] leading-5 text-text-soft">
              tandem-host --host 0.0.0.0
            </div>
            <p className="mt-2 text-[10.5px] leading-5 text-muted">
              桌面端也可在托盘菜单开启「允许局域网访问」，然后回到这里重新检测。
            </p>
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="mt-3 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[11.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              <RefreshCw size={12} /> 重新检测
            </button>
          </div>
        )}

        {relay && token && (
          <div className="flex rounded-md bg-[var(--t-bg-subtle)] p-0.5">
            <button
              onClick={() => setSource('direct')}
              disabled={urls.length === 0}
              className={cn(
                'flex h-7 flex-1 items-center justify-center gap-1 rounded px-2 text-[11px] transition-colors disabled:opacity-40',
                source === 'direct'
                  ? 'bg-[var(--t-bg-active)] text-text'
                  : 'text-muted hover:text-text-soft',
              )}
            >
              <Wifi size={11} /> 直连
            </button>
            <button
              onClick={() => setSource('relay')}
              className={cn(
                'flex h-7 flex-1 items-center justify-center gap-1 rounded px-2 text-[11px] transition-colors',
                source === 'relay'
                  ? 'bg-[var(--t-bg-active)] text-text'
                  : 'text-muted hover:text-text-soft',
              )}
            >
              中继 · 加密
            </button>
          </div>
        )}

        {(content || (!loopback && urls.length > 0)) && (
          <>
            {source === 'direct' && urls.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {urls.map((item, i) => (
                  <button
                    key={item}
                    onClick={() => setActive(i)}
                    className={cn(
                      'flex items-center gap-1 rounded-md border px-1.5 py-1 font-mono text-[10px] transition-colors',
                      i === active
                        ? 'border-accent/40 bg-accent-soft/50 text-text'
                        : 'border-border text-muted hover:text-text',
                    )}
                  >
                    <Wifi size={10} />
                    {item.replace(/^https?:\/\//, '')}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-col items-center rounded-xl border border-border bg-surface p-3">
              {svg ? (
                <div
                  className="size-[224px] overflow-hidden rounded-lg bg-white [&_svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: svg }}
                  aria-label="配对二维码"
                />
              ) : (
                <div className="flex size-[224px] items-center justify-center text-[11px] text-muted">
                  {content ? '正在生成二维码…' : '没有可用的配对地址'}
                </div>
              )}
              <div className="mt-2 flex w-full items-center gap-1.5 rounded-lg bg-[var(--t-bg)] px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-soft">
                  {content}
                </span>
                <button
                  onClick={() => void copy()}
                  aria-label="复制配对链接"
                  title="复制配对链接"
                  className="flex size-8 shrink-0 items-center justify-center rounded text-muted hover:bg-[var(--t-bg-hover)] hover:text-text sm:size-6"
                >
                  {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                </button>
              </div>
            </div>
          </>
        )}

        {source === 'relay' && relay && (
          <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[10.5px] leading-5 text-muted">
            <div className="mb-1 text-text-soft">Host 公钥指纹（SHA-256）</div>
            <div className="break-all font-mono text-[10px] text-text-secondary">{relay.fingerprint}</div>
            <p className="mt-1">链接里含 token 与指纹，请只发给可信设备；连接时指纹不符会拒绝连接。</p>
            {!relay.connected && <p className="mt-1 text-warning">Host 当前未连上中继，扫码后可能暂时无法连接。</p>}
          </div>
        )}

        {hint && !loopback && source === 'direct' && (
          <div className="rounded-lg border border-warning/30 bg-warning-soft/50 px-2.5 py-2 text-[11px] leading-5 text-warning">
            <div className="flex items-start gap-2">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{hint}</span>
            </div>
          </div>
        )}

        {!loopback && source === 'direct' && (
          <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[10.5px] leading-5 text-muted">
            <div className="mb-1 flex items-center gap-1.5 text-text-soft">
              <Smartphone size={12} /> 让局域网可访问
            </div>
            <p>
              命令行启动：<code className="rounded bg-[var(--t-bg-active)] px-1 font-mono text-text-soft">tandem-host --host 0.0.0.0</code>
            </p>
            <p>桌面端：在托盘菜单中开启「允许局域网访问」，然后重新打开本页。</p>
            <p className="mt-1">Tailscale 网络地址无需额外端口转发，直接扫码即可。</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
