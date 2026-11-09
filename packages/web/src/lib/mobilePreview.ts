import { desktop } from './desktop'

export type MobilePreviewPreset = 'pixel7' | 'small' | 'tablet'
export type MobilePreviewOrientation = 'portrait' | 'landscape'

export interface MobilePreviewOptions {
  preset?: MobilePreviewPreset
  orientation?: MobilePreviewOrientation
}

export interface MobilePreviewPresetInfo {
  id: MobilePreviewPreset
  label: string
  width: number
  height: number
}

/** 与桌面主进程保持一致的预览尺寸（内容区 CSS 像素）。 */
export const MOBILE_PREVIEW_PRESETS: MobilePreviewPresetInfo[] = [
  { id: 'pixel7', label: 'Pixel 7', width: 412, height: 915 },
  { id: 'small', label: '小屏', width: 360, height: 740 },
  { id: 'tablet', label: '平板', width: 800, height: 1280 },
]

const PREVIEW_PARAM = 'mobilePreview'

export function mobilePreviewPreset(value: string | null): MobilePreviewPreset {
  return value === 'small' || value === 'tablet' ? value : 'pixel7'
}

export function mobilePreviewOrientation(value: string | null): MobilePreviewOrientation {
  return value === 'landscape' ? 'landscape' : 'portrait'
}

export function mobilePreviewSize(
  preset: MobilePreviewPreset,
  orientation: MobilePreviewOrientation,
): { width: number; height: number } {
  const info = MOBILE_PREVIEW_PRESETS.find((item) => item.id === preset) ?? MOBILE_PREVIEW_PRESETS[0]!
  return orientation === 'landscape'
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height }
}

/** 当前页面是否是手机预览窗口（发布版永远为 false）。 */
export function isMobilePreview(): boolean {
  if (!__TANDEM_DEBUG__) return false
  try {
    return new URLSearchParams(window.location.search).get(PREVIEW_PARAM) === '1'
  } catch {
    return false
  }
}

export function currentMobilePreviewOptions(): Required<MobilePreviewOptions> {
  const params = new URLSearchParams(window.location.search)
  return {
    preset: mobilePreviewPreset(params.get('previewPreset')),
    orientation: mobilePreviewOrientation(params.get('previewOrientation')),
  }
}

/** 反馈包里的 platform：手机预览导出为 mobile-preview。 */
export function feedbackPlatform(): string {
  if (isMobilePreview()) return 'mobile-preview'
  return (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    ''
  )
}

/**
 * 调试版入口：桌面端交给主进程建独立窗口（触摸模拟）；浏览器端新开手机尺寸弹窗。
 */
export async function openMobilePreview(
  options: MobilePreviewOptions = {},
): Promise<'desktop' | 'window' | 'blocked'> {
  if (!__TANDEM_DEBUG__) return 'blocked'
  const preset = options.preset ?? 'pixel7'
  const orientation = options.orientation ?? 'portrait'
  const size = mobilePreviewSize(preset, orientation)
  if (desktop?.mobilePreview?.open) {
    await desktop.mobilePreview.open({ preset, orientation })
    return 'desktop'
  }
  const url = new URL(window.location.href)
  url.searchParams.set(PREVIEW_PARAM, '1')
  url.searchParams.set('previewPreset', preset)
  url.searchParams.set('previewOrientation', orientation)
  url.hash = ''
  const popup = window.open(
    url.toString(),
    'tandem-mobile-preview',
    `popup=yes,width=${size.width},height=${size.height}`,
  )
  return popup ? 'window' : 'blocked'
}
