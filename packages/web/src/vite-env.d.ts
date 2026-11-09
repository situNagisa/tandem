/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __TANDEM_DEBUG__: boolean
declare const __TANDEM_FLAVOR__: 'debug' | 'release'

interface Window {
  tandemDesktop?: {
    isDesktop?: boolean
    platform?: string
    updater?: {
      getConfig: () => Promise<{ source: string }>
      setConfig: (config: { source: string }) => Promise<{ source: string }>
      check: () => Promise<{ state: string; version?: string; message?: string }>
      install: () => Promise<void>
      status: () => Promise<{ state: string; version?: string; message?: string }>
      onStatus: (callback: (status: { state: string; version?: string; message?: string }) => void) => () => void
    }
    mobilePreview?: {
      open: (options?: {
        preset?: 'pixel7' | 'small' | 'tablet'
        orientation?: 'portrait' | 'landscape'
      }) => Promise<{ ok: boolean; error?: string }>
      configure: (options?: {
        preset?: 'pixel7' | 'small' | 'tablet'
        orientation?: 'portrait' | 'landscape'
      }) => Promise<{ ok: boolean; error?: string }>
    }
  }
}
