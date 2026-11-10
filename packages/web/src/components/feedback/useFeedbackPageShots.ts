import { useRef, type Dispatch, type SetStateAction } from 'react'
import { capturePageShot } from '../../lib/feedbackCapture'
import { newFeedbackId, type FeedbackPageShot } from '../../lib/feedback'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import type { EditorState } from './feedbackModeHelpers'

export function useFeedbackPageShots(
  setEditor: Dispatch<SetStateAction<EditorState | null>>,
) {
  const pageShotTasksRef = useRef(new Map<string, Promise<FeedbackPageShot | null>>())

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

  return { startPageShot, attachPageShot, pageShotTasksRef }
}
