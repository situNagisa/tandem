/**
 * 反馈草稿的实时落盘：web 端在 store 里写 IndexedDB（截图存 Blob），
 * 桌面调试版额外把同一份内容通过 IPC 写进 `<下载>/Tandem 反馈/草稿-…/`，
 * 每条一个文件，关页面/崩溃都不会丢。
 */
import { useAppStore } from '../store/useAppStore'
import { useFeedbackStore } from '../store/useFeedbackStore'
import {
  loadFeedbackSnapshotPrefs,
  type FeedbackDraftInfo,
  type FeedbackItem,
  type FeedbackReceipt,
} from './feedback'
import {
  archiveFilePayloads,
  buildFeedbackArchive,
  bytesToBase64,
  draftFolderName,
  type FeedbackArchive,
} from './feedbackArchive'
import { getFeedbackErrors } from './feedbackErrors'
import { checklistMarkdown } from './checklist'
import { APP_VERSION } from './changelog'
import { feedbackPlatform } from './mobilePreview'

const EXPORTED_RETENTION_DAYS = 7

type DesktopFeedbackApi = NonNullable<Window['tandemDesktop']>['feedback']

export function desktopFeedback(): DesktopFeedbackApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.tandemDesktop?.feedback
}

export function newDraftInfo(now = Date.now()): FeedbackDraftInfo {
  return { id: draftFolderName(new Date(now)), startedAt: now }
}

/** 当前环境：导出与草稿共用，保证 manifest 与 feedback.md 一致。 */
export function feedbackEnv(): Record<string, unknown> {
  const app = useAppStore.getState()
  const hostId = app.active?.hostId ?? app.activeHostId ?? undefined
  const hostInfo = hostId ? app.runtimes[hostId]?.info : undefined
  return {
    route: window.location.hash || '#/',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    window: {
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
    },
    dpr: window.devicePixelRatio || 1,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    platform: feedbackPlatform(),
    ua: navigator.userAgent,
    language: navigator.language,
    hostId,
    hostName: hostInfo?.name,
    hostPlatform: hostInfo?.platform,
    hostVersion: hostInfo?.version,
    sessionId: app.active?.sessionId,
  }
}

export function buildCurrentArchive(options: {
  items: FeedbackItem[]
  kind?: 'feedback' | 'verification'
  exportedAt?: string | null
  receipt?: FeedbackReceipt | null
  sourceReceiptFile?: string
  draft?: FeedbackDraftInfo | null
  checklist?: boolean
}): FeedbackArchive {
  return buildFeedbackArchive({
    items: options.items,
    pageShots: useFeedbackStore.getState().pageShots,
    errors: getFeedbackErrors(),
    env: feedbackEnv(),
    app: { name: 'Tandem', version: APP_VERSION, client: 'web' },
    kind: options.kind ?? 'feedback',
    snapshotPrefs: loadFeedbackSnapshotPrefs(),
    checklistMarkdown: options.checklist === false ? undefined : checklistMarkdown(),
    receipt: options.receipt,
    sourceReceiptFile: options.sourceReceiptFile,
    draftId: options.draft?.id,
    draftStartedAt: options.draft?.startedAt,
    exportedAt: options.exportedAt,
  })
}

function draftSignature(): string {
  const state = useFeedbackStore.getState()
  const draft = state.draft
  if (!draft || draft.exportedAt) return ''
  return [
    draft.id,
    state.items
      .map(
        (item) =>
          `${item.id}:${item.createdAt}:${item.text.length}:${item.annotatedScreenshot?.length ?? 0}:${item.references?.length ?? 0}`,
      )
      .join('|'),
    state.pageShots.map((shot) => `${shot.id}:${shot.createdAt}`).join('|'),
  ].join('#')
}

let syncTimer: number | null = null
let lastSignature = ''
let syncing = false

async function flushDraftSync(): Promise<void> {
  const api = desktopFeedback()
  if (!api || syncing) return
  const state = useFeedbackStore.getState()
  const draft = state.draft
  if (!state.hydrated || !draft) return
  const signature = draftSignature()
  if (!signature || signature === lastSignature) return
  syncing = true
  try {
    const archive = buildCurrentArchive({
      items: state.items,
      draft,
      exportedAt: null,
    })
    const result = await api.syncDraft(draft.id, archiveFilePayloads(archive))
    if (result?.ok) lastSignature = signature
  } catch (err) {
    console.warn('[feedback] 草稿落盘失败', err)
  } finally {
    syncing = false
  }
}

function scheduleDraftSync(): void {
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  // 合并连续编辑（标注保存、拖拽排序等），下一次变更立刻覆盖上次未写的批。
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    void flushDraftSync()
  }, 350)
}

/** 立即同步一次（导出、关闭前、手动操作后调用）。 */
export function flushDraftNow(): Promise<void> {
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer)
    syncTimer = null
  }
  return flushDraftSync()
}

/**
 * 订阅 store：新增/编辑/删除/排序/页截图变化后自动落盘。
 * 只在调试版、且 store 已从 IndexedDB 恢复之后才写，避免用空状态覆盖磁盘草稿。
 */
export function installFeedbackDraftSync(): void {
  const api = desktopFeedback()
  if (!api) return
  void api.prune?.().catch(() => undefined)
  useFeedbackStore.subscribe((state, prev) => {
    if (!state.hydrated) return
    if (
      state.items === prev.items &&
      state.pageShots === prev.pageShots &&
      state.draft === prev.draft
    ) {
      return
    }
    scheduleDraftSync()
  })
}

export async function exportArchiveToDisk(
  archive: FeedbackArchive,
): Promise<{ path: string } | null> {
  const api = desktopFeedback()
  if (!api) return null
  const result = await api.exportArchive(archive.filename, bytesToBase64(archive.bytes))
  return result?.ok && result.path ? { path: result.path } : null
}

export async function openFeedbackFolder(target?: string): Promise<void> {
  const api = desktopFeedback()
  if (!api) return
  await api.openFolder(target)
}

export async function markDraftExported(draft: FeedbackDraftInfo | null): Promise<void> {
  if (!draft || !draft.exportedAt) return
  await desktopFeedback()?.markExported(draft.id).catch(() => undefined)
}

export async function removeDesktopDraft(draft: FeedbackDraftInfo | null): Promise<void> {
  if (!draft) return
  lastSignature = ''
  await desktopFeedback()?.removeDraft(draft.id).catch(() => undefined)
}

/** 已导出草稿保留 7 天；超时的清掉，未导出的永远保留。 */
export function draftExpired(draft: FeedbackDraftInfo | null, now = Date.now()): boolean {
  if (!draft?.exportedAt) return false
  return now - draft.exportedAt > EXPORTED_RETENTION_DAYS * 24 * 60 * 60 * 1000
}
