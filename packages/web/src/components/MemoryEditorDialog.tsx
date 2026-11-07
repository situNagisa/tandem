import { useEffect, useState } from 'react'
import { Brain, Loader2, Save } from 'lucide-react'
import type { MemoryFile } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Markdown } from './Markdown'
import { formatRelative } from '../lib/format'

/** 记忆 Markdown 编辑器：左侧原文、右侧预览，保存即写回 Host。 */
export function MemoryEditorDialog() {
  const target = useUiStore((s) => s.memoryEditor)
  const close = useUiStore((s) => s.closeMemoryEditor)
  const open = useUiStore((s) => s.openMemoryEditor)
  const toast = useUiStore((s) => s.toast)
  const host =
    useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? s.hosts[0]) ?? null

  const [file, setFile] = useState<MemoryFile | null>(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target || !host) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .memory(host, target.scope, target.scope === 'project' ? target.project : undefined)
      .then((result) => {
        if (cancelled) return
        setFile(result)
        setText(result.text)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取记忆失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target, host])

  const dirty = !!file && text !== file.text
  // 预览隐藏 Tandem 元数据行（textarea 里保留，便于整篇编辑时原样保存）
  const previewText = text.replace(/^<!--\s*tandem-memory.*?-->\s*/, '')
  const scopeLabel = target?.scope === 'global' ? '全局记忆' : `项目记忆 · ${file?.name ?? ''}`

  const save = async () => {
    if (!host || !target) return
    setSaving(true)
    setError(null)
    try {
      const saved = await api.saveMemory(host, {
        scope: target.scope,
        ...(target.scope === 'project' ? { project: target.project } : {}),
        text,
      })
      setFile(saved)
      setText(saved.text)
      toast('记忆已保存', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!target}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Brain size={14} className="text-muted" />
          {scopeLabel}
        </span>
      }
      description={
        target?.scope === 'project'
          ? `${target.project ?? ''} · 仅本机 Tandem 使用，可随配置迁移`
          : '所有项目共享的长期记忆'
      }
      className="max-w-[min(1080px,94vw)]"
      bodyClassName="p-0"
      footer={
        <>
          {target?.scope === 'project' && (
            <Button
              size="lg"
              variant="ghost"
              onClick={() => open({ scope: 'global' })}
              disabled={saving}
              className="mr-auto"
            >
              全局记忆
            </Button>
          )}
          <Button size="lg" onClick={close} disabled={saving}>
            取消
          </Button>
          <Button size="lg" onClick={() => void save()} disabled={saving || loading || !dirty}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </Button>
        </>
      }
    >
      <div className="flex h-[clamp(320px,58vh,620px)] min-h-0 flex-col md:flex-row">
        <div className="flex min-h-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 text-[12px] text-muted">
            <span>编辑 Markdown</span>
            <span className="tabular-nums">
              {file?.exists ? `${file.entries} 条 · ${formatRelative(file.updatedAt)}` : '新建'}
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="记忆 Markdown"
            placeholder={'- 项目使用 pnpm 而不是 npm\n- 用户偏好中文回复'}
            className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-[1.7] text-text outline-none placeholder:text-muted/60"
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-3 text-[12px] text-muted">
            预览
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
            {previewText.trim() ? (
              <Markdown text={previewText} />
            ) : (
              <p className="text-[12px] text-muted">还没有内容。输入「#记住 …」或让 agent 记录长期事实。</p>
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="border-t border-danger/25 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      {loading && (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted">
          <Loader2 size={12} className="animate-spin" /> 读取中…
        </div>
      )}
    </Modal>
  )
}
