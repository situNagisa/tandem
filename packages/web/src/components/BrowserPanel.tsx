import { useEffect, useState } from 'react'
import { Camera, Copy, ExternalLink, Globe2, ImageOff, RefreshCw } from 'lucide-react'
import type { BrowserState } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useBrowserStore } from '../store/useBrowserStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { useBrowserShot } from '../lib/browserShot'
import { formatRelative } from '../lib/format'
import { Modal } from './ui/Modal'
import { Button, IconButton } from './ui/Button'

const EMPTY_STATE: BrowserState = { sessionId: '', active: false, updatedAt: 0 }

/** 浏览器面板：会话当前页面的最新截图 + URL（手机端同样可看）。 */
export function BrowserPanel() {
  const panel = useUiStore((s) => s.browserPanel)
  const close = useUiStore((s) => s.closeBrowserPanel)
  const toast = useUiStore((s) => s.toast)
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === panel?.hostId) ?? null
  const stored = useBrowserStore((s) => (panel ? s.states[panel.sessionId] : undefined))
  const apply = useBrowserStore((s) => s.apply)
  const state = stored ?? EMPTY_STATE
  const shot = useBrowserShot(host, panel?.sessionId, state.screenshotId)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!panel || !host) return
    let cancelled = false
    const load = async () => {
      try {
        const next = await api.browserState(host, panel.sessionId)
        if (!cancelled) apply(next)
      } catch {
        /* 面板轮询失败时保持上一次截图 */
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [panel?.hostId, panel?.sessionId, host?.id, apply])

  if (!panel || !host) return null

  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      apply(await api.browserState(host, panel.sessionId))
    } catch (err) {
      toast(err instanceof Error ? err.message : '刷新失败', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const copyUrl = async () => {
    if (!state.url) return
    await copyText(state.url)
    toast('已复制页面地址')
  }

  return (
    <Modal
      open
      onClose={close}
      ariaLabel="浏览器"
      title={
        <span className="flex items-center gap-2">
          <Globe2 size={14} className="text-muted" />
          浏览器
          {state.active ? (
            <span className="rounded-full bg-[var(--t-bg-active)] px-1.5 py-px text-[10px] font-normal text-text-soft">
              运行中
            </span>
          ) : null}
        </span>
      }
      className="h-[clamp(460px,76vh,820px)] w-[min(94vw,1080px)] max-w-none max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <Globe2 size={13} className="shrink-0 text-muted" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-soft"
            title={state.url}
          >
            {state.url || (state.active ? '（尚未打开页面）' : '浏览器未打开')}
          </span>
          {state.url ? (
            <IconButton onClick={() => void copyUrl()} label="复制页面地址" tooltip="复制地址">
              <Copy size={13} />
            </IconButton>
          ) : null}
          <IconButton
            onClick={() => void refresh()}
            label="刷新浏览器状态"
            tooltip="刷新"
            disabled={refreshing}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
          </IconButton>
          <span className="ml-1 shrink-0 text-[12px] text-muted">
            {state.updatedAt ? formatRelative(state.updatedAt) : ''}
          </span>
        </div>

        {state.title ? (
          <div className="shrink-0 truncate px-3 pt-1.5 text-[12px] text-muted" title={state.title}>
            {state.title}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--t-bg)_60%,transparent)] p-3">
          {shot.url ? (
            <img
              key={state.screenshotId}
              src={shot.url}
              alt="当前页面截图"
              className="mx-auto block h-auto w-full rounded-lg border border-border bg-surface object-contain"
            />
          ) : (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface/60 px-6 py-10 text-center">
              {shot.error ? (
                <ImageOff size={26} className="text-muted/60" />
              ) : (
                <Camera size={26} className="text-muted/60" />
              )}
              <p className="text-[13px] text-text-soft">
                {shot.error
                  ? '截图加载失败'
                  : state.active
                    ? '页面还没有截图，等 agent 调用一次 browser_* 工具'
                    : '本会话还没有打开浏览器'}
              </p>
              <p className="max-w-[420px] text-[12px] leading-5 text-muted">
                {state.error
                  ? state.error
                  : state.active
                    ? '每次浏览器工具调用后会自动刷新。'
                    : '在设置 → 浏览器启用后，让 agent 打开 localhost 页面复现问题，截图会实时出现在这里。'}
              </p>
              {shot.error ? (
                <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                  重新加载
                </Button>
              ) : null}
            </div>
          )}
          {state.error && shot.url ? (
            <p className="mt-2 text-[12px] text-danger">{state.error}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2 text-[12px] text-muted">
          <ExternalLink size={11} />
          截图由 {host.name} 上的 Chromium 生成，仅在本 Host 与已连接客户端之间传输。
        </div>
      </div>
    </Modal>
  )
}
