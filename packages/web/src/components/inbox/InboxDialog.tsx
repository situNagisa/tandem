import { Inbox } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { Modal } from '../ui/Modal'
import { InboxView } from './InboxView'

/** 桌面与移动端共用的收件箱弹层（侧栏图标打开）。 */
export function InboxDialog() {
  const open = useUiStore((s) => s.inboxOpen)
  const setOpen = useUiStore((s) => s.setInboxOpen)

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="收件箱"
      title={
        <span className="flex items-center gap-2">
          <Inbox size={14} className="text-muted" />
          收件箱
        </span>
      }
      className="h-[min(620px,86dvh)] w-[min(560px,94vw)] max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0 max-sm:pb-[env(safe-area-inset-bottom)]"
    >
      <InboxView embedded />
    </Modal>
  )
}
