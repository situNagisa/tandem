/** 反馈模式的数据结构、持久化与导出。 */

export type FeedbackType = 'issue' | 'suggestion' | 'praise'

export interface FeedbackRect {
  x: number
  y: number
  width: number
  height: number
  pageX: number
  pageY: number
}

export interface FeedbackItem {
  id: string
  type: FeedbackType
  text: string
  selector: string
  component?: string
  textSnippet: string
  route: string
  rect: FeedbackRect
  viewport: { width: number; height: number }
  dpr: number
  theme: 'light' | 'dark'
  platform: string
  ua: string
  hostId?: string
  hostName?: string
  hostPlatform?: string
  hostVersion?: string
  sessionId?: string
  createdAt: number
  /** dataURL；元素截图优先，失败时为整页缩略图。 */
  screenshot?: string
  screenshotKind?: 'element' | 'page'
  /** 元素截图是在四周补了 16px 背景的版本。 */
  screenshotPadding?: number
}

export interface FeedbackPageShot {
  id: string
  route: string
  dataURL: string
  width: number
  height: number
  createdAt: number
}

export interface FeedbackStoredState {
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
}

export const FEEDBACK_STORAGE_KEY = 'tandem.feedback.v1'
const DB_NAME = 'tandem-feedback'
const DB_STORE = 'state'
const DB_KEY = 'current'
const MAX_PAGE_SHOTS = 12

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

/** 完整数据（含截图）放 IndexedDB；同时把文字元数据镜像到 localStorage。 */
export async function loadFeedbackState(): Promise<FeedbackStoredState> {
  const db = await openDb()
  if (db) {
    const fromIdb = await new Promise<FeedbackStoredState | null>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly')
        const request = tx.objectStore(DB_STORE).get(DB_KEY)
        request.onsuccess = () => resolve((request.result as FeedbackStoredState | undefined) ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    db.close()
    if (fromIdb?.items?.length) return sanitizeStored(fromIdb)
  }
  try {
    const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY)
    if (!raw) return { items: [], pageShots: [] }
    return sanitizeStored(JSON.parse(raw) as FeedbackStoredState)
  } catch {
    return { items: [], pageShots: [] }
  }
}

function sanitizeStored(input: FeedbackStoredState): FeedbackStoredState {
  const items = Array.isArray(input?.items)
    ? input.items.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
    : []
  const pageShots = Array.isArray(input?.pageShots)
    ? input.pageShots.filter((shot) => shot && typeof shot.dataURL === 'string')
    : []
  return { items, pageShots: pageShots.slice(-MAX_PAGE_SHOTS) }
}

export async function saveFeedbackState(state: FeedbackStoredState): Promise<void> {
  const pageShots = state.pageShots.slice(-MAX_PAGE_SHOTS)
  const db = await openDb()
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).put({ items: state.items, pageShots }, DB_KEY)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
    db.close()
  }
  // 镜像只保留文字与坐标，避免撑爆 5MB 配额；截图仍可从 IndexedDB 读回。
  try {
    const meta = {
      items: state.items.slice(-20).map(({ screenshot: _screenshot, ...rest }) => rest),
      pageShots: [],
    }
    localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(meta))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

export function newFeedbackId(): string {
  return `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function feedbackTypeLabel(type: FeedbackType): string {
  return type === 'issue' ? '问题' : type === 'suggestion' ? '建议' : '好评'
}

export function feedbackFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `tandem-feedback-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}

function triggerDownload(data: string, filename: string): boolean {
  try {
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    if (typeof a.download !== 'string') {
      URL.revokeObjectURL(url)
      return false
    }
    a.href = url
    a.download = filename
    // 反馈模式会用文档级捕获监听拦截页面点击，这里标记为浮层内部元素放行。
    a.setAttribute('data-feedback-ui', '')
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  } catch {
    return false
  }
}

/** 浏览器下载；Capacitor/Electron 等不支持 a[download] 时退回分享或剪贴板。 */
export async function saveFeedbackFile(
  data: string,
  filename: string,
): Promise<'download' | 'share' | 'clipboard' | 'failed'> {
  const capacitor = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor
  const isNative = capacitor?.isNativePlatform?.() === true
  if (!isNative && triggerDownload(data, filename)) return 'download'
  try {
    const file = new File([data], filename, { type: 'application/json' })
    const nav = navigator as Navigator & {
      canShare?: (input: { files?: File[] }) => boolean
      share?: (input: { files?: File[]; title?: string }) => Promise<void>
    }
    if (file && nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: 'Tandem 反馈' })
      return 'share'
    }
  } catch {
    /* 用户取消分享也走剪贴板兜底 */
  }
  try {
    await navigator.clipboard.writeText(data)
    return 'clipboard'
  } catch {
    return 'failed'
  }
}
