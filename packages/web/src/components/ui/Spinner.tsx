import type { ComponentProps } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

/** 统一加载转圈；尺寸由调用方按各处原值传入。 */
export function Spinner({ className, ...props }: ComponentProps<typeof Loader2>) {
  return <Loader2 {...props} className={cn('animate-spin', className)} />
}
