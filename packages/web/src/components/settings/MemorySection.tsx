import { useCallback, useEffect, useState } from 'react'
import { Brain, Loader2, Pencil, Trash2 } from 'lucide-react'
import type { MemoryListItem } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button, IconButton } from '../ui/Button'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { formatRelative } from '../../lib/format'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function MemorySection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const openEditor = useUiStore((s) => s.openMemoryEditor)
  const editorOpen = useUiStore((s) => !!s.memoryEditor)
  const toast = useUiStore((s) => s.toast)

  const [global, setGlobal] = useState<MemoryListItem | null>(null)
  const [projects, setProjects] = useState<MemoryListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<MemoryListItem | null>(null)
  const [removing, setRemoving] = useState(false)

  const host = hosts.find((h) => h.id === hostId) ?? null

  const load = useCallback(async () => {
    if (!host) return
    setLoading(true)
    try {
      const result = await api.memoryList(host)
      setGlobal(result.global ?? null)
      setProjects(result.projects)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取记忆失败')
    } finally {
      setLoading(false)
    }
  }, [host])

  useEffect(() => {
    if (!hostId) return
    void load()
  }, [hostId, load, editorOpen])

  const confirmDelete = async () => {
    if (!host || !deleting) return
    setRemoving(true)
    try {
      await api.deleteMemory(
        host,
        deleting.scope,
        deleting.scope === 'project' ? deleting.project : undefined,
      )
      toast('记忆已删除', 'success')
      setDeleting(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setRemoving(false)
    }
  }

  const rows = [
    ...(global ? [global] : []),
    ...projects,
  ]

  const edit = (item: MemoryListItem) => {
    if (!hostId) return
    openEditor({
      scope: item.scope,
      ...(item.scope === 'project' && item.project ? { project: item.project } : {}),
    })
  }

  return (
    <div data-setting-id="memory.content" className="space-y-4">
      <div data-setting-id="memory.host" className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <Brain size={15} className="text-muted" />
            记忆
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            每个项目一份 Tandem 私有记忆，跨会话保留；与仓库内的 AGENTS.md / CLAUDE.md 不同。
          </p>
        </div>
        <span className="flex-1" />
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
        <Button
          variant="ghost"
          onClick={() => void load()}
          disabled={loading}
          className="max-sm:min-h-11"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : null} 刷新
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] leading-6 text-muted">
          还没有任何记忆。在会话里输入「#记住 内容」，或让 agent 用 Memory 工具记录长期事实。
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_64px_92px_72px] items-center gap-2 border-b border-border bg-bg/40 px-3 py-2 text-[12px] text-muted max-sm:grid-cols-[minmax(0,1fr)_56px_64px]">
            <span>项目</span>
            <span className="text-right">大小</span>
            <span className="text-right">最后修改</span>
            <span className="text-right">操作</span>
          </div>
          {rows.map((item) => (
            <div
              key={`${item.scope}:${item.project ?? ''}`}
              className="grid grid-cols-[minmax(0,1fr)_64px_92px_72px] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_56px_64px]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] text-text">
                    {item.scope === 'global' ? '全局记忆' : item.name}
                  </span>
                  {item.scope === 'global' && (
                    <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
                      全局
                    </span>
                  )}
                </div>
                <div
                  className="truncate font-mono text-[12px] text-muted"
                  title={item.project ?? '~/.tandem/memory/_global.md'}
                >
                  {item.project ?? '所有项目共享'}
                </div>
              </div>
              <span className="text-right font-mono text-[12px] tabular-nums text-text-soft">
                {formatSize(item.size)}
              </span>
              <span className="hidden text-right text-[12px] text-muted sm:block">
                {item.updatedAt ? formatRelative(item.updatedAt) : '—'}
              </span>
              <span className="flex items-center justify-end gap-0.5">
                <IconButton
                  size="sm"
                  onClick={() => edit(item)}
                  label={`编辑 ${item.name}`}
                  tooltip="编辑"
                  disabled={!hostId}
                  className="size-7! [&_svg]:size-3.5 max-sm:size-11! max-sm:[&_svg]:size-4"
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  size="sm"
                  onClick={() => setDeleting(item)}
                  label={`删除 ${item.name}`}
                  tooltip="删除"
                  disabled={!hostId}
                  className="size-7! [&_svg]:size-3.5 max-sm:size-11! max-sm:[&_svg]:size-4"
                >
                  <Trash2 size={13} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[12px] leading-5 text-muted">
        记忆保存在 Host 的 <span className="font-mono">~/.tandem/memory/</span>；agent 写入需要审批
        （自动接受编辑模式下自动通过），用户输入「#记住 内容」直接追加。导出配置包时会一并加密携带。
      </p>

      <Modal
        open={!!deleting}
        onClose={() => !removing && setDeleting(null)}
        title="删除记忆"
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
          确定删除「{deleting?.scope === 'global' ? '全局记忆' : deleting?.name}」？该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
