import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import type {
  ModelPriceChange,
  ModelPriceEntry,
  ModelPricePreview,
  ModelPriceTable,
  ModelPriceVendor,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Modal } from '../ui/Modal'
import { SettingNote, SettingRow } from '../ui/SettingRow'
import { Spinner } from '../ui/Spinner'
import { inputCls } from './profiles/shared'

/** 每百万 token 美元：去掉多余的 0，便于核对。 */
const money = (value: number | undefined) =>
  value === undefined ? '—' : `$${String(Number(value.toFixed(4)))}`

const FIELD_LABELS: Record<string, string> = {
  input: '输入',
  output: '输出',
  cacheWrite5m: '缓存写',
  cacheWrite1h: '缓存写 1h',
  cacheRead: '缓存读',
  longPrompt: '分段价',
}

function ruleText(vendor: ModelPriceVendor): string {
  const rule = vendor.rule
  if (!rule) return 'models'
  if (rule.type === 'json') return rule.path || 'models'
  return JSON.stringify(rule)
}

function rateLine(entry: ModelPriceEntry): string {
  const parts = [`输入 ${money(entry.input)}`, `输出 ${money(entry.output)}`]
  parts.push(`缓存写 ${money(entry.cacheWrite5m)}`, `缓存读 ${money(entry.cacheRead)}`)
  if (entry.cacheWrite1h !== undefined) parts.push(`缓存写 1h ${money(entry.cacheWrite1h)}`)
  return parts.join(' · ')
}

function segmentedLine(entry: ModelPriceEntry): string | undefined {
  if (!entry.longPrompt) return undefined
  const { threshold, rates } = entry.longPrompt
  return `分段：提示超过 ${Math.round(threshold / 1000)}K 时输入 ${money(rates.input)} · 输出 ${money(rates.output)}`
}

function changeLine(change: ModelPriceChange): string {
  const label = change.status === 'added' ? '新增' : change.status === 'removed' ? '移除' : '调价'
  const after = change.after
  if (!after) return `${change.model}（${label}）`
  const fields = change.fields.length ? `（${change.fields.map((key) => FIELD_LABELS[key] ?? key).join('、')}）` : ''
  return `${change.model}（${label}）${fields} ${rateLine(after)}`
}

/**
 * 设置 →「模型价格」：官方价按厂商列出（四种单价、分段价、来源链接、更新时间），
 * 每个厂商可配置定价页地址与解析规则；刷新先返回差异预览，确认后才写入（MODEL-5/6）。
 */
export function ModelPricesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const toast = useUiStore((s) => s.toast)
  const host = hosts.find((h) => h.id === activeHostId) ?? hosts[0]

  const [table, setTable] = useState<ModelPriceTable | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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

  const openEditor = (vendor: ModelPriceVendor) => {
    setEditing(vendor.id)
    setSourceDraft(vendor.source)
    setRuleDraft(ruleText(vendor))
  }

  const saveConfig = async (vendor: ModelPriceVendor) => {
    if (!host || saving) return
    setSaving(true)
    setVendorError((prev) => ({ ...prev, [vendor.id]: '' }))
    try {
      const saved = await api.savePriceVendor(host, vendor.id, { source: sourceDraft, rule: ruleDraft })
      setTable((prev) =>
        prev
          ? {
              ...prev,
              vendors: prev.vendors.map((item) => (item.id === vendor.id ? saved.vendor : item)),
            }
          : prev,
      )
      setEditing(null)
      toast('获取方式已保存', 'success')
    } catch (err) {
      setVendorError((prev) => ({
        ...prev,
        [vendor.id]: err instanceof Error ? err.message : '保存失败',
      }))
    } finally {
      setSaving(false)
    }
  }

  const refresh = async (vendor: ModelPriceVendor) => {
    if (!host || refreshing) return
    setRefreshing(vendor.id)
    setVendorError((prev) => ({ ...prev, [vendor.id]: '' }))
    try {
      const result = await api.refreshPriceVendor(host, vendor.id)
      if (result.preview.changes.length === 0) {
        toast('与当前价格一致，没有需要写入的变更', 'success')
        return
      }
      setPreview(result.preview)
    } catch (err) {
      setVendorError((prev) => ({
        ...prev,
        [vendor.id]: err instanceof Error ? err.message : '刷新失败',
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
        {table?.file ? (
          <SettingNote>数据文件：{table.file}</SettingNote>
        ) : null}
      </Card>

      {vendors.map((vendor) => (
        <Card key={vendor.id} className="px-3 py-2.5" data-price-vendor={vendor.id}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-[13px] font-medium text-text">{vendor.label}</h3>
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

          <div className="mt-1.5 divide-y divide-border/60" data-price-models>
            {vendor.models.map((entry) => {
              const segmented = segmentedLine(entry)
              return (
                <div key={entry.model} className="flex flex-wrap items-baseline gap-x-2 py-1">
                  <span className="w-full truncate font-mono text-[12.5px] text-text sm:w-56" data-tip={entry.model}>
                    {entry.model}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-text-soft">{rateLine(entry)}</span>
                  {segmented ? (
                    <span className="w-full text-[12px] leading-4 text-muted">{segmented}</span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </Card>
      ))}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        ariaLabel="刷新预览"
        title="刷新预览（差异）"
        description="确认后写入价格表；页面上没出现的型号保留原价。"
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
          <div className="space-y-1">
            <div className="text-[12px] text-muted">来自 {preview.source}</div>
            {preview.changes.map((change) => (
              <div key={change.model} className="border-t border-border/60 py-1 text-[12.5px] leading-5 first:border-t-0">
                <span className="font-mono text-text-soft">{changeLine(change)}</span>
                {change.before && change.status === 'changed' ? (
                  <div className="text-[12px] text-muted">原价：{rateLine(change.before)}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
