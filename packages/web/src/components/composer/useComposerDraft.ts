import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { SessionTarget } from '../../lib/types'
import { usePreviewStore } from '../../store/usePreviewStore'
import { loadDraft, saveDraft } from '../../lib/storage'
import { isTargetFocused } from '../session/SessionScope'
import type { Completion } from './completion'
import type { Attachment, PastedText } from './composerTypes'

interface Options {
  draftKey: string
  text: string
  setText: (text: string) => void
  textRef: MutableRefObject<string>
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  prevSessionRef: MutableRefObject<string | null>
  setPasted: Dispatch<SetStateAction<PastedText[]>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setCompletion: Dispatch<SetStateAction<Completion | null>>
  sessionId: string | null
  composerResetNonce: number
  seed: { text: string } | null
  clearPromptSeed: () => void
  scopeTarget: SessionTarget | undefined
  disabled: boolean
  autoFocus: boolean
  isMobile: boolean
  sessionless: boolean
}

export function useComposerDraft({
  draftKey,
  text,
  setText,
  textRef,
  textareaRef,
  prevSessionRef,
  setPasted,
  setAttachments,
  setCompletion,
  sessionId,
  composerResetNonce,
  seed,
  clearPromptSeed,
  scopeTarget,
  disabled,
  autoFocus,
  isMobile,
  sessionless,
}: Options) {

  // 切换会话时保存上一条草稿，并恢复目标会话的草稿
  useEffect(() => {
    if (prevSessionRef.current === draftKey) return
    if (prevSessionRef.current) saveDraft(prevSessionRef.current, textRef.current)
    prevSessionRef.current = draftKey
    setText(loadDraft(draftKey))
    setPasted([])
    setAttachments([])
    setCompletion(null)
  }, [draftKey])

  // 输入过程中防抖保存草稿
  useEffect(() => {
    const timer = window.setTimeout(() => saveDraft(draftKey, text), 180)
    return () => window.clearTimeout(timer)
  }, [draftKey, text])

  useEffect(
    () => () => {
      saveDraft(prevSessionRef.current ?? '', textRef.current)
    },
    [],
  )

  useEffect(() => {
    if (disabled) return
    // 会话模式沿用自动聚焦；无会话页只在 autoFocus 时聚焦。
    if (!autoFocus && (isMobile || sessionless)) return
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [sessionId, isMobile, autoFocus, sessionless, disabled])

  useEffect(() => {
    if (!seed || !isTargetFocused(scopeTarget ?? null)) return
    setText(seed.text)
    clearPromptSeed()
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.text.length, seed.text.length)
    })
  }, [seed, clearPromptSeed, scopeTarget])

  useEffect(() => {
    if (!composerResetNonce) return
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
      el.focus()
    })
    // 只响应“新会话”按钮的显式重置，不随草稿 key 变化重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerResetNonce])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.max(120, Math.round(window.innerHeight * 0.4))
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), max)}px`
  }, [text])
}
