#!/usr/bin/env node
// 解包 Tandem 反馈 JSON：截图/标注/参考图/录屏落地，轨迹与快照写成独立文件，
// 生成按功能分组的 feedback.md、by-feature/<功能>.md 与 by-cause/<编号>.md。
// 用法：node scripts/feedback-unpack.mjs <file.json> [outDir]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const input = process.argv[2]
if (!input) {
  console.error('用法: node scripts/feedback-unpack.mjs <file.json> [outDir]')
  process.exit(1)
}
const file = path.resolve(input)
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`)
  process.exit(1)
}
const outDir = path.resolve(process.argv[3] ?? `${file.replace(/\.json$/i, '')}-unpacked`)
mkdirSync(outDir, { recursive: true })
// 重复解包到同一目录时清掉旧的按功能/根因分组，避免残留已删除的条目。
rmSync(path.join(outDir, 'by-feature'), { recursive: true, force: true })
rmSync(path.join(outDir, 'by-cause'), { recursive: true, force: true })

let data
try {
  data = JSON.parse(readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`JSON 解析失败: ${err.message}`)
  process.exit(1)
}

const TYPE_LABELS = { issue: '问题', suggestion: '建议', praise: '好评' }
const STATUS_LABELS = { fixed: '已修复', wontfix: '不修复', 'needs-info': '需更多信息' }
const TRACE_LABELS = {
  click: '点击',
  key: '按键',
  route: '路由',
  ws: '连接',
  toast: '提示',
  error: '错误',
}
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
}
const pad2 = (n) => String(n).padStart(2, '0')

function writeDataUrl(dataUrl, target) {
  if (typeof dataUrl !== 'string') return null
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const [, mime, base64, payload] = match
  let bytes
  try {
    bytes = base64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    return null
  }
  writeFileSync(target, bytes)
  return { mime, bytes: bytes.length }
}

function extensionFor(dataUrl, fallback) {
  const match = /^data:([^;,]+)/.exec(typeof dataUrl === 'string' ? dataUrl : '')
  return EXT_BY_MIME[match?.[1]] ?? fallback
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function quoteBlock(value) {
  const text = oneLine(value)
  if (!text) return '（空）'
  return text.split('\n').join('\n  ')
}

function formatTime(value) {
  try {
    return new Date(value).toISOString()
  } catch {
    return '未知时间'
  }
}

function traceClock(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function safeName(value, fallback) {
  const name = String(value ?? '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return name || fallback
}

const items = Array.isArray(data.items) ? data.items : []
const pageShots = Array.isArray(data.pageShots) ? data.pageShots : []
const errors = Array.isArray(data.errors) ? data.errors : []
const receipt = data.receipt && Array.isArray(data.receipt.items) ? data.receipt : null
const receiptMap = new Map(receipt ? receipt.items.map((entry) => [entry.id, entry]) : [])
const isVerification = data.kind === 'verification'
const headerLines = []
const itemSections = []
const featureGroups = new Map()
const causeGroups = new Map()
const checklistReport =
  data.checklistReport && typeof data.checklistReport.markdown === 'string'
    ? data.checklistReport
    : null
let fileCount = 0

function groupInto(map, id, name, section) {
  if (!id) return
  const key = `${id}\u0000${name ?? id}`
  const entry = map.get(key) ?? { id, name: name ?? id, count: 0, sections: [] }
  entry.count += 1
  entry.sections.push(section)
  map.set(key, entry)
}

function prefixLinks(text) {
  return text.replace(/`(\d{2}-[^`]+)`/g, '`../$1`')
}

headerLines.push(isVerification ? '# Tandem 复验结果' : '# Tandem 反馈包', '')
const env = data.env ?? {}
const app = data.app ?? {}
headerLines.push(`- 导出时间：${data.exportedAt ?? '未知'}`)
headerLines.push(`- 应用：${app.name ?? 'Tandem'} ${app.version ?? ''}`.trim())
headerLines.push(`- 文件版本：v${data.version ?? 1}${data.kind ? `（${data.kind}）` : ''}`)
if (isVerification && data.sourceReceiptFile) {
  headerLines.push(`- 来源回执：\`${data.sourceReceiptFile}\``)
}
if (!env.route && items[0]?.route) env.route = items[0].route
if (env.route) headerLines.push(`- 路由：\`${env.route}\``)
if (env.viewport) {
  headerLines.push(`- 视口：${env.viewport.width}×${env.viewport.height} @${env.dpr ?? 1}x`)
}
if (env.theme) headerLines.push(`- 主题：${env.theme === 'dark' ? '深色' : '浅色'}`)
if (env.platform) headerLines.push(`- 平台：${env.platform}`)
if (env.hostName || env.hostPlatform || env.hostVersion) {
  headerLines.push(
    `- Host：${env.hostName ?? ''} ${env.hostPlatform ?? ''} ${env.hostVersion ?? ''}`.trim(),
  )
}
if (env.sessionId) headerLines.push(`- 会话：${env.sessionId}`)
headerLines.push(`- 条目：${items.length} 条`, '')

const pageFileMap = new Map()
pageShots.forEach((shot, index) => {
  const name = `page-${index + 1}.png`
  const written = writeDataUrl(shot.dataURL ?? shot.dataUrl, path.join(outDir, name))
  if (written) pageFileMap.set(shot, name)
})

items.forEach((item, index) => {
  const number = pad2(index + 1)
  const type = TYPE_LABELS[item.type] ?? item.type ?? '未分类'
  const featureName = item.featureName || (item.featureId ? item.featureId : '未分类')
  const causeName = item.causeTitle || (item.causeId ? item.causeId : '')
  const lines = [`### ${number}. ${type}${item.priority ? ` · ${item.priority}` : ''}`, '']
  lines.push(`- 文字：${quoteBlock(item.text)}`)
  lines.push(`- 类型：${type}`)
  if (item.priority) lines.push(`- 优先级：${item.priority}`)
  lines.push(`- 功能：${featureName}`)
  if (item.causeId) lines.push(`- 根因建议：${item.causeId}${causeName ? ` · ${causeName}` : ''}`)
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

  const isRegion = item.screenshotKind === 'region'
  const originalName = `${number}-${isRegion ? '区域截图' : '元素截图'}.png`
  const originalWritten = writeDataUrl(item.screenshot, path.join(outDir, originalName))
  const annotatedName = `${number}-标注截图.png`
  const annotatedWritten = writeDataUrl(item.annotatedScreenshot, path.join(outDir, annotatedName))
  if (originalWritten) {
    fileCount += 1
    const note =
      item.screenshotKind === 'page'
        ? '（元素截图采集失败，此处为整页截图；按上面的元素位置查看）'
        : isRegion
          ? '（框选区域）'
          : ''
    lines.push(`- 截图：\`${originalName}\`${note}`)
  } else if (!annotatedWritten) {
    lines.push('- 截图：（无）')
  }
  if (annotatedWritten) {
    fileCount += 1
    lines.push(`- 标注后截图：\`${annotatedName}\`${originalWritten ? `（原图见 \`${originalName}\`）` : ''}`)
  }

  const references = Array.isArray(item.references) ? item.references : []
  if (references.length) {
    const names = []
    references.forEach((reference, refIndex) => {
      const ext = extensionFor(reference.dataURL, 'png')
      const name = `${number}-参考-${refIndex + 1}.${ext}`
      if (writeDataUrl(reference.dataURL, path.join(outDir, name))) {
        fileCount += 1
        names.push(`\`${name}\`${reference.name ? `（${String(reference.name).slice(0, 60)}）` : ''}`)
      }
    })
    if (names.length) lines.push(`- 参考图：${names.join('、')}`)
  }

  const video = item.video
  if (video) {
    const ext = extensionFor(video.dataURL, 'webm')
    const name = `${number}-录屏.${ext}`
    const written = writeDataUrl(video.dataURL, path.join(outDir, name))
    if (written) {
      fileCount += 1
      const seconds = video.durationMs ? Math.round(video.durationMs / 1000) : null
      const size = video.sizeBytes ? `${(video.sizeBytes / 1024 / 1024).toFixed(1)}MB` : null
      lines.push(`- 录屏：\`${name}\`${seconds ? `（约 ${seconds} 秒）` : ''}${size ? ` ${size}` : ''}`)
    }
  }

  const trace = Array.isArray(item.trace) ? item.trace : []
  if (trace.length) {
    const traceName = `${number}-轨迹.md`
    const traceLines = [
      `# 第 ${index + 1} 条反馈 · 反馈前操作轨迹`,
      '',
      `- 反馈时间：${formatTime(item.createdAt)}`,
      `- 条目：${oneLine(item.text).slice(0, 120)}`,
      '',
      '| 时间 | 类型 | 内容 |',
      '| --- | --- | --- |',
      ...trace.map(
        (entry) =>
          `| ${traceClock(entry.time)} | ${TRACE_LABELS[entry.kind] ?? entry.kind ?? '?'} | ${oneLine(entry.detail).replace(/\|/g, '\\|').slice(0, 400)} |`,
      ),
    ]
    writeFileSync(path.join(outDir, traceName), `${traceLines.join('\n')}\n`, 'utf8')
    fileCount += 1
    lines.push(`- 操作轨迹：\`${traceName}\`（${trace.length} 条，反馈前 60 秒）`)
  }

  const snapshot = item.snapshot
  if (snapshot) {
    const snapshotName = `${number}-快照.json`
    writeFileSync(path.join(outDir, snapshotName), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    fileCount += 1
    const session = snapshot.session ?? {}
    const host = snapshot.host ?? {}
    const summary = [
      session.title ? `会话「${session.title}」` : session.id ? `会话 ${session.id}` : null,
      session.status ? `状态 ${session.status}` : null,
      session.model ? `模型 ${session.model}` : null,
      typeof session.messageCount === 'number' ? `${session.messageCount} 条消息` : null,
      host.platform ? `Host ${host.platform} ${host.version ?? ''}`.trim() : null,
      snapshot.hidePaths ? '路径已隐藏' : null,
    ].filter(Boolean)
    lines.push(`- 状态快照：\`${snapshotName}\`${summary.length ? `（${summary.join(' · ')}）` : ''}`)
    if (Array.isArray(snapshot.messages) && snapshot.messages.length) {
      lines.push(`  - 附带最近 ${snapshot.messages.length} 条消息正文（见快照 JSON）`)
    }
  }

  const receiptItem = receiptMap.get(item.id)
  if (receiptItem) {
    lines.push(`- 回执状态：${STATUS_LABELS[receiptItem.status] ?? receiptItem.status ?? '未知'}`)
    if (receiptItem.note) lines.push(`  - 说明：${quoteBlock(receiptItem.note)}`)
    if (receiptItem.verification) {
      lines.push(
        `  - 复验：${receiptItem.verification.result === 'pass' ? '通过' : '仍有问题'}${
          receiptItem.verification.note ? `（${quoteBlock(receiptItem.verification.note)}）` : ''
        }`,
      )
    }
    const afterName = `${number}-修复后.png`
    if (writeDataUrl(receiptItem.afterImage, path.join(outDir, afterName))) {
      fileCount += 1
      lines.push(`  - 修复后截图：\`${afterName}\``)
    }
  }
  if (item.verification) {
    lines.push(
      `- 复验结果：${item.verification.result === 'pass' ? '通过' : '仍有问题'}${
        item.verification.note ? `（${quoteBlock(item.verification.note)}）` : ''
      }`,
    )
  }
  if (item.createdAt) lines.push(`- 记录时间：${formatTime(item.createdAt)}`)
  lines.push('')

  const section = lines.join('\n')
  itemSections.push({ featureName, section })
  groupInto(featureGroups, item.featureId ?? featureName, featureName, section)
  if (item.causeId) groupInto(causeGroups, item.causeId, item.causeTitle || item.causeId, section)
})

// 本包命中的根因：出现次数 ≥2 标「复发」。
const causeSummary = [...causeGroups.values()].sort(
  (a, b) => b.count - a.count || a.id.localeCompare(b.id),
)
const causeLines = []
if (causeSummary.length > 0) {
  causeLines.push('## 本包命中的已知根因', '')
  for (const cause of causeSummary) {
    causeLines.push(
      `- ${cause.id}${cause.name && cause.name !== cause.id ? ` ${cause.name}` : ''} · ${cause.count} 次${cause.count >= 2 ? ' · **复发**' : ''}`,
    )
  }
  causeLines.push('')
}

const featureSummary = [...featureGroups.values()].sort((a, b) =>
  a.name.localeCompare(b.name, 'zh-CN'),
)
const bodyLines = []
for (const group of featureSummary) {
  bodyLines.push(`## 功能：${group.name}（${group.count} 条）`, '')
  for (const section of group.sections) {
    bodyLines.push(section.replace(/^### /, '### '), '')
  }
}

if (pageShots.length) {
  bodyLines.push('## 整页截图', '')
  pageShots.forEach((shot, index) => {
    const name = pageFileMap.get(shot) ?? `page-${index + 1}.png`
    const size = shot.width && shot.height ? `（${shot.width}×${shot.height}）` : ''
    bodyLines.push(`- 第 ${index + 1} 页${shot.route ? ` ${shot.route}` : ''}：\`${name}\`${size}`)
  })
  bodyLines.push('')
}

if (receipt && isVerification) {
  bodyLines.push('## 回执复验汇总', '')
  const byStatus = {}
  receipt.items.forEach((entry) => {
    const status = STATUS_LABELS[entry.status] ?? entry.status ?? '未知'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  })
  bodyLines.push(`- ${Object.entries(byStatus).map(([status, count]) => `${status} ${count}`).join(' · ')}`)
  const passed = receipt.items.filter((entry) => entry.verification?.result === 'pass').length
  const failed = receipt.items.filter((entry) => entry.verification?.result === 'fail').length
  bodyLines.push(`- 复验通过 ${passed} 条 · 仍有问题 ${failed} 条`, '')
}

bodyLines.push(`## 最近错误（${errors.length}）`, '')
if (errors.length === 0) {
  bodyLines.push('无记录。', '')
} else {
  errors.forEach((error, index) => {
    const time = error.time ? new Date(error.time).toISOString() : '未知时间'
    bodyLines.push(`### ${index + 1}. ${error.source ?? 'error'} · ${time}`, '')
    bodyLines.push('```')
    bodyLines.push(oneLine(error.message).slice(0, 4000))
    if (error.stack) bodyLines.push('', oneLine(error.stack).slice(0, 4000))
    bodyLines.push('```', '')
  })
}

const lines = [...headerLines, ...causeLines, ...bodyLines]
const mdPath = path.join(outDir, 'feedback.md')
writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8')

// by-feature/<功能>.md
const featureDir = path.join(outDir, 'by-feature')
mkdirSync(featureDir, { recursive: true })
const featureFiles = []
for (const group of featureSummary) {
  const name = `${safeName(group.name, '未归类')}.md`
  const content = [
    `# 功能：${group.name}`,
    '',
    `- 条目：${group.count} 条`,
    `- 汇总：\`../feedback.md\`；附件在上级目录。`,
    '',
    ...group.sections.map((section) => `${prefixLinks(section)}`),
  ].join('\n')
  writeFileSync(path.join(featureDir, name), `${content}\n`, 'utf8')
  featureFiles.push({ name, count: group.count })
}

// by-cause/<编号>.md
const causeDir = path.join(outDir, 'by-cause')
mkdirSync(causeDir, { recursive: true })
const causeFiles = []
for (const cause of causeSummary) {
  const name = `${safeName(cause.id, '未归类')}.md`
  const content = [
    `# 根因：${cause.id}${cause.name && cause.name !== cause.id ? ` ${cause.name}` : ''}`,
    '',
    `- 条目：${cause.count} 条${cause.count >= 2 ? ' · **复发**' : ''}`,
    `- 汇总：\`../feedback.md\`；附件在上级目录。`,
    '',
    ...cause.sections.map((section) => `${prefixLinks(section)}`),
  ].join('\n')
  writeFileSync(path.join(causeDir, name), `${content}\n`, 'utf8')
  causeFiles.push({ name, count: cause.count, id: cause.id })
}

if (checklistReport) {
  writeFileSync(path.join(outDir, '体验清单.md'), checklistReport.markdown, 'utf8')
}

console.log(
  `已解包 ${items.length} 条反馈、${pageShots.length} 张整页截图、${fileCount} 个附件 → ${outDir}`,
)
console.log(`  索引 ${mdPath}`)
for (const feature of featureFiles) console.log(`  功能 ${feature.name}（${feature.count} 条）`)
for (const cause of causeFiles) {
  console.log(`  根因 ${cause.id}（${cause.count} 条${cause.count >= 2 ? '，复发' : ''}）`)
}
if (checklistReport) console.log('  体验清单：体验清单.md')
if (isVerification) console.log('  类型：复验结果')
