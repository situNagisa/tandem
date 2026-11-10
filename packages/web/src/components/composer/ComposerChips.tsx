import { FileText, MousePointerClick, X } from 'lucide-react'
import { IconButton } from '../ui/Button'
import type { PreviewSelection } from '@tandem/protocol'
import { selectionContextText, selectionLabel, selectionSource } from '../../lib/previewElement'
import type { Attachment, PastedText } from './composerTypes'

interface ComposerChipsProps {
  previewSelections: PreviewSelection[]
  onRemoveSelection: (selection: PreviewSelection) => void
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  pasted: PastedText[]
  onRemovePasted: (id: string) => void
}

export function ComposerChips({
  previewSelections,
  onRemoveSelection,
  attachments,
  onRemoveAttachment,
  pasted,
  onRemovePasted,
}: ComposerChipsProps) {
  return (
    <>
          {previewSelections.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5" data-testid="composer-preview-selections">
              {previewSelections.map((selection) => (
                <div
                  key={selection.id}
                  data-tip={selectionContextText([selection])}
                  className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-text-soft"
                >
                  <MousePointerClick size={13} className="shrink-0 text-muted" />
                  <span className="truncate">{selectionLabel(selection)}</span>
                  {selectionSource(selection) ? (
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      {selectionSource(selection)}
                    </span>
                  ) : null}
                  <IconButton
                    size="sm"
                    onClick={() => onRemoveSelection(selection)}
                    label={`移除已选元素 ${selection.name}`}
                    className="size-6! [&_svg]:size-3"
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative size-14 overflow-hidden rounded-lg border border-border bg-surface-2"
                >
                  <img
                    src={`data:${a.mediaType};base64,${a.dataBase64}`}
                    alt={a.name}
                    className="size-full object-contain p-0.5"
                  />
                  <IconButton
                    onClick={() => onRemoveAttachment(a.id)}
                    label="移除图片"
                    className="absolute right-0 top-0 rounded-bl-lg rounded-tr-lg bg-[color-mix(in_srgb,var(--t-text)_62%,transparent)] text-[var(--t-bg)] opacity-80 hover:bg-[color-mix(in_srgb,var(--t-text)_72%,transparent)] hover:text-[var(--t-bg)] hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {pasted.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pasted.map((p) => (
                <div
                  key={p.id}
                  data-tip={`${p.lines} 行 · ${p.text.length} 字`}
                  className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-text-soft"
                >
                  <FileText size={13} className="shrink-0 text-muted" />
                  <span className="truncate">粘贴的文本 · {p.lines} 行</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted">
                    {p.text.length > 999 ? `${(p.text.length / 1000).toFixed(1)}k` : p.text.length} 字
                  </span>
                  <IconButton
                    size="sm"
                    onClick={() => onRemovePasted(p.id)}
                    label="移除粘贴的文本"
                    className="size-6! [&_svg]:size-3"
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
    </>
  )
}
