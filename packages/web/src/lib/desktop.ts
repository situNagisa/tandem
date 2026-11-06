/** Electron 桌面端通过 preload 暴露的最小标识。 */
export const desktop = typeof window !== 'undefined' ? window.tandemDesktop : undefined
export const isDesktop = !!desktop?.isDesktop
export const desktopPlatform = desktop?.platform ?? ''

export const isMacDesktop = isDesktop && desktopPlatform === 'darwin'
export const isWindowsDesktop = isDesktop && desktopPlatform === 'win32'
