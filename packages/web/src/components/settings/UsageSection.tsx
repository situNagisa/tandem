import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, RefreshCw, TriangleAlert } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import type { RouteRole, UsageStatsRow } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { formatCost, formatTokens } from '../../lib/format'
import { IconButton } from '../ui/Button'
import { SegmentedControl } from '../ui/Controls'

import { Card } from '../ui/Card'
type RangeKey = '7d' | '30d' | 'month'
import { Card } from '../ui/Card'

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'month', label: '本月' },
]

function dayString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function rangeOf(key: RangeKey): { from: string; to: string; days: string[] } {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const to = dayString(now)
  let start = new Date(now)
  if (key === '7d') start.setDate(start.getDate() - 6)
  else if (key === '30d') start.setDate(start.getDate() - 29)
  else start = new Date(now.getFullYear(), now.getMonth(), 1)
  const days: string[] = []
  const cursor = new Date(start)
  while (cursor.getTime() <= now.getTime()) {
    days.push(dayString(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return { from: dayString(start), to, days }
}

interface AggRow extends UsageStatsRow {
  hostConfigId: string
  hostName: string
  profileName: string
}

interface RankRow {
  key: string
  label: string
  sub?: string
  cost: number
  tokens: number
  turns: number
}

function rank(
  rows: AggRow[],
  keyOf: (row: AggRow) => string,
  labelOf: (row: AggRow) => { label: string; sub?: string },
): RankRow[] {
  const map = new Map<string, RankRow>()
  for (const row of rows) {
    const key = keyOf(row)
    const current = map.get(key)
    const label = labelOf(row)
    if (current) {
      current.cost += row.costUsd
      current.tokens += row.inputTokens + row.outputTokens
      current.turns += row.turns
    } else {
      map.set(key, {
        key,
        label: label.label,
        sub: label.sub,
        cost: row.costUsd,
        tokens: row.inputTokens + row.outputTokens,
        turns: row.turns,
      })
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
}

function RankTable({ title, rows }: { title: string; rows: RankRow[] }) {
  return (
    <Card className="min-w-0 p-0">
      <div className="border-b border-border/70 px-3 py-2 text-[13px] font-medium text-text-soft">
        {title}
      </div>
      {rows.length === 0 ? (
        <EmptyState variant="plain" title={<>暂无数据</>} />
      ) : (
        <>
          <div className="divide-y divide-[var(--t-border)]">
            {rows.slice(0, 6).map((row) => (
              <div key={row.key} className="flex items-center gap-2 px-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] text-text" data-tip={row.label}>
                    {row.label}
                  </div>
                  {row.sub && <div className="truncate text-[13px] text-muted">{row.sub}</div>}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[13px] tabular-nums text-text">{formatCost(row.cost)}</div>
                  <div className="text-[13px] tabular-nums text-muted">{formatTokens(row.tokens)} tok</div>
                </div>
              </div>
            ))}
          </div>
          {rows.length > 6 && (
            <div className="border-t border-border/70 px-3 py-1 text-[13px] text-muted">
              仅显示前 6 项，共 {rows.length} 项
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function DayChart({ days, values }: { days: string[]; values: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // 按容器实际宽度绘制，避免固定 viewBox 在手机上把 9px 标签缩成 ~5px。
  const [width, setWidth] = useState(() =>
    Math.min(640, Math.max(280, (typeof window !== 'undefined' ? window.innerWidth : 720) - 80)),
  )
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const compact = width < 460
  const height = compact ? 152 : 168
  const padding = { left: compact ? 34 : 40, right: 8, top: 12, bottom: 22 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  const max = Math.max(...values, 0)
  const scale = max > 0 ? plotH / max : 0
  const slot = plotW / Math.max(1, days.length)
  const barW = Math.max(2, Math.min(26, slot * 0.62))
  const labelEvery = Math.max(1, Math.ceil(days.length / (compact ? 4 : 7)))
  const activeIndex = hover ?? pinned
  const activeValue = activeIndex !== null ? (values[activeIndex] ?? 0) : 0
  const activeDay = activeIndex !== null ? (days[activeIndex] ?? '') : ''
  const today = days[days.length - 1]
  const tipLeft =
    activeIndex === null
      ? 4
      : Math.min(width - 96, Math.max(4, padding.left + slot * (activeIndex + 0.5) - 44))

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const next = Math.min(720, Math.max(260, el.clientWidth))
      if (next > 0) setWidth(next)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="h-auto w-full"
        role="img"
        aria-label="按天花费柱状图"
      >
        {[0, 0.5, 1].map((frac) => {
          const y = padding.top + plotH * frac
          return (
            <line
              key={frac}
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke="var(--t-border)"
              strokeWidth={1}
            />
          )
        })}
        <text x={padding.left - 5} y={padding.top + 4} textAnchor="end" fontSize={11} fill="var(--t-muted)">
          {max > 0 ? formatCost(max) : '$0'}
        </text>
        {max > 0 && (
          <text
            x={padding.left - 5}
            y={padding.top + plotH / 2 + 3}
            textAnchor="end"
            fontSize={11}
            fill="var(--t-muted)"
          >
            {formatCost(max / 2)}
          </text>
        )}
        <text x={padding.left - 5} y={padding.top + plotH + 3} textAnchor="end" fontSize={11} fill="var(--t-muted)">
          $0
        </text>
        {days.map((day, i) => {
          const value = values[i] ?? 0
          const h = value > 0 ? Math.max(2, value * scale) : 0
          const x = padding.left + slot * i + (slot - barW) / 2
          const y = padding.top + plotH - h
          const active = activeIndex === i
          const isToday = day === today
          const showLabel = i % labelEvery === 0
          return (
            <g
              key={day}
              onClick={() => setPinned((prev) => (prev === i ? null : i))}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
              aria-label={`${day} 花费 ${formatCost(value)}`}
            >
              <rect x={padding.left + slot * i} y={padding.top} width={slot} height={plotH} fill="transparent" />
              {h > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={2}
                  fill={isToday || active ? 'var(--t-accent)' : 'var(--t-text-soft)'}
                  opacity={active ? 1 : isToday ? 0.72 : 0.42}
                />
              )}
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor={i + labelEvery >= days.length ? 'end' : 'middle'}
                  fontSize={11}
                  fill="var(--t-muted)"
                >
                  {day.slice(5)}
                </text>
              )}
            </g>
          )
        })}
        {max === 0 && (
          <text
            x={padding.left + plotW / 2}
            y={padding.top + plotH / 2 - 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--t-muted)"
          >
            这段时间还没有用量
          </text>
        )}
      </svg>
      {activeIndex !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-text shadow-[var(--t-shadow-sm)]"
          style={{ left: tipLeft }}
        >
          <div className="font-mono">{activeDay}</div>
          <div className="tabular-nums text-text-soft">{formatCost(activeValue)}</div>
        </div>
      )}
      {compact && (
        <div className="mt-1 text-center text-[13px] text-muted">点按柱子查看每日花费</div>
      )}
    </div>
  )
}

export function UsageSection() {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const [range, setRange] = useState<RangeKey>('7d')
  const [rows, setRows] = useState<AggRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const { from, to, days } = useMemo(() => rangeOf(range), [range])
  const profileKey = useMemo(
    () =>
      hosts
        .map((h) => (runtimes[h.id]?.profiles ?? []).map((p) => `${p.id}:${p.name}`).join(','))
        .join('|'),
    [hosts, runtimes],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const jobs = hosts.map(async (host) => {
      const data = await api.usage(host, from, to)
      const profiles = runtimes[host.id]?.profiles ?? []
      return data.map((row) => {
        const profile = profiles.find((p) => p.id === row.profileId)
        return {
          ...row,
          hostConfigId: host.id,
          hostName: host.name,
          profileName: profile?.name ?? row.profileId,
        }
      })
    })
    Promise.allSettled(jobs)
      .then((results) => {
        if (cancelled) return
        const merged: AggRow[] = []
        const errors: string[] = []
        for (const result of results) {
          if (result.status === 'fulfilled') merged.push(...result.value)
          else errors.push(result.reason instanceof Error ? result.reason.message : '读取失败')
        }
        setRows(merged)
        if (errors.length) setError(`部分 Host 用量读取失败：${errors[0]}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hosts, from, to, nonce, profileKey])

  const daily = useMemo(() => {
    const map = new Map<string, number>(days.map((day) => [day, 0]))
    for (const row of rows) {
      if (map.has(row.day)) map.set(row.day, (map.get(row.day) ?? 0) + row.costUsd)
    }
    return days.map((day) => map.get(day) ?? 0)
  }, [rows, days])

  const totals = useMemo(() => {
    let cost = 0
    let input = 0
    let output = 0
    let turns = 0
    for (const row of rows) {
      cost += row.costUsd
      input += row.inputTokens
      output += row.outputTokens
      turns += row.turns
    }
    return { cost, input, output, turns }
  }, [rows])

  const modelRanks = useMemo(
    () => rank(rows, (row) => row.model, (row) => ({ label: row.model })),
    [rows],
  )
  const accountRanks = useMemo(
    () =>
      rank(
        rows,
        (row) => `${row.hostConfigId}:${row.profileId}`,
        (row) => ({ label: row.profileName, sub: row.hostName }),
      ),
    [rows],
  )
  const hostRanks = useMemo(
    () =>
      rank(
        rows,
        (row) => row.hostConfigId,
        (row) => ({ label: row.hostName }),
      ),
    [rows],
  )
  const memberRanks = useMemo(
    () =>
      rank(
        rows.filter((row) => !!row.memberId),
        (row) => `${row.hostConfigId}:${row.memberId}`,
        (row) => ({ label: row.memberName ?? row.memberId ?? '成员', sub: `${row.hostName} · 网关` }),
      ),
    [rows],
  )
  const roleStats = useMemo(() => {
    const map = new Map<RouteRole, { role: RouteRole; calls: number; cost: number; saved: number }>()
    for (const row of rows) {
      if (!row.role) continue
      const current = map.get(row.role) ?? { role: row.role, calls: 0, cost: 0, saved: 0 }
      current.calls += row.turns
      current.cost += row.costUsd
      current.saved += row.routeSavedUsd ?? 0
      map.set(row.role, current)
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost)
  }, [rows])

  const keyRanks = useMemo(
    () =>
      rank(
        rows.filter((row) => !!row.keyId),
        (row) => `${row.hostConfigId}:${row.profileId}:${row.groupId ?? ''}:${row.keyId}`,
        (row) => {
          const profile = (runtimes[row.hostConfigId]?.profiles ?? []).find(
            (p) => p.id === row.profileId,
          )
          const group = profile?.groups?.find((g) => g.id === row.groupId)
          const key = group?.keys?.find((k) => k.id === row.keyId)
          return {
            label: key?.label?.trim() || key?.apiKeyMasked?.slice(-4) || row.keyId?.slice(-8) || 'Key',
            sub: `${profile?.name ?? row.profileName}${group ? ` / ${group.name}` : ''}`,
          }
        },
      ),
    [rows, runtimes],
  )

  return (
    <div>
      <div data-setting-id="usage.range" className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">用量</h3>
        <span className="text-[13px] text-muted">跨 Host 汇总</span>
        <span className="flex-1" />
        <SegmentedControl
          aria-label="统计范围"
          value={range}
          onChange={setRange}
          options={RANGES.map((item) => ({ value: item.key, label: item.label }))}
        />
        <IconButton
          onClick={() => setNonce((n) => n + 1)}
          disabled={loading}
          label="刷新"
          tooltip="刷新用量"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
          <TriangleAlert size={12} /> {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card>
          <div className="text-[13px] text-muted">总花费</div>
          <div className="mt-0.5 font-mono text-[17px] tabular-nums text-text">{formatCost(totals.cost)}</div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">输入 token</div>
          <div className="mt-0.5 font-mono text-[17px] tabular-nums text-text">{formatTokens(totals.input)}</div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">输出 token</div>
          <div className="mt-0.5 font-mono text-[17px] tabular-nums text-text">{formatTokens(totals.output)}</div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">回合</div>
          <div className="mt-0.5 font-mono text-[17px] tabular-nums text-text">{totals.turns}</div>
        </Card>
      </div>

      <Card data-setting-id="usage.chart" className="mt-3">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-text-soft">
          <BarChart3 size={13} className="text-muted" /> 按天花费
          {loading && <Spinner size={11} className="text-muted" />}
          <span className="flex-1" />
          <span className="text-[13px] font-normal text-muted">
            {from} — {to}
          </span>
        </div>
        <DayChart days={days} values={daily} />
      </Card>

      <div data-setting-id="usage.models" className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <RankTable title="按模型" rows={modelRanks} />
        <RankTable title="按账号" rows={accountRanks} />
        <RankTable title="按 Key" rows={keyRanks} />
        {memberRanks.length > 0 && <RankTable title="按成员" rows={memberRanks} />}
        {hosts.length > 1 && <RankTable title="按 Host" rows={hostRanks} />}
      </div>

      {roleStats.length > 0 && (
        <Card data-setting-id="usage.roles" className="mt-3 p-0">
          <div className="border-b border-border/70 px-3 py-2 text-[13px] font-medium text-text-soft">
            分工路由 · 按角色
          </div>
          <div className="divide-y divide-[var(--t-border)]">
            {roleStats.map((item) => (
              <div key={item.role} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                <span className="min-w-0 flex-1 text-text">
                  {item.role === 'planner'
                    ? '规划者'
                    : item.role === 'executor'
                      ? '执行者'
                      : item.role === 'specialist'
                        ? '专长执行者'
                        : '审查者'}
                </span>
                <span className="w-12 shrink-0 text-right text-[12px] text-muted">{item.calls} 次</span>
                <span className="w-20 shrink-0 text-right font-mono tabular-nums text-text">
                  {formatCost(item.cost)}
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted" data-tip="对比全程使用最强档的估算节省">
                  {item.saved > 0 ? `省 ${formatCost(item.saved)}` : '—'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="settings-note">
        花费按实际记账：官方参考价（每百万 token 美元）× 账号倍率 × 分组倍率；按模型覆盖单价时不乘倍率。
        倍率变化只影响之后的请求，已记录的历史花费不会重算。
      </p>
    </div>
  )
}
