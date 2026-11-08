// 生成 Wiki 前的确认：选择账号/模型、查看预计页数与花费，确认后开始后台任务。
import { useEffect, useMemo, useState } from 'react'
import type { WikiEstimate, WikiJob } from '@tandem/protocol'
import type { HostConfig } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { formatCost, formatTokens } from '../../lib/format'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Controls'

export function WikiGenerateDialog({
  host,
  project,
  mode,
  open,
  onClose,
  onStarted,
}: {
  host: HostConfig | null
  project: string
  mode: 'generate' | 'update'
  open: boolean
  onClose: () => void
  onStarted: (job: WikiJob) => void
}) {
  const profiles = useAppStore((s) => (host ? s.runtimes[host.id]?.profiles : undefined))
  const activeSummary = useAppStore((s) => s.active?.summary ?? null)
  const [profileId, setProfileId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [model, setModel] = useState('auto')
  const [maxCost, setMaxCost] = useState('')
  const [estimate, setEstimate] = useState<WikiEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  const profile = useMemo(
    () => profiles?.find((item) => item.id === profileId) ?? profiles?.[0],
    [profiles, profileId],
  )
  const group = profile?.groups?.find((item) => item.id === groupId)
  const models = group?.models?.length ? group.models : (profile?.models ?? [])

  useEffect(() => {
    if (!open) return
    setError('')
    setStarting(false)
    setMaxCost('')
    setModel('auto')
    const preferred =
      (activeSummary?.profileId && profiles?.some((item) => item.id === activeSummary.profileId)
        ? activeSummary.profileId
        : profiles?.[0]?.id) ?? ''
    setProfileId(preferred)
    const preferredProfile = profiles?.find((item) => item.id === preferred)
    setGroupId(
      activeSummary?.groupId && preferredProfile?.groups?.some((item) => item.id === activeSummary.groupId)
        ? activeSummary.groupId
        : '',
    )
  }, [open, activeSummary?.profileId, activeSummary?.groupId, profiles])

  useEffect(() => {
    if (!open || !host || !project) return
    let cancelled = false
    setEstimating(true)
    const timer = window.setTimeout(() => {
      api
        .wikiEstimate(host, {
          project,
          mode,
          ...(profile?.id ? { profileId: profile.id } : {}),
          ...(group?.id ? { groupId: group.id } : {}),
          ...(model !== 'auto' ? { model } : {}),
        })
        .then((result) => {
          if (!cancelled) {
            setEstimate(result)
            setError('')
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setEstimate(null)
            setError((err as Error).message)
          }
        })
        .finally(() => {
          if (!cancelled) setEstimating(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, host, project, mode, profile?.id, group?.id, model])

  const start = async () => {
    if (!host || !profile?.id) return
    const cap = Number(maxCost)
    setStarting(true)
    setError('')
    try {
      const job = await api.wikiGenerate(host, {
        project,
        mode,
        profileId: profile.id,
        ...(group?.id ? { groupId: group.id } : {}),
        ...(model !== 'auto' ? { model } : {}),
        ...(Number.isFinite(cap) && cap > 0 ? { maxCostUsd: cap } : {}),
      })
      onStarted(job)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const pages = estimate?.pages ?? 0
  const nothing = mode === 'update' && estimate !== null && pages === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'update' ? '更新项目 Wiki' : '生成项目 Wiki'}
      description={
        mode === 'update'
          ? '只重新生成自上次 commit 以来有改动的模块页面，手写段落会保留。'
          : '按目录结构分批阅读代码，生成概览、模块页与术语表；后台运行，可继续做别的事。'
      }
      className="w-[520px] max-w-[92vw]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!estimate || estimating || starting || nothing || !profile}
            onClick={() => void start()}
          >
            {starting ? '正在启动…' : nothing ? '没有需要更新的模块' : '确认并开始'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[12px] text-muted">账号</span>
          <Select
            value={profile?.id ?? ''}
            onChange={(event) => {
              setProfileId(event.target.value)
              setGroupId('')
              setModel('auto')
            }}
            disabled={!profiles?.length}
          >
            {(profiles ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>

        {profile?.groups?.length ? (
          <label className="block space-y-1">
            <span className="text-[12px] text-muted">分组</span>
            <Select value={group?.id ?? ''} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">账号默认</option>
              {profile.groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <label className="block space-y-1">
          <span className="text-[12px] text-muted">模型</span>
          <Select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="auto">自动（快速档，推荐）</option>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-[12px] text-muted">预算上限（美元，可选）</span>
          <Input
            value={maxCost}
            onChange={(event) => setMaxCost(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="例如 0.50；达到上限后停止并保留已完成页面"
            inputMode="decimal"
          />
        </label>

        <div className="rounded-lg border border-border bg-[var(--t-surface-2)] px-3 py-2.5 text-[12px] leading-5">
          {estimating && !estimate ? (
            <span className="text-muted">正在估算…</span>
          ) : estimate ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">本次范围</span>
                <span className="tabular-nums text-text">
                  {pages} 页 · {estimate.files} 个文件 · {estimate.modules} 个模块
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">预计 token</span>
                <span className="tabular-nums text-text">
                  输入 ~{formatTokens(estimate.inputTokens)} · 输出 ~{formatTokens(estimate.outputTokens)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">预计花费</span>
                <span className="tabular-nums text-text">
                  {estimate.priceKnown ? formatCost(estimate.costUsd) : '未知单价'}
                  {estimate.autoRoute ? ' · 自动选择快速档' : ''}
                </span>
              </div>
              {estimate.changedFiles > 0 ? (
                <div className="mt-1 text-muted">上次生成后仓库有 {estimate.changedFiles} 个文件改动。</div>
              ) : null}
              {mode === 'update' && pages === 0 ? (
                <div className="mt-1 text-text-soft">没有检测到需要更新的模块，无需重新生成。</div>
              ) : null}
            </>
          ) : (
            <span className="text-muted">选择账号后估算。</span>
          )}
        </div>

        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}
