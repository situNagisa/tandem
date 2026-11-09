/**
 * 反馈包（.tfb）：zip 容器里放正常文件——feedback.md、manifest.json、截图、
 * 快照、轨迹、体验清单。浏览器端负责组装，桌面端负责落盘（草稿目录与导出）。
 */
import type {
  FeedbackItem,
  FeedbackPageShot,
  FeedbackReceipt,
  FeedbackTraceEntry,
} from './feedback'
import { createZip, type ZipEntryInput } from './zipStore'

export const FEEDBACK_ARCHIVE_VERSION = 1
export const FEEDBACK_ARCHIVE_EXT = 'tfb'

const TYPE_LABELS: Record<string, string> = { issue: '问题', suggestion: '建议', praise: '好评' }
const TRACE_LABELS: Record<string, string> = {
  click: '点击',
  key: '按键',
  route: '路由',
  ws: '连接',
  toast: '提示',
  error: '错误',
}
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
}

export interface ArchiveFile {
  path: string
  text?: string
  bytes?: Uint8Array
}

export interface ArchiveItemFiles {
  screenshot?: string
  annotated?: string
  references?: Array<{ name: string; file: string }>
  video?: { name: string; mime: string; durationMs: number; sizeBytes: number; file: string }
  snapshot?: string
  trace?: string
  afterImage?: string
}

export interface ArchiveManifest {
  version: number
  format: 'tfb'
  kind: 'feedback' | 'verification'
  exportedAt: string | null
  draft?: { id: string; startedAt: number }
  app: { name: string; version: string; client: string }
  env: Record<string, unknown>
  snapshotPrefs?: { includeMessages: boolean; hidePaths: boolean }
  items: Array<Record<string, unknown> & { id: string; files?: ArchiveItemFiles }>
  featureGroups: Array<{ id: string; name: string; count: number }>
  causeGroups: Array<{ id: string; name: string; count: number }>
  pageShots: Array<{ id: string; route: string; width: number; height: number; createdAt: number; file: string }>
  receipt?: { version: number; sourceFile: string; items: Array<Record<string, unknown>> }
  checklist?: string
  errors: unknown[]
}

export interface FeedbackArchive {
  filename: string
  files: ArchiveFile[]
  bytes: Uint8Array
  manifest: ArchiveManifest
}

export interface ArchiveInput {
  items: FeedbackItem[]
  pageShots: FeedbackPageShot[]
  errors: unknown[]
  env: Record<string, unknown>
  app: { name: string; version: string; client: string }
  kind?: 'feedback' | 'verification'
  snapshotPrefs?: { includeMessages: boolean; hidePaths: boolean }
  checklistMarkdown?: string
  receipt?: FeedbackReceipt | null
  sourceReceiptFile?: string
  exportedAt?: string | null
  draftId?: string
  draftStartedAt?: number
  now?: Date
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function archiveTimestamp(date = new Date()): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

export function feedbackArchiveFilename(date = new Date()): string {
  return `tandem-feedback-${archiveTimestamp(date)}.${FEEDBACK_ARCHIVE_EXT}`
}

export function draftFolderName(date = new Date()): string {
  return `草稿-${archiveTimestamp(date)}`
}

function dataUrlParts(dataURL: string | undefined): { mime: string; bytes: Uint8Array; ext: string } | null {
  if (typeof dataURL !== 'string') return null
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataURL)
  if (!match) return null
  const [, mime, base64, payload] = match
  const ext = EXT_BY_MIME[mime] ?? (mime.startsWith('video/') ? 'webm' : 'png')
  if (!base64) {
    try {
      return { mime, ext, bytes: utf8(decodeURIComponent(payload)) }
    } catch {
      return null
    }
  }
  return { mime, ext, bytes: base64ToBytes(payload) }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function quoteBlock(value: unknown): string {
  const text = oneLine(value)
  if (!text) return '（空）'
  return text.split('\n').join('\n  ')
}

function isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return String(value ?? '未知时间')
}

function clockTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function traceMarkdown(item: FeedbackItem, trace: FeedbackTraceEntry[], index: number): string {
  return [
    `# 第 ${index + 1} 条反馈 · 反馈前操作轨迹`,
    '',
    `- 反馈时间：${isoTime(item.createdAt)}`,
    `- 条目：${oneLine(item.text).slice(0, 120)}`,
    '',
    '| 时间 | 类型 | 内容 |',
    '| --- | --- | --- |',
    ...trace.map(
      (entry) =>
        `| ${clockTime(entry.time)} | ${TRACE_LABELS[entry.kind] ?? entry.kind} | ${oneLine(entry.detail).replace(/\|/g, '\\|').slice(0, 400)} |`,
    ),
    '',
  ].join('\n')
}

function groupItems(items: FeedbackItem[], field: 'feature' | 'cause') {
  const groups = new Map<string, { id: string; name: string; count: number }>()
  for (const item of items) {
    const id = field === 'feature' ? item.featureId : item.causeId
    if (!id) continue
    const name =
      field === 'feature' ? item.featureName ?? item.featureId ?? id : item.causeTitle ?? id
    const current = groups.get(id)
    if (current) current.count += 1
    else groups.set(id, { id, name, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/**
 * 组装反馈包。items 顺序即分组与编号顺序；截图等二进制直接以字节进 zip，
 * 不再塞进 JSON 字符串。
 */
export function buildFeedbackArchive(input: ArchiveInput): FeedbackArchive {
  const now = input.now ?? new Date()
  const kind = input.kind ?? 'feedback'
  const exportedAt = input.exportedAt === undefined ? now.toISOString() : input.exportedAt
  const files: ArchiveFile[] = []
  const pushText = (path: string, text: string) => files.push({ path, text })
  const pushBytes = (path: string, bytes: Uint8Array) => files.push({ path, bytes })

  const pageShotFiles = input.pageShots.map((shot, index) => {
    const file = `page-${index + 1}.png`
    const parts = dataUrlParts(shot.dataURL)
    if (parts) pushBytes(file, parts.bytes)
    return { shot, file, written: !!parts }
  })

  const manifestItems: ArchiveManifest['items'] = []
  const itemSections: Array<{ featureName: string; section: string }> = []
  const receiptMap = new Map(input.receipt?.items.map((entry) => [entry.id, entry]) ?? [])

  input.items.forEach((item, index) => {
    const number = pad2(index + 1)
    const itemFiles: ArchiveItemFiles = {}
    const lines: string[] = []
    let snapshotSummary: string[] = []

    const isRegion = item.screenshotKind === 'region'
    const screenshotParts = dataUrlParts(item.screenshot)
    if (screenshotParts) {
      itemFiles.screenshot = `${number}-${isRegion ? '区域截图' : '元素截图'}.${screenshotParts.ext}`
      pushBytes(itemFiles.screenshot, screenshotParts.bytes)
    }
    const annotatedParts = dataUrlParts(item.annotatedScreenshot)
    if (annotatedParts) {
      itemFiles.annotated = `${number}-标注截图.${annotatedParts.ext}`
      pushBytes(itemFiles.annotated, annotatedParts.bytes)
    }
    const references = item.references ?? []
    references.forEach((reference, refIndex) => {
      const parts = dataUrlParts(reference.dataURL)
      if (!parts) return
      const file = `${number}-参考-${refIndex + 1}.${parts.ext}`
      itemFiles.references = [...(itemFiles.references ?? []), { name: reference.name, file }]
      pushBytes(file, parts.bytes)
    })
    const videoParts = dataUrlParts(item.video?.dataURL)
    if (item.video && videoParts) {
      const file = `${number}-录屏.${videoParts.ext}`
      itemFiles.video = {
        name: item.video.name,
        mime: item.video.mime,
        durationMs: item.video.durationMs,
        sizeBytes: item.video.sizeBytes,
        file,
      }
      pushBytes(file, videoParts.bytes)
    }
    if (item.trace?.length) {
      itemFiles.trace = `${number}-轨迹.md`
      pushText(itemFiles.trace, traceMarkdown(item, item.trace, index))
    }
    if (item.snapshot) {
      itemFiles.snapshot = `${number}-快照.json`
      pushText(itemFiles.snapshot, `${JSON.stringify(item.snapshot, null, 2)}\n`)
    }
    const receiptItem = receiptMap.get(item.id)
    const afterParts = dataUrlParts(receiptItem?.afterImage)
    if (afterParts) {
      itemFiles.afterImage = `${number}-修复后.${afterParts.ext}`
      pushBytes(itemFiles.afterImage, afterParts.bytes)
    }

    const type = TYPE_LABELS[item.type] ?? item.type
    const featureName = item.featureName || item.featureId || '未归类'
    lines.push(`### ${number}. ${type}${item.priority ? ` · ${item.priority}` : ''}`, '')
    lines.push(`- 文字：${quoteBlock(item.text)}`)
    lines.push(`- 类型：${type}`)
    if (item.priority) lines.push(`- 优先级：${item.priority}`)
    lines.push(`- 功能：${featureName}`)
    if (item.causeId) {
      lines.push(`- 根因建议：${item.causeId}${item.causeTitle ? ` · ${item.causeTitle}` : ''}`)
    }
    if (item.mode === 'region') lines.push('- 选择方式：框选区域')
    if (item.component) lines.push(`- 组件：\`${item.component}\``)
    if (item.selector) lines.push(`- 选择器：\`${String(item.selector).replace(/`/g, "'")}\``)
    if (item.route) lines.push(`- 路由：\`${item.route}\``)
    if (item.viewport) lines.push(`- 视口：${item.viewport.width}×${item.viewport.height}`)
    if (item.theme) lines.push(`- 主题：${item.theme === 'dark' ? '深色' : '浅色'}`)
    if (item.textSnippet) lines.push(`- 可见文本：${quoteBlock(item.textSnippet)}`)
    if (item.rect) {
      lines.push(
        `- 元素位置：x=${item.rect.x}, y=${item.rect.y}, ${item.rect.width}×${item.rect.height}`,
      )
    }
    if (itemFiles.screenshot) {
      const note =
        item.screenshotKind === 'page'
          ? '（元素截图采集失败，此处为整页截图；按上面的元素位置查看）'
          : isRegion
            ? '（框选区域）'
            : ''
      lines.push(`- 截图：\`${itemFiles.screenshot}\`${note}`)
    } else if (!itemFiles.annotated) {
      lines.push('- 截图：（无）')
    }
    if (itemFiles.annotated) lines.push(`- 标注后截图：\`${itemFiles.annotated}\``)
    if (itemFiles.references?.length) {
      lines.push(
        `- 参考图：${itemFiles.references
          .map((entry) => `\`${entry.file}\`${entry.name ? `（${entry.name.slice(0, 60)}）` : ''}`)
          .join('、')}`,
      )
    }
    if (itemFiles.video) {
      const seconds = itemFiles.video.durationMs
        ? Math.round(itemFiles.video.durationMs / 1000)
        : null
      const size = itemFiles.video.sizeBytes
        ? `${(itemFiles.video.sizeBytes / 1024 / 1024).toFixed(1)}MB`
        : null
      lines.push(
        `- 录屏：\`${itemFiles.video.file}\`${seconds ? `（约 ${seconds} 秒）` : ''}${size ? ` ${size}` : ''}`,
      )
    }
    if (itemFiles.trace) {
      lines.push(`- 操作轨迹：\`${itemFiles.trace}\`（${item.trace?.length ?? 0} 条，反馈前 60 秒）`)
    }
    if (itemFiles.snapshot) {
      const session = (item.snapshot?.session ?? {}) as Record<string, unknown>
      const host = (item.snapshot?.host ?? {}) as Record<string, unknown>
      const summary = [
        session.title ? `会话「${session.title}」` : session.id ? `会话 ${session.id}` : null,
        session.status ? `状态 ${session.status}` : null,
        session.model ? `模型 ${session.model}` : null,
        typeof session.messageCount === 'number' ? `${session.messageCount} 条消息` : null,
        host.platform ? `Host ${host.platform} ${host.version ?? ''}`.trim() : null,
        item.snapshot?.hidePaths ? '路径已隐藏' : null,
      ].filter(Boolean)
      lines.push(`- 状态快照：\`${itemFiles.snapshot}\`${summary.length ? `（${summary.join(' · ')}）` : ''}`)
      if (item.snapshot?.messages?.length) {
        lines.push(`  - 附带最近 ${item.snapshot.messages.length} 条消息正文（见快照 JSON）`)
      }
    }
    if (receiptItem) {
      const statusLabel =
        receiptItem.status === 'fixed' ? '已修复' : receiptItem.status === 'wontfix' ? '不修复' : '需更多信息'
      lines.push(`- 回执状态：${statusLabel}`)
      if (receiptItem.note) lines.push(`  - 说明：${quoteBlock(receiptItem.note)}`)
      if (receiptItem.verification) {
        lines.push(
          `  - 复验：${receiptItem.verification.result === 'pass' ? '通过' : '仍有问题'}${
            receiptItem.verification.note ? `（${quoteBlock(receiptItem.verification.note)}）` : ''
          }`,
        )
      }
      if (itemFiles.afterImage) lines.push(`  - 修复后截图：\`${itemFiles.afterImage}\``)
    }
    if (item.verification) {
      lines.push(
        `- 复验结果：${item.verification.result === 'pass' ? '通过' : '仍有问题'}${
          item.verification.note ? `（${quoteBlock(item.verification.note)}）` : ''
        }`,
      )
    }
    if (item.createdAt) lines.push(`- 记录时间：${isoTime(item.createdAt)}`)
    lines.push('')

    itemSections.push({ featureName, section: lines.join('\n') })

    const {
      screenshot: _screenshot,
      annotatedScreenshot: _annotated,
      references: _references,
      video: _video,
      snapshot: _snapshot,
      trace: _trace,
      ...rest
    } = item
    manifestItems.push({
      ...rest,
      ...(item.trace?.length ? { traceCount: item.trace.length } : {}),
      ...(item.snapshot
        ? { snapshotCapturedAt: item.snapshot.capturedAt, snapshotSummary }
        : {}),
      files: itemFiles,
    })
  })

  const featureGroups = groupItems(input.items, 'feature')
  const causeGroups = groupItems(input.items, 'cause')

  const headerLines: string[] = [
    kind === 'verification' ? '# Tandem 复验结果' : '# Tandem 反馈包',
    '',
    `- 导出时间：${exportedAt ?? '未导出（草稿）'}`,
    `- 应用：${input.app.name} ${input.app.version}`.trim(),
    `- 文件版本：v${FEEDBACK_ARCHIVE_VERSION}（${kind}）`,
  ]
  if (kind === 'verification' && input.sourceReceiptFile) {
    headerLines.push(`- 来源回执：\`${input.sourceReceiptFile}\``)
  }
  const env = input.env
  if (env.route) headerLines.push(`- 路由：\`${env.route}\``)
  if (env.viewport && typeof env.viewport === 'object') {
    const viewport = env.viewport as { width?: number; height?: number }
    headerLines.push(`- 视口：${viewport.width}×${viewport.height} @${env.dpr ?? 1}x`)
  }
  if (env.window && typeof env.window === 'object') {
    const win = env.window as { outerWidth?: number; outerHeight?: number; screenWidth?: number; screenHeight?: number }
    headerLines.push(
      `- 窗口：${win.outerWidth}×${win.outerHeight}${win.screenWidth ? ` · 屏幕 ${win.screenWidth}×${win.screenHeight}` : ''}`,
    )
  }
  if (env.theme) headerLines.push(`- 主题：${env.theme === 'dark' ? '深色' : '浅色'}`)
  if (env.platform) headerLines.push(`- 平台：${env.platform}`)
  if (env.hostName || env.hostPlatform || env.hostVersion) {
    headerLines.push(
      `- Host：${env.hostName ?? ''} ${env.hostPlatform ?? ''} ${env.hostVersion ?? ''}`.trim(),
    )
  }
  if (env.sessionId) headerLines.push(`- 会话：${env.sessionId}`)
  headerLines.push(`- 条目：${input.items.length} 条`)
  if (input.draftId) {
    headerLines.push(
      `- 草稿：\`${input.draftId}\`${exportedAt ? '（已导出）' : '（尚未导出，内容随记录实时更新）'}`,
    )
  }
  headerLines.push('')

  const causeLines: string[] = []
  if (causeGroups.length > 0) {
    causeLines.push('## 本包命中的已知根因', '')
    for (const cause of causeGroups) {
      causeLines.push(
        `- ${cause.id}${cause.name && cause.name !== cause.id ? ` ${cause.name}` : ''} · ${cause.count} 次${cause.count >= 2 ? ' · **复发**' : ''}`,
      )
    }
    causeLines.push('')
  }

  const grouped = new Map<string, string[]>()
  for (const entry of itemSections) {
    grouped.set(entry.featureName, [...(grouped.get(entry.featureName) ?? []), entry.section])
  }
  const bodyLines: string[] = []
  for (const [name, sections] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
    bodyLines.push(`## 功能：${name}（${sections.length} 条）`, '', ...sections)
  }

  if (pageShotFiles.length) {
    bodyLines.push('## 整页截图', '')
    pageShotFiles.forEach(({ shot, file, written }, index) => {
      const size = shot.width && shot.height ? `（${shot.width}×${shot.height}）` : ''
      bodyLines.push(
        `- 第 ${index + 1} 页${shot.route ? ` ${shot.route}` : ''}：\`${file}\`${size}${written ? '' : '（缺失）'}`,
      )
    })
    bodyLines.push('')
  }

  if (kind === 'verification' && input.receipt && input.receipt.items.length) {
    bodyLines.push('## 回执复验汇总', '')
    const passed = input.receipt.items.filter((entry) => entry.verification?.result === 'pass').length
    const failed = input.receipt.items.filter((entry) => entry.verification?.result === 'fail').length
    bodyLines.push(`- 复验通过 ${passed} 条 · 仍有问题 ${failed} 条`, '')
  }

  const errors = Array.isArray(input.errors) ? input.errors : []
  bodyLines.push(`## 最近错误（${errors.length}）`, '')
  if (errors.length === 0) {
    bodyLines.push('无记录。', '')
  } else {
    errors.forEach((error, index) => {
      const entry = (error ?? {}) as { source?: string; time?: number; message?: string; stack?: string }
      bodyLines.push(
        `### ${index + 1}. ${entry.source ?? 'error'} · ${
          entry.time ? new Date(entry.time).toISOString() : '未知时间'
        }`,
        '',
        '```',
        oneLine(entry.message).slice(0, 4000),
      )
      if (entry.stack) bodyLines.push('', oneLine(entry.stack).slice(0, 4000))
      bodyLines.push('```', '')
    })
  }

  pushText('feedback.md', [...headerLines, ...causeLines, ...bodyLines].join('\n'))
  if (input.checklistMarkdown) pushText('体验清单.md', input.checklistMarkdown)

  const manifest: ArchiveManifest = {
    version: FEEDBACK_ARCHIVE_VERSION,
    format: 'tfb',
    kind,
    exportedAt,
    ...(input.draftId
      ? { draft: { id: input.draftId, startedAt: input.draftStartedAt ?? now.getTime() } }
      : {}),
    app: input.app,
    env,
    ...(input.snapshotPrefs ? { snapshotPrefs: input.snapshotPrefs } : {}),
    items: manifestItems,
    featureGroups,
    causeGroups,
    pageShots: pageShotFiles.map(({ shot, file }) => ({
      id: shot.id,
      route: shot.route,
      width: shot.width,
      height: shot.height,
      createdAt: shot.createdAt,
      file,
    })),
    ...(kind === 'verification' && input.receipt
      ? {
          receipt: {
            version: input.receipt.version,
            sourceFile: input.receipt.sourceFile,
            items: input.receipt.items.map(({ afterImage: _afterImage, ...rest }) => rest),
          },
        }
      : {}),
    ...(input.checklistMarkdown ? { checklist: '体验清单.md' } : {}),
    errors,
  }
  pushText('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)

  const zipEntries: ZipEntryInput[] = files.map((file) => ({
    name: file.path,
    data: file.text !== undefined ? utf8(file.text) : (file.bytes ?? new Uint8Array()),
  }))
  return {
    filename: feedbackArchiveFilename(now),
    files,
    bytes: createZip(zipEntries, now),
    manifest,
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 草稿目录里落盘用的描述：文本直接给，二进制给 base64。 */
export function archiveFilePayloads(
  archive: FeedbackArchive,
): Array<{ path: string; text?: string; base64?: string }> {
  return archive.files.map((file) => ({
    path: file.path,
    ...(file.text !== undefined
      ? { text: file.text }
      : { base64: bytesToBase64(file.bytes ?? new Uint8Array()) }),
  }))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
