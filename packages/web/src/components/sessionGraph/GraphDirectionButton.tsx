import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../store/useUiStore'
import { IconButton } from '../ui/Button'

/**
 * 会话图方向切换：最新在上 / 最新在下。全局记住，右栏卡片、全高视图与侧栏悬停拓扑共用。
 */
export function GraphDirectionButton({ className }: { className?: string }) {
  const direction = useUiStore((s) => s.graphDirection)
  const setDirection = useUiStore((s) => s.setGraphDirection)
  const newestTop = direction === 'newest-top'
  return (
    <IconButton
      size="sm"
      onClick={() => setDirection(newestTop ? 'newest-bottom' : 'newest-top')}
      label="切换会话图方向"
      tooltip={newestTop ? '最新在上' : '最新在下'}
      className={cn('size-6! [&_svg]:size-3', className)}
    >
      {newestTop ? <ArrowDownWideNarrow size={12} /> : <ArrowUpWideNarrow size={12} />}
    </IconButton>
  )
}
