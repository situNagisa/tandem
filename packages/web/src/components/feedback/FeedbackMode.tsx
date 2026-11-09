import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Download,
  ImagePlus,
  ListChecks,
  Loader2,
  Pencil,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { feedbackPlatform } from '../../lib/mobilePreview'
import {
  feedbackTypeLabel,
  loadFeedbackSnapshotPrefs,
  newFeedbackId,
  readFileAsDataURL,
  saveFeedbackBlob,
  saveFeedbackSnapshotPrefs,
  type FeedbackItem,
  type FeedbackPageShot,
  type FeedbackPriority,
  type FeedbackReceipt,
  type FeedbackRect,
  type FeedbackReference,
  type FeedbackSelectMode,
  type FeedbackType,
  type FeedbackVideo,
} from '../../lib/feedback'
import {
  archiveFilePayloads,
  type FeedbackArchive,
} from '../../lib/feedbackArchive'
import {
  buildCurrentArchive,
  desktopFeedback,
  draftExpired,
  exportArchiveToDisk,
  flushDraftNow,
  installFeedbackDraftSync,
  markDraftExported,
  openFeedbackFolder,
  removeDesktopDraft,
} from '../../lib/feedbackDrafts'
import {
  captureElementShot,
  capturePageShot,
  captureRegionShot,
  cssSelectorFor,
  reactComponentName,
  rectFor,
  visibleTextSnippet,
} from '../../lib/feedbackCapture'
import { elementsAtPoint } from '../../lib/overlay'
import { getFeedbackTrace } from '../../lib/feedbackTrace'
import { captureFeedbackSnapshot } from '../../lib/feedbackSnapshot'
import { FEEDBACK_CAUSE_RULES } from '../../lib/feedbackCauses'
import {
  FEEDBACK_FEATURE_OPTIONS,
  inferFeedbackTag,
  type FeedbackTag,
} from '../../lib/feedbackFeatures'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import { FeedbackAnnotator } from './FeedbackAnnotator'
import { FeedbackDrawer, type SnapshotPrefs } from './FeedbackDrawer'

const TYPE_OPTIONS: ReadonlyArray<{ value: FeedbackType; label: string }> = [
  { value: 'issue', label: '问题' },
  { value: 'suggestion', label: '建议' },
  { value: 'praise', label: '好评' },
]

const PRIORITY_OPTIONS: ReadonlyArray<{ value: FeedbackPriority; label: string }> = [
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
]

const SELECT_MODE_OPTIONS: ReadonlyArray<{ value: FeedbackSelectMode; label: string }> = [
  { value: 'element', label: '点选' },
  { value: 'region', label: '框选' },
]

const MAX_VIDEO_BYTES = 8 * 1024 * 1024

/** 提示只在本页生命周期内出现一次，切回反馈模式不重复。 */
let restoreNoticeShown = false

const UI_ATTR = 'data-feedback-ui'
const HOVER_ATTR = 'data-feedback-hover'

interface EditorState {
  mode: 'new' | 'edit'
  itemId?: string
  kind: FeedbackSelectMode
  element: Element | null
  rect: FeedbackRect
  type: FeedbackType
  priority: FeedbackPriority
  text: string
  /** 选中瞬间、输入浮窗出现前完成的截图。 */
  elementShot?: string | null
  pageShot?: FeedbackPageShot | null
  references: FeedbackReference[]
  annotatedShot?: string | null
  textSnippet?: string
  featureId?: string
  featureName?: string
  causeId?: string
  causeTitle?: string
  /** 用户手动改过根因：保存时不再用文字规则覆盖。 */
  causeEdited?: boolean
}

interface VerifyState {
  queue: Array<{ item: FeedbackItem; receipt: FeedbackReceipt['items'][number] }>
  index: number
  note: string
}

function safeQuery(selector: string): Element | null {
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

/**
 * 冻结进入反馈模式前的 hover 链：给链上元素加标记，并把样式表里所有
 * `:hover` 规则复制成 `[data-feedback-hover]` 版本，group-hover 的
 * “悬停才出现的按钮”也不会因为指针移到捕获层而消失。
 */
function freezeHoverState(): () => void {
  for (const element of Array.from(document.querySelectorAll(':hover'))) {
    element.setAttribute(HOVER_ATTR, '')
  }

  const hoverRules = (rules: CSSRuleList): string => {
    const chunks: string[] = []
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText
        if (!selector?.includes(':hover')) continue
        chunks.push(
          `${selector.replaceAll(':hover', `[${HOVER_ATTR}]`)}{${rule.style.cssText}}`,
        )
      } else if (rule instanceof CSSMediaRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@media ${rule.conditionText}{${inner}}`)
      } else if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@supports ${rule.conditionText}{${inner}}`)
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(inner)
      } else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@container ${rule.conditionText}{${inner}}`)
      }
    }
    return chunks.join('\n')
  }

  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      css += hoverRules(sheet.cssRules)
    } catch {
      /* 跨域样式表无法读取，忽略 */
    }
  }
  const style = document.createElement('style')
  style.dataset.feedbackHover = ''
  style.textContent = css
  document.head.appendChild(style)

  return () => {
    style.remove()
    for (const element of Array.from(document.querySelectorAll(`[${HOVER_ATTR}]`))) {
      element.removeAttribute(HOVER_ATTR)
    }
  }
}

function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${UI_ATTR}]`) !== null
}

/** 捕获层之下的真实目标：跳过捕获层、高亮层与反馈自身 UI。 */
function elementAtPoint(x: number, y: number): Element | null {
  try {
    for (const element of elementsAtPoint(x, y)) {
      if (isUiTarget(element)) continue
      if (element === document.documentElement) continue
      // 点在图标的 path/文字上时落到最近的可交互控件，截图才是整个按钮。
      return (
        element.closest(
          'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
        ) ?? element
      )
    }
  } catch {
    // 命中测试在浮层卸载等瞬间可能拿到失效节点：当作没选中，捕获层继续可用。
  }
  return null
}

/** 目标自身或最近的显式可滚动祖先。 */
function scrollableFrom(element: Element | null): Element | null {
  let node: Element | null = element
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    const canY =
      /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
    const canX =
      /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
    if (canY || canX) return node
    node = node.parentElement
  }
  return null
}

function elementLabel(element: Element | null, kind: FeedbackSelectMode = 'element'): string {
  if (kind === 'region' || !element) return '框选区域'
  const component = reactComponentName(element)
  const tag = element.tagName.toLowerCase()
  if (component) return `<${component}>`
  const id = element.id ? `#${element.id}` : ''
  const cls = element.classList[0] ? `.${element.classList[0]}` : ''
  return `${tag}${id}${cls}`.slice(0, 42)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function viewportRectFor(item: FeedbackItem): FeedbackRect {
  const element = safeQuery(item.selector)
  if (element) return rectFor(element)
  return {
    x: item.rect.pageX - window.scrollX,
    y: item.rect.pageY - window.scrollY,
    width: item.rect.width,
    height: item.rect.height,
    pageX: item.rect.pageX,
    pageY: item.rect.pageY,
  }
}

function imageFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return []
  return Array.from(files).filter((file) => file.type.startsWith('image/'))
}

function FeedbackEditor({
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
          <button
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
              <button
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
                <button
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
              <button
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
                <button
                  key={rule.id}
                  type="button"
                  onClick={() => onTagChange(editor.featureId, rule.id)}
                  data-tip={rule.title}
                  aria-pressed={editor.causeId === rule.id}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px]',
                    editor.causeId === rule.id
                      ? 'border-border-strong bg-[var(--bg-active)] text-text'
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
              <button
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
                <button
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
                <Loader2 size={11} className="animate-spin" /> 采集中
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

export function FeedbackMode() {
  const active = useFeedbackStore((s) => s.active)
  const items = useFeedbackStore((s) => s.items)
  const receipt = useFeedbackStore((s) => s.receipt)
  const pendingFeature = useFeedbackStore((s) => s.pendingFeature)
  const draft = useFeedbackStore((s) => s.draft)
  const exit = useFeedbackStore((s) => s.exit)
  const [selectMode, setSelectMode] = useState<FeedbackSelectMode>('element')
  const [hover, setHover] = useState<{ rect: FeedbackRect; label: string } | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [tick, setTick] = useState(0)
  const [regionBox, setRegionBox] = useState<FeedbackRect | null>(null)
  const [regionBusy, setRegionBusy] = useState(false)
  const [captureBusy, setCaptureBusy] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [annotator, setAnnotator] = useState<{ image: string; itemId?: string } | null>(null)
  const [focusRect, setFocusRect] = useState<FeedbackRect | null>(null)
  const [prefs, setPrefs] = useState<SnapshotPrefs>(loadFeedbackSnapshotPrefs)
  const [verify, setVerify] = useState<VerifyState | null>(null)
  const [pendingVideo, setPendingVideo] = useState<FeedbackVideo | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const editorRef = useRef<EditorState | null>(null)
  editorRef.current = editor
  const selectModeRef = useRef(selectMode)
  selectModeRef.current = selectMode
  const drawerRef = useRef(drawerOpen)
  drawerRef.current = drawerOpen
  const annotatorRef = useRef(annotator)
  annotatorRef.current = annotator
  const verifyRef = useRef(verify)
  verifyRef.current = verify
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const lastHoverRef = useRef<{ element: Element; alt: boolean } | null>(null)
  /** 每个路由只补拍一次整页；编辑器先出现，整页在空闲时补上。 */
  const pageShotTasksRef = useRef(new Map<string, Promise<FeedbackPageShot | null>>())
  const layerRef = useRef<HTMLDivElement>(null)
  const capturingRef = useRef(false)
  const focusTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordStartedRef = useRef(0)
  const recordTimerRef = useRef<number | null>(null)
  const recordTickRef = useRef<number | null>(null)

  const canRecord =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'

  useEffect(() => {
    saveFeedbackSnapshotPrefs(prefs)
  }, [prefs])

  // 刷新/崩溃后重新打开：恢复未导出草稿，并提示条数；已导出超过 7 天则清理。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void useFeedbackStore.getState().hydrate().then((result) => {
      if (cancelled) return
      const store = useFeedbackStore.getState()
      if (store.draft && draftExpired(store.draft)) {
        store.clear()
        return
      }
      if (!restoreNoticeShown && result.restored > 0 && result.unexported) {
        restoreNoticeShown = true
        useUiStore.getState().toast(`已恢复 ${result.restored} 条未导出的反馈`, 'info', {
          durationMs: 6000,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [active])

  // 关页面前把最后一次变更写进桌面草稿目录（IndexedDB 已经同步落盘）。
  useEffect(() => {
    if (!active) return
    const flush = () => void flushDraftNow()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      void flushDraftNow()
    }
  }, [active])

  // 进入/退出反馈模式：冻结 hover、页面光标。热键在 main.tsx 中最早注册。
  useEffect(() => {
    if (!active) {
      document.documentElement.classList.remove('feedback-mode')
      setHover(null)
      setEditor(null)
      setSaving(false)
      setRegionBox(null)
      setDrawerOpen(false)
      setAnnotator(null)
      setVerify(null)
      setFocusRect(null)
      setPendingVideo(null)
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      setRecording(false)
      return
    }
    const releaseHover = freezeHoverState()
    document.documentElement.classList.add('feedback-mode')
    return () => {
      releaseHover()
      document.documentElement.classList.remove('feedback-mode')
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editorRef.current) return
      if (annotatorRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (verifyRef.current) {
        setVerify(null)
        setDrawerOpen(true)
        return
      }
      if (drawerRef.current) {
        setDrawerOpen(false)
        return
      }
      exit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, exit])

  // 滚动/缩放后重新定位徽标与高亮。
  useEffect(() => {
    if (!active) return
    const bump = () => setTick((value) => value + 1)
    window.addEventListener('scroll', bump, true)
    window.addEventListener('resize', bump)
    window.addEventListener('hashchange', bump)
    return () => {
      window.removeEventListener('scroll', bump, true)
      window.removeEventListener('resize', bump)
      window.removeEventListener('hashchange', bump)
    }
  }, [active])

  // 圈选：在 window capture 阶段接管应用交互。
  // Radix DismissableLayer 在 document 上监听 pointerdown / focusin，
  // 必须比它更早 stopImmediatePropagation，打开的菜单/Popover 才不会被判为外部点击而关闭。
  useEffect(() => {
    if (!active) return
    const layer = layerRef.current
    if (!layer) return
    let down: { x: number; y: number; pointerId: number } | null = null
    let lastPoint: { x: number; y: number } | null = null

    // 单个处理器抛错（如浮层卸载导致节点失效）不能冻结捕获层：
    // 清掉拖拽/悬停状态后继续保持响应，下一次点击照常可选。
    const safely = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        down = null
        lastHoverRef.current = null
        setHover(null)
        setRegionBox(null)
        console.warn('[feedback] 圈选处理失败，已恢复捕获层', err)
      }
    }

    // 捕获层自身也带 data-feedback-ui，它不是可交互 UI，事件必须继续拦截。
    const isFeedbackUi = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest('[data-feedback-capture]') === null &&
      target.closest(`[${UI_ATTR}]`) !== null

    const hoverAt = (x: number, y: number, alt: boolean) => {
      if (editorRef.current || selectModeRef.current !== 'element') return
      const target = elementAtPoint(x, y)
      if (!target) {
        lastHoverRef.current = null
        setHover(null)
        return
      }
      const picked = alt && target.parentElement ? target.parentElement : target
      if (lastHoverRef.current?.element === picked && lastHoverRef.current.alt === alt) {
        return
      }
      lastHoverRef.current = { element: picked, alt }
      setHover({ rect: rectFor(picked), label: elementLabel(picked) })
    }

    const onPointerMove = (e: PointerEvent) => {
      e.stopPropagation()
      lastPoint = { x: e.clientX, y: e.clientY }
      if (down) {
        const distance = Math.hypot(e.clientX - down.x, e.clientY - down.y)
        if (selectModeRef.current === 'region') {
          setRegionBox({
            x: Math.min(down.x, e.clientX),
            y: Math.min(down.y, e.clientY),
            width: Math.abs(e.clientX - down.x),
            height: Math.abs(e.clientY - down.y),
            pageX: Math.min(down.x, e.clientX) + window.scrollX,
            pageY: Math.min(down.y, e.clientY) + window.scrollY,
          })
          return
        }
        if (distance > 8) {
          down = null
          lastHoverRef.current = null
          setHover(null)
          return
        }
      }
      hoverAt(e.clientX, e.clientY, e.altKey)
    }

    // 点击后立刻截图，截图完成才弹输入浮窗：菜单或 hover 元素不会在截图前消失。
    const openEditorFor = async (picked: Element, rect: FeedbackRect) => {
      if (capturingRef.current) return
      capturingRef.current = true
      setCaptureBusy(true)
      try {
        const route = window.location.hash || '#/'
        // 先让「截图中…」提示画出来，再开始克隆（长会话里这步很重）。
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const elementShot = await captureElementShot(picked)
        if (!useFeedbackStore.getState().active) return
        lastHoverRef.current = null
        setHover(null)
        const pending = useFeedbackStore.getState().pendingFeature
        const inferred = inferFeedbackTag({
          element: picked,
          component: reactComponentName(picked),
          selector: cssSelectorFor(picked),
          route,
          textSnippet: visibleTextSnippet(picked),
        })
        const featureId = pending?.featureId ?? inferred?.featureId
        const featureName = pending?.featureName ?? inferred?.featureName
        setEditor({
          mode: 'new',
          kind: 'element',
          element: picked,
          rect,
          type: 'issue',
          priority: 'P1',
          text: '',
          references: [],
          elementShot,
          pageShot: null,
          featureId,
          featureName,
          causeId: inferred?.causeId,
          causeTitle: inferred?.causeTitle,
        })
        // 整页缩略图只是归档参考图：编辑器已可用，空闲时后台补拍。
        attachPageShot(route)
      } catch (err) {
        // 截图/推断失败不能让捕获层停在“采集中”，用户下次点击必须还能用。
        console.warn('[feedback] 圈选截图失败', err)
        useUiStore.getState().toast('圈选失败，请再试一次', 'error')
      } finally {
        capturingRef.current = false
        setCaptureBusy(false)
      }
    }

    const openEditorForRegion = async (rect: FeedbackRect) => {
      if (capturingRef.current) return
      capturingRef.current = true
      setRegionBusy(true)
      try {
        const route = window.location.hash || '#/'
        // 让「截取区域」提示先画出来，避免长会话里像没反应。
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const regionShot = await captureRegionShot(rect)
        if (!useFeedbackStore.getState().active) return
        const center = elementsAtPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ).find((element) => !isUiTarget(element) && element !== document.documentElement)
        const pending = useFeedbackStore.getState().pendingFeature
        const textSnippet = center ? visibleTextSnippet(center) : ''
        const inferred = inferFeedbackTag({
          element: center,
          component: center ? reactComponentName(center) : undefined,
          selector: center ? cssSelectorFor(center) : undefined,
          route,
          textSnippet,
        })
        setEditor({
          mode: 'new',
          kind: 'region',
          element: center ?? null,
          rect,
          type: 'issue',
          priority: 'P1',
          text: '',
          references: [],
          elementShot: regionShot,
          pageShot: null,
          textSnippet,
          featureId: pending?.featureId ?? inferred?.featureId,
          featureName: pending?.featureName ?? inferred?.featureName,
          causeId: inferred?.causeId,
          causeTitle: inferred?.causeTitle,
        })
        attachPageShot(route)
      } catch (err) {
        console.warn('[feedback] 区域截图失败', err)
        useUiStore.getState().toast('圈选失败，请再试一次', 'error')
      } finally {
        capturingRef.current = false
        setRegionBusy(false)
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (isFeedbackUi(e.target)) return
      // 阻止默认行为也避免了焦点转移，radix 菜单/Popover 不会被判为外部点击而关闭。
      e.preventDefault()
      e.stopImmediatePropagation()
      down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
      lastPoint = { x: e.clientX, y: e.clientY }
      if (selectModeRef.current === 'region' && !editorRef.current) {
        setRegionBox({
          x: e.clientX,
          y: e.clientY,
          width: 0,
          height: 0,
          pageX: e.clientX + window.scrollX,
          pageY: e.clientY + window.scrollY,
        })
        return
      }
      hoverAt(e.clientX, e.clientY, e.altKey)
    }

    const onPointerUp = (e: PointerEvent) => {
      if (isFeedbackUi(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const start = down
      down = null
      if (!start || start.pointerId !== e.pointerId) return
      if (selectModeRef.current === 'region' && !editorRef.current) {
        setRegionBox(null)
        const x = Math.min(start.x, e.clientX)
        const y = Math.min(start.y, e.clientY)
        const width = Math.abs(e.clientX - start.x)
        const height = Math.abs(e.clientY - start.y)
        if (width < 8 || height < 8) return
        const rect: FeedbackRect = {
          x,
          y,
          width,
          height,
          pageX: x + window.scrollX,
          pageY: y + window.scrollY,
        }
        void openEditorForRegion(rect)
        return
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return
      if (capturingRef.current) return
      if (editorRef.current) {
        setEditor(null)
        return
      }
      const target = elementAtPoint(e.clientX, e.clientY)
      if (!target) return
      const picked = e.altKey && target.parentElement ? target.parentElement : target
      void openEditorFor(picked, rectFor(picked))
    }

    const onPointerCancel = () => {
      down = null
      setRegionBox(null)
    }

    const onPointerLeave = () => {
      if (down) return
      lastHoverRef.current = null
      setHover(null)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
      const dx = e.deltaX * unit
      const dy = e.deltaY * unit
      const scroller = scrollableFrom(elementAtPoint(e.clientX, e.clientY))
      if (scroller) scroller.scrollBy({ left: dx, top: dy })
      else window.scrollBy(dx, dy)
      lastPoint = { x: e.clientX, y: e.clientY }
      requestAnimationFrame(() => {
        if (lastPoint) hoverAt(lastPoint.x, lastPoint.y, false)
      })
    }

    // 其余指针/触摸/焦点事件在 window capture 阶段消化，避免 Radix 关闭弹层。
    const blockInteraction = (e: Event) => {
      if (isFeedbackUi(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const blockFocus = (e: Event) => {
      e.stopImmediatePropagation()
    }
    const blocked = [
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'auxclick',
      'contextmenu',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'focusin',
      'focusout',
    ]

    const onPointerDownSafe = (e: PointerEvent) => safely(() => onPointerDown(e))
    const onPointerUpSafe = (e: PointerEvent) => safely(() => onPointerUp(e))
    const onPointerMoveSafe = (e: PointerEvent) => safely(() => onPointerMove(e))
    const onPointerCancelSafe = () => safely(onPointerCancel)
    const onPointerLeaveSafe = () => safely(onPointerLeave)
    const onWheelSafe = (e: WheelEvent) => safely(() => onWheel(e))

    window.addEventListener('pointerdown', onPointerDownSafe, true)
    window.addEventListener('pointerup', onPointerUpSafe, true)
    for (const type of blocked) {
      window.addEventListener(type, type === 'focusin' || type === 'focusout' ? blockFocus : blockInteraction, true)
    }
    layer.addEventListener('pointermove', onPointerMoveSafe)
    layer.addEventListener('pointercancel', onPointerCancelSafe)
    layer.addEventListener('pointerleave', onPointerLeaveSafe)
    layer.addEventListener('wheel', onWheelSafe, { passive: false })
    return () => {
      window.removeEventListener('pointerdown', onPointerDownSafe, true)
      window.removeEventListener('pointerup', onPointerUpSafe, true)
      for (const type of blocked) {
        window.removeEventListener(type, type === 'focusin' || type === 'focusout' ? blockFocus : blockInteraction, true)
      }
      layer.removeEventListener('pointermove', onPointerMoveSafe)
      layer.removeEventListener('pointercancel', onPointerCancelSafe)
      layer.removeEventListener('pointerleave', onPointerLeaveSafe)
      layer.removeEventListener('wheel', onWheelSafe)
    }
  }, [active])

  // 键盘：Esc 与反馈输入框内的按键放行，其余在捕获阶段拦下，避免应用响应。
  // 常驻注册（早于 App 的全局快捷键监听），仅在反馈模式生效。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useFeedbackStore.getState().active) return
      if (e.target instanceof Element && e.target.closest(`[${UI_ATTR}]`)) {
        // 反馈 UI 内放行输入，但 Tab 不交给设置等弹窗的焦点陷阱。
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }
      if (e.key === 'Escape') return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') return
      // 允许全局 Ctrl+V，供输入浮窗接收参考图（纯文字粘贴也照常）。
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') return
      e.preventDefault()
      // 同一 window 上的全局快捷键（App 等）注册可能更晚，需立即停止派发。
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keypress', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keypress', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [])

  // 复验：切到对应路由并把目标滚到视口中间；路由渲染有延迟时轮询等待。
  useEffect(() => {
    if (!verify) return
    const entry = verify.queue[verify.index]
    if (!entry) return
    if (entry.item.route && window.location.hash !== entry.item.route) {
      window.location.hash = entry.item.route
    }
    let interval: number | null = null
    let attempts = 0
    const locate = () => {
      const element = safeQuery(entry.item.selector)
      if (element) element.scrollIntoView({ block: 'center', inline: 'center' })
      setTick((value) => value + 1)
      return !!element
    }
    const timer = window.setTimeout(() => {
      if (locate()) return
      interval = window.setInterval(() => {
        attempts += 1
        if (locate() || attempts >= 7) {
          if (interval) window.clearInterval(interval)
          interval = null
        }
      }, 500)
    }, 420)
    return () => {
      window.clearTimeout(timer)
      if (interval) window.clearInterval(interval)
    }
  }, [verify?.index, verify?.queue])

  useEffect(() => {
    return () => {
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current)
      if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current)
      if (recordTickRef.current) window.clearInterval(recordTickRef.current)
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  /** 公用的「空闲时」调度：先让元素/区域截图与输入浮窗渲染完，别抢同一帧的主线程。 */
  const onIdle = (task: () => void, delayMs = 0) => {
    const schedule = () => {
      const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
      if (idle) idle(task, { timeout: 1200 })
      else window.setTimeout(task, 300)
    }
    if (delayMs > 0) window.setTimeout(schedule, delayMs)
    else schedule()
  }

  /**
   * 整页缩略图：每个路由只拍一次。它只是随条目归档的参考图，
   * 不该挡在「点选 → 能继续操作」的路径上，所以空闲时后台补拍。
   */
  const startPageShot = (route: string): Promise<FeedbackPageShot | null> => {
    const store = useFeedbackStore.getState()
    const cached = store.pageShots.find((shot) => shot.route === route)
    if (cached) return Promise.resolve(cached)
    const existing = pageShotTasksRef.current.get(route)
    if (existing) return existing
    const task = new Promise<FeedbackPageShot | null>((resolve) => {
      onIdle(() => {
        void (async () => {
          try {
            if (!useFeedbackStore.getState().active) return resolve(null)
            const captured = await capturePageShot()
            if (!captured) return resolve(null)
            const shot: FeedbackPageShot = {
              id: newFeedbackId(),
              route,
              dataURL: captured.dataURL,
              width: captured.width,
              height: captured.height,
              createdAt: Date.now(),
            }
            useFeedbackStore.getState().addPageShot(shot)
            resolve(shot)
          } catch (err) {
            console.warn('[feedback] 整页截图失败', err)
            resolve(null)
          } finally {
            pageShotTasksRef.current.delete(route)
          }
        })()
      }, 600)
    })
    pageShotTasksRef.current.set(route, task)
    return task
  }

  const attachPageShot = (route: string) => {
    void startPageShot(route).then((shot) => {
      if (!shot) return
      setEditor((current) =>
        current && current.mode === 'new' && !current.pageShot ? { ...current, pageShot: shot } : current,
      )
    })
  }

  const openEditorForItem = (item: FeedbackItem) => {
    const element = safeQuery(item.selector)
    setEditor({
      mode: 'edit',
      itemId: item.id,
      kind: item.mode ?? 'element',
      element,
      rect: viewportRectFor(item),
      type: item.type,
      priority: item.priority ?? 'P1',
      text: item.text,
      elementShot: item.screenshot ?? null,
      references: item.references ? [...item.references] : [],
      annotatedShot: item.annotatedScreenshot ?? null,
      featureId: item.featureId,
      featureName: item.featureName,
      causeId: item.causeId,
      causeTitle: item.causeTitle,
    })
    setDrawerOpen(false)
  }

  const saveNew = async (
    text: string,
    type: FeedbackType,
    priority: FeedbackPriority,
    references: FeedbackReference[],
    annotated: string | null,
  ) => {
    const current = editorRef.current
    if (!current || current.mode !== 'new' || saving) return
    if (current.kind === 'element' && !current.element) return
    const element = current.element
    const rect = current.rect
    const route = window.location.hash || '#/'
    setSaving(true)
    try {
      const store = useFeedbackStore.getState()
      const pageShot = store.pageShots.find((shot) => shot.route === route)
      let pageShotData: string | null = current.pageShot?.dataURL ?? pageShot?.dataURL ?? null
      if (!pageShotData) {
        // 后台补拍可能还在跑：保存时等它一次，没有再补拍。
        const pendingShot = pageShotTasksRef.current.get(route) ?? startPageShot(route)
        const shot = await pendingShot
        pageShotData = shot?.dataURL ?? null
      }
      // 选中时已截图；这里只在缺失（如重试）时补拍，框选区域不补拍整页元素。
      const elementShot = current.kind === 'region'
        ? current.elementShot ?? null
        : current.elementShot === undefined || current.elementShot === null
          ? await captureElementShot(element ?? document.body)
          : current.elementShot
      const app = useAppStore.getState()
      const hostId = app.active?.hostId ?? app.activeHostId ?? undefined
      const hostInfo = hostId ? app.runtimes[hostId]?.info : undefined
      const ua = navigator.userAgent
      const snapshotPrefs = prefsRef.current
      const inferredAtSave = inferFeedbackTag({
        element,
        component: element ? reactComponentName(element) : undefined,
        selector: element && current.kind !== 'region' ? cssSelectorFor(element) : undefined,
        route,
        text,
        textSnippet: current.textSnippet,
      })
      const featureId = current.featureId ?? inferredAtSave?.featureId
      const featureName =
        current.featureName ??
        (featureId
          ? FEEDBACK_FEATURE_OPTIONS.find((feature) => feature.id === featureId)?.title ?? featureId
          : undefined)
      const causeId = current.causeEdited ? current.causeId : inferredAtSave?.causeId ?? current.causeId
      const causeTitle = current.causeEdited
        ? current.causeTitle
        : inferredAtSave?.causeTitle ?? current.causeTitle
      const item: FeedbackItem = {
        id: newFeedbackId(),
        type,
        text,
        mode: current.kind,
        priority,
        selector: current.kind === 'region' || !element ? '' : cssSelectorFor(element),
        component: current.kind === 'region' || !element ? undefined : reactComponentName(element),
        textSnippet:
          current.textSnippet ??
          (element ? visibleTextSnippet(element) : `框选区域 ${rect.width}×${rect.height}`),
        route,
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        platform: feedbackPlatform(),
        ua,
        hostId,
        hostName: hostInfo?.name,
        hostPlatform: hostInfo?.platform,
        hostVersion: hostInfo?.version,
        sessionId: app.active?.sessionId,
        createdAt: Date.now(),
        screenshot: elementShot ?? pageShotData ?? undefined,
        screenshotKind:
          current.kind === 'region'
            ? 'region'
            : elementShot
              ? 'element'
              : pageShotData
                ? 'page'
                : undefined,
        screenshotPadding: elementShot && current.kind === 'element' ? 16 : undefined,
        annotatedScreenshot: annotated ?? undefined,
        references: references.length ? references : undefined,
        trace: getFeedbackTrace(60_000),
        snapshot: captureFeedbackSnapshot(snapshotPrefs.includeMessages, snapshotPrefs.hidePaths),
        video: pendingVideo ?? undefined,
        ...(featureId ? { featureId, featureName: featureName ?? featureId } : {}),
        ...(causeId ? { causeId, causeTitle } : {}),
      }
      store.upsertItem(item)
      store.setPendingFeature(null)
      setPendingVideo(null)
      setEditor(null)
      useUiStore.getState().toast(`已记录第 ${useFeedbackStore.getState().items.length} 条反馈`, 'info')
    } catch {
      useUiStore.getState().toast('截图或保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = (
    text: string,
    type: FeedbackType,
    priority: FeedbackPriority,
    references: FeedbackReference[],
    annotated: string | null,
  ) => {
    const current = editorRef.current
    if (!current?.itemId) return
    const store = useFeedbackStore.getState()
    const item = store.items.find((entry) => entry.id === current.itemId)
    if (!item) return
    store.upsertItem({
      ...item,
      text,
      type,
      priority,
      references: references.length ? references : undefined,
      annotatedScreenshot: annotated ?? item.annotatedScreenshot,
      ...(current.featureId
        ? { featureId: current.featureId, featureName: current.featureName ?? current.featureId }
        : { featureId: undefined, featureName: undefined }),
      ...(current.causeId
        ? { causeId: current.causeId, causeTitle: current.causeTitle }
        : { causeId: undefined, causeTitle: undefined }),
    })
    setEditor(null)
  }

  const deleteCurrent = () => {
    const current = editorRef.current
    if (!current?.itemId) return
    useFeedbackStore.getState().removeItem(current.itemId)
    setEditor(null)
    useUiStore.getState().toast('已删除反馈', 'info')
  }

  const highlightItem = (item: FeedbackItem) => {
    setDrawerOpen(false)
    const element = safeQuery(item.selector)
    if (element) element.scrollIntoView({ block: 'center', inline: 'center' })
    requestAnimationFrame(() => {
      setFocusRect(viewportRectFor(item))
      setTick((value) => value + 1)
    })
    if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current)
    focusTimerRef.current = window.setTimeout(() => setFocusRect(null), 2600)
  }

  const annotateItem = (item: FeedbackItem) => {
    const image = item.annotatedScreenshot ?? item.screenshot
    if (!image) {
      useUiStore.getState().toast('这条反馈没有截图可标注', 'info')
      return
    }
    setAnnotator({ image, itemId: item.id })
  }

  const annotateEditorShot = () => {
    const current = editorRef.current
    if (!current) return
    const image = current.annotatedShot ?? current.elementShot ?? current.pageShot?.dataURL
    if (!image) return
    setAnnotator({ image })
  }

  /** 导出与草稿共用同一份包结构；桌面端直接落盘到「下载/Tandem 反馈」。 */
  const finishExport = async (archive: FeedbackArchive): Promise<boolean> => {
    const before = useFeedbackStore.getState()
    const saved = await exportArchiveToDisk(archive)
    if (saved) {
      // 先把「已导出」写进草稿目录的 manifest，再清空条目（磁盘副本保留 7 天）。
      if (before.draft && desktopFeedback()) {
        const exportedAt = Date.now()
        const draftArchive = buildCurrentArchive({
          items: before.items,
          draft: { ...before.draft, exportedAt },
          exportedAt: new Date(exportedAt).toISOString(),
        })
        await desktopFeedback()
          ?.syncDraft(before.draft.id, archiveFilePayloads(draftArchive))
          .catch(() => undefined)
      }
      const exported = useFeedbackStore.getState().markExported()
      await markDraftExported(exported)
      useUiStore.getState().toast(`已导出 ${archive.filename}`, 'success', {
        actionLabel: '打开所在文件夹',
        onClick: () => void openFeedbackFolder(saved.path),
        durationMs: 9000,
      })
      return true
    }
    const result = await saveFeedbackBlob(
      new Blob([archive.bytes as BlobPart], { type: 'application/zip' }),
      archive.filename,
    )
    if (result === 'failed') {
      useUiStore.getState().toast('导出失败，请重试', 'error')
      return false
    }
    useFeedbackStore.getState().markExported()
    useUiStore.getState().toast(
      result === 'share' ? '已通过系统分享导出反馈包' : `已导出 ${archive.filename}`,
      'success',
    )
    return true
  }

  const exportAll = async () => {
    const store = useFeedbackStore.getState()
    if (store.items.length === 0) {
      useUiStore.getState().toast('还没有记录反馈', 'info')
      return
    }
    await flushDraftNow()
    const archive = buildCurrentArchive({ items: store.items, draft: store.draft })
    await finishExport(archive)
  }

  /** 手动删除草稿：条目、IndexedDB 与桌面草稿目录一起清掉。 */
  const clearDraft = () => {
    const store = useFeedbackStore.getState()
    const draft = store.draft
    if (store.items.length > 0 && !window.confirm('删除当前草稿（含已记录条目与桌面草稿文件）？')) {
      return
    }
    store.clear()
    void removeDesktopDraft(draft)
    useUiStore.getState().toast('已删除草稿', 'info')
  }

  const importReceipt = (next: FeedbackReceipt) => {
    useFeedbackStore.getState().importReceipt(next)
    const matched = items.filter((item) => next.items.some((entry) => entry.id === item.id)).length
    useUiStore.getState().toast(`已导入回执，匹配 ${matched}/${next.items.length} 条`, 'success')
    setDrawerOpen(true)
  }

  const startVerify = () => {
    const currentReceipt = useFeedbackStore.getState().receipt
    if (!currentReceipt) return
    const currentItems = useFeedbackStore.getState().items
    const queue = currentReceipt.items.flatMap((entry) => {
      const item = currentItems.find((candidate) => candidate.id === entry.id)
      return item ? [{ item, receipt: entry }] : []
    })
    if (queue.length === 0) {
      useUiStore.getState().toast('回执里没有能匹配当前条目的 id', 'info')
      return
    }
    setDrawerOpen(false)
    setEditor(null)
    setVerify({ queue, index: 0, note: '' })
  }

  const advanceVerify = (result: 'pass' | 'fail' | 'skip') => {
    const current = verifyRef.current
    if (!current) return
    const entry = current.queue[current.index]
    if (!entry) {
      setVerify(null)
      return
    }
    if (result !== 'skip') {
      useFeedbackStore.getState().setVerification(
        entry.item.id,
        result,
        current.note.trim() || undefined,
      )
    }
    if (current.index + 1 >= current.queue.length) {
      setVerify(null)
      setDrawerOpen(true)
      useUiStore.getState().toast('复验完成，可导出复验结果', 'success')
      return
    }
    setVerify({ ...current, index: current.index + 1, note: '' })
  }

  const exportVerification = async () => {
    const store = useFeedbackStore.getState()
    const currentReceipt = store.receipt
    if (!currentReceipt) return
    const verifiedIds = new Set(
      currentReceipt.items.filter((entry) => entry.verification).map((entry) => entry.id),
    )
    const verifiedItems = store.items
      .filter((item) => verifiedIds.has(item.id))
      .map((item) => ({
        ...item,
        verification: currentReceipt.items.find((entry) => entry.id === item.id)?.verification,
      }))
    if (verifiedItems.length === 0) {
      useUiStore.getState().toast('还没有复验结果', 'info')
      return
    }
    const archive = buildCurrentArchive({
      items: verifiedItems,
      kind: 'verification',
      receipt: currentReceipt,
      sourceReceiptFile: currentReceipt.sourceFile,
      draft: store.draft,
    })
    const saved = await exportArchiveToDisk(archive)
    if (saved) {
      useUiStore.getState().toast(`已导出复验结果 ${archive.filename}`, 'success', {
        actionLabel: '打开所在文件夹',
        onClick: () => void openFeedbackFolder(saved.path),
        durationMs: 9000,
      })
      return
    }
    const result = await saveFeedbackBlob(
      new Blob([archive.bytes as BlobPart], { type: 'application/zip' }),
      archive.filename,
    )
    useUiStore.getState().toast(
      result === 'failed' ? '导出失败，请重试' : `已导出复验结果 ${archive.filename}`,
      result === 'failed' ? 'error' : 'success',
    )
  }

  const stopRecording = () => {
    if (recordTimerRef.current) {
      window.clearTimeout(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recordTickRef.current) {
      window.clearInterval(recordTickRef.current)
      recordTickRef.current = null
    }
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    setRecording(false)
  }

  const startRecording = async () => {
    if (!canRecord || recording) return
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      streamRef.current = stream
      chunksRef.current = []
      recordStartedRef.current = Date.now()
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        if (recordTickRef.current) {
          window.clearInterval(recordTickRef.current)
          recordTickRef.current = null
        }
        if (recordTimerRef.current) {
          window.clearTimeout(recordTimerRef.current)
          recordTimerRef.current = null
        }
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
        chunksRef.current = []
        if (blob.size === 0) return
        if (blob.size > MAX_VIDEO_BYTES) {
          useUiStore.getState().toast('录屏超过 8MB，已丢弃（可缩短后重录）', 'error')
          return
        }
        const dataURL = await readFileAsDataURL(blob)
        if (!dataURL) return
        if (!useFeedbackStore.getState().active) return
        setPendingVideo({
          name: `repro-${Date.now()}.webm`,
          mime: blob.type,
          dataURL,
          durationMs: Date.now() - recordStartedRef.current,
          sizeBytes: blob.size,
        })
        useUiStore.getState().toast('录屏已附加到下一条反馈', 'success')
      }
      recorder.start(1000)
      setRecording(true)
      setRecordSeconds(0)
      recordTickRef.current = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartedRef.current) / 1000))
      }, 1000)
      recordTimerRef.current = window.setTimeout(() => stopRecording(), 60_000)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording())
    } catch {
      useUiStore.getState().toast('无法开始录屏（可能取消了授权）', 'error')
    }
  }

  const verifyEntry = verify?.queue[verify.index] ?? null
  const verifyLive = useMemo(() => {
    void tick
    if (!verifyEntry) return null
    const element = safeQuery(verifyEntry.item.selector)
    return {
      rect: element ? rectFor(element) : viewportRectFor(verifyEntry.item),
      found: !!element,
      region: !verifyEntry.item.selector,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyEntry, tick])

  const badges = useMemo(() => {
    void tick
    if (!active) return []
    return items.map((item, index) => {
      const rect = viewportRectFor(item)
      const left = clamp(rect.x + rect.width - 10, 4, window.innerWidth - 24)
      const top = clamp(rect.y - 10, 4, window.innerHeight - 24)
      return { item, index, left, top }
    })
  }, [active, items, tick])

  if (!active) return null

  const selected = editor?.rect ?? null

  return createPortal(
    <>
      {/* 全屏透明捕获层：拦截应用的一切交互，反馈自身 UI 位于其上方 */}
      <div
        ref={layerRef}
        {...{ [UI_ATTR]: '', 'data-feedback-capture': '' }}
        className="pointer-events-auto fixed inset-0 z-[105] touch-none select-none"
        aria-hidden
      />

      {/* 高亮框与徽标层：pointer-events:none，不改变页面元素自身样式 */}
      <div
        {...{ [UI_ATTR]: '' }}
        className="pointer-events-none fixed inset-0 z-[110]"
        aria-hidden
      >
        {hover && !editor && !regionBox && (
          <div
            className="absolute rounded-[2px]"
            style={{
              left: hover.rect.x,
              top: hover.rect.y,
              width: hover.rect.width,
              height: hover.rect.height,
              boxShadow: '0 0 0 2px #F97316',
            }}
          >
            <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-[#F97316] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
              {hover.label}
            </span>
          </div>
        )}
        {regionBox && (regionBox.width > 0 || regionBox.height > 0) && (
          <div
            className="absolute rounded-[2px] border-2 border-dashed border-[#F97316] bg-[#F97316]/10"
            style={{
              left: regionBox.x,
              top: regionBox.y,
              width: regionBox.width,
              height: regionBox.height,
            }}
          >
            <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-[#F97316] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
              框选 {Math.round(regionBox.width)}×{Math.round(regionBox.height)}
            </span>
          </div>
        )}
        {selected && editor && (
          <div
            className="absolute rounded-[2px]"
            style={{
              left: selected.x,
              top: selected.y,
              width: selected.width,
              height: selected.height,
              boxShadow: '0 0 0 2px #F97316',
            }}
          />
        )}
        {focusRect && (
          <div
            className="absolute animate-pulse rounded-[2px] bg-[#F97316]/10"
            style={{
              left: focusRect.x,
              top: focusRect.y,
              width: focusRect.width,
              height: focusRect.height,
              boxShadow: '0 0 0 3px #F97316, 0 0 0 8px rgba(249,115,22,.25)',
            }}
          />
        )}
        {verifyLive && (
          <div
            className="absolute rounded-[2px] bg-[#F97316]/10"
            style={{
              left: verifyLive.rect.x,
              top: verifyLive.rect.y,
              width: verifyLive.rect.width,
              height: verifyLive.rect.height,
              boxShadow: verifyLive.found || verifyLive.region
                ? '0 0 0 2px #F97316, 0 0 0 8px rgba(249,115,22,.22)'
                : '0 0 0 2px #EF4444, 0 0 0 8px rgba(239,68,68,.18)',
            }}
          >
            <span
              className={cn(
                'absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-white',
                verifyLive.found || verifyLive.region ? 'bg-[#F97316]' : 'bg-red-500',
              )}
            >
              {verifyLive.region
                ? '框选区域（按记录位置定位）'
                : verifyLive.found
                  ? '复验目标'
                  : '未找到元素（按记录位置定位）'}
            </span>
          </div>
        )}
        {!verify && badges.map(({ item, index, left, top }) => (
          <button
            key={item.id}
            {...{ [UI_ATTR]: '' }}
            type="button"
            onClick={() => openEditorForItem(item)}
            className={cn(
              'pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border border-white/70 bg-[#F97316] text-[10px] font-semibold leading-none text-white shadow-sm',
              'transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#F97316]',
            )}
            style={{ left, top }}
            data-tip={`${index + 1}. ${feedbackTypeLabel(item.type)}：${item.text}`}
            aria-label={`编辑第 ${index + 1} 条反馈`}
          >
            {index + 1}
          </button>
        ))}
      </div>

      {/* 顶部浮条 */}
      <div
        {...{ [UI_ATTR]: '' }}
        role="region"
        aria-label="反馈模式工具栏"
        className="pointer-events-auto fixed left-1/2 top-3 z-[130] w-max max-w-[calc(100vw-16px)] -translate-x-1/2 max-sm:top-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-1.5 shadow-md">
          <span className="size-1.5 rounded-full bg-[#F97316]" />
          <span className="whitespace-nowrap text-[12.5px] font-medium text-text">
            反馈模式 · 已记录 {items.length} 条
          </span>
          {pendingFeature && (
            <span className="flex items-center gap-1 rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[11px] text-[#F97316]">
              标记：{pendingFeature.featureName}
              <button
                type="button"
                aria-label="取消功能标记"
                onClick={() => useFeedbackStore.getState().setPendingFeature(null)}
                className="rounded-full hover:bg-[#F97316]/20"
              >
                <X size={10} />
              </button>
            </span>
          )}
          <span className="h-4 w-px bg-border" />
          <SegmentedControl
            size="sm"
            options={SELECT_MODE_OPTIONS}
            value={selectMode}
            onChange={setSelectMode}
            aria-label="选择方式"
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<ListChecks size={13} />}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            条目 {items.length}
          </Button>
          {canRecord && (
            <Button
              size="sm"
              variant={recording ? 'danger-ghost' : 'ghost'}
              icon={<Video size={13} />}
              onClick={() => (recording ? stopRecording() : void startRecording())}
              tooltip={recording ? '停止录制并附加到下一条反馈' : '录制复现（仅本地，最长 60 秒）'}
            >
              {recording ? `停止 ${recordSeconds}s` : '录制'}
            </Button>
          )}
          {pendingVideo && (
            <span className="flex items-center gap-1 rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[10.5px] text-[#F97316]">
              录屏待附加
              <button
                type="button"
                aria-label="丢弃录屏"
                onClick={() => setPendingVideo(null)}
                className="rounded-full hover:bg-[#F97316]/20"
              >
                <X size={10} />
              </button>
            </span>
          )}
          {(regionBusy || captureBusy) && (
            <span className="flex items-center gap-1 text-[10.5px] text-muted" role="status" aria-live="polite">
              <Loader2 size={11} className="animate-spin" /> {regionBusy ? '截取区域' : '截图'}
            </span>
          )}
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="secondary"
            icon={<Download size={13} />}
            onClick={() => void exportAll()}
            tooltip="导出 .tfb 包（zip 容器，改扩展名即可解压查看）"
          >
            导出
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={exit}>
            退出
          </Button>
        </div>
      </div>

      {/* 复验操作条 */}
      {verify && verifyEntry && (
        <div
          {...{ [UI_ATTR]: '' }}
          className="pointer-events-auto fixed bottom-4 left-1/2 z-[130] w-[min(560px,calc(100vw-16px))] -translate-x-1/2 rounded-xl border border-border bg-surface p-2.5 shadow-lg"
        >
          <div className="flex items-center gap-2">
            <span className="rounded bg-[#F97316]/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#F97316]">
              复验 {verify.index + 1}/{verify.queue.length}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-text" data-tip={verifyEntry.item.text}>
              {verifyEntry.item.text}
            </span>
            <IconButton label="退出复验" size="sm" onClick={() => setVerify(null)}>
              <X size={13} />
            </IconButton>
          </div>
          {verifyLive && !verifyLive.found && !verifyLive.region && (
            <p className="mt-1 text-[10px] text-red-500">
              当前页面没有找到对应元素，已按记录的位置高亮；可能已被修复或移走。
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Input
              size="sm"
              value={verify.note}
              onChange={(e) => setVerify({ ...verify, note: e.target.value })}
              placeholder="复验备注（可选，例如仍复现的细节）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) advanceVerify('pass')
              }}
            />
            <Button size="sm" variant="primary" onClick={() => advanceVerify('pass')}>
              通过
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => advanceVerify('fail')}>
              仍有问题
            </Button>
            <Button size="sm" variant="ghost" onClick={() => advanceVerify('skip')}>
              跳过
            </Button>
          </div>
        </div>
      )}

      {editor && (
        <FeedbackEditor
          key={editor.mode + (editor.itemId ?? '')}
          editor={editor}
          saving={saving}
          onSave={
            editor.mode === 'new'
              ? (text, type, priority, references, annotated) =>
                  void saveNew(text, type, priority, references, annotated)
              : saveEdit
          }
          onCancel={() => !saving && setEditor(null)}
          onDelete={editor.mode === 'edit' ? deleteCurrent : undefined}
          onAnnotate={annotateEditorShot}
          onReferencesChange={(references) =>
            setEditor((current) => (current ? { ...current, references } : current))
          }
          onTagChange={(featureId, causeId) =>
            setEditor((current) =>
              current
                ? {
                    ...current,
                    featureId,
                    featureName: featureId
                      ? FEEDBACK_FEATURE_OPTIONS.find((feature) => feature.id === featureId)?.title ??
                        featureId
                      : undefined,
                    causeId,
                    causeTitle: causeId
                      ? FEEDBACK_CAUSE_RULES.find((rule) => rule.id === causeId)?.title
                      : undefined,
                    causeEdited: true,
                  }
                : current,
            )
          }
        />
      )}

      <FeedbackDrawer
        open={drawerOpen}
        items={items}
        receipt={receipt}
        prefs={prefs}
        onPrefsChange={setPrefs}
        onClose={() => setDrawerOpen(false)}
        onEdit={openEditorForItem}
        onDelete={(id) => {
          useFeedbackStore.getState().removeItem(id)
          useUiStore.getState().toast('已删除反馈', 'info')
        }}
        onMove={(from, to) => useFeedbackStore.getState().moveItem(from, to)}
        onHighlight={highlightItem}
        onAnnotate={annotateItem}
        onImportReceipt={importReceipt}
        onClearReceipt={() => {
          useFeedbackStore.getState().clearReceipt()
          useUiStore.getState().toast('已移除回执', 'info')
        }}
        onVerify={startVerify}
        onExportVerification={() => void exportVerification()}
        draft={draft}
        desktopDraft={!!desktopFeedback()}
        onDeleteDraft={clearDraft}
      />

      {annotator && (
        <FeedbackAnnotator
          image={annotator.image}
          onCancel={() => setAnnotator(null)}
          onSave={(dataURL) => {
            if (annotator.itemId) {
              const store = useFeedbackStore.getState()
              const item = store.items.find((entry) => entry.id === annotator.itemId)
              if (item) store.upsertItem({ ...item, annotatedScreenshot: dataURL })
              useUiStore.getState().toast('标注已保存', 'success')
            } else {
              setEditor((current) => (current ? { ...current, annotatedShot: dataURL } : current))
            }
            setAnnotator(null)
          }}
        />
      )}
    </>,
    document.body,
  )
}
