import { useCallback, useEffect, useMemo, useState } from 'react'
import { EyeOff, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SecretMeta, SecretScope, SecretsOverview } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button, IconButton } from '../ui/Button'
import { Input, Switch, Textarea } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { formatRelative } from '../../lib/format'

const SCOPE_LABELS: Record<SecretScope, string> = {
  bash: 'Bash / 后台任务',
  mcp: 'stdio MCP',
  hooks: 'Hooks',
}

const ALL_SCOPES: SecretScope[] = ['bash', 'mcp', 'hooks']

interface FormState {
  name: string
  value: string
  description: string
  scopes: SecretScope[]
  project: string
}

const EMPTY_FORM: FormState = {
  name: '',
  value: '',
  description: '',
  scopes: [...ALL_SCOPES],
  project: '',
}

export function SecretsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const toast = useUiStore((s) => s.toast)
  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const host = hosts.find((item) => item.id === hostId) ?? null

  const [overview, setOverview] = useState<SecretsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState('')
  const [editing, setEditing] = useState<SecretMeta | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<SecretMeta | null>(null)
  const [removing, setRemoving] = useState(false)
  const [customProject, setCustomProject] = useState(false)

  const load = useCallback(async () => {
    if (!host) return
    setLoading(true)
    try {
      const result = await api.secrets(host)
      setOverview(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Secrets 失败')
    } finally {
      setLoading(false)
    }
  }, [host])

  useEffect(() => {
    if (!hostId) return
    void load()
  }, [hostId, load])

  const projectOptions = useMemo(() => {
    const list = overview?.knownProjects ?? []
    const merged = [...new Set([...list, ...(project && project !== '__custom__' ? [project] : [])])]
    return [
      { value: '', label: '全局（所有项目）' },
      ...merged.map((item) => ({ value: item, label: item })),
      { value: '__custom__', label: '自定义项目路径…' },
    ]
  }, [overview?.knownProjects, project])

  const secrets = useMemo(() => {
    if (!overview || project === '__custom__') return []
    if (!project) return overview.global
    return overview.projects.find((item) => item.project === project)?.secrets ?? []
  }, [overview, project])

  const openCreate = () => {
    const target = project === '__custom__' ? '' : project
    setForm({ ...EMPTY_FORM, project: target })
    setCustomProject(project === '__custom__')
    setEditing('new')
  }

  const openEdit = (secret: SecretMeta) => {
    setForm({
      name: secret.name,
      value: '',
      description: secret.description ?? '',
      scopes: [...secret.scopes],
      project: secret.project ?? '',
    })
    setCustomProject(false)
    setEditing(secret)
  }

  const toggleScope = (scope: SecretScope) => {
    setForm((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope)
        ? prev.scopes.filter((item) => item !== scope)
        : [...prev.scopes, scope],
    }))
  }

  const save = async () => {
    if (!host || !editing) return
    const name = form.name.trim()
    if (!name) {
      toast('名称不能为空', 'error')
      return
    }
    if (editing === 'new' && !form.value) {
      toast('值不能为空', 'error')
      return
    }
    if (form.scopes.length === 0) {
      toast('至少选择一个作用范围', 'error')
      return
    }
    if (customProject && !form.project.trim()) {
      toast('请填写项目路径', 'error')
      return
    }
    setSaving(true)
    try {
      const input = {
        name,
        ...(form.value ? { value: form.value } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        scopes: form.scopes,
        ...(!customProject && form.project ? { project: form.project } : {}),
        ...(customProject && form.project.trim() ? { project: form.project.trim() } : {}),
      }
      if (editing === 'new') {
        const created = await api.createSecret(host, input)
        if (created.project) {
          setProject(created.project)
          setCustomProject(false)
        }
        toast(`已保存 secret ${created.name}`, 'success')
      } else {
        await api.updateSecret(host, editing.id, input)
        toast(`已更新 secret ${name}`, 'success')
      }
      setEditing(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!host || !deleting) return
    setRemoving(true)
    try {
      await api.deleteSecret(host, deleting.id)
      toast(`已删除 secret ${deleting.name}`, 'success')
      setDeleting(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setRemoving(false)
    }
  }

  const toggleGenericMask = async (checked: boolean) => {
    if (!host || !overview) return
    setOverview({ ...overview, settings: { ...overview.settings, genericMask: checked } })
    try {
      const settings = await api.saveSecretsSettings(host, { genericMask: checked })
      setOverview((prev) => (prev ? { ...prev, settings } : prev))
    } catch (err) {
      setOverview((prev) => (prev ? { ...prev, settings: { genericMask: !checked } } : prev))
      toast(err instanceof Error ? err.message : '保存设置失败', 'error')
    }
  }

  return (
    <div data-setting-id="secrets.list" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <KeyRound size={15} className="text-muted" />
            项目 Secrets
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            按项目向 Bash、后台任务、stdio MCP 与 Hooks 注入环境变量；模型、日志、界面都看不到明文。
          </p>
        </div>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <MenuSelect
            value={hostId ?? ''}
            onChange={setHostId}
            aria-label="选择 Host"
            options={hosts.map((item) => ({ value: item.id, label: item.name }))}
            wrapperClassName="w-auto max-w-[180px]"
            className="text-[13px]"
          />
        )}
        <Button variant="ghost" onClick={() => void load()} disabled={loading} className="max-sm:min-h-11">
          {loading ? <Loader2 size={13} className="animate-spin" /> : null} 刷新
        </Button>
        <Button onClick={openCreate} disabled={!host} className="max-sm:min-h-11">
          <Plus size={14} /> 新增 secret
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <MenuSelect
          value={project}
          onChange={(value) => {
            setProject(value)
            setCustomProject(value === '__custom__')
          }}
          aria-label="选择项目"
          options={projectOptions}
          wrapperClassName="w-auto max-w-full"
          className="text-[13px]"
        />
        <span className="text-[12px] text-muted">
          {project && project !== '__custom__'
            ? '本项目的 secret（全局 secret 对该项目同样生效）'
            : project === '__custom__'
              ? '填写路径后保存为新项目'
              : '全局 secret 对所有项目生效'}
        </span>
      </div>

      {loading && !overview ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 size={12} className="animate-spin" /> 读取中…
        </p>
      ) : secrets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] leading-6 text-muted">
          这里还没有 secret。新增后，模型会在系统提示里看到名称与描述，并可在命令中用{' '}
          <span className="font-mono">$NAME</span> 引用；值不会出现在对话里。
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_130px_92px_72px] items-center gap-2 border-b border-border bg-bg/40 px-3 py-2 text-[12px] text-muted max-sm:grid-cols-[minmax(0,1fr)_84px_64px]">
            <span>名称 / 描述</span>
            <span className="max-sm:hidden">作用范围</span>
            <span className="text-right">最后使用</span>
            <span className="text-right">操作</span>
          </div>
          {secrets.map((secret) => (
            <div
              key={secret.id}
              className="grid grid-cols-[minmax(0,1fr)_130px_92px_72px] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_84px_64px]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[13px] text-text">{secret.name}</span>
                  {!secret.project && (
                    <span className="shrink-0 rounded border border-border px-1 text-[10.5px] text-muted">
                      全局
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-muted" title={secret.description ?? ''}>
                  {secret.description || '—'}
                </div>
              </div>
              <span className="flex flex-wrap gap-1 text-[11px] text-text-soft max-sm:hidden">
                {secret.scopes.map((scope) => (
                  <span key={scope} className="rounded border border-border px-1 py-px">
                    {scope}
                  </span>
                ))}
              </span>
              <span className="text-right text-[12px] text-muted">
                {secret.lastUsedAt ? formatRelative(secret.lastUsedAt) : '—'}
              </span>
              <span className="flex items-center justify-end gap-0.5">
                <IconButton
                  size="sm"
                  onClick={() => openEdit(secret)}
                  label={`编辑 ${secret.name}`}
                  tooltip="编辑"
                  disabled={!host}
                  className="size-7! [&_svg]:size-3.5 max-sm:size-11! max-sm:[&_svg]:size-4"
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  size="sm"
                  onClick={() => setDeleting(secret)}
                  label={`删除 ${secret.name}`}
                  tooltip="删除"
                  disabled={!host}
                  className="size-7! [&_svg]:size-3.5 max-sm:size-11! max-sm:[&_svg]:size-4"
                >
                  <Trash2 size={13} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        data-setting-id="secrets.generic-mask"
        className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] text-text">
            <EyeOff size={13} className="text-muted" /> 通用 Key 打码
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-muted">
            除本机 secrets 外，自动把 <span className="font-mono">sk-…</span>、<span className="font-mono">ghp_…</span>、
            <span className="font-mono">AKIA…</span> 与私钥块替换为{' '}
            <span className="font-mono">[secret:generic]</span>。关闭后只打码本机保存的值。
          </p>
        </div>
        <Switch
          checked={overview?.settings.genericMask !== false}
          onChange={(value) => void toggleGenericMask(value)}
          disabled={!host || !overview}
          label="通用 Key 打码"
        />
      </div>

      <p className="text-[12px] leading-5 text-muted">
        值以 AES-256-GCM 加密保存在 Host 的 <span className="font-mono">~/.tandem/secrets.json</span>
        （600，密钥单独存放）；接口永不回传值。通用打码可关闭，本机 secret 值的打码不可关闭。
      </p>

      <Modal
        open={!!editing}
        onClose={() => !saving && setEditing(null)}
        title={editing === 'new' ? '新增 secret' : `编辑 ${editing ? editing.name : ''}`}
        className="max-w-lg"
        footer={
          <>
            <Button size="lg" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </Button>
            <Button size="lg" variant="primary" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">名称（环境变量名）</span>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="DB_PASSWORD"
              className="font-mono"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">
              值{editing !== 'new' ? '（留空表示不修改）' : ''}
            </span>
            <Input
              type="password"
              value={form.value}
              onChange={(e) => setForm((prev) => ({ ...prev, value: e.target.value }))}
              placeholder={editing === 'new' ? '输入后保存，不再回显' : '••••••••'}
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">描述（会显示给模型，不要写值）</span>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="例如：本地测试数据库密码"
            />
          </label>
          <div>
            <span className="mb-1 block text-[12px] text-muted">注入范围</span>
            <div className="space-y-2 rounded-lg border border-border px-3 py-2">
              {ALL_SCOPES.map((scope) => (
                <div key={scope} className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-text-soft">{SCOPE_LABELS[scope]}</span>
                  <Switch
                    checked={form.scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    label={SCOPE_LABELS[scope]}
                  />
                </div>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">所属项目</span>
            {editing !== 'new' ? (
              <div className="rounded-md border border-border bg-bg/40 px-2.5 py-1.5 font-mono text-[12px] text-text-soft">
                {form.project || '全局（所有项目）'}
              </div>
            ) : (
              <>
                <MenuSelect
                  value={customProject ? '__custom__' : form.project}
                  onChange={(value) => {
                    setCustomProject(value === '__custom__')
                    setForm((prev) => ({ ...prev, project: value === '__custom__' ? '' : value }))
                  }}
                  aria-label="所属项目"
                  options={projectOptions}
                  wrapperClassName="w-full"
                  className="text-[13px]"
                />
                {customProject && (
                  <Input
                    value={form.project}
                    onChange={(e) => setForm((prev) => ({ ...prev, project: e.target.value }))}
                    placeholder="/path/to/repo"
                    className="mt-2 font-mono"
                  />
                )}
                <span className="mt-1 block text-[12px] leading-4 text-muted">
                  自动归到该目录所在的 git 仓库根；全局 secret 对所有项目生效。
                </span>
              </>
            )}
          </label>
        </div>
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => !removing && setDeleting(null)}
        title="删除 secret"
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setDeleting(null)} disabled={removing}>
              取消
            </Button>
            <Button size="lg" variant="danger-ghost" onClick={() => void confirmDelete()} disabled={removing}>
              {removing && <Loader2 size={14} className="animate-spin" />}
              删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          确定删除「{deleting?.name}」？之后启动的命令将不再获得该环境变量，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
