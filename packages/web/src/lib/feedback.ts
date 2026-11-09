/** 反馈模式的数据结构、持久化与导出。 */
import { readJson, writeJson } from './storage'

export type FeedbackType = 'issue' | 'suggestion' | 'praise'

export interface FeedbackRect {
  x: number
  y: number
  width: number
  height: number
  pageX: number
  pageY: number
}

export type FeedbackPriority = 'P0' | 'P1' | 'P2'

export type FeedbackSelectMode = 'element' | 'region'

export interface FeedbackReference {
  id: string
  name: string
  dataURL: string
  addedAt: number
}

export interface FeedbackTraceEntry {
  time: number
  kind: 'click' | 'key' | 'route' | 'ws' | 'toast' | 'error'
  detail: string
}

export interface FeedbackSnapshotMessage {
  role: string
  createdAt: number
  text: string
}

export interface FeedbackSnapshot {
  capturedAt: number
  route: string
  viewport: { width: number; height: number; dpr: number }
  theme: string
  hidePaths: boolean
  client: { platform: string; language: string; ua: string }
  ui: Record<string, unknown>
  host?: Record<string, unknown>
  session?: Record<string, unknown>
  messages?: FeedbackSnapshotMessage[]
}

export interface FeedbackVideo {
  name: string
  mime: string
  dataURL: string
  durationMs: number
  sizeBytes: number
}

export type ReceiptStatus = 'fixed' | 'wontfix' | 'needs-info'

export interface FeedbackReceiptItem {
  id: string
  status: ReceiptStatus
  note?: string
  afterImage?: string
  /** 用户复验结果，随「复验」导出。 */
  verification?: { result: 'pass' | 'fail'; note?: string; at: number }
}

export interface FeedbackReceipt {
  version: number
  sourceFile: string
  items: FeedbackReceiptItem[]
}

export function receiptStatusLabel(status: ReceiptStatus): string {
  return status === 'fixed' ? '已修复' : status === 'wontfix' ? '不修复' : '需更多信息'
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
  screenshotKind?: 'element' | 'page' | 'region'
  /** 元素截图是在四周补了 16px 背景的版本。 */
  screenshotPadding?: number
  /** 选择方式：点选元素 / 拖拽框选区域。 */
  mode?: FeedbackSelectMode
  priority?: FeedbackPriority
  /** 标注后的截图（dataURL）；原图始终保留在 screenshot。 */
  annotatedScreenshot?: string
  references?: FeedbackReference[]
  /** 反馈前 60 秒的操作轨迹。 */
  trace?: FeedbackTraceEntry[]
  snapshot?: FeedbackSnapshot
  /** 录屏附件（webm，仅本地）。 */
  video?: FeedbackVideo
  /** 自动/手动功能标签（看板、子代理、设置-xx…）。 */
  featureId?: string
  featureName?: string
  /** 根因台账建议编号（R01–R10）；不确定时缺省。 */
  causeId?: string
  causeTitle?: string
  /** 维护者回执的复验结果（随「导出复验结果」写入）。 */
  verification?: { result: 'pass' | 'fail'; note?: string; at: number }
}

export interface FeedbackPageShot {
  id: string
  route: string
  dataURL: string
  width: number
  height: number
  createdAt: number
}

export interface FeedbackDraftInfo {
  id: string
  startedAt: number
  /** 已导出时间；草稿保留 7 天后清理。 */
  exportedAt?: number
}

export interface FeedbackSnapshotPrefs {
  includeMessages: boolean
  hidePaths: boolean
}

const SNAPSHOT_PREFS_KEY = 'tandem.feedback.snapshotPrefs.v1'

export function loadFeedbackSnapshotPrefs(): FeedbackSnapshotPrefs {
  const parsed = readJson<Partial<FeedbackSnapshotPrefs> | null>(SNAPSHOT_PREFS_KEY, null)
  if (parsed) return { includeMessages: !!parsed.includeMessages, hidePaths: !!parsed.hidePaths }
  return { includeMessages: false, hidePaths: false }
}

export function saveFeedbackSnapshotPrefs(prefs: FeedbackSnapshotPrefs): void {
  writeJson(SNAPSHOT_PREFS_KEY, prefs)
}

export interface FeedbackStoredState {
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
  receipt?: FeedbackReceipt | null
  draft?: FeedbackDraftInfo | null
}

export interface FeedbackExportGroup {
  id: string
  name: string
  count: number
}

export const FEEDBACK_STORAGE_KEY = 'tandem.feedback.v1'
const DB_NAME = 'tandem-feedback'
const DB_STORE = 'state'
const DB_KEY = 'current'
const MAX_PAGE_SHOTS = 12

interface StoredItemBlobs {
  screenshot?: Blob
  annotated?: Blob
  references?: Blob[]
  video?: Blob
}

type StoredItem = Omit<
  FeedbackItem,
  'screenshot' | 'annotatedScreenshot' | 'references' | 'video'
> & {
  /** 旧格式直接带 dataURL；新格式在 blobs 里。 */
  screenshot?: string
  annotatedScreenshot?: string
  references?: Array<Pick<FeedbackReference, 'id' | 'name' | 'addedAt'> | FeedbackReference>
  video?: FeedbackVideo | Omit<FeedbackVideo, 'dataURL'>
}

interface StoredIdbState {
  items: StoredItem[]
  pageShots: Array<Omit<FeedbackPageShot, 'dataURL'> & { dataURL?: string }>
  blobs?: { items?: Record<string, StoredItemBlobs>; pageShots?: Record<string, Blob> }
  receipt?: FeedbackReceipt | null
  draft?: FeedbackDraftInfo | null
}

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

/** 截图等大对象在 IndexedDB 里存 Blob，不再存 base64 字符串。 */
function dataUrlToBlob(dataURL: string | undefined): Blob | undefined {
  if (typeof dataURL !== 'string') return undefined
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataURL)
  if (!match) return undefined
  const [, mime, base64, payload] = match
  try {
    if (!base64) return new Blob([decodeURIComponent(payload)], { type: mime })
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return undefined
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/** 完整数据（含截图 Blob）放 IndexedDB；同时把文字元数据镜像到 localStorage。 */
export async function loadFeedbackState(): Promise<FeedbackStoredState> {
  const db = await openDb()
  if (db) {
    const fromIdb = await new Promise<StoredIdbState | null>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly')
        const request = tx.objectStore(DB_STORE).get(DB_KEY)
        request.onsuccess = () => resolve((request.result as StoredIdbState | undefined) ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    db.close()
    if (fromIdb?.items?.length) return hydrateStored(fromIdb)
  }
  const parsed = readJson<StoredIdbState | null>(FEEDBACK_STORAGE_KEY, null)
  if (!parsed) return { items: [], pageShots: [], receipt: null, draft: null }
  return {
    ...sanitizeMeta(parsed),
    pageShots: [],
  }
}

function sanitizeMeta(input: StoredIdbState | null | undefined): FeedbackStoredState {
  const items = Array.isArray(input?.items)
    ? (input.items.filter(
        (item) => item && typeof item.id === 'string' && typeof item.text === 'string',
      ) as unknown as FeedbackItem[])
    : []
  const pageShots = Array.isArray(input?.pageShots)
    ? (input.pageShots.filter((shot) => shot && typeof shot.dataURL === 'string') as FeedbackPageShot[])
    : []
  return {
    items,
    pageShots: pageShots.slice(-MAX_PAGE_SHOTS),
    receipt: sanitizeReceipt(input?.receipt),
    draft: sanitizeDraft(input?.draft),
  }
}

async function hydrateStored(input: StoredIdbState): Promise<FeedbackStoredState> {
  const items: FeedbackItem[] = []
  for (const raw of input.items) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
    const blobs = input.blobs?.items?.[raw.id]
    const screenshot =
      typeof raw.screenshot === 'string'
        ? raw.screenshot
        : blobs?.screenshot
          ? ((await blobToDataUrl(blobs.screenshot)) ?? undefined)
          : undefined
    const annotatedScreenshot =
      typeof raw.annotatedScreenshot === 'string'
        ? raw.annotatedScreenshot
        : blobs?.annotated
          ? ((await blobToDataUrl(blobs.annotated)) ?? undefined)
          : undefined
    const rawReferences = Array.isArray(raw.references) ? raw.references : []
    const references: FeedbackReference[] | undefined = rawReferences.length
      ? (
          await Promise.all(
            rawReferences.map(async (reference, index) => {
              if ('dataURL' in reference && typeof reference.dataURL === 'string') {
                return reference as FeedbackReference
              }
              const blob = blobs?.references?.[index]
              const dataURL = blob ? await blobToDataUrl(blob) : null
              return dataURL
                ? { ...(reference as Pick<FeedbackReference, 'id' | 'name' | 'addedAt'>), dataURL }
                : null
            }),
          )
        ).filter((entry): entry is FeedbackReference => entry !== null)
      : undefined
    let video: FeedbackVideo | undefined
    if (raw.video) {
      const meta = raw.video as Omit<FeedbackVideo, 'dataURL'>
      const dataURL =
        'dataURL' in raw.video && typeof raw.video.dataURL === 'string'
          ? raw.video.dataURL
          : blobs?.video
            ? await blobToDataUrl(blobs.video)
            : null
      if (dataURL) video = { ...meta, dataURL }
    }
    const {
      screenshot: _storedShot,
      annotatedScreenshot: _storedAnnotated,
      references: _storedRefs,
      video: _storedVideo,
      ...rest
    } = raw
    items.push({
      ...(rest as Omit<FeedbackItem, 'screenshot' | 'annotatedScreenshot' | 'references' | 'video'>),
      ...(screenshot ? { screenshot } : {}),
      ...(annotatedScreenshot ? { annotatedScreenshot } : {}),
      ...(references?.length ? { references } : {}),
      ...(video ? { video } : {}),
    })
  }

  const pageShots: FeedbackPageShot[] = []
  for (const shot of input.pageShots ?? []) {
    if (!shot || typeof shot.id !== 'string') continue
    const dataURL =
      typeof shot.dataURL === 'string'
        ? shot.dataURL
        : input.blobs?.pageShots?.[shot.id]
          ? await blobToDataUrl(input.blobs.pageShots[shot.id])
          : null
    if (!dataURL) continue
    pageShots.push({ ...shot, dataURL })
  }

  return {
    items,
    pageShots: pageShots.slice(-MAX_PAGE_SHOTS),
    receipt: sanitizeReceipt(input.receipt),
    draft: sanitizeDraft(input.draft),
  }
}

function sanitizeDraft(input: unknown): FeedbackDraftInfo | null {
  if (!input || typeof input !== 'object') return null
  const draft = input as FeedbackDraftInfo
  if (typeof draft.id !== 'string' || !draft.id) return null
  return {
    id: draft.id,
    startedAt: Number.isFinite(draft.startedAt) ? draft.startedAt : Date.now(),
    ...(Number.isFinite(draft.exportedAt) ? { exportedAt: draft.exportedAt } : {}),
  }
}

function sanitizeReceipt(input: unknown): FeedbackReceipt | null {
  if (!input || typeof input !== 'object') return null
  const receipt = input as FeedbackReceipt
  if (!Array.isArray(receipt.items)) return null
  const items = receipt.items.filter(
    (item) =>
      item &&
      typeof item.id === 'string' &&
      (item.status === 'fixed' || item.status === 'wontfix' || item.status === 'needs-info'),
  )
  return { version: receipt.version ?? 1, sourceFile: receipt.sourceFile ?? '', items }
}

export async function saveFeedbackState(state: FeedbackStoredState): Promise<void> {
  const pageShots = state.pageShots.slice(-MAX_PAGE_SHOTS)
  const items: StoredItem[] = state.items.map((item) => {
    const {
      screenshot,
      annotatedScreenshot,
      references,
      video,
      ...rest
    } = item
    return {
      ...rest,
      ...(references?.length
        ? { references: references.map(({ id, name, addedAt }) => ({ id, name, addedAt })) }
        : {}),
      ...(video
        ? {
            video: {
              name: video.name,
              mime: video.mime,
              durationMs: video.durationMs,
              sizeBytes: video.sizeBytes,
            },
          }
        : {}),
    }
  })
  const blobs: NonNullable<StoredIdbState['blobs']> = { items: {}, pageShots: {} }
  for (const item of state.items) {
    const entry: StoredItemBlobs = {}
    const screenshot = dataUrlToBlob(item.screenshot)
    if (screenshot) entry.screenshot = screenshot
    const annotated = dataUrlToBlob(item.annotatedScreenshot)
    if (annotated) entry.annotated = annotated
    const references = (item.references ?? [])
      .map((reference) => dataUrlToBlob(reference.dataURL))
      .filter((blob): blob is Blob => !!blob)
    if (references.length) entry.references = references
    const video = dataUrlToBlob(item.video?.dataURL)
    if (video) entry.video = video
    if (Object.keys(entry).length) blobs.items![item.id] = entry
  }
  for (const shot of pageShots) {
    const blob = dataUrlToBlob(shot.dataURL)
    if (blob) blobs.pageShots![shot.id] = blob
  }

  const db = await openDb()
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).put(
          {
            items,
            pageShots: pageShots.map(({ dataURL: _dataURL, ...rest }) => rest),
            blobs,
            receipt: state.receipt ?? null,
            draft: state.draft ?? null,
          },
          DB_KEY,
        )
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
      items: state.items.slice(-20).map(({ screenshot: _screenshot, annotatedScreenshot: _annotated, references: _refs, video: _video, ...rest }) => rest),
      pageShots: [],
      receipt: state.receipt
        ? {
            ...state.receipt,
            items: state.receipt.items.map(({ afterImage: _afterImage, ...rest }) => rest),
          }
        : null,
      draft: state.draft ?? null,
    }
    writeJson(FEEDBACK_STORAGE_KEY, meta)
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

/** 反馈包文件名在 feedbackArchive.ts；这里只保留回执与下载工具。 */
/** 解析维护者回执；非法结构返回 null。 */
export function parseFeedbackReceipt(raw: string): FeedbackReceipt | null {
  try {
    const data = JSON.parse(raw) as FeedbackReceipt
    return sanitizeReceipt(data)
  } catch {
    return null
  }
}

export function readFileAsDataURL(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function mimeForFilename(filename: string): string {
  if (/\.md$/i.test(filename)) return 'text/markdown;charset=utf-8'
  if (/\.json$/i.test(filename)) return 'application/json;charset=utf-8'
  return 'text/plain;charset=utf-8'
}

export function triggerDownload(data: string, filename: string): boolean {
  return triggerDownloadBlob(new Blob([data], { type: mimeForFilename(filename) }), filename)
}

export function triggerDownloadBlob(blob: Blob, filename: string): boolean {
  try {
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
    const file = new File([data], filename, { type: mimeForFilename(filename) })
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

/** 二进制包（.tfb）下载；桌面端由 IPC 直接落盘，这里只负责浏览器与分享。 */
export async function saveFeedbackBlob(
  blob: Blob,
  filename: string,
): Promise<'download' | 'share' | 'failed'> {
  const capacitor = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor
  const isNative = capacitor?.isNativePlatform?.() === true
  if (!isNative && triggerDownloadBlob(blob, filename)) return 'download'
  try {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
    const nav = navigator as Navigator & {
      canShare?: (input: { files?: File[] }) => boolean
      share?: (input: { files?: File[]; title?: string }) => Promise<void>
    }
    if (file && nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: 'Tandem 反馈' })
      return 'share'
    }
  } catch {
    /* 用户取消分享 */
  }
  return 'failed'
}
