#!/usr/bin/env node
// 由维护者填写的 Markdown/JSON 草稿生成 Tandem 回执文件（tandem-feedback-receipt-*.json）。
// 用法：node scripts/feedback-receipt.mjs <feedback.json> <receipt.md|receipt.json> [outDir]
//
// Markdown 草稿格式：
//   # 回执
//   ## fb-abc123
//   - status: fixed        （fixed / wontfix / needs-info，也支持 已修复 / 不修复 / 需更多信息）
//   - note: 已修复下拉被裁切的问题
//   - after: ./after-shots/01.png   （可选，修复后截图，相对草稿文件或当前目录）
//
// JSON 草稿：{ "items": [{ "id": "fb-...", "status": "fixed", "note": "...", "afterImagePath": "..." }] }
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [, , feedbackArg, draftArg, outArg] = process.argv
if (!feedbackArg || !draftArg) {
  console.error('用法: node scripts/feedback-receipt.mjs <feedback.json> <receipt.md|receipt.json> [outDir]')
  process.exit(1)
}
const feedbackFile = path.resolve(feedbackArg)
const draftFile = path.resolve(draftArg)
for (const target of [feedbackFile, draftFile]) {
  if (!existsSync(target)) {
    console.error(`文件不存在: ${target}`)
    process.exit(1)
  }
}

const outDir = path.resolve(
  outArg ?? path.join(path.dirname(draftFile), 'receipt-out'),
)
mkdirSync(outDir, { recursive: true })

let feedback
try {
  feedback = JSON.parse(readFileSync(feedbackFile, 'utf8'))
} catch (err) {
  console.error(`反馈 JSON 解析失败: ${err.message}`)
  process.exit(1)
}
const sourceIds = new Set(
  (Array.isArray(feedback.items) ? feedback.items : []).map((item) => item?.id).filter(Boolean),
)

const EXT_BY_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

function normalizeStatus(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['fixed', 'fix', '已修复', '修复', 'done'].includes(text)) return 'fixed'
  if (['wontfix', "won't fix", '不修复', '不处理', 'ignore'].includes(text)) return 'wontfix'
  if (['needs-info', 'needs_info', 'need-info', '需更多信息', '需要更多信息', 'info'].includes(text)) {
    return 'needs-info'
  }
  return null
}

function imageToDataUrl(value) {
  if (!value) return undefined
  if (/^data:image\//.test(value)) return value
  const candidates = [path.resolve(path.dirname(draftFile), value), path.resolve(value)]
  const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!target) {
    console.warn(`  警告：修复后截图不存在，已跳过：${value}`)
    return undefined
  }
  const ext = path.extname(target).slice(1).toLowerCase()
  const mime = EXT_BY_MIME[ext] ?? 'image/png'
  return `data:${mime};base64,${readFileSync(target).toString('base64')}`
}

function parseMarkdown(text) {
  const items = []
  let current = null
  const flush = () => {
    if (current?.id) items.push(current)
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('#')) {
      const header = line.replace(/^#+\s*/, '')
      const match = /fb-[A-Za-z0-9_-]+/.exec(header)
      if (match) {
        flush()
        current = { id: match[0] }
      } else if (current && !line.startsWith('##')) {
        continue
      } else if (current) {
        flush()
        current = null
      }
      continue
    }
    if (!current) continue
    const field = /^[-*]\s*([A-Za-z\u4e00-\u9fa5-]+)\s*[:：]\s*(.*)$/.exec(line)
    if (!field) continue
    const key = field[1].toLowerCase()
    const value = field[2].trim()
    if (key === 'status' || key === '状态') current.status = normalizeStatus(value)
    else if (key === 'note' || key === '说明' || key === '备注') {
      current.note = current.note ? `${current.note}\n${value}` : value
    } else if (['after', 'afterimage', 'afterimagepath', '修复后', '截图'].includes(key)) {
      current.afterImage = imageToDataUrl(value)
    }
  }
  flush()
  return items
}

function parseJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    console.error(`草稿 JSON 解析失败: ${err.message}`)
    process.exit(1)
  }
  const rawItems = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
  return rawItems.map((item) => ({
    id: String(item.id ?? ''),
    status: normalizeStatus(item.status),
    note: typeof item.note === 'string' ? item.note : undefined,
    afterImage: imageToDataUrl(item.afterImage ?? item.afterImagePath ?? item.after ?? item.after_path),
  }))
}

const draftText = readFileSync(draftFile, 'utf8')
const draftItems = /\.json$/i.test(draftFile) ? parseJson(draftText) : parseMarkdown(draftText)
if (draftItems.length === 0) {
  console.error('草稿里没有解析到任何条目。请检查 Markdown 的 "## fb-..." 段落或 JSON 的 items。')
  process.exit(1)
}

const items = []
let skipped = 0
for (const draft of draftItems) {
  if (!draft.id) {
    skipped += 1
    continue
  }
  if (!draft.status) {
    console.warn(`  警告：${draft.id} 缺少合法 status（fixed/wontfix/needs-info），已按 needs-info 处理`)
    draft.status = 'needs-info'
  }
  if (!sourceIds.has(draft.id)) {
    console.warn(`  警告：反馈文件里没有 id ${draft.id}，仍写入回执`)
  }
  items.push({
    id: draft.id,
    status: draft.status,
    ...(draft.note ? { note: draft.note } : {}),
    ...(draft.afterImage ? { afterImage: draft.afterImage } : {}),
  })
}

if (items.length === 0) {
  console.error('没有可写入回执的条目。')
  process.exit(1)
}

const pad2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const filename = `tandem-feedback-receipt-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}.json`
const target = path.join(outDir, filename)
const receipt = {
  version: 1,
  sourceFile: path.basename(feedbackFile),
  items,
}
writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

const counts = items.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] ?? 0) + 1
  return acc
}, {})
console.log(`已生成回执 ${items.length} 条 → ${target}`)
console.log(
  `  ${Object.entries(counts)
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ')}${skipped ? ` · 跳过 ${skipped} 条空 id` : ''}`,
)
const withAfter = items.filter((item) => item.afterImage).length
if (withAfter) console.log(`  含修复后截图 ${withAfter} 张`)
