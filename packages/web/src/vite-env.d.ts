/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __TANDEM_DEBUG__: boolean
declare const __TANDEM_FLAVOR__: 'debug' | 'release'

interface Window {
  tandemDesktop?: {
    isDesktop?: boolean
    platform?: string
    /** 构建时写死的桌面风味；调试版才暴露 mobilePreview / feedback 桥。 */
    flavor?: 'debug' | 'release'
    clipboard?: {
      readText: () => Promise<string>
      writeText: (text: string) => Promise<void>
    }
    /** 反馈1323#09：本机目录的系统文件夹对话框。 */
    folder?: {
      pick: (defaultPath?: string) => Promise<string | null>
    }
    host?: {
      /** 桌面内嵌 Host 的 hostId；与所选主机的 HostInfo.id 相同才共用文件系统。 */
      localId: () => Promise<string | null>
    }
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
    // 反馈草稿实时落盘与 .tfb 导出：仅调试版主进程注册。
    feedback?: {
      /** 原生页面截图；rect 为 CSS px，返回 PNG data URL。 */
      capturePage: (rect: {
        x: number
        y: number
        width: number
        height: number
      }) => Promise<{ ok: boolean; dataURL?: string; error?: string }>
      syncDraft: (
        draftId: string,
        files: Array<{ path: string; text?: string; base64?: string }>,
      ) => Promise<{ ok: boolean; dir?: string; error?: string }>
      markExported: (draftId: string) => Promise<{ ok: boolean; error?: string }>
      removeDraft: (draftId: string) => Promise<{ ok: boolean; error?: string }>
      exportArchive: (
        filename: string,
        base64: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>
      openFolder: (target?: string) => Promise<{ ok: boolean; error?: string }>
      dir: () => Promise<{ dir?: string; error?: string }>
      prune: () => Promise<{ removed: number }>
    }
  }
}
