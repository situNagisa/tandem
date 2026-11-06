import { useEffect, useState } from 'react'
import type { PermissionRule } from '@tandem/protocol'
import { ArrowDown, ArrowUp, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl, Select } from '../ui/Controls'

const TOOL_OPTIONS = ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', '*']

const ACTIONS: Array<{ value: PermissionRule['action']; label: string }> = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '询问' },
  { value: 'deny', label: '拒绝' },
]

function placeholderFor(tool: string): string {
  if (tool === 'Bash') return '命令前缀，如 npm test*'
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') return '文件 glob，如 src/**/*.ts'
  return '留空表示匹配该工具的所有调用'
}

export function PermissionsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = hosts.find((h) => h.id === activeHostId) ?? null
  const toast = useUiStore((s) => s.toast)

  const [rules, setRules] = useState<PermissionRule[]>([])
  const [saved, setSaved] = useState<PermissionRule[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!host) {
      setRules([])
      setSaved([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    api
      .permissions(host)
      .then((list) => {
        if (cancelled) return
        setRules(list)
        setSaved(list)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取权限规则失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host])

  const dirty = JSON.stringify(rules) !== JSON.stringify(saved)

  const update = (index: number, patch: Partial<PermissionRule>) => {
    setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }

  const move = (index: number, delta: number) => {
    setRules((prev) => {
      const next = prev.slice()
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const save = async () => {
    if (!host || saving) return
    setSaving(true)
    try {
      const result = await api.setPermissions(host, rules)
      setRules(result)
      setSaved(result)
      toast('权限规则已保存', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存权限规则失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!host) {
    return <p className="text-[12.5px] text-muted">先添加一台 Host 才能配置权限规则。</p>
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <ShieldCheck size={15} className="text-text-soft" />
          <h2 className="text-[14px] font-semibold">权限规则</h2>
          <span className="rounded bg-bg-hover px-1.5 py-0.5 text-[10.5px] text-muted">{host.name}</span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          规则保存在 Host 上，对所有会话生效。优先级为
          <span className="mx-1 text-danger">拒绝</span>&gt;
          <span className="mx-1 text-text-soft">询问</span>&gt;
          <span className="mx-1 text-success">允许</span>
          ；Bash 的 pattern 是命令前缀通配，文件工具是相对工作目录的 glob。
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      ) : (
        <div className="space-y-2">
          {rules.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[12px] text-muted">
              暂无规则。未命中的工具调用会按会话权限模式处理。
            </p>
          )}
          {rules.map((rule, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg/40 px-2 py-2"
            >
              <Select
                size="sm"
                value={rule.tool}
                onChange={(e) => update(index, { tool: e.target.value })}
                aria-label="工具"
                wrapperClassName="w-[96px] shrink-0"
                className="font-mono"
              >
                {!TOOL_OPTIONS.includes(rule.tool) && <option value={rule.tool}>{rule.tool}</option>}
                {TOOL_OPTIONS.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool === '*' ? '全部工具' : tool}
                  </option>
                ))}
              </Select>
              <Input
                size="sm"
                value={rule.pattern ?? ''}
                onChange={(e) => update(index, { pattern: e.target.value || undefined })}
                placeholder={placeholderFor(rule.tool)}
                aria-label="匹配模式"
                className="min-w-0 flex-1 font-mono max-sm:order-last max-sm:basis-full"
              />
              <SegmentedControl
                aria-label="规则动作"
                size="sm"
                className="shrink-0"
                options={ACTIONS.map((action) => ({ value: action.value, label: action.label }))}
                value={rule.action}
                onChange={(action) => update(index, { action })}
              />
              <div className="flex shrink-0 items-center">
                <IconButton
                  size="sm"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  label="上移规则"
                  className="size-7 [&_svg]:size-3"
                >
                  <ArrowUp size={12} />
                </IconButton>
                <IconButton
                  size="sm"
                  onClick={() => move(index, 1)}
                  disabled={index === rules.length - 1}
                  label="下移规则"
                  className="size-7 [&_svg]:size-3"
                >
                  <ArrowDown size={12} />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}
                  label="删除规则"
                  className="size-7 [&_svg]:size-3"
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            </div>
          ))}

          <Button
            variant="secondary"
            onClick={() =>
              setRules((prev) => [...prev, { tool: 'Bash', pattern: '', action: 'ask' }])
            }
            className="border-dashed"
          >
            <Plus size={13} /> 添加规则
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span className="text-[11px] text-muted">
          {dirty ? '有未保存的修改' : rules.length ? `共 ${rules.length} 条规则` : ''}
        </span>
        <span className="flex-1" />
        {dirty && (
          <Button size="sm" onClick={() => setRules(saved)}>
            撤销
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving && <Loader2 size={11} className="animate-spin" />}
          保存
        </Button>
      </div>
    </div>
  )
}
