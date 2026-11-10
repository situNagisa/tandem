import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { saveFeedbackBlob, type FeedbackItem, type FeedbackReceipt } from '../../lib/feedback'
import { archiveFilePayloads, type FeedbackArchive } from '../../lib/feedbackArchive'
import {
  buildCurrentArchive,
  desktopFeedback,
  exportArchiveToDisk,
  flushDraftNow,
  markDraftExported,
  openFeedbackFolder,
  removeDesktopDraft,
} from '../../lib/feedbackDrafts'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useUiStore } from '../../store/useUiStore'
import type { EditorState, VerifyState } from './feedbackModeHelpers'

interface ExportOptions {
  items: FeedbackItem[]
  verifyRef: MutableRefObject<VerifyState | null>
  setVerify: Dispatch<SetStateAction<VerifyState | null>>
  setDrawerOpen: Dispatch<SetStateAction<boolean>>
  setEditor: Dispatch<SetStateAction<EditorState | null>>
}

export function useFeedbackExport({
  items,
  verifyRef,
  setVerify,
  setDrawerOpen,
  setEditor,
}: ExportOptions) {
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
  return {
    exportAll,
    clearDraft,
    importReceipt,
    startVerify,
    advanceVerify,
    exportVerification,
  }
}
