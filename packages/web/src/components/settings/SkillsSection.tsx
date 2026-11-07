import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Loader2, Sparkles, TriangleAlert } from 'lucide-react'
import type { SkillInfo, SkillSource } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Switch } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Markdown } from '../Markdown'

const SOURCE_ORDER: SkillSource[] = ['project', 'tandem', 'user', 'plugin']
const SOURCE_LABEL: Record<SkillSource, string> = {
  project: '项目',
  tandem: 'Tandem',
  user: '用户',
  plugin: '插件',
}
const SOURCE_HINT: Record<SkillSource, string> = {
  project: '<cwd>/.claude/skills',
  tandem: '~/.tandem/skills',
  user: '~/.claude/skills',
  plugin: '~/.claude/plugins',
}

export function SkillsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const activeCwd = useAppStore((s) => s.active?.summary?.cwd)
  const toast = useUiStore((s) => s.toast)
  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillInfo | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const host = hosts.find((h) => h.id === hostId) ?? null
  const cwd = hostId === activeHostId ? activeCwd : undefined

  const load = useCallback(async () => {
    if (!host) return
    setLoading(true)
    try {
      setSkills(await api.skills(host, cwd))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Skills 失败')
    } finally {
      setLoading(false)
    }
  }, [host, cwd])

  useEffect(() => {
    if (!hostId) return
    void load()
  }, [hostId, load])

  // 预览只展示正文；frontmatter 里的元数据已在列表与弹层标题中展示
  const previewBody = useMemo(
    () => previewText.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ''),
    [previewText],
  )

  const groups = useMemo(() => {
    const map = new Map<SkillSource, SkillInfo[]>()
    for (const skill of skills) {
      const list = map.get(skill.source) ?? []
      list.push(skill)
      map.set(skill.source, list)
    }
    return SOURCE_ORDER.filter((source) => map.has(source)).map((source) => ({
      source,
      items: (map.get(source) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
  }, [skills])

  const enabledCount = skills.filter((skill) => skill.enabled).length

  const toggle = async (skill: SkillInfo) => {
    if (!host || saving) return
    const next = skills.map((item) =>
      item.path === skill.path ? { ...item, enabled: !item.enabled } : item,
    )
    setSkills(next)
    setSaving(skill.path)
    try {
      const saved = await api.saveSkillState(
        host,
        next.filter((item) => !item.enabled).map((item) => item.path),
        cwd,
      )
      setSkills(saved)
    } catch (err) {
      setSkills(skills)
      toast(err instanceof Error ? err.message : '保存技能状态失败', 'error')
    } finally {
      setSaving(null)
    }
  }

  const openPreview = async (skill: SkillInfo) => {
    setPreview(skill)
    setPreviewText('')
    setPreviewError(null)
    if (!host) return
    setPreviewLoading(true)
    try {
      const file = await api.fsRead(host, skill.path, cwd)
      setPreviewText(file.content)
      if (file.truncated) setPreviewError('文件较大，仅显示开头部分')
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取 SKILL.md 失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  if (!host) {
    return (
      <div className="settings-empty">
        <span className="settings-empty-icon"><Sparkles size={17} /></span>
        <p className="settings-empty-title">还没有连接 Host</p>
        <p className="settings-empty-hint">先连接一台 Host，才能查看本机的 Skills。</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <BookOpen size={15} className="text-muted" /> Skills
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">兼容 Claude Code 的 SKILL.md</p>
        </div>
        {hosts.length > 1 && (
          <MenuSelect
            value={hostId ?? ''}
            onChange={setHostId}
            aria-label="选择 Host"
            options={hosts.map((h) => ({ value: h.id, label: h.name }))}
            wrapperClassName="w-auto max-w-[180px]"
            className="text-[13px]"
          />
        )}
        <Button variant="ghost" onClick={() => void load()} disabled={loading} className="max-sm:min-h-11">
          {loading ? <Loader2 size={13} className="animate-spin" /> : null} 刷新
        </Button>
      </div>

      <p className="text-[13px] leading-5 text-muted">
        停用只记录在 Host 的 ~/.tandem/skills-state.json，不会修改原文件。当前目录：
        <span className="ml-1 font-mono text-text-soft">{cwd ?? '（未选择会话，按 Host 默认目录）'}</span>
      </p>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
          <TriangleAlert size={12} /> {error}
        </div>
      )}

      {loading && skills.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> 正在扫描 Skills…
        </div>
      )}

      {!loading && skills.length === 0 && (
        <div className="settings-empty">
          <span className="settings-empty-icon"><Sparkles size={17} /></span>
          <p className="settings-empty-title">还没有发现技能</p>
          <p className="settings-empty-hint">
            在 ~/.claude/skills、~/.tandem/skills 或 <span className="font-mono">&lt;cwd&gt;/.claude/skills</span>{' '}
            下新建 <span className="font-mono">&lt;name&gt;/SKILL.md</span> 即可。
          </p>
        </div>
      )}

      {groups.map(({ source, items }) => (
        <div key={source} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[13px] font-semibold text-text-soft">{SOURCE_LABEL[source]}</h4>
            <span className="font-mono text-[12px] text-muted">{SOURCE_HINT[source]}</span>
            <span className="text-[12px] text-muted">· {items.length}</span>
          </div>
          {items.map((skill) => (
            <div key={skill.path} className="settings-item">
              <div className="flex items-start gap-2.5 p-3">
                <span
                  className={cn(
                    'mt-1 size-2 shrink-0 rounded-full',
                    skill.enabled ? 'bg-text-tertiary/70' : 'border border-border-strong bg-transparent',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      onClick={() => void openPreview(skill)}
                      className="min-w-0 text-left text-[13px] font-semibold text-text hover:underline"
                      title="预览 SKILL.md"
                    >
                      <span className="truncate font-mono">{skill.name}</span>
                    </button>
                    <span className="text-[13px] text-muted">{SOURCE_LABEL[skill.source]}</span>
                    {!skill.enabled && <span className="text-[13px] text-muted">已停用</span>}
                    {!skill.modelInvocable && (
                      <span className="text-[13px] text-muted">仅手动调用</span>
                    )}
                    {!skill.userInvocable && (
                      <span className="text-[13px] text-muted">仅模型调用</span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-text-soft">
                    {skill.description || '（无描述）'}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-muted" title={skill.path}>
                    {skill.path}
                  </p>
                </div>
                <div className="settings-actions" data-open="true">
                  <IconButton
                    onClick={() => void openPreview(skill)}
                    label={`预览 ${skill.name}`}
                    tooltip="预览 SKILL.md"
                    className="max-sm:size-11"
                  >
                    <Sparkles size={13} />
                  </IconButton>
                  <Switch
                    checked={skill.enabled}
                    onChange={() => void toggle(skill)}
                    disabled={saving === skill.path}
                    label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {skills.length > 0 && (
        <p className="text-[12px] text-muted">
          共 {skills.length} 个技能，已启用 {enabledCount} 个。启用的技能会出现在系统提示和 / 菜单中。
        </p>
      )}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        ariaLabel="技能预览"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Sparkles size={14} className="shrink-0 text-muted" />
            <span className="truncate font-mono text-[13px]">{preview?.name}</span>
          </span>
        }
        description={
          preview ? (
            <span className="block min-w-0">
              <span className="block text-[12.5px] leading-5 text-text-soft">{preview.description}</span>
              <span className="block truncate font-mono text-[12px] text-muted" title={preview.path}>
                {preview.path}
              </span>
            </span>
          ) : undefined
        }
        className="h-[clamp(420px,76vh,820px)] w-[min(94vw,860px)] max-w-none"
        bodyClassName="min-h-0 flex-1 overflow-y-auto p-4"
      >
        {previewError && (
          <div className="mb-2 flex items-center gap-1.5 text-[13px] text-danger">
            <TriangleAlert size={12} /> {previewError}
          </div>
        )}
        {previewLoading ? (
          <div className="flex items-center justify-center py-10 text-[13px] text-muted">
            <Loader2 size={14} className="animate-spin" />
          </div>
        ) : (
          <Markdown text={previewBody.trim() || '（空文件）'} cwd={cwd} />
        )}
      </Modal>
    </div>
  )
}
