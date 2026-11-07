import { useEffect, useState } from 'react'
import type {
  PermissionInsights,
  PermissionRule,
  PermissionRuleDraft,
  SandboxSettings,
  SandboxStatus,
} from '@tandem/protocol'
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl, Switch, Textarea } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'

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

function lastSegment(value?: string): string {
  if (!value) return ''
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value
}

const ACTION_LABEL: Record<PermissionRule['action'], string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
}

export function PermissionsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = hosts.find((h) => h.id === activeHostId) ?? null
  const toast = useUiStore((s) => s.toast)

  const activeSessionId = useAppStore((s) => s.active?.summary?.id ?? null)
  const [rules, setRules] = useState<PermissionRule[]>([])
  const [saved, setSaved] = useState<PermissionRule[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [insights, setInsights] = useState<PermissionInsights | null>(null)
  const [busySuggestion, setBusySuggestion] = useState<string | null>(null)
  // 手机屏幕小：建议区默认收起，避免把下方规则列表挤出首屏；桌面默认展开。
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [nlText, setNlText] = useState('')
  const [nlError, setNlError] = useState<string | undefined>()
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState<PermissionRuleDraft | null>(null)
  const [draftSaving, setDraftSaving] = useState(false)
  const [sandbox, setSandbox] = useState<SandboxSettings | null>(null)
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null)
  const [sandboxHostText, setSandboxHostText] = useState('')
  const [sandboxSaving, setSandboxSaving] = useState(false)

  useEffect(() => {
    setInsightsOpen(window.innerWidth >= 640)
  }, [])

  useEffect(() => {
    if (!host) {
      setRules([])
      setSaved([])
      setInsights(null)
      setSandbox(null)
      setSandboxStatus(null)
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
    api
      .permissionInsights(host)
      .then((value) => {
        if (!cancelled) setInsights(value)
      })
      .catch(() => {
        if (!cancelled) setInsights(null)
      })
    api
      .sandboxStatus(host)
      .then((value) => {
        if (cancelled) return
        setSandboxStatus(value)
        setSandbox(value.settings)
        setSandboxHostText(value.settings.allowedHosts.join('\n'))
      })
      .catch(() => {
        if (!cancelled) setSandboxStatus(null)
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

  const refreshInsights = () => {
    if (!host) return
    api.permissionInsights(host).then(setInsights).catch(() => setInsights(null))
  }

  const applyRules = (list: PermissionRule[]) => {
    setRules(list)
    setSaved(list)
  }

  const adopt = async (id: string) => {
    if (!host || busySuggestion) return
    if (dirty) {
      toast('请先保存或撤销手动修改，再采纳建议', 'error')
      return
    }
    setBusySuggestion(id)
    try {
      applyRules(await api.adoptPermissionSuggestion(host, id))
      refreshInsights()
      toast('已采纳规则建议', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '采纳建议失败', 'error')
    } finally {
      setBusySuggestion(null)
    }
  }

  const ignore = async (id: string) => {
    if (!host || busySuggestion) return
    setBusySuggestion(id)
    try {
      await api.ignorePermissionSuggestion(host, id)
      setInsights((prev) =>
        prev ? { ...prev, suggestions: prev.suggestions.filter((item) => item.id !== id) } : prev,
      )
      toast('已忽略该建议', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '忽略建议失败', 'error')
    } finally {
      setBusySuggestion(null)
    }
  }

  const generateDraft = async () => {
    if (!host || drafting || !nlText.trim()) return
    if (!activeSessionId) {
      setNlError('先打开一个会话，才能用该会话的模型生成规则')
      return
    }
    setDrafting(true)
    setNlError(undefined)
    try {
      setDraft(await api.draftPermissionRule(host, activeSessionId, nlText.trim()))
    } catch (err) {
      setNlError(err instanceof Error ? err.message : '生成规则失败')
    } finally {
      setDrafting(false)
    }
  }

  const saveDraft = async () => {
    if (!host || !draft || draftSaving) return
    setDraftSaving(true)
    try {
      applyRules(await api.addPermissionRule(host, draft.rule))
      setDraft(null)
      setNlText('')
      refreshInsights()
      toast('已保存规则', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存规则失败', 'error')
    } finally {
      setDraftSaving(false)
    }
  }

  const updateSandbox = async (patch: Partial<SandboxSettings>, hostText?: string) => {
    if (!host || sandboxSaving) return
    const current = sandbox ?? sandboxStatus?.settings
    if (!current) return
    const next: SandboxSettings = {
      ...current,
      ...patch,
      allowedHosts:
        patch.allowedHosts ??
        (hostText !== undefined
          ? hostText
              .split(/[\s,，;；]+/)
              .map((item) => item.trim())
              .filter(Boolean)
          : current.allowedHosts),
    }
    setSandbox(next)
    setSandboxHostText(next.allowedHosts.join('\n'))
    setSandboxSaving(true)
    try {
      const saved = await api.updateSettings(host, { sandbox: next })
      if (saved.sandbox) {
        setSandbox(saved.sandbox)
        setSandboxHostText(saved.sandbox.allowedHosts.join('\n'))
      }
      toast('沙箱设置已保存', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存沙箱设置失败', 'error')
    } finally {
      setSandboxSaving(false)
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
      <div className="settings-item space-y-2 px-2.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles size={14} className="text-accent-text" />
          <h3 className="text-[13px] font-semibold">建议的规则</h3>
          <span className="flex-1" />
          <span className="text-[12px] text-muted" data-approval-stats="">
            过去 7 天：弹窗 {insights?.stats.prompts ?? 0} 次，被规则自动处理{' '}
            {insights?.stats.autoHandled ?? 0} 次
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setInsightsOpen((open) => !open)}
            aria-expanded={insightsOpen}
            className="h-7 px-1.5 text-[12px] sm:hidden"
          >
            {insightsOpen ? '收起' : '展开建议'}
          </Button>
        </div>
        {insightsOpen && (
          <>
        <p className="text-[12px] leading-5 text-muted">
          根据审批历史生成。同类请求批准 3 次以上且从未拒绝才会建议自动允许；危险命令只会建议「询问」。
        </p>
        {insights && insights.suggestions.length > 0 && (
          <div className="space-y-1.5">
            {insights.suggestions.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-2"
                data-suggestion={item.pattern}
              >
                <p className="min-w-0 flex-1 text-[13px] leading-5">{item.reason}</p>
                {item.dangerous && (
                  <span className="rounded-[4px] bg-danger-soft/60 px-1.5 py-0.5 text-[12px] text-danger">
                    危险：{item.dangerous}
                  </span>
                )}
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void ignore(item.id)}
                    disabled={busySuggestion !== null}
                  >
                    忽略
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void adopt(item.id)}
                    disabled={busySuggestion !== null}
                  >
                    {busySuggestion === item.id && <Loader2 size={11} className="animate-spin" />}
                    采纳
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {insights && insights.suggestions.length === 0 && (
          <p className="text-[12px] leading-5 text-muted">
            暂无建议。同类审批积累后会在这里出现；也可以直接用下面一句话生成规则。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
          <Input
            value={nlText}
            onChange={(e) => {
              setNlText(e.target.value)
              setNlError(undefined)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void generateDraft()
              }
            }}
            placeholder="用一句话生成规则，例如：这个项目里所有只读的 git 命令都不用问我"
            aria-label="用一句话生成权限规则"
            className="min-w-0 flex-1"
          />
          <Button
            onClick={() => void generateDraft()}
            disabled={drafting || !nlText.trim()}
            className="max-sm:min-h-11"
          >
            {drafting && <Loader2 size={12} className="animate-spin" />}
            生成规则
          </Button>
        </div>
        {!activeSessionId && (
          <p className="text-[12px] text-muted">先打开一个会话，才能用该会话的模型生成规则。</p>
        )}
        {nlError && (
          <p className="flex items-start gap-1 text-[12px] leading-5 text-danger">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {nlError}
          </p>
        )}
          </>
        )}
      </div>

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
              {rule.project && (
                <span
                  className="max-w-[180px] truncate rounded-[4px] bg-[var(--t-surface-2)] px-1.5 py-0.5 text-[12px] text-muted max-sm:order-last max-sm:basis-full"
                  title={`仅在该项目生效：${rule.project}`}
                >
                  项目：{lastSegment(rule.project)}
                </span>
              )}
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

      <section
        data-setting-id="permissions.sandbox"
        className="settings-item space-y-3 px-2.5 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={14} className="text-accent-text" />
          <h3 className="text-[13px] font-semibold">命令沙箱</h3>
          <span className="flex-1" />
          {sandbox && (
            <Switch
              checked={sandbox.enabled}
              disabled={sandboxSaving || !sandboxStatus?.platform.available}
              onChange={(enabled) => void updateSandbox({ enabled })}
              label="启用命令沙箱"
            />
          )}
        </div>
        <p className="text-[12px] leading-5 text-muted">
          {sandboxStatus?.platform.message ??
            '静态检查跨平台生效：写工作目录之外、受保护路径与非白名单网络会转审批。'}
          {sandboxStatus?.platform.available
            ? ' 关闭后仍保留静态检查。'
            : ' Windows 上仅静态检查。'}
        </p>

        <div className="space-y-1.5">
          <span className="text-[13px]">写入保护</span>
          <p className="text-[12px] leading-5 text-muted">
            默认只允许写入会话工作目录、worktree 与系统临时目录。~/.ssh、~/.aws、~/.gnupg、
            ~/.tandem、~/.claude、~/.codex、系统目录、项目 .git/hooks 与 .env* 的任何写入都会转审批，
            不受 bypassPermissions 影响。
          </p>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-2.5 py-2">
            <span className="min-w-0">
              <span className="block text-[13px]">严格模式</span>
              <span className="block text-[12px] leading-5 text-muted">
                无法静态判断写入范围的命令（脚本、构建、eval 等）也转审批；默认不拦截以避免误伤。
              </span>
            </span>
            {sandbox && (
              <Switch
                checked={sandbox.strict}
                disabled={sandboxSaving}
                onChange={(strict) => void updateSandbox({ strict })}
                label="严格模式"
              />
            )}
          </label>
        </div>

        <div data-setting-id="permissions.network" className="space-y-2 border-t border-border/60 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px]">网络策略</span>
            <span className="flex-1" />
            {sandbox && (
              <SegmentedControl
                aria-label="沙箱网络策略"
                options={[
                  { value: 'host', label: '可联网' },
                  { value: 'none', label: '断网' },
                ]}
                value={sandbox.network}
                onChange={(network) => void updateSandbox({ network })}
                disabled={sandboxSaving || !sandboxStatus?.platform.networkIsolation}
              />
            )}
          </div>
          <p className="text-[12px] leading-5 text-muted">
            {sandboxStatus?.platform.networkIsolation
              ? '断网后需要联网的命令会失败并转审批；在审批中允许会临时放行这一次。'
              : '当前平台不支持在沙箱内断网；网络白名单仍会对联网命令生效。'}
          </p>
          <span className="block text-[13px]">网络白名单</span>
          <p className="text-[12px] leading-5 text-muted">
            curl、wget、git clone/fetch/push、npm/pip install、ssh、scp、nc 等命令的目标主机
            不在白名单时转审批。支持域名、*.example.com、IP 与 CIDR 网段；回环地址始终放行。
          </p>
          {sandbox && (
            <>
              <Textarea
                value={sandboxHostText}
                onChange={(e) => setSandboxHostText(e.target.value)}
                aria-label="网络白名单"
                className="min-h-20 font-mono text-[12px]"
                placeholder={'localhost\n*.corp.example.com\n192.168.0.0/16'}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void updateSandbox({}, sandboxHostText)}
                  disabled={sandboxSaving}
                >
                  {sandboxSaving && <Loader2 size={11} className="animate-spin" />}
                  保存白名单
                </Button>
                {sandboxStatus?.packageSources.map((source) => (
                  <Button
                    key={source.label}
                    size="sm"
                    variant="ghost"
                    disabled={sandboxSaving}
                    onClick={() =>
                      void updateSandbox({
                        allowedHosts: [...new Set([...sandbox.allowedHosts, ...source.hosts])],
                      })
                    }
                  >
                    + {source.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title="确认规则草稿"
          description="这是由当前会话模型生成的草稿，确认后才会保存并生效；当前正在等待的请求不受影响。"
          className="max-w-md"
          footer={
            <>
              <Button size="lg" onClick={() => setDraft(null)} disabled={draftSaving}>
                取消
              </Button>
              <Button
                size="lg"
                variant="primary"
                onClick={() => void saveDraft()}
                disabled={draftSaving}
              >
                {draftSaving && <Loader2 size={14} className="animate-spin" />}
                保存规则
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-[13px] leading-5 text-text-soft">{draft.explanation}</p>
            <div className="space-y-1 rounded-lg bg-[color-mix(in_srgb,var(--t-surface-2)_60%,transparent)] px-3 py-2 text-[12px]">
              <div>
                <span className="text-muted">工具：</span>
                <span className="font-mono">{draft.rule.tool}</span>
              </div>
              <div>
                <span className="text-muted">匹配：</span>
                <span className="font-mono">{draft.rule.pattern || '全部调用'}</span>
              </div>
              <div>
                <span className="text-muted">动作：</span>
                <span>{ACTION_LABEL[draft.rule.action]}</span>
              </div>
              <div>
                <span className="text-muted">作用范围：</span>
                <span>
                  {draft.rule.project
                    ? `项目 ${lastSegment(draft.rule.project)}（${draft.rule.project}）`
                    : '所有项目'}
                </span>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
