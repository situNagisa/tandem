import { cn } from '../../lib/cn'

/** 增删行数的统一着色（顶栏「改动」与右栏改动摘要共用）。 */
export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  return (
    <>
      <span className={cn('text-[var(--t-git-plus)]', className)}>+{additions}</span>{' '}
      <span className={cn('text-[var(--t-git-minus)]', className)}>−{deletions}</span>
    </>
  )
}
