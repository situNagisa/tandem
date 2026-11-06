#!/usr/bin/env node
// 解包 Tandem 反馈 JSON：截图落地为 PNG，并生成可读的 feedback.md。
// 用法：node scripts/feedback-unpack.mjs <file.json> [outDir]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const outDir = path.resolve(
  process.argv[3] ?? `${file.replace(/\.json$/i, '')}-unpacked`,
)
mkdirSync(outDir, { recursive: true })

let data
try {
  data = JSON.parse(readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`JSON 解析失败: ${err.message}`)
  process.exit(1)
}

const TYPE_LABELS = { issue: '问题', suggestion: '建议', praise: '好评' }
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

const items = Array.isArray(data.items) ? data.items : []
const pageShots = Array.isArray(data.pageShots) ? data.pageShots : []
const errors = Array.isArray(data.errors) ? data.errors : []
const lines = []

lines.push('# Tandem 反馈包', '')
const env = data.env ?? {}
const app = data.app ?? {}
lines.push(`- 导出时间：${data.exportedAt ?? '未知'}`)
lines.push(`- 应用：${app.name ?? 'Tandem'} ${app.version ?? ''}`.trim())
if (!env.route && items[0]?.route) env.route = items[0].route
if (env.route) lines.push(`- 路由：\`${env.route}\``)
if (env.viewport) {
  lines.push(`- 视口：${env.viewport.width}×${env.viewport.height} @${env.dpr ?? 1}x`)
}
if (env.theme) lines.push(`- 主题：${env.theme === 'dark' ? '深色' : '浅色'}`)
if (env.platform) lines.push(`- 平台：${env.platform}`)
if (env.hostName || env.hostPlatform || env.hostVersion) {
  lines.push(
    `- Host：${env.hostName ?? ''} ${env.hostPlatform ?? ''} ${env.hostVersion ?? ''}`.trim(),
  )
}
if (env.sessionId) lines.push(`- 会话：${env.sessionId}`)
lines.push(`- 条目：${items.length} 条`, '')

const pageFileMap = new Map()
pageShots.forEach((shot, index) => {
  const name = `page-${index + 1}.png`
  const written = writeDataUrl(shot.dataURL ?? shot.dataUrl, path.join(outDir, name))
  if (written) pageFileMap.set(shot, name)
})

items.forEach((item, index) => {
  const number = pad2(index + 1)
  const imageName = `${number}-元素截图.png`
  const written = writeDataUrl(item.screenshot, path.join(outDir, imageName))
  const type = TYPE_LABELS[item.type] ?? item.type ?? '未分类'
  lines.push(`## ${number}. ${type}`, '')
  lines.push(`- 文字：${quoteBlock(item.text)}`)
  lines.push(`- 类型：${type}`)
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
  if (written) {
    const note =
      item.screenshotKind === 'page'
        ? '（元素截图采集失败，此处为整页截图；按上面的元素位置查看）'
        : ''
    lines.push(`- 截图：\`${imageName}\`${note}`)
  } else {
    lines.push('- 截图：（无）')
  }
  if (item.createdAt) lines.push(`- 记录时间：${new Date(item.createdAt).toISOString()}`)
  lines.push('')
})

if (pageShots.length) {
  lines.push('## 整页截图', '')
  pageShots.forEach((shot, index) => {
    const name = pageFileMap.get(shot) ?? `page-${index + 1}.png`
    const size = shot.width && shot.height ? `（${shot.width}×${shot.height}）` : ''
    lines.push(`- 第 ${index + 1} 页${shot.route ? ` ${shot.route}` : ''}：\`${name}\`${size}`)
  })
  lines.push('')
}

lines.push(`## 最近错误（${errors.length}）`, '')
if (errors.length === 0) {
  lines.push('无记录。', '')
} else {
  errors.forEach((error, index) => {
    const time = error.time ? new Date(error.time).toISOString() : '未知时间'
    lines.push(`### ${index + 1}. ${error.source ?? 'error'} · ${time}`, '')
    lines.push('```')
    lines.push(oneLine(error.message).slice(0, 4000))
    if (error.stack) lines.push('', oneLine(error.stack).slice(0, 4000))
    lines.push('```', '')
  })
}

const mdPath = path.join(outDir, 'feedback.md')
writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8')

const images = [...items.map((item) => item.screenshot), ...pageShots.map((shot) => shot.dataURL)].filter(
  Boolean,
).length
console.log(`已解包 ${items.length} 条反馈、${pageShots.length} 张整页截图 → ${outDir}`)
console.log(`  图片 ${images} 张，索引 ${mdPath}`)
