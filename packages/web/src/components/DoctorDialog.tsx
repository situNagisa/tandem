import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Copy,
  Loader2,
  MinusCircle,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import type { DoctorCheck, DoctorReport, DoctorStatus } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { Button, IconButton } from './ui/Button'
import { Switch } from './ui/Controls'
import { Modal } from './ui/Modal'

/** 与服务端 DOCTOR_CHECK_IDS 保持一致；勾选账号连通性时显式请求全部检查。 */
const ALL_CHECKS = [
  'node',
  'dataDir',
  'disk',
  'listen',
  'firewall',
  'profiles',
  'git',
  'gh',
  'glab',
  'rg',
  'browser',
  'whisper',
  'mcp',
  'hooks',
  'external',
  'encoding',
  'clock',
]

const STATUS_META: Record<
  DoctorStatus,
  { label: string; icon: typeof CheckCircle2; className: string; badge: string }
> = {
  fail: {
    label: '失败',
    icon: XCircle,
    className: 'text-danger',
    badge: 'border-danger/30 bg-danger-soft/60 text-danger',
  },
  warn: {
    label: '警告',
    icon: TriangleAlert,
    className: 'text-warning',
    badge: 'border-warning/30 bg-warning-soft/60 text-warning',
  },
  skip: {
    label: '跳过',
    icon: MinusCircle,
    className: 'text-muted',
    badge: 'border-border bg-surface-2 text-muted',
  },
  ok: {
    label: '正常',
    icon: CheckCircle2,
    className: 'text-success',
    badge: 'border-border bg-surface-2 text-text-soft',
  },
}

const WEIGHT: Record<DoctorStatus, number> = { fail: 0, warn: 1, skip: 2, ok: 3 }

function CheckRow({ item }: { item: DoctorCheck }) {
  const meta = STATUS_META[item.status]
  const Icon = meta.icon
  const toast = useUiStore((s) => s.toast)
  const copyFix = async () => {
    if (!item.fix) return
    toast(
      (await copyText(item.fix)) ? '修复建议已复制' : '复制失败，请手动选择',
      'success',
    )
  }
  return (
    <div
      data-doctor-check={item.id}
      data-doctor-status={item.status}
      className="rounded-xl border border-border bg-surface px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <Icon size={15} className={cn('mt-0.5 shrink-0', meta.className)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold">{item.title}</span>
            <span
              className={cn(
                'rounded border px-1.5 py-px text-[11px] leading-4',
                meta.badge,
              )}
            >
              {meta.label}
            </span>
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted">
            {item.detail}
          </p>
          {item.fix && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-border bg-bg/60 px-2 py-1">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-text-soft">
                {item.fix}
              </code>
              <IconButton
                size="sm"
                onClick={() => void copyFix()}
                label="复制修复建议"
                tooltip="复制"
                className="size-6 shrink-0 [&_svg]:size-3"
              >
                <Copy size={12} />
              </IconButton>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 主机诊断面板：一键检查运行环境，导出可贴给维护者的脱敏报告。 */
export function DoctorDialog() {
  const hostId = useUiStore((s) => s.doctorHostId)
  const close = useUiStore((s) => s.closeDoctor)
  const hosts = useAppStore((s) => s.hosts)
  const toast = useUiStore((s) => s.toast)
  const host = hostId ? hosts.find((item) => item.id === hostId) : undefined

  const [report, setReport] = useState<DoctorReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testProfiles, setTestProfiles] = useState(false)
  const [hideHome, setHideHome] = useState(true)

  const run = useCallback(
    async (withProfiles: boolean) => {
      if (!host) return
      setLoading(true)
      setError(null)
      try {
        const next = await api.doctor(host, {
          ...(withProfiles ? { checks: ALL_CHECKS } : {}),
          clientTime: Date.now(),
        })
        setReport(next)
      } catch (err) {
        setReport(null)
        setError(err instanceof Error ? err.message : '诊断失败')
      } finally {
        setLoading(false)
      }
    },
    [host],
  )

  useEffect(() => {
    if (!hostId) return
    setReport(null)
    setError(null)
    setTestProfiles(false)
    setHideHome(true)
    void run(false)
    // host 对象变化不应触发重新检查（会重复请求）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])

  if (!hostId) return null

  const checks = report
    ? report.checks.slice().sort((a, b) => WEIGHT[a.status] - WEIGHT[b.status])
    : []
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const item of checks) counts[item.status] += 1

  const copyReport = async () => {
    if (!report) return
    const text = hideHome ? report.textHidden : report.text
    toast(
      (await copyText(text)) ? '诊断报告已复制（已脱敏）' : '复制失败，请手动选择',
      'success',
    )
  }

  return (
    <Modal
      open={!!hostId}
      onClose={close}
      title={
        <span className="flex items-center gap-1.5">
          <Stethoscope size={15} /> 主机诊断 · {host?.name ?? '未知主机'}
        </span>
      }
      description="检查这台主机的运行环境；失败项排在前面。不会访问公网，账号连通性需手动勾选。"
      ariaLabel="主机诊断"
      className="max-w-2xl"
      bodyClassName="space-y-3 p-4"
      footer={
        <>
          <span className="mr-auto hidden text-[12px] text-muted sm:inline">
            {report
              ? `正常 ${counts.ok} · 警告 ${counts.warn} · 失败 ${counts.fail} · 跳过 ${counts.skip}`
              : ''}
          </span>
          <Button onClick={close}>关闭</Button>
          <Button onClick={() => void copyReport()} disabled={!report}>
            <Copy size={12} /> 复制报告
          </Button>
          <Button
            variant="primary"
            onClick={() => void run(testProfiles)}
            disabled={loading}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            重新检查
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">检测账号连通性</p>
            <p className="mt-0.5 text-[12px] leading-5 text-muted">
              会向每个已启用的 Key 发送一次最小请求，可能产生少量费用；勾选后点「重新检查」。
            </p>
          </div>
          <Switch
            checked={testProfiles}
            onChange={setTestProfiles}
            label="检测账号连通性"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">报告隐藏用户主目录</p>
            <p className="mt-0.5 text-[12px] leading-5 text-muted">
              复制报告时把用户主目录路径替换为 ~，方便贴给维护者。
            </p>
          </div>
          <Switch checked={hideHome} onChange={setHideHome} label="隐藏用户主目录" />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-3 py-2.5 text-[13px] leading-5 text-danger">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">无法运行诊断：{error}</span>
        </div>
      )}

      {!report && loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> 正在检查本机环境…
        </div>
      )}

      {checks.length > 0 && (
        <div className="space-y-1.5">
          {checks.map((item) => (
            <CheckRow key={item.id} item={item} />
          ))}
        </div>
      )}

      {!checks.length && !loading && !error && (
        <p className="py-6 text-center text-[13px] text-muted">没有检查结果。</p>
      )}
    </Modal>
  )
}
