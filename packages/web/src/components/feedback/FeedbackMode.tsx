import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  loadFeedbackSnapshotPrefs,
  saveFeedbackSnapshotPrefs,
  type AdjustSnapshot,
  type FeedbackItem,
  type FeedbackRect,
  type FeedbackVideo,
} from '../../lib/feedback'
import {
  desktopFeedback,
  draftExpired,
  flushDraftNow,
} from '../../lib/feedbackDrafts'
import { FEEDBACK_CAUSE_RULES } from '../../lib/feedbackCauses'
import { FEEDBACK_FEATURE_OPTIONS, inferFeedbackTag } from '../../lib/feedbackFeatures'
import { feedbackPlatform } from '../../lib/mobilePreview'
import { useAppStore } from '../../store/useAppStore'
import { rectFor } from '../../lib/feedbackCapture'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useUiStore } from '../../store/useUiStore'
import { FeedbackAdjust, type AdjustPayload } from './FeedbackAdjust'
import { FeedbackAnnotator } from './FeedbackAnnotator'
import { FeedbackDrawer, type SnapshotPrefs } from './FeedbackDrawer'
import { FeedbackEditor } from './FeedbackEditor'
import { FeedbackOverlay } from './FeedbackOverlay'
import {
  UI_ATTR,
  clamp,
  freezeHoverState,
  safeQuery,
  viewportRectFor,
  type EditorState,
  type FeedbackTool,
  type VerifyState,
} from './feedbackModeHelpers'
import { summarizeAdjust } from './feedbackAdjust'
import { useFeedbackCapture } from './useFeedbackCapture'
import { useFeedbackEditing } from './useFeedbackEditing'
import { useFeedbackExport } from './useFeedbackExport'
import { useFeedbackPageShots } from './useFeedbackPageShots'
import { useFeedbackRecording } from './useFeedbackRecording'

/** 提示只在本页生命周期内出现一次，切回反馈模式不重复。 */
let restoreNoticeShown = false

export function FeedbackMode() {
  const active = useFeedbackStore((s) => s.active)
  const items = useFeedbackStore((s) => s.items)
  const receipt = useFeedbackStore((s) => s.receipt)
  const pendingFeature = useFeedbackStore((s) => s.pendingFeature)
  const draft = useFeedbackStore((s) => s.draft)
  const exit = useFeedbackStore((s) => s.exit)
  const [selectMode, setSelectMode] = useState<FeedbackTool>('element')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [tick, setTick] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [annotator, setAnnotator] = useState<{ image: string; itemId?: string } | null>(null)
  const [focusRect, setFocusRect] = useState<FeedbackRect | null>(null)
  const [prefs, setPrefs] = useState<SnapshotPrefs>(loadFeedbackSnapshotPrefs)
  const [verify, setVerify] = useState<VerifyState | null>(null)
  const [pendingVideo, setPendingVideo] = useState<FeedbackVideo | null>(null)
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
  const focusTimerRef = useRef<number | null>(null)
  const adjustEscapeRef = useRef<(() => boolean) | null>(null)
  const adjustSessionRef = useRef<{ id: string } | null>(null)

  const { startPageShot, attachPageShot, pageShotTasksRef } = useFeedbackPageShots(setEditor)
  const { layerRef, hover, regionBox, regionBusy, captureBusy } = useFeedbackCapture({
    active,
    editorRef,
    selectModeRef,
    setEditor,
    attachPageShot,
  })
  const {
    openEditorForItem,
    saveNew,
    saveEdit,
    deleteCurrent,
    highlightItem,
    annotateItem,
    annotateEditorShot,
  } = useFeedbackEditing({
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
  })
  const {
    exportAll,
    clearDraft,
    importReceipt,
    startVerify,
    advanceVerify,
    exportVerification,
  } = useFeedbackExport({
    items,
    verifyRef,
    setVerify,
    setDrawerOpen,
    setEditor,
  })
  const { canRecord, recording, recordSeconds, startRecording, stopRecording } =
    useFeedbackRecording(active, setPendingVideo)

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
      setEditor(null)
      setSaving(false)
      setDrawerOpen(false)
      setAnnotator(null)
      setVerify(null)
      setFocusRect(null)
      setPendingVideo(null)
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
      if (selectModeRef.current === 'adjust') {
        const handled = adjustEscapeRef.current?.()
        if (!handled) setSelectMode('element')
        return
      }
      exit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, exit])

  // 进入调整：输入浮窗、抽屉与标注层都先收起，冻结副本不应被反馈自身的弹层挡住。
  useEffect(() => {
    if (selectMode !== 'adjust') {
      adjustSessionRef.current = null
      return
    }
    setEditor(null)
    setDrawerOpen(false)
    setAnnotator(null)
    setFocusRect(null)
    setVerify(null)
  }, [selectMode])

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
      if (selectModeRef.current === 'adjust') {
        // 调整工具自己处理 Delete / 方向键 / Ctrl+Z；其余按键仍拦下，避免应用响应。
        const allowed =
          e.key === 'Delete' ||
          e.key === 'Backspace' ||
          e.key.startsWith('Arrow') ||
          (mod && e.key.toLowerCase() === 'z')
        if (allowed) return
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
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
    }
  }, [])

  /** 调整条目：改动清单 + 前后截图进普通反馈条目，随 .tfb 导出。 */
  const buildAdjustItem = (
    payload: AdjustPayload,
    afterImage: string | null,
  ): FeedbackItem => {
    const snapshot: AdjustSnapshot = payload.snapshot
    const first = snapshot.changes[0]
    const itemId = `fb-${payload.id}`
    const existing = useFeedbackStore.getState().items.find((item) => item.id === itemId)
    const pending = useFeedbackStore.getState().pendingFeature
    const inferred = inferFeedbackTag({
      route: snapshot.route,
      component: first?.target.component,
      selector: first?.target.selector,
      text: snapshot.title,
      textSnippet: first?.target.textSnippet,
    })
    const featureId = pending?.featureId ?? inferred?.featureId
    const featureName =
      pending?.featureName ??
      (featureId
        ? FEEDBACK_FEATURE_OPTIONS.find((feature) => feature.id === featureId)?.title ?? featureId
        : undefined)
    const causeId = inferred?.causeId
    const causeTitle = inferred?.causeTitle
    const app = useAppStore.getState()
    const hostId = app.active?.hostId ?? app.activeHostId ?? undefined
    const hostInfo = hostId ? app.runtimes[hostId]?.info : undefined
    return {
      id: itemId,
      type: 'suggestion',
      text: `调整：${snapshot.title}`,
      mode: 'adjust',
      priority: 'P1',
      selector: first?.target.selector ?? '',
      component: first?.target.component,
      textSnippet: first?.target.textSnippet ?? snapshot.title,
      route: snapshot.route,
      rect: first?.target.rect ?? { x: 0, y: 0, width: 0, height: 0, pageX: 0, pageY: 0 },
      viewport: { width: snapshot.viewport.width, height: snapshot.viewport.height },
      dpr: snapshot.viewport.dpr,
      theme: snapshot.theme,
      platform: feedbackPlatform(),
      ua: navigator.userAgent,
      hostId,
      hostName: hostInfo?.name,
      hostPlatform: hostInfo?.platform,
      hostVersion: hostInfo?.version,
      sessionId: app.active?.sessionId,
      createdAt: existing?.createdAt ?? snapshot.createdAt,
      screenshot: payload.beforeImage ?? existing?.screenshot ?? undefined,
      screenshotKind: 'viewport',
      afterImage: afterImage ?? existing?.afterImage ?? undefined,
      adjust: summarizeAdjust(snapshot),
      adjustSnapshot: snapshot,
      ...(featureId ? { featureId, featureName: featureName ?? featureId } : {}),
      ...(causeId ? { causeId, causeTitle } : {}),
    }
  }

  const handleAdjustProgress = (payload: AdjustPayload) => {
    adjustSessionRef.current = { id: payload.id }
    useFeedbackStore.getState().upsertItem(buildAdjustItem(payload, null))
  }

  const handleAdjustFinish = (payload: AdjustPayload) => {
    adjustSessionRef.current = null
    useFeedbackStore.getState().upsertItem(buildAdjustItem(payload, payload.afterImage))
    setSelectMode('element')
    setDrawerOpen(true)
    useUiStore
      .getState()
      .toast(`已生成调整条目（${payload.snapshot.changes.length} 项），可在条目里改文字后导出`, 'success')
  }

  const handleAdjustClose = () => {
    const changes = adjustSessionRef.current
      ? useFeedbackStore.getState().items.find((item) => item.id === `fb-${adjustSessionRef.current!.id}`)
          ?.adjust?.changeCount ?? 0
      : 0
    adjustSessionRef.current = null
    setSelectMode('element')
    if (changes > 0) {
      useUiStore.getState().toast(`已保留 ${changes} 项调整（未导出）`, 'info')
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
      <FeedbackOverlay
        layerRef={layerRef}
        items={items}
        pendingFeature={pendingFeature}
        selectMode={selectMode}
        onSelectModeChange={setSelectMode}
        editor={editor}
        selected={selected}
        hover={hover}
        regionBox={regionBox}
        focusRect={focusRect}
        verifyLive={verifyLive}
        badges={badges}
        verify={verify}
        verifyEntry={verifyEntry}
        onVerifyNote={(note) => setVerify((current) => (current ? { ...current, note } : current))}
        onAdvanceVerify={advanceVerify}
        onCancelVerify={() => setVerify(null)}
        onOpenItem={openEditorForItem}
        onClearFeature={() => useFeedbackStore.getState().setPendingFeature(null)}
        canRecord={canRecord}
        recording={recording}
        recordSeconds={recordSeconds}
        onToggleRecord={() => (recording ? stopRecording() : void startRecording())}
        pendingVideo={pendingVideo}
        onDiscardVideo={() => setPendingVideo(null)}
        regionBusy={regionBusy}
        captureBusy={captureBusy}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onExport={() => void exportAll()}
        onExit={exit}
      />

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

      {selectMode === 'adjust' && (
        <FeedbackAdjust
          onClose={handleAdjustClose}
          onProgress={handleAdjustProgress}
          onFinish={handleAdjustFinish}
          onNotify={(message, tone) => useUiStore.getState().toast(message, tone)}
          escapeRef={adjustEscapeRef}
        />
      )}

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
