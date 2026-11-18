import { Fragment, useEffect, useMemo, useState } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import type {
  ModelPriceChange,
  ModelPricePreview,
  ModelPriceTable,
  ModelPriceVendor,
  UnitPrice,
} from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { SegmentedControl } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { SettingNote, SettingRow } from '../ui/SettingRow'
import { Spinner } from '../ui/Spinner'
import { inputCls } from './profiles/shared'

/** 每百万 token 美元：去掉多余的 0，便于核对。 */
const money = (value: number | undefined) =>
  value === undefined ? '—' : `$${String(Number(value.toFixed(4)))}`

type RateKey = keyof UnitPrice

const RATE_COLUMNS: Array<{ key: RateKey; label: string }> = [
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheWrite5m', label: '缓存写 5m' },
  { key: 'cacheWrite1h', label: '缓存写 1h' },
  { key: 'cacheRead', label: '缓存读' },
]

/** 输入、输出必有；缓存列在整张表都没有收录时省掉。 */
function rateColumns(entries: Array<UnitPrice | undefined>) {
  return RATE_COLUMNS.filter(
    (column) =>
      column.key === 'input' ||
      column.key === 'output' ||
      entries.some((rates) => rates?.[column.key] !== undefined),
  )
}

/** 只给读屏保留的列名，保证单价单元格在表格外被读出时也知道是哪一项。 */
function RateValue({ label, value, muted }: { label: string; value?: number; muted?: boolean }) {
  return (
    <>
      <span className="sr-only">{label} </span>
      <span className={muted ? 'text-muted' : undefined}>{money(value)}</span>
    </>
  )
}

function rateCellClass(extra?: string) {
  return cn('whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums', extra)
}

function ruleText(vendor: ModelPriceVendor): string {
  const rule = vendor.rule
  if (!rule) return 'models'
  if (rule.type === 'json') return rule.path || 'models'
  return JSON.stringify(rule)
}

function changeLabel(change: ModelPriceChange): string {
  return change.status === 'added' ? '新增' : change.status === 'removed' ? '移除' : '调价'
}

/** 预览单元格：变化项显示「旧 → 新」，未变化项显示当前值并弱化。 */
function RateDiff({
  before,
  after,
  changed,
  normal,
}: {
  before?: number
  after?: number
  changed: boolean
  normal: boolean
}) {
  if (!changed || before === after) {
    if (before === undefined && after === undefined) return <span className="text-muted">—</span>
    return <span className={normal ? 'text-text' : 'text-muted'}>{money(after ?? before)}</span>
  }
  if (before === undefined) return <span className="text-text">{money(after)}</span>
  return (
    <span className="inline-flex items-baseline justify-end gap-1">
      <s className="text-muted">{money(before)}</s>
      <span className="text-xs text-muted">→</span>
      <span className={after === undefined ? 'text-muted' : 'text-text'}>{money(after)}</span>
    </span>
  )
}

/**
 * 设置 →「模型价格」：顶部厂商标签切换，选中厂商以表格列出官方价（输入/输出/缓存写/缓存读、
 * 分段价、来源链接、更新时间），每个厂商可配置定价页地址与解析规则；刷新先返回差异表格，
 * 确认后才写入（MODEL-5/6）。
 */
export function ModelPricesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const toast = useUiStore((s) => s.toast)
  const host = hosts.find((h) => h.id === activeHostId) ?? hosts[0]

  const [table, setTable] = useState<ModelPriceTable | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeVendorId, setActiveVendorId] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [sourceDraft, setSourceDraft] = useState('')
  const [ruleDraft, setRuleDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [vendorError, setVendorError] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<ModelPricePreview | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!host) return
    let alive = true
    setLoading(true)
    setError('')
    api
      .priceTable(host)
      .then((value) => {
        if (alive) setTable(value)
      })
      .catch((err: Error) => {
        if (alive) setError(err.message || '读取价格表失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [host?.id])

  const vendors = useMemo(() => table?.vendors ?? [], [table])
  const vendor = vendors.find((item) => item.id === activeVendorId) ?? vendors[0]
  const modelColumns = useMemo(
    () => rateColumns((vendor?.models ?? []).flatMap((entry) => [entry, entry.longPrompt?.rates])),
    [vendor],
  )
  const previewColumns = useMemo(
    () =>
      rateColumns(
        (preview?.changes ?? []).flatMap((change) => [
          change.before,
          change.after,
          change.before?.longPrompt?.rates,
          change.after?.longPrompt?.rates,
        ]),
      ),
    [preview],
  )

  /*
   * 表格里每行都带一份只给读屏的列名（sr-only）。modelRowText 这类验收辅助靠行内
   * 同时出现「输入/输出」与金额来定位单个模型，表格化后表头在行外，保留在行内是现行约定。
   */

  const openEditor = (item: ModelPriceVendor) => {
    setEditing(item.id)
    setSourceDraft(item.source)
    setRuleDraft(ruleText(item))
  }

  const saveConfig = async (item: ModelPriceVendor) => {
    if (!host || saving) return
    setSaving(true)
    setVendorError((prev) => ({ ...prev, [item.id]: '' }))
    try {
      const saved = await api.savePriceVendor(host, item.id, { source: sourceDraft, rule: ruleDraft })
      setTable((prev) =>
        prev
          ? {
              ...prev,
              vendors: prev.vendors.map((entry) => (entry.id === item.id ? saved.vendor : entry)),
            }
          : prev,
      )
      setEditing(null)
      toast('获取方式已保存', 'success')
    } catch (err) {
      setVendorError((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : '保存失败',
      }))
    } finally {
      setSaving(false)
    }
  }

  const refresh = async (item: ModelPriceVendor) => {
    if (!host || refreshing) return
    setRefreshing(item.id)
    setVendorError((prev) => ({ ...prev, [item.id]: '' }))
    try {
      const result = await api.refreshPriceVendor(host, item.id)
      if (result.preview.changes.length === 0) {
        toast('与当前价格一致，没有需要写入的变更', 'success')
        return
      }
      setPreview(result.preview)
    } catch (err) {
      setVendorError((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : '刷新失败',
      }))
    } finally {
      setRefreshing(null)
    }
  }

  const applyPreview = async () => {
    if (!host || !preview || applying) return
    setApplying(true)
    try {
      const saved = await api.applyPriceVendor(host, preview.vendorId, preview.models)
      setTable((prev) =>
        prev
          ? {
              ...prev,
              vendors: prev.vendors.map((item) => (item.id === saved.vendor.id ? saved.vendor : item)),
            }
          : prev,
      )
      setPreview(null)
      toast('官方价已更新', 'success')
    } catch (err) {
      setPreview(null)
      setVendorError((prev) => ({
        ...prev,
        [preview.vendorId]: err instanceof Error ? err.message : '写入失败',
      }))
    } finally {
      setApplying(false)
    }
  }

  if (!host) return <p className="text-[13px] text-muted">先连接一个主机，再查看官方价格表。</p>
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[13px] text-muted">
        <Spinner size={12} /> 读取价格表…
      </div>
    )
  }
  if (error) {
    return (
      <p className="flex items-start gap-1.5 text-[13px] leading-5 text-danger">
        <TriangleAlert size={13} className="mt-1 shrink-0" /> {error}
      </p>
    )
  }

  return (
    <div className="space-y-3" data-setting-id="prices.vendors">
      <Card className="px-3 py-2.5">
        <p className="text-[13px] leading-5 text-text-soft">
          计价只认这张官方价格表，以及分组里为某个模型设置的自定义单价；调价不改已记账的花费。
        </p>
        {table?.file ? <SettingNote>数据文件：{table.file}</SettingNote> : null}
      </Card>

      {vendors.length > 1 ? (
        <div className="-mx-0.5 overflow-x-auto px-0.5 pb-0.5" data-price-vendor-tabs>
          <SegmentedControl
            size="sm"
            aria-label="厂商"
            className="w-max"
            value={vendor?.id ?? ''}
            onChange={(value) => {
              setActiveVendorId(value)
              setEditing(null)
            }}
            options={vendors.map((item) => ({ value: item.id, label: item.label }))}
          />
        </div>
      ) : null}

      {vendor ? (
        <Card className="px-3 py-2.5" data-price-vendor={vendor.id} aria-label={vendor.label}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <a
              href={vendor.source}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-[12px] text-text-tertiary underline decoration-border underline-offset-2 hover:text-text"
            >
              {vendor.source}
            </a>
            <span className="text-[12px] text-muted">更新于 {vendor.updatedAt ?? '—'}</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => openEditor(vendor)}>
              获取方式
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refresh(vendor)}
              disabled={refreshing === vendor.id}
            >
              {refreshing === vendor.id ? <Spinner size={12} /> : <RefreshCw size={12} />}
              刷新
            </Button>
          </div>

          {editing === vendor.id && (
            <div className="mt-2 rounded-lg border border-border bg-bg/40 p-2.5" data-price-editor>
              <SettingRow label="定价页地址" htmlFor={`price-source-${vendor.id}`} stacked wide>
                <input
                  id={`price-source-${vendor.id}`}
                  value={sourceDraft}
                  onChange={(e) => setSourceDraft(e.target.value)}
                  placeholder="https://厂商定价页地址"
                  spellCheck={false}
                  className={inputCls}
                />
              </SettingRow>
              <SettingRow
                label="解析规则"
                htmlFor={`price-rule-${vendor.id}`}
                stacked
                wide
                hint='JSON 路径写 models；HTML 表格写 {"type":"html-table","table":"table#pricing","columns":{"model":0,"input":1,"output":2,"cacheWrite":3,"cacheRead":4}}'
              >
                <textarea
                  id={`price-rule-${vendor.id}`}
                  value={ruleDraft}
                  onChange={(e) => setRuleDraft(e.target.value)}
                  placeholder="解析规则：models 或 HTML 表格 JSON"
                  spellCheck={false}
                  rows={2}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-text outline-none focus:border-border-strong"
                />
              </SettingRow>
              <div className="mt-1.5 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void saveConfig(vendor)} disabled={saving}>
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  取消
                </Button>
              </div>
            </div>
          )}

          {vendorError[vendor.id] ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-4 text-danger">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              {vendorError[vendor.id]}
            </p>
          ) : null}

          <div className="mt-2 flex items-baseline justify-between gap-2 text-[12px] text-muted">
            <span>{vendor.models.length} 个型号</span>
            <span>美元 / 百万 token</span>
          </div>

          <div className="mt-1 overflow-x-auto" data-price-models>
            <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border text-[12px] text-muted">
                  <th className="px-2 py-1.5 text-left font-medium">模型</th>
                  {modelColumns.map((column) => (
                    <th key={column.key} className="whitespace-nowrap px-2 py-1.5 text-right font-medium">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vendor.models.map((entry) => {
                  const threshold = entry.longPrompt ? `${Math.round(entry.longPrompt.threshold / 1000)}K` : ''
                  return (
                    <Fragment key={entry.model}>
                      <tr className="border-b border-border/60 last:border-0">
                        <td className="px-2 py-1.5">
                          <span
                            className="block max-w-[280px] truncate font-mono text-[12.5px] text-text"
                            data-tip={entry.model}
                          >
                            {entry.model}
                          </span>
                        </td>
                        {modelColumns.map((column) => (
                          <td key={column.key} className={rateCellClass('text-text-soft')}>
                            <RateValue label={column.label} value={entry[column.key]} />
                          </td>
                        ))}
                      </tr>
                      {entry.longPrompt ? (
                        <tr className="border-b border-border/60 bg-bg/30 last:border-0">
                          <td className="py-1 pl-5 pr-2 text-[12px] text-muted">&gt; {threshold} 提示</td>
                          {modelColumns.map((column) => (
                            <td key={column.key} className={rateCellClass('py-1 text-[12px] text-muted')}>
                              <RateValue label={column.label} value={entry.longPrompt?.rates[column.key]} muted />
                            </td>
                          ))}
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        ariaLabel="刷新预览"
        title="刷新预览（差异）"
        description="确认后写入价格表；页面上没出现的型号保留原价。"
        className="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void applyPreview()} disabled={applying}>
              {applying ? <Spinner size={12} /> : null}
              写入价格
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-muted">
              <span className="min-w-0 break-all">来自 {preview.source}</span>
              <span className="flex-1" />
              <span className="whitespace-nowrap">{preview.changes.length} 项变化</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-[12px] text-muted">
                    <th className="px-2 py-1.5 text-left font-medium">模型</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">变化</th>
                    {previewColumns.map((column) => (
                      <th key={column.key} className="whitespace-nowrap px-2 py-1.5 text-right font-medium">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change) => {
                    const after = change.after
                    const before = change.before
                    const longThreshold = after?.longPrompt?.threshold ?? before?.longPrompt?.threshold
                    const normal = change.status === 'added'
                    return (
                      <Fragment key={change.model}>
                        <tr className="border-b border-border/60 last:border-0">
                          <td className="px-2 py-1.5">
                            <span
                              className="block max-w-[280px] truncate font-mono text-[12.5px] text-text"
                              data-tip={change.model}
                            >
                              {change.model}
                            </span>
                          </td>
                          <td
                            className={cn(
                              'whitespace-nowrap px-2 py-1.5 text-[12px]',
                              change.status === 'added'
                                ? 'text-success'
                                : change.status === 'removed'
                                  ? 'text-danger'
                                  : 'text-warning',
                            )}
                          >
                            {changeLabel(change)}
                          </td>
                          {previewColumns.map((column) => (
                            <td key={column.key} className={rateCellClass()}>
                              <RateDiff
                                before={before?.[column.key]}
                                after={after?.[column.key]}
                                changed={normal || change.fields.includes(column.key)}
                                normal={normal}
                              />
                            </td>
                          ))}
                        </tr>
                        {longThreshold !== undefined ? (
                          <tr className="border-b border-border/60 bg-bg/30 last:border-0">
                            <td className="py-1 pl-5 pr-2 text-[12px] text-muted">
                              &gt; {Math.round(longThreshold / 1000)}K 提示
                            </td>
                            <td />
                            {previewColumns.map((column) => (
                              <td key={column.key} className={rateCellClass('py-1 text-[12px]')}>
                                <RateDiff
                                  before={before?.longPrompt?.rates[column.key]}
                                  after={after?.longPrompt?.rates[column.key]}
                                  changed={normal || change.fields.includes('longPrompt')}
                                  normal={normal}
                                />
                              </td>
                            ))}
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
