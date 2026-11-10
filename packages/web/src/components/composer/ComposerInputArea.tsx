import type {
  ClipboardEvent as ReactClipboardEvent,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  SetStateAction,
} from 'react'
import type { PreviewSelection } from '@tandem/protocol'
import { ComposerChips } from './ComposerChips'
import { ComposerEditor } from './ComposerEditor'
import type { Completion } from './completion'
import type { Attachment, PastedText } from './composerTypes'

interface ComposerInputAreaProps {
  previewSelections: PreviewSelection[]
  onRemoveSelection: (selection: PreviewSelection) => void
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  pasted: PastedText[]
  onRemovePasted: (id: string) => void
  text: string
  composing: boolean
  disabled: boolean
  placeholder: string | undefined
  running: boolean
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  highlightRef: MutableRefObject<HTMLDivElement | null>
  composingRef: MutableRefObject<boolean>
  setComposing: Dispatch<SetStateAction<boolean>>
  setCompletion: Dispatch<SetStateAction<Completion | null>>
  onChange: (value: string, caret: number) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void
}

export function ComposerInputArea({
  previewSelections,
  onRemoveSelection,
  attachments,
  onRemoveAttachment,
  pasted,
  onRemovePasted,
  ...editor
}: ComposerInputAreaProps) {
  return (
    <div className="px-3.5 pb-0.5 pt-3">
      <ComposerChips
        previewSelections={previewSelections}
        onRemoveSelection={onRemoveSelection}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        pasted={pasted}
        onRemovePasted={onRemovePasted}
      />
      <ComposerEditor {...editor} />
    </div>
  )
}
