import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
} from 'react'
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  PASTE_COLLAPSE_THRESHOLD,
  imageFingerprint,
  readFileAsDataUrl,
  type Attachment,
  type PastedText,
} from './composerTypes'

interface Options {
  attachments: Attachment[]
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setPasted: Dispatch<SetStateAction<PastedText[]>>
  setDragging: Dispatch<SetStateAction<boolean>>
  toast: (text: string, kind?: 'info' | 'success' | 'error') => void
}

export function useComposerAttachments({
  attachments,
  setAttachments,
  setPasted,
  setDragging,
  toast,
}: Options) {
  const addImages = useCallback(
    async (files: File[]) => {
      const candidates = files.filter((f) => f.type.startsWith('image/'))
      if (!candidates.length) return
      const signatures = await Promise.all(candidates.map(imageFingerprint))
      const seen = new Set<string>()
      const images = candidates.filter((_, i) => {
        if (seen.has(signatures[i])) return false
        seen.add(signatures[i])
        return true
      })
      const room = MAX_ATTACHMENTS - attachments.length
      if (room <= 0) {
        toast(`最多添加 ${MAX_ATTACHMENTS} 张图片`, 'info')
        return
      }
      const picked = images.slice(0, room)
      if (images.length > room) {
        toast(`最多添加 ${MAX_ATTACHMENTS} 张图片`, 'info')
      }
      for (const file of picked) {
        if (file.size > MAX_IMAGE_BYTES) {
          toast(`图片 ${file.name || ''} 超过 10MB，已跳过`, 'error')
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const comma = dataUrl.indexOf(',')
          if (comma < 0) continue
          const attachment: Attachment = {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            mediaType: file.type || 'image/png',
            dataBase64: dataUrl.slice(comma + 1),
            name: file.name || '粘贴的图片',
          }
          setAttachments((prev) =>
            prev.length >= MAX_ATTACHMENTS ? prev : [...prev, attachment],
          )
        } catch {
          toast('读取图片失败', 'error')
        }
      }
    },
    [attachments.length, toast],
  )

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = e.clipboardData
    if (!clipboard) return
    // items 是剪贴板图片的规范来源；files 仅作兜底。两者同时遍历时，
    // 同一张图会以不同 File 实例出现，导致粘贴一次添加多张。
    const files: File[] = []
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) {
      for (const f of Array.from(clipboard.files)) {
        if (f.type.startsWith('image/')) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      void addImages(files)
      return
    }
    // 大段文本折叠成胶囊，避免把输入框撑满；发送时再展开。
    const plain = clipboard.getData('text/plain')
    if (plain.length > PASTE_COLLAPSE_THRESHOLD) {
      e.preventDefault()
      const lines = plain.split('\n').length
      setPasted((prev) => [
        ...prev,
        {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: plain,
          lines,
        },
      ])
    }
  }

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void addImages(files)
  }

  return { addImages, onPaste, onDrop }
}
