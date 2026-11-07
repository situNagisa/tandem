import { useEffect, useState } from 'react'
import type { PermissionRule } from '@tandem/protocol'
import { ArrowDown, ArrowUp, Loader2, Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'

const TOOL_OPTIONS = ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'browser_navigate', 'browser_*', '*']

const ACTIONS: Array<{ value: PermissionRule['action']; label: string }> = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '询问' },
  { value: 'deny', label: '拒绝' },
]

function placeholderFor(tool: string): string {
  if (tool === 'Bash') return '命令前缀，如 npm test*'
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') return '文件 glob，如 src/**/*.ts'
  if (tool.startsWith('browser_')) return '域名模式，如 192.168.* 或 *.corp.example.com'
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
    return (
      <div className="settings-empty">
        <span className="settings-empty-icon"><ShieldCheck size={17} /></span>
        <p className="settings-empty-title">还没有连接 Host</p>
        <p className="settings-empty-hint">先添加一台 Host，才能配置权限规则。</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={15} className="text-text-soft" />
          <h3 className="text-[14px] font-semibold">权限规则</h3>
          <span className="rounded-[4px] bg-[var(--t-surface-2)] px-1.5 py-0.5 font-mono text-[12px] text-muted">
            {host.name}
          </span>
          <span className="flex-1" />
          <Button
            variant="primary"
            onClick={() =>
              setRules((prev) => [...prev, { tool: 'Bash', pattern: '', action: 'ask' }])
            }
            disabled={loading || !!error}
            className="max-sm:min-h-11"
          >
            <Plus size={13} /> 添加规则
          </Button>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          规则保存在 Host 上，对所有会话生效。优先级为拒绝 &gt; 询问 &gt; 允许；Bash 的
          pattern 是命令前缀通配，文件工具是相对工作目录的 glob，browser_* 的 pattern 是域名模式。
          浏览器还有一道硬边界：不在设置 → 浏览器允许列表里的域名一律拒绝。
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> 正在读取权限规则…
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] leading-5 text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      ) : (
        <div className="space-y-2">
          {rules.length === 0 && (
            <div className="settings-empty">
              <span className="settings-empty-icon">
                <ShieldCheck size={17} />
              </span>
              <p className="settings-empty-title">暂无权限规则</p>
              <p className="settings-empty-hint">
                未命中的工具调用会按会话权限模式处理。添加规则可减少重复审批。
              </p>
            </div>
          )}
          {rules.map((rule, index) => (
            <div
              key={index}
              className="settings-item flex flex-wrap items-center gap-1.5 px-2 py-2"
            >
              <MenuSelect
                value={rule.tool}
                onChange={(tool) => update(index, { tool })}
                aria-label="工具"
                options={[
                  ...(!TOOL_OPTIONS.includes(rule.tool)
                    ? [{ value: rule.tool, label: rule.tool }]
                    : []),
                  ...TOOL_OPTIONS.map((tool) => ({
                    value: tool,
                    label: tool === '*' ? '全部工具' : tool,
                  })),
                ]}
                wrapperClassName="w-[96px] shrink-0"
                className="font-mono"
              />
              <Input
                value={rule.pattern ?? ''}
                onChange={(e) => update(index, { pattern: e.target.value || undefined })}
                placeholder={placeholderFor(rule.tool)}
                aria-label="匹配模式"
                className="min-w-0 flex-1 font-mono max-sm:order-last max-sm:basis-full"
              />
              <SegmentedControl
                aria-label="规则动作"
                className="shrink-0"
                options={ACTIONS.map((action) => ({ value: action.value, label: action.label }))}
                value={rule.action}
                onChange={(action) => update(index, { action })}
              />
              <div className="settings-actions">
                <IconButton
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  label="上移规则"
                  tooltip="上移"
                  className="size-7 [&_svg]:size-3"
                >
                  <ArrowUp size={12} />
                </IconButton>
                <IconButton
                  onClick={() => move(index, 1)}
                  disabled={index === rules.length - 1}
                  label="下移规则"
                  tooltip="下移"
                  className="size-7 [&_svg]:size-3"
                >
                  <ArrowDown size={12} />
                </IconButton>
                <IconButton
                  variant="danger-ghost"
                  onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}
                  label="删除规则"
                  tooltip="删除"
                  className="size-7 [&_svg]:size-3"
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span className="text-[13px] text-muted">
          {dirty ? '有未保存的修改' : rules.length ? `共 ${rules.length} 条规则` : ''}
        </span>
        <span className="flex-1" />
        {dirty && (
          <Button onClick={() => setRules(saved)}>撤销</Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving && <Loader2 size={12} className="animate-spin" />}
          保存
        </Button>
      </div>
    </div>
  )
}
