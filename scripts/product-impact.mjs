#!/usr/bin/env node
/**
 * 编号影响清单：改一条产品行为前，先看清谁在引用它。
 *
 * 列出：
 * - product/ 里引用该编号的规格段落（含所属章节）；
 * - 测试名引用该编号的位置（文件:行，覆盖单测与 e2e，兼容 e2e/regression.mjs 与拆分后的目录）；
 * - scripts/decisions-check.mjs 里引用该编号的用户决定；
 * - product/approved/ 下的参照截图（文件名含编号，或所在目录就是该编号的领域）；
 * - 代码注释里引用该编号的位置。
 * 输出 Markdown，直接贴进变更单。
 *
 * 用法：node scripts/product-impact.mjs TREE-12 [TREE-14 …]
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  decisionSummary,
  idsIn,
  readApproved,
  readDecisions,
  readProduct,
  readTestNames,
  readText,
  relPath,
  walk,
} from './lib/product.mjs'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const wanted = [...new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('-')).map((arg) => arg.trim().toUpperCase()))]
if (wanted.length === 0) {
  console.error('用法：node scripts/product-impact.mjs <编号…>，例如 TREE-12')
  process.exit(2)
}

const product = readProduct(ROOT)
const tests = readTestNames(ROOT)
const decisions = readDecisions(ROOT)
const approved = readApproved(ROOT)

const sourceFiles = []
const packagesDir = path.join(ROOT, 'packages')
if (existsSync(packagesDir)) {
  for (const pkg of readdirSync(packagesDir)) {
    sourceFiles.push(
      ...walk(path.join(packagesDir, pkg, 'src'), (name) => /\.(?:ts|tsx|css)$/.test(name)),
    )
  }
}

/** 行所在的章节标题链（`# TREE 会话树 › 一棵树在侧栏只占一行`）。 */
function headingChain(lines, upto) {
  const stack = []
  for (let index = 0; index <= upto && index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/)
    if (!match) continue
    const level = match[1].length
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, text: match[2].trim() })
  }
  return stack.map((item) => item.text).join(' › ')
}

/**
 * 一行里属于注释的区间。用来区分「注释提到编号」与「字符串/选择器里恰好有编号」。
 * 已进入块注释的状态从上一行传入。
 */
function commentSegments(line, inBlock) {
  const segments = []
  let block = inBlock
  let index = 0
  let start = block ? 0 : -1
  while (index < line.length) {
    if (block) {
      const end = line.indexOf('*/', index)
      if (end < 0) {
        segments.push({ from: start, to: line.length })
        index = line.length
      } else {
        segments.push({ from: start, to: end + 2 })
        block = false
        index = end + 2
        start = -1
      }
      continue
    }
    const lineComment = line.indexOf('//', index)
    const blockComment = line.indexOf('/*', index)
    if (lineComment >= 0 && (blockComment < 0 || lineComment < blockComment)) {
      segments.push({ from: lineComment, to: line.length })
      index = line.length
    } else if (blockComment < 0) {
      index = line.length
    } else {
      block = true
      start = blockComment
      index = blockComment + 2
    }
  }
  return { segments, block }
}

const commentHits = new Map()
for (const id of wanted) commentHits.set(id, [])
for (const file of sourceFiles) {
  const rel = relPath(ROOT, file)
  const lines = readText(file).split('\n')
  let block = false
  lines.forEach((line, index) => {
    const found = idsIn(line)
    const state = commentSegments(line, block)
    block = state.block
    if (found.length === 0) return
    for (const id of found) {
      if (!commentHits.has(id)) continue
      const at = line.indexOf(id)
      if (!state.segments.some((segment) => at >= segment.from && at < segment.to)) continue
      commentHits.get(id).push({ file: rel, line: index + 1, text: line.trim() })
    }
  })
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const cell = (text) => text.replace(/\|/g, '\\|')

const labelOf = (id) => {
  const record = product.ids.get(id)
  const definition = record?.occurrences.find((item) => item.definition) ?? record?.occurrences[0]
  if (!definition) return ''
  return shorten(
    definition.text
      .replace(/\*\*/g, '')
      .replace(/^[-*]\s+/, '')
      .replace(new RegExp(`^${id}\\s*`), ''),
    80,
  )
}

const lines = []
lines.push(`# 编号影响清单：${wanted.join('、')}`)
lines.push('')
lines.push(`> 由 \`node scripts/product-impact.mjs ${wanted.join(' ')}\` 生成；规格改动时把它贴进变更单，确认测试、用户决定与参照图都跟着改。`)
lines.push('')
lines.push('| 编号 | 规格引用 | 测试 | 用户决定 | 参照截图 | 代码注释 |')
lines.push('|---|---:|---:|---:|---:|---:|')
for (const id of wanted) {
  const spec = product.occurrences.filter((item) => item.id === id)
  lines.push(
    `| ${id} | ${spec.length} | ${tests.filter((test) => idsIn(test.name).includes(id)).length} | ${
      decisions.filter((entry) => idsIn(entry.text).includes(id)).length
    } | ${approved.filter((file) => file.includes(id) || file.includes(`/${id.split('-')[0].toLowerCase()}/`)).length} | ${
      commentHits.get(id).length
    } |`,
  )
}
lines.push('')

let missingAny = false
for (const id of wanted) {
  const record = product.ids.get(id)
  const prefix = id.split('-')[0]
  lines.push(`## ${id} ${labelOf(id)}`.trim())
  if (!product.domainById.has(prefix)) missingAny = true
  if (!record) {
    lines.push('')
    lines.push('> ⚠ product/ 中没有这个编号：规格尚未写，或编号拼错。')
  } else {
    const domainTitle = product.domainById.get(prefix)
    lines.push('')
    lines.push(`领域：${domainTitle ? `${prefix} ${domainTitle.title}` : prefix}（\`${record.occurrences[0].file}\`）`)
  }
  lines.push('')

  // 规格段落
  lines.push('### 规格')
  const specHits = product.occurrences.filter((item) => item.id === id)
  if (specHits.length === 0) lines.push('（无）')
  for (const hit of specHits) {
    const file = product.domainFiles.find((item) => item.rel === hit.file)
    const chain = file ? headingChain(file.lines, hit.line - 1) : ''
    const text = hit.text.replace(/\*\*/g, '').replace(/^[-*]\s+/, '')
    lines.push(`- \`${hit.file}:${hit.line}\`${chain ? ` ${chain}` : ''}`)
    lines.push(`  ${cell(shorten(text, 200))}`)
  }
  lines.push('')

  // 测试
  lines.push('### 测试')
  const testHits = tests.filter((test) => idsIn(test.name).includes(id))
  if (testHits.length === 0) lines.push('（无：这条编号还没有测试守住）')
  for (const hit of testHits) lines.push(`- \`${hit.file}:${hit.line}\` ${hit.kind} — ${cell(hit.name)}`)
  lines.push('')

  // 用户决定
  lines.push('### 用户决定（decisions-check）')
  const decisionHits = decisions.filter((entry) => idsIn(entry.text).includes(id))
  if (decisionHits.length === 0) lines.push('（无）')
  for (const hit of decisionHits) {
    lines.push(`- \`${hit.id}\`（scripts/decisions-check.mjs:${hit.line}）— ${cell(decisionSummary(hit))}`)
  }
  lines.push('')

  // 参照截图
  lines.push('### 参照截图（product/approved/）')
  const domainDir = `product/approved/${(record?.domain ?? prefix).toLowerCase()}/`
  const inDir = approved.filter((file) => file.startsWith(domainDir))
  const byName = approved.filter((file) => path.basename(file).includes(id))
  const shots = [
    ...byName.map((file) => ({ file, why: '文件名含编号' })),
    ...inDir.filter((file) => !byName.includes(file)).map((file) => ({ file, why: '该领域目录' })),
  ]
  if (shots.length === 0) lines.push('（无）')
  for (const shot of shots) lines.push(`- \`${shot.file}\`（${shot.why}）`)
  lines.push('')

  // 代码注释
  lines.push('### 代码注释')
  const codeHits = commentHits.get(id)
  if (codeHits.length === 0) lines.push('（无）')
  for (const hit of codeHits) lines.push(`- \`${hit.file}:${hit.line}\` ${cell(shorten(hit.text, 160))}`)
  lines.push('')
}

console.log(lines.join('\n').trimEnd())
if (missingAny) process.exitCode = 1
