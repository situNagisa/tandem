import { useEffect, useState } from 'react'
import type { ModelPriceInfo, SessionUsageBreakdown, SessionUsageRow } from '@tandem/protocol'
import { api } from '../../lib/api'
import { formatCost, formatTokens } from '../../lib/format'
import { prettyModel } from '../../lib/modelName'
import { useUiStore } from '../../store/useUiStore'
import type { HostConfig } from '../../lib/types'
import { Spinner } from '../ui/Spinner'

const priceNumber = (value: number | undefined) =>
  value === undefined ? '—' : String(Number(value.toFixed(4)))

function priceSource(price: ModelPriceInfo | undefined): string {
  if (!price) return '该型号尚未收录官方价'
  if (price.source === 'account') return '账号自定义单价'
  return price.officialInput !== undefined ? '内置官方价 × 账号/分组倍率' : '内置官方价'
}

function tokenLine(row: SessionUsageRow): string {
  const parts = [`输入 ${formatTokens(row.inputTokens)}`, `输出 ${formatTokens(row.outputTokens)}`]
  if (row.cacheReadTokens > 0) parts.push(`缓存读 ${formatTokens(row.cacheReadTokens)}`)
  if (row.cacheWriteTokens > 0) parts.push(`缓存写 ${formatTokens(row.cacheWriteTokens)}`)
  return parts.join(' · ')
}

/**
 * 用量卡悬停明细（反馈1724#06）：各模型的 token × 单价 = 小计，单价来源写清楚。
 * 金额是记账时的值（历史不重算）；当前单价只用于解释计算式。未收录官方价的型号显示「未知单价」，
 * 并复用模型菜单的入口跳到该账号的单价覆盖。
 */
export function UsageBreakdownCard({ host, sessionId }: { host: HostConfig; sessionId: string }) {
  const focusSetting = useUiStore((s) => s.focusSetting)
  const [data, setData] = useState<SessionUsageBreakdown | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setData(null)
    setError('')
    api
      .sessionUsage(host, sessionId)
      .then((value) => {
        if (alive) setData(value)
      })
      .catch((err: Error) => {
        if (alive) setError(err.message || '读取用量明细失败')
      })
    return () => {
      alive = false
    }
  }, [host.id, sessionId])

  if (error) return <div className="px-1 py-2 text-[12px] text-danger">{error}</div>
  if (!data) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-2 text-[12px] text-muted">
        <Spinner size={12} /> 读取用量明细…
      </div>
    )
  }
  const unpriced = data.rows.some(
    (row) =>
      !data.prices[row.model] &&
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0,
  )
  const residual = data.residual
  const showResidual =
    residual.costUsd > 0 ||
    residual.inputTokens > 0 ||
    residual.outputTokens > 0 ||
    residual.cacheReadTokens > 0 ||
    residual.cacheWriteTokens > 0
  return (
    <div className="max-h-[360px] min-w-0 overflow-y-auto px-1" data-usage-breakdown>
      <div className="pb-1 text-[12px] text-muted">
        按模型汇总；金额为记账时口径，历史不重算。
      </div>
      {data.rows.map((row) => {
        const price = data.prices[row.model]
        return (
          <div key={row.model} className="border-t border-border/60 py-1.5 first:border-t-0">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[12.5px] text-text" data-tip={row.model}>
                {prettyModel(row.model)}
              </span>
              <span className="shrink-0 font-mono text-[13px] tabular-nums text-text">
                {price ? formatCost(row.costUsd) : '未知单价'}
              </span>
            </div>
            <div className="mt-0.5 text-[12px] leading-4 text-muted">
              {row.calls} 次 · {tokenLine(row)}
            </div>
            {price ? (
              <div className="text-[12px] leading-4 text-muted">
                单价 输入 ${priceNumber(price.input)} · 输出 ${priceNumber(price.output)} / 百万
                {price.cacheRead !== undefined ? ` · 缓存读 $${priceNumber(price.cacheRead)}` : ''}
                {price.cacheWrite !== undefined ? ` · 缓存写 $${priceNumber(price.cacheWrite)}` : ''}
              </div>
            ) : null}
            <div className="flex items-baseline gap-1.5 text-[12px] leading-4 text-text-tertiary">
              <span>{priceSource(price)}</span>
              {!price && data.profileId ? (
                <button
                  type="button"
                  data-raw-button
                  onClick={() => focusSetting('profiles', `profiles.prices:${data.profileId}`)}
                  className="text-text-secondary underline decoration-border underline-offset-2 hover:text-text"
                >
                  去设置
                </button>
              ) : null}
            </div>
            {!price ? (
              <div className="text-[12px] leading-4 text-text-tertiary">
                可在账号里设置单价后按自定义价记账
              </div>
            ) : null}
          </div>
        )
      })}
      {showResidual && (
        <div className="border-t border-border/60 py-1.5">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[12.5px] text-text-soft">其他（压缩、评审等）</span>
            <span className="shrink-0 font-mono text-[13px] tabular-nums text-text-soft">
              {formatCost(residual.costUsd)}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] leading-4 text-muted">{tokenLine(residual)}</div>
        </div>
      )}
      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
        <span className="text-[12px] text-muted">合计</span>
        <span className="font-mono text-[13px] tabular-nums text-text">
          {unpriced && !data.total.costUsd ? '未知单价' : formatCost(data.total.costUsd)}
        </span>
      </div>
      <div className="pt-0.5 text-[12px] leading-4 text-text-tertiary">
        用户在输入框里的 token 预估不计入总花费；子代理用量另列。
      </div>
    </div>
  )
}
