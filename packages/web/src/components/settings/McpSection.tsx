import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { McpServerConfig, McpServerStatus } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[12.5px] text-text outline-none transition-colors focus:border-border-strong'
const labelCls = 'mb-1.5 block text-[11px] font-medium text-text-soft'

const SOURCE_LABEL: Record<string, string> = {
  tandem: 'Tandem',
  claude: 'Claude',
  project: '项目',
}

const STATUS_STYLE: Record<McpServerStatus['status'] | 'unknown', { dot: string; text: string; label: string }> = {
  connected: { dot: 'bg-text-tertiary/70', text: 'text-text-soft', label: '已连接' },
  connecting: { dot: 'bg-text-secondary running-dot', text: 'text-text-secondary', label: '连接中' },
  error: { dot: 'bg-text-tertiary/70', text: 'text-danger', label: '出错' },
  disabled: { dot: 'border border-border-strong bg-transparent', text: 'text-muted', label: '已停用' },
  unknown: { dot: 'bg-border-strong', text: 'text-muted', label: '未连接' },
}

interface Draft {
  original?: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  headers: string
  enabled: boolean
}

function emptyDraft(): Draft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    enabled: true,
  }
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function pairs(text: string, sep: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of lines(text)) {
    const idx = line.indexOf(sep)
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + sep.length).trim()
    if (key) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

function toDraft(config: McpServerConfig): Draft {
  return {
    original: config.name,
    name: config.name,
    transport: config.transport,
    command: config.command ?? '',
    args: (config.args ?? []).join('\n'),
    env: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    url: config.url ?? '',
    headers: Object.entries(config.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    enabled: config.enabled,
  }
}

function draftToConfig(draft: Draft): McpServerConfig {
  const base = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    source: 'tandem' as const,
  }
  if (draft.transport === 'http') {
    const headers = pairs(draft.headers, ':')
    return { ...base, transport: 'http', url: draft.url.trim(), ...(headers ? { headers } : {}) }
  }
  const args = lines(draft.args)
  const env = pairs(draft.env, '=')
  return {
    ...base,
    transport: 'stdio',
    command: draft.command.trim(),
    ...(args.length ? { args } : {}),
    ...(env ? { env } : {}),
  }
}

function McpEditor({
  draft,
  busy,
  onSave,
  onClose,
}: {
  draft: Draft
  busy: boolean
  onSave: (draft: Draft) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<Draft>(draft)
  const [error, setError] = useState<string | null>(null)
  const valid = form.name.trim() && (form.transport === 'http' ? form.url.trim() : form.command.trim())
  const save = () => {
    if (!form.name.trim()) return setError('请填写服务器名称')
    if (form.transport === 'http' && !form.url.trim()) return setError('请填写 HTTP 地址')
    if (form.transport === 'stdio' && !form.command.trim()) return setError('请填写启动命令')
    setError(null)
    onSave(form)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={draft.original ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
      description="保存在 Host 的 ~/.tandem/mcp.json，会话中的工具以 mcp__server__tool 命名。"
      className="max-w-lg"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={busy || !valid}
            className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            保存
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls}>名称</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如 github、playwright"
            spellCheck={false}
            className={cn(inputCls, 'font-mono text-[11.5px]')}
          />
          <p className="mt-1 text-[10.5px] text-muted">工具名前缀为 mcp__{form.name.trim() || 'server'}__…</p>
        </div>
        <div className="flex gap-1.5">
          {(['stdio', 'http'] as const).map((transport) => (
            <button
              key={transport}
              onClick={() => setForm({ ...form, transport })}
              className={cn(
                'flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[11.5px] transition-colors',
                form.transport === transport
                  ? 'border-accent/40 bg-accent-soft/50 text-text'
                  : 'border-border bg-surface text-muted hover:border-border-strong',
              )}
            >
              {transport === 'stdio' ? 'stdio' : 'Streamable HTTP'}
            </button>
          ))}
        </div>
        {form.transport === 'stdio' ? (
          <>
            <div>
              <label className={labelCls}>命令</label>
              <input
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx"
                spellCheck={false}
                className={cn(inputCls, 'font-mono text-[11.5px]')}
              />
            </div>
            <div>
              <label className={labelCls}>参数（每行一个）</label>
              <textarea
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/me'}
                spellCheck={false}
                rows={3}
                className="w-full resize-y rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-text outline-none focus:border-border-strong"
              />
            </div>
            <div>
              <label className={labelCls}>环境变量（KEY=value，每行一个）</label>
              <textarea
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
                placeholder="GITHUB_TOKEN=ghp_…"
                spellCheck={false}
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-text outline-none focus:border-border-strong"
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={labelCls}>地址</label>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                className={cn(inputCls, 'font-mono text-[11.5px]')}
              />
            </div>
            <div>
              <label className={labelCls}>请求头（Name: value，每行一个）</label>
              <textarea
                value={form.headers}
                onChange={(e) => setForm({ ...form, headers: e.target.value })}
                placeholder="Authorization: Bearer …"
                spellCheck={false}
                rows={3}
                className="w-full resize-y rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-text outline-none focus:border-border-strong"
              />
            </div>
          </>
        )}
        <label className="flex items-center gap-2 text-[12px] text-text-soft">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            className="size-3.5 accent-[var(--t-accent)]"
          />
          启用（保存后立即尝试连接）
        </label>
        {error && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-danger">
            <TriangleAlert size={12} /> {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

export function McpSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const activeCwd = useAppStore((s) => s.active?.summary?.cwd)
  const toast = useUiStore((s) => s.toast)
  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editor, setEditor] = useState<Draft | null>(null)
  const [removeTarget, setRemoveTarget] = useState<McpServerConfig | null>(null)
  const [saving, setSaving] = useState(false)

  const host = hosts.find((h) => h.id === hostId) ?? null
  const cwd = hostId === activeHostId ? activeCwd : undefined

  const load = useCallback(
    async (silent = false, retry = false) => {
      if (!host) return
      if (!silent) setLoading(true)
      try {
        const data = await api.mcp(host, cwd, retry)
        setServers(data.servers)
        setStatuses(data.status)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取 MCP 配置失败')
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [host, cwd],
  )

  useEffect(() => {
    if (!hostId) return
    void load()
  }, [hostId, load])

  useEffect(() => {
    if (!hostId) return
    const timer = window.setInterval(() => void load(true), 5000)
    return () => window.clearInterval(timer)
  }, [hostId, load])

  const statusOf = useMemo(() => {
    const map = new Map<string, McpServerStatus>()
    for (const item of statuses) map.set(item.name, item)
    return map
  }, [statuses])

  const ownServers = useMemo(
    () => servers.filter((s) => (s.source ?? 'tandem') === 'tandem'),
    [servers],
  )

  const saveOwn = async (next: McpServerConfig[]) => {
    if (!host) return
    setSaving(true)
    try {
      await api.saveMcp(host, next)
      await load(true)
      toast('MCP 配置已保存', 'success')
      setEditor(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存 MCP 配置失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggle = (config: McpServerConfig) => {
    const next = ownServers.map((s) =>
      s.name === config.name ? { ...s, enabled: !s.enabled } : s,
    )
    void saveOwn(next)
  }

  const remove = (config: McpServerConfig) => {
    setRemoveTarget(config)
  }

  const confirmRemove = async () => {
    if (!removeTarget || !host) return
    const target = removeTarget
    setSaving(true)
    try {
      await api.saveMcp(
        host,
        ownServers.filter((s) => s.name !== target.name),
      )
      await load(true)
      toast(`已移除 MCP 服务器 ${target.name}`, 'success')
      setRemoveTarget(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '移除 MCP 服务器失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = (draft: Draft) => {
    const config = draftToConfig(draft)
    const without = ownServers.filter((s) => s.name !== draft.original)
    if (without.some((s) => s.name === config.name)) {
      toast(`已有同名服务器：${config.name}`, 'error')
      return
    }
    void saveOwn([...without, config])
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">MCP 服务器</h3>
        <span className="text-[11px] text-muted">stdio / Streamable HTTP</span>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <select
            value={hostId ?? ''}
            onChange={(e) => setHostId(e.target.value)}
            aria-label="选择 Host"
            className="h-8 rounded-lg border border-border bg-surface px-2 text-[11.5px] text-text outline-none focus:border-border-strong"
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => void load(false, true)}
          disabled={loading || !host}
          aria-label="刷新并重连"
          title="刷新状态，并重连失败的服务器"
          className="flex size-11 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50 sm:size-8"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setEditor(emptyDraft())}
          disabled={!host}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50 sm:min-h-8"
        >
          <Plus size={13} /> 添加服务器
        </button>
      </div>

      {!hosts.length && (
        <div className="rounded-xl border border-dashed border-border bg-bg/30 px-4 py-8 text-center text-[12px] text-muted">
          先连接一台 Host，再配置 MCP。
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11.5px] text-danger">
          <TriangleAlert size={12} /> {error}
        </div>
      )}

      {loading && servers.length === 0 && (
        <div className="flex items-center gap-2 py-8 text-[12px] text-muted">
          <Loader2 size={13} className="animate-spin" /> 正在读取 MCP 配置…
        </div>
      )}

      {!loading && host && servers.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-bg/30 px-4 py-8 text-center">
          <Plug size={20} className="mx-auto text-muted" />
          <p className="mt-2 text-[12.5px] text-text-soft">还没有 MCP 服务器</p>
          <p className="mt-1 text-[11px] text-muted">添加后，模型可调用其工具，默认需要审批。</p>
        </div>
      )}

      <div className="space-y-2">
        {servers.map((config) => {
          const status = statusOf.get(config.name)
          const state: McpServerStatus['status'] | 'unknown' = status?.status ?? (config.enabled ? 'unknown' : 'disabled')
          const style = STATUS_STYLE[state]
          const source = config.source ?? 'tandem'
          const readonly = source !== 'tandem'
          const isOpen = !!expanded[config.name]
          return (
            <div key={config.name} className="rounded-xl border border-border bg-surface transition-colors hover:border-border-strong/60">
              <div className="flex items-start gap-2.5 p-3">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', style.dot)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      onClick={() => setExpanded((prev) => ({ ...prev, [config.name]: !prev[config.name] }))}
                      className="flex min-w-0 items-center gap-1 text-left text-[12.5px] font-semibold text-text"
                    >
                      <ChevronRight
                        size={12}
                        className={cn('shrink-0 text-muted transition-transform duration-150', isOpen && 'rotate-90')}
                      />
                      <span className="truncate font-mono">{config.name}</span>
                    </button>
                    <span className="text-[10px] text-muted">{SOURCE_LABEL[source] ?? source}</span>
                    <span className={cn('text-[10px]', style.text)}>{style.label}</span>
                    {state === 'connected' && (
                      <span className="text-[10px] text-muted">{status?.tools.length ?? 0} 个工具</span>
                    )}
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-[10px] text-muted"
                    title={
                      config.transport === 'http'
                        ? config.url
                        : [config.command, ...(config.args ?? [])].join(' ')
                    }
                  >
                    {config.transport === 'http'
                      ? config.url
                      : [config.command, ...(config.args ?? [])].join(' ')}
                  </div>
                  {state === 'error' && status?.error && (
                    <p
                      className="mt-0.5 line-clamp-1 break-all text-[10.5px] leading-4 text-danger"
                      title={status.error}
                    >
                      {status.error}
                    </p>
                  )}
                  {readonly && (
                    <p className="mt-1 text-[10.5px] leading-4 text-muted">
                      来自 {source === 'claude' ? '~/.claude.json' : '项目 .mcp.json'}，只读；请
                      {source === 'claude' ? '在 Claude Code 中修改' : '直接编辑项目里的 .mcp.json'}。
                    </p>
                  )}
                </div>
                {!readonly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      role="switch"
                      aria-checked={config.enabled}
                      aria-label={`${config.enabled ? '停用' : '启用'} ${config.name}`}
                      onClick={() => toggle(config)}
                      disabled={saving}
                      title={config.enabled ? '停用' : '启用'}
                      className="flex size-11 shrink-0 items-center justify-center disabled:opacity-50 sm:size-7"
                    >
                      <span
                        className={cn(
                          'relative h-4 w-7 rounded-full transition-colors',
                          config.enabled ? 'bg-accent' : 'bg-[var(--t-bg-active)]',
                        )}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform',
                            config.enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                          )}
                        />
                      </span>
                    </button>
                    <button
                      onClick={() => setEditor(toDraft(config))}
                      aria-label={`编辑 ${config.name}`}
                      title="编辑"
                      className="flex size-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text sm:size-7"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => remove(config)}
                      aria-label={`删除 ${config.name}`}
                      title="删除"
                      className="flex size-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger-soft hover:text-danger sm:size-7"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
                {readonly && <span className="shrink-0 text-[10px] text-muted">只读</span>}
              </div>
              <div className="collapse-grid" data-open={isOpen}>
                <div className="collapse-inner">
                  <div className="border-t border-border/70 px-3 py-2.5">
                    {status?.error ? (
                      <div className="mb-2 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11px] leading-4 text-danger">
                        <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1 break-words">{status.error}</span>
                      </div>
                    ) : null}
                    {status && status.tools.length > 0 ? (
                      <div>
                        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
                          工具（{status.tools.length}）
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {status.tools.map((tool) => (
                            <span
                              key={tool}
                              title={`mcp__${config.name}__${tool}`}
                              className="rounded-md bg-[var(--t-bg-active)] px-1.5 py-0.5 font-mono text-[10px] text-text-soft"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted">
                        {state === 'disabled'
                          ? '服务器已停用。'
                          : state === 'error'
                            ? '连接失败，暂无工具。'
                            : state === 'unknown'
                              ? '尚未连接，点击右上角刷新并重连。'
                              : '尚未获取到工具。'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-4 text-[10.5px] leading-4 text-muted">
        Tandem 来源可编辑；Claude 与项目来源只读，仅用于展示与合并。MCP 工具默认需要审批，可在「权限」中添加放行规则。
      </p>

      {editor && (
        <McpEditor
          draft={editor}
          busy={saving}
          onSave={saveDraft}
          onClose={() => {
            if (!saving) setEditor(null)
          }}
        />
      )}

      <Modal
        open={!!removeTarget}
        onClose={() => {
          if (!saving) setRemoveTarget(null)
        }}
        title="移除 MCP 服务器"
        description="会从 Host 的 mcp.json 中删除该条目，已连接的工具立即失效。"
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setRemoveTarget(null)}
              disabled={saving}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => void confirmRemove()}
              disabled={saving}
              className="flex min-h-9 items-center gap-1.5 rounded-lg btn-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              移除
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          确定移除「
          <span className="font-mono text-text">{removeTarget?.name}</span>
          」？此操作只删除 Tandem 自己的配置，不影响 Claude 或项目里的只读条目。
        </p>
        {removeTarget?.command && (
          <p className="mt-2 break-all rounded-lg bg-[var(--t-surface-2)] px-2.5 py-2 font-mono text-[10.5px] text-muted">
            {[removeTarget.command, ...(removeTarget.args ?? [])].join(' ')}
          </p>
        )}
      </Modal>
    </div>
  )
}
