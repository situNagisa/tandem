import type { ReactNode } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { nodeContains } from '../../lib/overlay'

interface ComposerCardProps {
  dragging: boolean
  setDragging: (dragging: boolean) => void
  disabled: boolean
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function ComposerCard({
  dragging,
  setDragging,
  disabled,
  onDrop,
  children,
}: ComposerCardProps) {
  return (
    <div
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (nodeContains(e.currentTarget, e.relatedTarget)) return
        setDragging(false)
      }}
      onDrop={onDrop}
      data-dragging={dragging}
      data-disabled={disabled || undefined}
      className="composer-card"
    >
      {dragging && (
        <div className="composer-drop">
          <ImageIcon size={16} />
          松开以添加图片
        </div>
      )}
      {children}
    </div>
  )
}
