import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  captureElementShot,
  captureRegionShot,
  cssSelectorFor,
  reactComponentName,
  rectFor,
  visibleTextSnippet,
} from '../../lib/feedbackCapture'
import { elementsAtPoint } from '../../lib/overlay'
import { inferFeedbackTag } from '../../lib/feedbackFeatures'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useUiStore } from '../../store/useUiStore'
import type { FeedbackRect, FeedbackSelectMode } from '../../lib/feedback'
import {
  UI_ATTR,
  elementAtPoint,
  elementLabel,
  isUiTarget,
  scrollableFrom,
  type EditorState,
  type FeedbackTool,
} from './feedbackModeHelpers'

interface CaptureOptions {
  active: boolean
  editorRef: MutableRefObject<EditorState | null>
  selectModeRef: MutableRefObject<FeedbackTool>
  setEditor: Dispatch<SetStateAction<EditorState | null>>
  attachPageShot: (route: string) => void
}

export function useFeedbackCapture({
  active,
  editorRef,
  selectModeRef,
  setEditor,
  attachPageShot,
}: CaptureOptions) {
  const [hover, setHover] = useState<{ rect: FeedbackRect; label: string } | null>(null)
  const [regionBox, setRegionBox] = useState<FeedbackRect | null>(null)
  const [regionBusy, setRegionBusy] = useState(false)
  const [captureBusy, setCaptureBusy] = useState(false)
  const layerRef = useRef<HTMLDivElement>(null)
  const lastHoverRef = useRef<{ element: Element; alt: boolean } | null>(null)
  const capturingRef = useRef(false)

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
      // 调整模式由自己的命中层接管指针。
      if (selectModeRef.current === 'adjust') return
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
      if (selectModeRef.current === 'adjust') return
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
      if (selectModeRef.current === 'adjust') return
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
  // 退出反馈模式时清掉悬停/框选高亮。
  useEffect(() => {
    if (active) return
    lastHoverRef.current = null
    setHover(null)
    setRegionBox(null)
    setRegionBusy(false)
    setCaptureBusy(false)
  }, [active])

  return { layerRef, hover, regionBox, regionBusy, captureBusy }
}
