import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2, Trash2, X } from 'lucide-react'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import {
  feedbackFilename,
  feedbackTypeLabel,
  newFeedbackId,
  saveFeedbackFile,
  type FeedbackItem,
  type FeedbackPageShot,
  type FeedbackRect,
  type FeedbackType,
} from '../../lib/feedback'
import {
  captureElementShot,
  capturePageShot,
  cssSelectorFor,
  reactComponentName,
  rectFor,
  visibleTextSnippet,
} from '../../lib/feedbackCapture'
import { getFeedbackErrors } from '../../lib/feedbackErrors'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/Controls'

const TYPE_OPTIONS: ReadonlyArray<{ value: FeedbackType; label: string }> = [
  { value: 'issue', label: '问题' },
  { value: 'suggestion', label: '建议' },
  { value: 'praise', label: '好评' },
]

const APP_VERSION = '0.1.0'

const UI_ATTR = 'data-feedback-ui'
const HOVER_ATTR = 'data-feedback-hover'

interface EditorState {
  mode: 'new' | 'edit'
  itemId?: string
  element: Element | null
  rect: FeedbackRect
  type: FeedbackType
  text: string
  /** 选中瞬间、输入浮窗出现前完成的截图。 */
  elementShot?: string | null
  pageShot?: FeedbackPageShot | null
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
  for (const element of document.elementsFromPoint(x, y)) {
    if (isUiTarget(element)) continue
    if (element === document.documentElement) continue
    // 点在图标的 path/文字上时落到最近的可交互控件，截图才是整个按钮。
    return (
      element.closest(
        'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
      ) ?? element
    )
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

function elementLabel(element: Element | null): string {
  if (!element) return ''
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
  const element = (() => {
    try {
      return document.querySelector(item.selector)
    } catch {
      return null
    }
  })()
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

function FeedbackEditor({
  editor,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  editor: EditorState
  saving: boolean
  onSave: (text: string, type: FeedbackType) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [text, setText] = useState(editor.text)
  const [type, setType] = useState<FeedbackType>(editor.type)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

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
  }, [editor, text, type, saving])

  const submit = () => {
    if (!text.trim() || saving) return
    onSave(text.trim(), type)
  }

  return createPortal(
    <>
      <div
        {...{ [UI_ATTR]: '' }}
        className="pointer-events-none fixed inset-0 z-[119] bg-black/[0.03]"
      />
      <div
        {...{ [UI_ATTR]: '' }}
        className="fixed z-[140] w-[min(360px,calc(100vw-16px))] rounded-xl border border-border bg-surface p-2.5 shadow-lg"
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        ref={panelRef}
        role="dialog"
        aria-label="反馈输入"
      >
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            options={TYPE_OPTIONS}
            value={type}
            onChange={setType}
            aria-label="反馈类型"
          />
          <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted">
            {editor.mode === 'new' ? elementLabel(editor.element) : '编辑反馈'}
          </span>
        </div>
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
          placeholder="描述问题或建议…"
          className="mt-2 w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-5 text-text outline-none placeholder:text-muted"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
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
          Enter 保存 · Shift + Enter 换行 · Esc 取消
        </p>
      </div>
    </>,
    document.body,
  )
}

export function FeedbackMode() {
  const active = useFeedbackStore((s) => s.active)
  const items = useFeedbackStore((s) => s.items)
  const exit = useFeedbackStore((s) => s.exit)
  const [hover, setHover] = useState<{ rect: FeedbackRect; label: string } | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [tick, setTick] = useState(0)
  const editorRef = useRef<EditorState | null>(null)
  editorRef.current = editor
  const lastHoverRef = useRef<{ element: Element; alt: boolean } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const capturingRef = useRef(false)

  // 进入/退出反馈模式：冻结 hover、页面光标。热键在 main.tsx 中最早注册。
  useEffect(() => {
    if (!active) {
      document.documentElement.classList.remove('feedback-mode')
      setHover(null)
      setEditor(null)
      setSaving(false)
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
      e.preventDefault()
      e.stopPropagation()
      exit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, exit])

  // 滚动/缩放后重新定位徽标。
  useEffect(() => {
    if (!active) return
    const bump = () => setTick((value) => value + 1)
    window.addEventListener('scroll', bump, true)
    window.addEventListener('resize', bump)
    return () => {
      window.removeEventListener('scroll', bump, true)
      window.removeEventListener('resize', bump)
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

    // 捕获层自身也带 data-feedback-ui，它不是可交互 UI，事件必须继续拦截。
    const isFeedbackUi = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest('[data-feedback-capture]') === null &&
      target.closest(`[${UI_ATTR}]`) !== null

    const hoverAt = (x: number, y: number, alt: boolean) => {
      if (editorRef.current) return
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
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) {
        down = null
        lastHoverRef.current = null
        setHover(null)
        return
      }
      hoverAt(e.clientX, e.clientY, e.altKey)
    }

    // 点击后立刻截图，截图完成才弹输入浮窗：菜单或 hover 元素不会在截图前消失。
    const openEditorFor = async (picked: Element, rect: FeedbackRect) => {
      if (capturingRef.current) return
      capturingRef.current = true
      try {
        const route = window.location.hash || '#/'
        const store = useFeedbackStore.getState()
        let pageShot = store.pageShots.find((shot) => shot.route === route) ?? null
        const [elementShot, capturedPage] = await Promise.all([
          captureElementShot(picked),
          pageShot ? Promise.resolve(null) : capturePageShot(),
        ])
        if (!useFeedbackStore.getState().active) return
        if (capturedPage) {
          const shot: FeedbackPageShot = {
            id: newFeedbackId(),
            route,
            dataURL: capturedPage.dataURL,
            width: capturedPage.width,
            height: capturedPage.height,
            createdAt: Date.now(),
          }
          store.addPageShot(shot)
          pageShot = shot
        }
        lastHoverRef.current = null
        setHover(null)
        setEditor({
          mode: 'new',
          element: picked,
          rect,
          type: 'issue',
          text: '',
          elementShot,
          pageShot,
        })
      } finally {
        capturingRef.current = false
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (isFeedbackUi(e.target)) return
      // 阻止默认行为也避免了焦点转移，radix 菜单/Popover 不会被判为外部点击而关闭。
      e.preventDefault()
      e.stopImmediatePropagation()
      down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
      lastPoint = { x: e.clientX, y: e.clientY }
      hoverAt(e.clientX, e.clientY, e.altKey)
    }

    const onPointerUp = (e: PointerEvent) => {
      if (isFeedbackUi(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const start = down
      down = null
      if (!start || start.pointerId !== e.pointerId) return
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

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    for (const type of blocked) {
      window.addEventListener(type, type === 'focusin' || type === 'focusout' ? blockFocus : blockInteraction, true)
    }
    layer.addEventListener('pointermove', onPointerMove)
    layer.addEventListener('pointercancel', onPointerCancel)
    layer.addEventListener('pointerleave', onPointerLeave)
    layer.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      for (const type of blocked) {
        window.removeEventListener(type, type === 'focusin' || type === 'focusout' ? blockFocus : blockInteraction, true)
      }
      layer.removeEventListener('pointermove', onPointerMove)
      layer.removeEventListener('pointercancel', onPointerCancel)
      layer.removeEventListener('pointerleave', onPointerLeave)
      layer.removeEventListener('wheel', onWheel)
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

  const openEditorForItem = (item: FeedbackItem) => {
    const element = (() => {
      try {
        return document.querySelector(item.selector)
      } catch {
        return null
      }
    })()
    const rect = viewportRectFor(item)
    setEditor({
      mode: 'edit',
      itemId: item.id,
      element,
      rect,
      type: item.type,
      text: item.text,
    })
  }

  const saveNew = async (text: string, type: FeedbackType) => {
    const current = editorRef.current
    if (!current || current.mode !== 'new' || !current.element || saving) return
    const element = current.element
    const rect = current.rect
    const route = window.location.hash || '#/'
    setSaving(true)
    try {
      const store = useFeedbackStore.getState()
      const pageShot = store.pageShots.find((shot) => shot.route === route)
      let pageShotData: string | null = current.pageShot?.dataURL ?? pageShot?.dataURL ?? null
      if (!pageShotData) {
        const captured = await capturePageShot()
        if (captured) {
          pageShotData = captured.dataURL
          store.addPageShot({
            id: newFeedbackId(),
            route,
            dataURL: captured.dataURL,
            width: captured.width,
            height: captured.height,
            createdAt: Date.now(),
          })
        }
      }
      // 选中时已截图；这里只在缺失（如重试）时补拍。
      const elementShot =
        current.elementShot === undefined ? await captureElementShot(element) : current.elementShot
      const app = useAppStore.getState()
      const hostId = app.active?.hostId ?? app.activeHostId ?? undefined
      const hostInfo = hostId ? app.runtimes[hostId]?.info : undefined
      const ua = navigator.userAgent
      const item: FeedbackItem = {
        id: newFeedbackId(),
        type,
        text,
        selector: cssSelectorFor(element),
        component: reactComponentName(element),
        textSnippet: visibleTextSnippet(element),
        route,
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        platform:
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ||
          navigator.platform ||
          '',
        ua,
        hostId,
        hostName: hostInfo?.name,
        hostPlatform: hostInfo?.platform,
        hostVersion: hostInfo?.version,
        sessionId: app.active?.sessionId,
        createdAt: Date.now(),
        screenshot: elementShot ?? pageShotData ?? undefined,
        screenshotKind: elementShot ? 'element' : pageShotData ? 'page' : undefined,
        screenshotPadding: elementShot ? 16 : undefined,
      }
      store.upsertItem(item)
      setEditor(null)
      useUiStore.getState().toast(`已记录第 ${useFeedbackStore.getState().items.length} 条反馈`, 'info')
    } catch {
      useUiStore.getState().toast('截图或保存失败，请重试', 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = (text: string, type: FeedbackType) => {
    const current = editorRef.current
    if (!current?.itemId) return
    const store = useFeedbackStore.getState()
    const item = store.items.find((entry) => entry.id === current.itemId)
    if (!item) return
    store.upsertItem({ ...item, text, type })
    setEditor(null)
  }

  const deleteCurrent = () => {
    const current = editorRef.current
    if (!current?.itemId) return
    useFeedbackStore.getState().removeItem(current.itemId)
    setEditor(null)
    useUiStore.getState().toast('已删除反馈', 'info')
  }

  const exportAll = async () => {
    const store = useFeedbackStore.getState()
    if (store.items.length === 0) {
      useUiStore.getState().toast('还没有记录反馈', 'info')
      return
    }
    const app = useAppStore.getState()
    const hostId = app.active?.hostId ?? app.activeHostId ?? undefined
    const hostInfo = hostId ? app.runtimes[hostId]?.info : undefined
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      app: { name: 'Tandem', version: APP_VERSION, client: 'web' },
      env: {
        route: window.location.hash || '#/',
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        platform:
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ||
          navigator.platform ||
          '',
        ua: navigator.userAgent,
        language: navigator.language,
        hostId,
        hostName: hostInfo?.name,
        hostPlatform: hostInfo?.platform,
        hostVersion: hostInfo?.version,
        sessionId: app.active?.sessionId,
      },
      items: store.items,
      pageShots: store.pageShots,
      errors: getFeedbackErrors(),
    }
    const filename = feedbackFilename()
    const result = await saveFeedbackFile(JSON.stringify(payload, null, 2), filename)
    if (result === 'failed') {
      useUiStore.getState().toast('导出失败，请重试', 'error')
      return
    }
    const message =
      result === 'download'
        ? `已导出 ${filename}`
        : result === 'share'
          ? '已通过系统分享导出'
          : '已复制到剪贴板'
    useUiStore.getState().toast(message, 'success')
    if (window.confirm('已导出反馈。是否清空已记录的条目？')) {
      useFeedbackStore.getState().clear()
    }
  }

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
        className="fixed inset-0 z-[105] touch-none select-none"
        aria-hidden
      />

      {/* 高亮框与徽标层：pointer-events:none，不改变页面元素自身样式 */}
      <div
        {...{ [UI_ATTR]: '' }}
        className="pointer-events-none fixed inset-0 z-[110]"
        aria-hidden
      >
        {hover && !editor && (
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
        {badges.map(({ item, index, left, top }) => (
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
            title={`${index + 1}. ${feedbackTypeLabel(item.type)}：${item.text}`}
            aria-label={`编辑第 ${index + 1} 条反馈`}
          >
            {index + 1}
          </button>
        ))}
      </div>

      {/* 顶部浮条 */}
      <div
        {...{ [UI_ATTR]: '' }}
        className="fixed left-1/2 top-3 z-[130] -translate-x-1/2"
      >
        <div className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-1.5 shadow-md">
          <span className="size-1.5 rounded-full bg-[#F97316]" />
          <span className="whitespace-nowrap text-[12.5px] font-medium text-text">
            反馈模式 · 已记录 {items.length} 条
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="secondary"
            icon={<Download size={13} />}
            onClick={() => void exportAll()}
          >
            导出
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={exit}>
            退出
          </Button>
        </div>
      </div>

      {editor && (
        <FeedbackEditor
          key={editor.mode + (editor.itemId ?? '')}
          editor={editor}
          saving={saving}
          onSave={editor.mode === 'new' ? (text, type) => void saveNew(text, type) : saveEdit}
          onCancel={() => !saving && setEditor(null)}
          onDelete={editor.mode === 'edit' ? deleteCurrent : undefined}
        />
      )}
    </>,
    document.body,
  )
}
