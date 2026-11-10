import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useBrowserShot } from '../../lib/browserShot'
import { Modal } from '../ui/Modal'

export function BrowserShotThumb({
  hostId,
  sessionId,
  shotId,
}: {
  hostId: string
  sessionId: string
  shotId: string
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const { url, error } = useBrowserShot(host, sessionId, shotId)
  const [open, setOpen] = useState(false)
  if (error) return <p className="mt-1 text-[12px] text-danger">截图加载失败：{error}</p>
  if (!url) return <p className="mt-1 text-[12px] text-muted">截图加载中…</p>
  return (
    <>
      <button data-raw-button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看浏览器截图大图"
        className="mt-1 block max-w-full overflow-hidden rounded-lg border border-border bg-[var(--t-bg)] transition-colors hover:border-border-strong"
      >
        <img
          src={url}
          alt="浏览器截图"
          className="block h-24 w-auto max-w-full object-cover object-top"
        />
      </button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          ariaLabel="浏览器截图"
          title="浏览器截图"
          className="w-[min(94vw,1100px)] max-w-none"
          bodyClassName="p-2"
        >
          <img src={url} alt="浏览器截图大图" className="mx-auto block h-auto max-h-[75vh] w-auto max-w-full object-contain" />
        </Modal>
      )}
    </>
  )
}

