import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, Pencil, Trash2, X } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/Controls'
import { cn } from '../../lib/cn'
import {
  newFeedbackId,
  readFileAsDataURL,
  type FeedbackPriority,
  type FeedbackReference,
  type FeedbackType,
} from '../../lib/feedback'
import { FEEDBACK_CAUSE_RULES } from '../../lib/feedbackCauses'
import { FEEDBACK_FEATURE_OPTIONS } from '../../lib/feedbackFeatures'
import {
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  UI_ATTR,
  clamp,
  elementLabel,
  imageFiles,
  type EditorState,
} from './feedbackModeHelpers'

export function FeedbackEditor({
  editor,
  saving,
  onSave,
  onCancel,
  onDelete,
  onAnnotate,
  onReferencesChange,
  onTagChange,
}: {
  editor: EditorState
  saving: boolean
  onSave: (
    text: string,
    type: FeedbackType,
    priority: FeedbackPriority,
    references: FeedbackReference[],
    annotated: string | null,
  ) => void
  onCancel: () => void
  onDelete?: () => void
  onAnnotate: () => void
  onReferencesChange: (references: FeedbackReference[]) => void
  onTagChange: (featureId?: string, causeId?: string) => void
}) {
  const [text, setText] = useState(editor.text)
  const [type, setType] = useState<FeedbackType>(editor.type)
  const [priority, setPriority] = useState<FeedbackPriority>(editor.priority)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [tagOpen, setTagOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = textRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])

  useEffect(() => {
    const input = textRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(140, Math.max(40, input.scrollHeight))}px`
  }, [text])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const { width, height } = panel.getBoundingClientRect()
    const margin = 8
    const rect = editor.rect
    let top = rect.y + rect.height + 8
    if (top + height > window.innerHeight - margin) top = rect.y - height - 8
    if (top < margin) top = margin
    top = Math.min(top, window.innerHeight - height - margin)
    let left = rect.x
    if (left + width > window.innerWidth - margin) left = rect.x + rect.width - width
    left = clamp(left, margin, window.innerWidth - width - margin)
    setPos({ left, top })
  }, [editor, text, type, saving, editor.references.length])

  const references = editor.references

  const addFiles = async (files: File[]) => {
    const images = files.slice(0, 6)
    if (images.length === 0) return
    const added: FeedbackReference[] = []
    for (const file of images) {
      const dataURL = await readFileAsDataURL(file)
      if (dataURL) {
        added.push({
          id: newFeedbackId(),
          name: file.name || '粘贴的图片',
          dataURL,
          addedAt: Date.now(),
        })
      }
    }
    if (added.length) onReferencesChange([...references, ...added].slice(0, 6))
  }

  // 聚焦输入框时可直接 Ctrl+V 粘贴参考图；纯文字粘贴不受影响。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files)
      if (files.length === 0) return
      e.preventDefault()
      void addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  const submit = () => {
    if (!text.trim() || saving) return
    onSave(text.trim(), type, priority, references, editor.annotatedShot ?? null)
  }

  const annotateSource = editor.annotatedShot ?? editor.elementShot ?? editor.pageShot?.dataURL ?? null
  const hasAnnotated = !!editor.annotatedShot

  return createPortal(
    <>
      <div
        {...{ [UI_ATTR]: '' }}
        className="pointer-events-none fixed inset-0 z-[119] bg-black/[0.03]"
      />
      <div
        {...{ [UI_ATTR]: '' }}
        className="pointer-events-auto fixed z-[140] w-[min(440px,calc(100vw-16px))] rounded-xl border border-border bg-surface p-2.5 shadow-lg"
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        ref={panelRef}
        role="dialog"
        aria-label="反馈输入"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer?.files)
          if (files.length === 0) return
          e.preventDefault()
          void addFiles(files)
        }}
      >
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            options={TYPE_OPTIONS}
            value={type}
            onChange={setType}
            aria-label="反馈类型"
          />
          <SegmentedControl
            size="sm"
            options={PRIORITY_OPTIONS}
            value={priority}
            onChange={setPriority}
            aria-label="优先级"
          />
          <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted">
            {editor.mode === 'new' ? elementLabel(editor.element, editor.kind) : '编辑反馈'}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button data-raw-button
            type="button"
            onClick={() => setTagOpen((open) => !open)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px] transition-colors',
              editor.featureId
                ? 'border-border-strong bg-[var(--t-bg-subtle)] text-text'
                : 'border-dashed border-border text-muted hover:text-text',
            )}
            aria-expanded={tagOpen}
            aria-label="更改功能标签"
          >
            功能：{editor.featureName ?? '未归类'}
          </button>
          {editor.causeId ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[#F97316]/12 px-2 text-[11.5px] text-[#F97316]">
              根因建议 {editor.causeId}
              <button data-raw-button
                type="button"
                aria-label="清除根因建议"
                data-tip={editor.causeTitle}
                onClick={() => onTagChange(editor.featureId, undefined)}
                className="rounded-full hover:bg-[#F97316]/20"
              >
                <X size={10} />
              </button>
            </span>
          ) : null}
          <span className="text-[10.5px] text-muted">按元素自动推断，可修改</span>
        </div>
        {tagOpen && (
          <div className="mt-1.5 max-h-36 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-[var(--t-bg-subtle)] p-1.5">
            <div className="flex flex-wrap gap-1">
              {FEEDBACK_FEATURE_OPTIONS.map((feature) => (
                <button data-raw-button
                  key={feature.id}
                  type="button"
                  onClick={() => onTagChange(feature.id, editor.causeId)}
                  aria-pressed={editor.featureId === feature.id}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    editor.featureId === feature.id
                      ? 'border-border-strong bg-[var(--t-bg-active)] text-text'
                      : 'border-border bg-surface text-text-soft hover:text-text',
                  )}
                >
                  {feature.title}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 border-t border-border pt-1.5">
              <button data-raw-button
                type="button"
                onClick={() => onTagChange(editor.featureId, undefined)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  !editor.causeId
                    ? 'border-border-strong bg-[var(--t-bg-active)] text-text'
                    : 'border-border bg-surface text-text-soft',
                )}
              >
                无根因
              </button>
              {FEEDBACK_CAUSE_RULES.map((rule) => (
                <button data-raw-button
                  key={rule.id}
                  type="button"
                  onClick={() => onTagChange(editor.featureId, rule.id)}
                  data-tip={rule.title}
                  aria-pressed={editor.causeId === rule.id}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px]',
                    editor.causeId === rule.id
                      ? 'border-border-strong bg-[var(--t-bg-active)] text-text'
                      : 'border-border bg-surface text-text-soft hover:text-text',
                  )}
                >
                  {rule.id}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          ref={textRef}
          value={text}
          rows={1}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (!saving) onCancel()
            }
          }}
          placeholder="描述问题或建议…（可 Ctrl+V 粘贴参考图）"
          className="mt-2 w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-5 text-text outline-none placeholder:text-muted"
        />

        {(annotateSource || references.length > 0) && (
          <div className="mt-1.5 flex items-start gap-1.5 overflow-x-auto pb-0.5">
            {annotateSource && (
              <button data-raw-button
                type="button"
                onClick={onAnnotate}
                data-tip="打开标注编辑器"
                className="relative h-14 w-20 shrink-0 overflow-hidden rounded border border-border bg-black/10"
              >
                <img src={annotateSource} alt="" className="size-full object-cover" draggable={false} />
                <span
                  className={cn(
                    'absolute inset-x-0 bottom-0 py-0.5 text-center text-[9px] text-white',
                    hasAnnotated ? 'bg-emerald-600/80' : 'bg-black/55',
                  )}
                >
                  {hasAnnotated ? '已标注' : '标注'}
                </span>
              </button>
            )}
            {references.map((reference) => (
              <div
                key={reference.id}
                className="group relative h-14 w-20 shrink-0 overflow-hidden rounded border border-border bg-black/10"
                data-tip={reference.name}
              >
                <img src={reference.dataURL} alt={reference.name} className="size-full object-cover" draggable={false} />
                <span className="absolute left-0 top-0 rounded-br bg-black/60 px-1 text-[8.5px] text-white">参考</span>
                <button data-raw-button
                  type="button"
                  aria-label="移除参考图"
                  onClick={() => onReferencesChange(references.filter((entry) => entry.id !== reference.id))}
                  className="absolute right-0 top-0 flex size-4 items-center justify-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {onDelete ? (
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Trash2 size={13} />}
                onClick={onDelete}
                disabled={saving}
              >
                删除
              </Button>
            ) : (
              <span className="truncate text-[10px] text-muted">Alt + 点击可选父元素</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil size={12} />}
              onClick={onAnnotate}
              disabled={!annotateSource || saving}
            >
              标注
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<ImagePlus size={12} />}
              onClick={() => fileRef.current?.click()}
              disabled={saving}
            >
              参考图
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = imageFiles(e.target.files)
                e.target.value = ''
                void addFiles(files)
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {saving && (
              <span className="flex items-center gap-1 text-[10.5px] text-muted">
                <Spinner size={11} /> 采集中
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim() || saving}>
              保存
            </Button>
          </div>
        </div>
        <p className="mt-1 px-1 text-[9.5px] leading-4 text-muted">
          Enter 保存 · Shift + Enter 换行 · Esc 取消 · 参考图可粘贴或拖入
        </p>
      </div>
    </>,
    document.body,
  )
}
