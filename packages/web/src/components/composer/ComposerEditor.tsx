import type {
  ClipboardEvent as ReactClipboardEvent,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  SetStateAction,
} from 'react'
import { MarkdownHighlight } from './MarkdownHighlight'

interface ComposerEditorProps {
  text: string
  composing: boolean
  disabled: boolean
  placeholder: string | undefined
  running: boolean
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  highlightRef: MutableRefObject<HTMLDivElement | null>
  composingRef: MutableRefObject<boolean>
  setComposing: Dispatch<SetStateAction<boolean>>
  setCompletion: Dispatch<SetStateAction<import('./completion').Completion | null>>
  onChange: (value: string, caret: number) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void
}

export function ComposerEditor({
  text,
  composing,
  disabled,
  placeholder,
  running,
  textareaRef,
  highlightRef,
  composingRef,
  setComposing,
  setCompletion,
  onChange,
  onKeyDown,
  onPaste,
}: ComposerEditorProps) {
  return (
    <div className="composer-editor" data-composing={composing || undefined}>
      <div
        ref={highlightRef}
        className="composer-highlight"
        data-testid="composer-highlight"
        aria-hidden="true"
      >
        <MarkdownHighlight text={text} />
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) =>
          onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={(e) => {
          const layer = highlightRef.current
          if (!layer) return
          layer.scrollTop = e.currentTarget.scrollTop
          layer.scrollLeft = e.currentTarget.scrollLeft
        }}
        onBlur={() => setCompletion(null)}
        onCompositionStart={() => {
          composingRef.current = true
          setComposing(true)
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          setComposing(false)
        }}
        rows={1}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={disabled}
        aria-label="消息输入框"
        placeholder={
          placeholder ??
          (running ? '运行中，可继续输入，消息会排队发送…' : '给 Tandem 发消息…')
        }
        className="composer-textarea max-sm:min-h-11"
      />
    </div>
  )
}
