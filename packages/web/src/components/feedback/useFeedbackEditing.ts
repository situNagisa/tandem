import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { captureElementShot, cssSelectorFor, reactComponentName, visibleTextSnippet } from '../../lib/feedbackCapture'
import { feedbackPlatform } from '../../lib/mobilePreview'
import {
  newFeedbackId,
  type FeedbackItem,
  type FeedbackPageShot,
  type FeedbackPriority,
  type FeedbackRect,
  type FeedbackReference,
  type FeedbackType,
  type FeedbackVideo,
} from '../../lib/feedback'
import { getFeedbackTrace } from '../../lib/feedbackTrace'
import { captureFeedbackSnapshot } from '../../lib/feedbackSnapshot'
import { FEEDBACK_FEATURE_OPTIONS, inferFeedbackTag } from '../../lib/feedbackFeatures'
import { useAppStore } from '../../store/useAppStore'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useUiStore } from '../../store/useUiStore'
import { safeQuery, viewportRectFor, type EditorState } from './feedbackModeHelpers'
import type { SnapshotPrefs } from './FeedbackDrawer'

interface EditingOptions {
  editorRef: MutableRefObject<EditorState | null>
  saving: boolean
  setSaving: Dispatch<SetStateAction<boolean>>
  setEditor: Dispatch<SetStateAction<EditorState | null>>
  setDrawerOpen: Dispatch<SetStateAction<boolean>>
  setAnnotator: Dispatch<SetStateAction<{ image: string; itemId?: string } | null>>
  focusTimerRef: MutableRefObject<number | null>
  setFocusRect: Dispatch<SetStateAction<FeedbackRect | null>>
  setTick: Dispatch<SetStateAction<number>>
  pendingVideo: FeedbackVideo | null
  setPendingVideo: Dispatch<SetStateAction<FeedbackVideo | null>>
  prefsRef: MutableRefObject<SnapshotPrefs>
  pageShotTasksRef: MutableRefObject<Map<string, Promise<FeedbackPageShot | null>>>
  startPageShot: (route: string) => Promise<FeedbackPageShot | null>
}

export function useFeedbackEditing({
  editorRef,
  saving,
  setSaving,
  setEditor,
  setDrawerOpen,
  setAnnotator,
  focusTimerRef,
  setFocusRect,
  setTick,
  pendingVideo,
  setPendingVideo,
  prefsRef,
  pageShotTasksRef,
  startPageShot,
}: EditingOptions) {
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

  return {
    openEditorForItem,
    saveNew,
    saveEdit,
    deleteCurrent,
    highlightItem,
    annotateItem,
    annotateEditorShot,
  }
}
