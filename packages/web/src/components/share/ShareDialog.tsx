import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, Link2, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { CreateShareResult, SessionSummary, ShareExpiry } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Select, Switch } from '../ui/Controls'

const EXPIRY_OPTIONS: Array<{ value: ShareExpiry; label: string }> = [
  { value: '1h', label: '1 小时' },
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天（默认）' },
  { value: 'never', label: '不过期（手动撤销）' },
]

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts)
}

export function ShareDialog({
  hostId,
  session,
  onClose,
}: {
  hostId: string
  session: SessionSummary
  onClose: () => void
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>('7d')
  const [includeToolOutputs, setIncludeToolOutputs] = useState(true)
  const [hidePaths, setHidePaths] = useState(true)
  const [snapshot, setSnapshot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreateShareResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [svg, setSvg] = useState('')

  useEffect(() => {
    if (!created?.url) {
      setSvg('')
      return
    }
    let cancelled = false
    QRCode.toString(created.url, {
      type: 'svg',
      margin: 1,
      width: 208,
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
  }, [created?.url])

  const summary = useMemo(() => {
    const bits = [
      expiresIn === 'never' ? '不过期' : EXPIRY_OPTIONS.find((o) => o.value === expiresIn)?.label,
      snapshot ? '快照' : '实时',
      hidePaths ? '隐藏路径' : '保留路径',
      includeToolOutputs ? '含工具输出' : '工具输出仅摘要',
    ]
    return bits.filter(Boolean).join(' · ')
  }, [expiresIn, snapshot, hidePaths, includeToolOutputs])

  const create = async () => {
    if (!host) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.createShare(host, session.id, {
        expiresIn,
        includeToolOutputs,
        hidePaths,
        snapshot,
      })
      setCreated(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建分享失败')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!created?.url) return
    if (await copyText(created.url)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Link2 size={14} className="text-muted" />
          分享会话
        </span>
      }
      description="生成一个只读链接，发给同一局域网内的同事。链接可随时在设置 → 分享中撤销。"
      className="max-w-lg"
      footer={
        created ? (
          <Button size="lg" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button size="lg" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="primary"
              onClick={() => void create()}
              disabled={busy || !host}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              生成链接
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <div className="min-w-0 rounded-lg border border-border bg-bg/40 px-3 py-2">
          <div className="truncate text-[13px] font-medium">{session.title || '未命名会话'}</div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-muted">
            {hidePaths ? '路径已隐藏' : session.cwd}
          </div>
        </div>

        {!created ? (
          <>
            <div className="space-y-1.5">
              <label
                htmlFor="share-expiry"
                className="text-[12px] font-medium text-text-secondary"
              >
                有效期
              </label>
              <Select
                id="share-expiry"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value as ShareExpiry)}
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              <OptionRow
                title="隐藏绝对路径"
                desc="把 /home/… 等路径换成项目相对路径或 <home>"
                checked={hidePaths}
                onChange={setHidePaths}
              />
              <OptionRow
                title="包含工具输出"
                desc="关闭后 Bash / Read 等结果只保留首行摘要"
                checked={includeToolOutputs}
                onChange={setIncludeToolOutputs}
              />
              <OptionRow
                title="冻结快照"
                desc="关闭为实时更新（分享页每 3 秒刷新）"
                checked={snapshot}
                onChange={setSnapshot}
              />
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[12px] leading-5 text-muted">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
              <span>
                链接只对持有 token 的人可见，主机不保存明文 token。密钥、环境变量与 URL
                凭据始终会被移除；<span className="text-text-soft">请只在可信内网使用</span>。
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center rounded-xl border border-border bg-surface p-3">
              {svg ? (
                <div
                  className="size-[208px] overflow-hidden rounded-lg bg-white [&_svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: svg }}
                  aria-label="分享二维码"
                />
              ) : (
                <div className="flex size-[208px] items-center justify-center text-[13px] text-muted">
                  正在生成二维码…
                </div>
              )}
              <div className="mt-2 flex w-full items-center gap-1.5 rounded-lg bg-[var(--t-bg)] px-2 py-1.5">
                <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-text-soft">
                  {created.url}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void copy()}>
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                  {copied ? '已复制' : '复制'}
                </Button>
              </div>
            </div>
            <p className="text-[12px] leading-5 text-muted">
              {summary}
              {created.expiresAt ? ` · ${formatTime(created.expiresAt)} 到期` : ' · 不过期'}
              。链接里的 token 只显示这一次；关闭后可在设置 → 分享查看访问次数或撤销。
            </p>
          </>
        )}

        {created?.warning && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-2.5 py-2 text-[12px] leading-5 text-warning">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {created.warning}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

function OptionRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className={cn('flex items-center gap-3 px-3 py-2.5')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="mt-0.5 text-[12px] leading-5 text-muted">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  )
}
