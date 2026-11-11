import { useEffect, useState } from 'react'
import { Keyboard, RotateCw } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../../lib/cn'
import { desktop } from '../../lib/desktop'
import {
  MOBILE_PREVIEW_PRESETS,
  currentMobilePreviewOptions,
  mobilePreviewSize,
  type MobilePreviewOrientation,
  type MobilePreviewPreset,
} from '../../lib/mobilePreview'

const KEY_ROWS = ['q w e r t y u i o p', 'a s d f g h j k l', 'z x c v b n m']

/** 调试版手机预览窗口顶栏：预设/旋转/模拟键盘；正式版构建中整个模块会被剔除。 */
export function MobilePreviewBar() {
  const initial = currentMobilePreviewOptions()
  const [preset, setPreset] = useState<MobilePreviewPreset>(initial.preset)
  const [orientation, setOrientation] = useState<MobilePreviewOrientation>(initial.orientation)
  const [keyboard, setKeyboard] = useState(false)
  const nativeTouch = !!desktop?.mobilePreview?.configure
  const size = mobilePreviewSize(preset, orientation)

  useEffect(() => {
    try {
      document.documentElement.dataset.mobilePreview = '1'
    } catch {
      /* 忽略 */
    }
  }, [])

  const apply = (nextPreset: MobilePreviewPreset, nextOrientation: MobilePreviewOrientation) => {
    setPreset(nextPreset)
    setOrientation(nextOrientation)
    const params = new URLSearchParams(window.location.search)
    params.set('mobilePreview', '1')
    params.set('previewPreset', nextPreset)
    params.set('previewOrientation', nextOrientation)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`)
    if (desktop?.mobilePreview?.configure) {
      void desktop.mobilePreview.configure({ preset: nextPreset, orientation: nextOrientation })
      return
    }
    const next = mobilePreviewSize(nextPreset, nextOrientation)
    window.resizeTo(next.width, next.height)
  }

  const rotate = () =>
    apply(preset, orientation === 'portrait' ? 'landscape' : 'portrait')

  return (
    <>
      <div
        data-mobile-preview-bar
        data-tip={`手机预览（模拟） · ${size.width}×${size.height}`}
        className="fixed inset-x-0 top-0 z-[95] flex h-[30px] items-center gap-1 overflow-hidden border-b border-border bg-[var(--t-surface-2)] px-2 text-[11px] leading-none text-text-soft"
      >
        <span className="shrink-0 font-medium text-text">手机预览 · 模拟</span>
        <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
        {MOBILE_PREVIEW_PRESETS.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={preset === item.id ? 'secondary' : 'ghost'}
            aria-pressed={preset === item.id}
            tooltip={`${item.label} · ${item.width}×${item.height}`}
            className="h-5 shrink-0 px-1.5 text-[11px]"
            onClick={() => apply(item.id, orientation)}
          >
            {item.id === 'pixel7' ? 'P7' : item.label}
          </Button>
        ))}
        <IconButton
          size="sm"
          label="旋转屏幕"
          tooltip={orientation === 'portrait' ? '旋转为横屏' : '旋转为竖屏'}
          className="size-5 shrink-0 [&_svg]:size-3"
          onClick={rotate}
        >
          <RotateCw size={12} />
        </IconButton>
        <Button
          size="sm"
          variant={keyboard ? 'secondary' : 'ghost'}
          aria-pressed={keyboard}
          aria-label="模拟键盘"
          tooltip="模拟键盘占位"
          className="h-5 shrink-0 px-1.5 text-[11px]"
          icon={<Keyboard size={11} />}
          onClick={() => setKeyboard((value) => !value)}
        >
          键盘
        </Button>
        <span
          data-tip={nativeTouch ? '触摸模拟已开启' : '浏览器弹窗无法模拟触摸'}
          className={cn('ml-auto shrink-0', nativeTouch ? 'text-muted' : 'text-warning')}
          data-preview-touch={nativeTouch ? 'emulated' : 'browser'}
        >
          {nativeTouch ? '触摸' : '无触摸模拟'}
        </span>
      </div>
      {keyboard && (
        <div
          data-preview-keyboard
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[94] border-t border-border bg-[var(--t-surface-2)] px-2 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_24px_rgba(0,0,0,.18)]"
        >
          <div className="mx-auto flex max-w-[420px] flex-col gap-1.5 opacity-80">
            {KEY_ROWS.map((row) => (
              <div key={row} className="flex justify-center gap-1">
                {row.split(' ').map((key) => (
                  <span
                    key={key}
                    className="flex h-7 min-w-7 items-center justify-center rounded bg-bg text-[11px] text-text-soft"
                  >
                    {key}
                  </span>
                ))}
              </div>
            ))}
            <div className="flex justify-center gap-1">
              <span className="flex h-7 min-w-14 items-center justify-center rounded bg-bg text-[11px] text-text-soft">
                空格
              </span>
              <span className="flex h-7 min-w-10 items-center justify-center rounded bg-bg text-[11px] text-text-soft">
                换行
              </span>
            </div>
            <div className="pb-1 text-center text-[11px] text-muted">模拟键盘（占位，不接管输入）</div>
          </div>
        </div>
      )}
    </>
  )
}
