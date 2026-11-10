import { flushSync } from 'react-dom'
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react'
import type { ContentBlock, PermissionRequest, SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { usePreviewStore } from '../../store/usePreviewStore'
import { recordModelUse } from '../../lib/recentModels'
import { loadSentHistory, pushSentHistory, saveDraft } from '../../lib/storage'
import { handleMarkdownEnter, handleMarkdownTab } from './markdownInput'
import { detectCompletion, type Completion, type CompletionEntry } from './completion'
import type { Attachment, PastedText } from './composerTypes'

import type { SessionTarget } from '../../lib/types'

type StoreState = ReturnType<typeof useAppStore.getState>

interface Options {
  text: string
  setText: (text: string) => void
  textRef: MutableRefObject<string>
  composingRef: MutableRefObject<boolean>
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  draftKey: string
  sessionId: string | null
  isMobile: boolean
  canSend: boolean
  outgoingText: string
  selectionContext: string
  attachments: Attachment[]
  setPasted: Dispatch<SetStateAction<PastedText[]>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setCompletion: Dispatch<SetStateAction<Completion | null>>
  setIndex: Dispatch<SetStateAction<number>>
  completion: Completion | null
  items: CompletionEntry[]
  index: number
  selectItem: (item: CompletionEntry) => void
  cycleMode: () => void
  running: boolean
  stopping: boolean
  autoRoute: boolean
  currentProfileId: string
  currentGroupId: string | undefined
  currentModel: string
  summary: SessionSummary | null
  activeHostId: string | null
  scopeTarget: SessionTarget | undefined
  hostStatus: string
  pendingRequests: PermissionRequest[]
  routeOverride: import('@tandem/protocol').TurnRouteMode | undefined
  setRouteOverride: (mode: import('@tandem/protocol').TurnRouteMode | undefined) => void
  onSubmit?: (content: ContentBlock[]) => unknown | Promise<unknown>
  onStop?: () => void
  interrupt: StoreState['interrupt']
  ensureWorktree: StoreState['ensureWorktree']
  send: StoreState['send']
  worktreeBusyRef: MutableRefObject<boolean>
  openScheduleComposer: () => void
  openMemoryEditor: (target: { scope: 'project'; project: string }) => void
  toast: (text: string, kind?: 'info' | 'success' | 'error') => void
  clearSelections: (sessionId: string) => void
}

export function useComposerSend({
  text,
  setText,
  textRef,
  composingRef,
  textareaRef,
  draftKey,
  sessionId,
  isMobile,
  canSend,
  outgoingText,
  selectionContext,
  attachments,
  setPasted,
  setAttachments,
  setCompletion,
  setIndex,
  completion,
  items,
  index,
  selectItem,
  cycleMode,
  running,
  stopping,
  autoRoute,
  currentProfileId,
  currentGroupId,
  currentModel,
  summary,
  activeHostId,
  scopeTarget,
  hostStatus,
  pendingRequests,
  routeOverride,
  setRouteOverride,
  onSubmit,
  onStop,
  interrupt,
  ensureWorktree,
  send,
  worktreeBusyRef,
  openScheduleComposer,
  openMemoryEditor,
  toast,
  clearSelections,
}: Options) {
  const resetInput = () => {
    setText('')
    setPasted([])
    setAttachments([])
    setCompletion(null)
    if (sessionId) usePreviewStore.getState().clearSelections(sessionId)
    saveDraft(draftKey, '')
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = '28px'
      if (!isMobile) el.focus()
    })
  }

  const rememberSent = (value: string) => {
    if (!value) return
    pushSentHistory(draftKey, value)
  }

  const handleSend = async () => {
    if (!canSend) return
    // 记录常用模型（跨账号分组排序；自动路由下实际模型由路由决定，不记这里）。
    if (!autoRoute && currentProfileId && currentModel) {
      recordModelUse({
        profileId: currentProfileId,
        ...(currentGroupId ? { groupId: currentGroupId } : {}),
        model: currentModel,
      })
    }
    // /schedule 只打开创建界面，不作为消息发送
    if (!attachments.length && outgoingText.trim() === '/schedule') {
      openScheduleComposer()
      resetInput()
      return
    }
    // /memory 直接打开当前项目的记忆编辑器
    if (!attachments.length && outgoingText.trim() === '/memory') {
      if (summary?.cwd) openMemoryEditor({ scope: 'project', project: summary.cwd })
      else toast('当前会话没有项目目录', 'info')
      resetInput()
      return
    }
    const blocks: ContentBlock[] = []
    const messageText = [outgoingText, selectionContext].filter(Boolean).join('\n\n')
    if (messageText) blocks.push({ type: 'text', text: messageText })
    for (const a of attachments) {
      blocks.push({ type: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64 })
    }
    if (onSubmit) {
      let result: unknown
      try {
        result = await onSubmit(blocks)
      } catch {
        return
      }
      if (result === false) return
      rememberSent(outgoingText)
      resetInput()
      return
    }
    if (!summary) return
    if (hostStatus !== 'online') {
      toast('主机未连接，消息未发送', 'error')
      return
    }
    // worktree 开关只记录意图：真正发送前才创建隔离分支（创建后 cwd 已切换）。
    if (activeHostId) {
      if (worktreeBusyRef.current) return
      worktreeBusyRef.current = true
      const ready = await ensureWorktree(activeHostId, summary.id)
      worktreeBusyRef.current = false
      if (!ready) return
    }
    // 反馈14#07：有待审批时发送消息 = 拒绝并附说明（输入框保持可用，不打断写作）。
    if (pendingRequests.length > 0) {
      const decide = useAppStore.getState().decidePermission
      for (const request of pendingRequests) {
        decide(request.id, 'deny', outgoingText || undefined, scopeTarget)
      }
    }
    if (!send(blocks, scopeTarget, routeOverride)) return
    setRouteOverride(undefined)
    rememberSent(outgoingText)
    resetInput()
  }

  const stop = () => {
    if (stopping) return
    if (onStop) onStop()
    else interrupt(scopeTarget)
  }

  const applyTextEdit = (edit: { text: string; caret: number }) => {
    textRef.current = edit.text
    // 同步提交，避免下一次按键前 React 还没把受控值写回 DOM（光标会跳到末尾）。
    flushSync(() => setText(edit.text))
    setCompletion(null)
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(edit.caret, edit.caret)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229
    if (
      !composing &&
      completion &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')
    ) {
      setCompletion(null)
    }
    if (completion) {
      if (composing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setCompletion(null)
        return
      }
      if (items.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setIndex((i) => Math.min(items.length - 1, i + 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setIndex((i) => Math.max(0, i - 1))
          return
        }
        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
          if (composing) return
          e.preventDefault()
          const item = items[index]
          if (item) selectItem(item)
          return
        }
      }
    }
    // 代码块内 Tab 缩进；其他位置不拦截，保留 Shift+Tab 离开输入框。
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !composing) {
      const el = textareaRef.current
      if (el && el.selectionStart === el.selectionEnd) {
        const edit = handleMarkdownTab(textRef.current, el.selectionStart)
        if (edit) {
          e.preventDefault()
          applyTextEdit(edit)
          return
        }
      }
    }
    if (e.key === 'Escape') {
      if (composing) return
      if (running) {
        e.preventDefault()
        e.stopPropagation()
        stop()
      }
      return
    }
    if (
      e.key === 'ArrowUp' &&
      !composing &&
      !completion &&
      text.length === 0 &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const el = textareaRef.current
      if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
        const last = loadSentHistory(draftKey)[0]
        if (last) {
          e.preventDefault()
          setText(last)
          window.requestAnimationFrame(() => {
            const box = textareaRef.current
            if (!box) return
            box.setSelectionRange(last.length, last.length)
          })
        }
      }
      return
    }
    if (e.key === 'Enter') {
      if (composing) return
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        void handleSend()
        return
      }
      // Markdown：代码块内换行、列表续项；其余位置保持 Enter 发送。
      const el = textareaRef.current
      if (!e.shiftKey && el && el.selectionStart === el.selectionEnd) {
        const edit = handleMarkdownEnter(textRef.current, el.selectionStart)
        if (edit) {
          e.preventDefault()
          applyTextEdit(edit)
          return
        }
      }
      if (isMobile || e.shiftKey) return
      e.preventDefault()
      void handleSend()
      return
    }
    // 不劫持 Shift+Tab：反向 Tab 必须能离开输入框（键盘可达性）。
    // 权限模式切换改用 Alt+Shift+Tab，仍保留单手键盘操作。
    if (e.key === 'Tab' && e.shiftKey && e.altKey) {
      if (composing) return
      e.preventDefault()
      cycleMode()
    }
  }

  const onChange = (value: string, caret: number) => {
    textRef.current = value
    setText(value)
    setCompletion(detectCompletion(value, caret))
  }

  // 语音转写结果插入光标处，不自动发送。
  const insertVoiceText = (spoken: string) => {
    const node = textareaRef.current
    const value = textRef.current
    const start = node?.selectionStart ?? value.length
    const end = node?.selectionEnd ?? value.length
    const before = value.slice(0, start)
    const after = value.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const insert = `${prefix}${spoken}${suffix}`
    const caret = start + insert.length
    onChange(before + insert + after, caret)
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  return {
    resetInput,
    handleSend,
    stop,
    applyTextEdit,
    onKeyDown,
    onChange,
    insertVoiceText,
  }
}
