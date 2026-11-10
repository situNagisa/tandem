import { useEffect, type MutableRefObject } from 'react'
import type { SessionTarget } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { isTargetFocused } from '../session/SessionScope'
import type { VoiceButtonHandle } from '../voice/VoiceButton'

interface Options {
  disabled: boolean
  scopeTarget: SessionTarget | undefined
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  voiceRef: MutableRefObject<VoiceButtonHandle | null>
}

export function useComposerVoiceShortcut({
  disabled,
  scopeTarget,
  textareaRef,
  voiceRef,
}: Options) {
  // 桌面快捷键：按住 Ctrl+Shift+Space 说话，松开转写。
  useEffect(() => {
    const onVoiceKeyDown = (e: KeyboardEvent) => {
      if (!isTargetFocused(scopeTarget ?? null)) return
      if (!e.ctrlKey || !e.shiftKey || e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      const editable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (editable && target !== textareaRef.current) return
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen) return
      if (disabled) return
      e.preventDefault()
      voiceRef.current?.startHold()
    }
    const onVoiceKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') voiceRef.current?.stopHold()
    }
    window.addEventListener('keydown', onVoiceKeyDown)
    window.addEventListener('keyup', onVoiceKeyUp)
    return () => {
      window.removeEventListener('keydown', onVoiceKeyDown)
      window.removeEventListener('keyup', onVoiceKeyUp)
    }
  }, [disabled, scopeTarget])
}
