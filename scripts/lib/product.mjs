// product/ 规格的共享解析：product-check.mjs（检查）与 product-impact.mjs（影响清单）共用。
// 两边对「领域表、行为编号、测试名」的口径必须一致，所以解析只写这一份。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 行为编号 TREE-12；前缀是领域编号（2 个字母以上）。 */
const ID_SOURCE = '(?<![A-Za-z0-9])[A-Z]{2,}-\\d+(?![0-9])'
const ID_RE = new RegExp(ID_SOURCE, 'g')

export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

/** 递归列出文件；跳过 node_modules、dist 与点目录（.git 等）。 */
export function walk(dir, accept, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, accept, out)
    else if (accept(entry.name)) out.push(full)
  }
  return out
}

/** 字符串里出现的所有行为编号，按整词切分（TREE-1 不会从 TREE-12 里切出来）。 */
export function idsIn(text) {
  return [...text.matchAll(ID_RE)].map((match) => match[0])
}

function lineLookup(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

function tableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 4) return null
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
  return cells.length >= 3 ? cells : null
}

/** 去掉括注（「模型能力（强度/上下文）」→「模型能力」）与反引号。 */
function stripNotes(cell) {
  return cell
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/`/g, '')
    .trim()
}

function splitList(cell) {
  return stripNotes(cell)
    .split(/[、,，;；]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== '—' && item !== '-' && item !== '无')
}

/**
 * 读 product/：领域表（领域编号、概念、依赖）、领域文件及其行为编号。
 * 领域文件 = 首个一级标题以领域编号开头（`# TREE 会话树`）的 product/*.md。
 */
export function readProduct(root) {
  const dir = path.join(root, 'product')
  const readmeFile = path.join(dir, 'README.md')
  const readmeText = readText(readmeFile)
  const domains = []
  const domainById = new Map()
  for (const line of readmeText.split('\n')) {
    const cells = tableCells(line)
    if (!cells) continue
    const head = cells[0].match(/^([A-Z]{2,})\s*(.*)$/)
    if (!head) continue
    const domain = {
      id: head[1],
      title: head[2].trim(),
      concepts: splitList(cells[1]),
      deps: splitList(cells[2]),
      order: domains.length,
    }
    domains.push(domain)
    if (!domainById.has(domain.id)) domainById.set(domain.id, domain)
  }

  const markdownFiles = []
  const domainFiles = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.md')).sort()) {
      const file = path.join(dir, name)
      const text = readText(file)
      const lines = text.split('\n')
      markdownFiles.push({ file, rel: relPath(root, file), lines, text })
      if (name === 'README.md') continue
      const heading = lines.find((line) => /^#\s/.test(line)) ?? ''
      const match = heading.match(/^#\s+([A-Z]{2,})(?:\s|$)/)
      // 只有一级标题以领域编号开头的才是领域文件；ROLLOUT、漏检记录等不算。
      if (!match) continue
      domainFiles.push({
        file,
        rel: relPath(root, file),
        lines,
        text,
        domainId: match[1],
      })
    }
  }

  const occurrences = []
  for (const entry of domainFiles) {
    entry.lines.forEach((line, index) => {
      for (const id of idsIn(line)) {
        const definition = line.includes(`**${id}**`)
        occurrences.push({
          id,
          prefix: id.split('-')[0],
          domain: entry.domainId,
          file: entry.rel,
          line: index + 1,
          text: line.trim(),
          definition,
          // 迁移期约定：编号所在行标注「意图」的不要求测试（意图靠参照图与产品所有者认可）。
          intent: definition && line.includes('意图'),
        })
      }
    })
  }

  const ids = new Map()
  for (const occurrence of occurrences) {
    if (!ids.has(occurrence.id)) {
      ids.set(occurrence.id, {
        id: occurrence.id,
        domain: occurrence.domain,
        occurrences: [],
        definitions: 0,
        intent: false,
      })
    }
    const record = ids.get(occurrence.id)
    record.occurrences.push(occurrence)
    if (occurrence.definition) record.definitions += 1
    record.intent = record.intent || occurrence.intent
  }

  return {
    dir,
    readmeFile,
    readmeText,
    readmeLines: readmeText ? readmeText.split('\n').length : 0,
    domains,
    domainById,
    domainFiles,
    markdownFiles,
    occurrences,
    ids,
    requiredIds: [...ids.keys()].filter((id) => !ids.get(id).intent),
  }
}

/**
 * 测试名。覆盖单测（vitest / node --test）与端到端用例（e2e 的 desktop/mobile/small/check），
 * 同时支持 e2e/regression.mjs 单文件与 e2e/regression/ 拆分后的目录。
 * describe 名称也算：编号写在 describe 里同样能保护到这条行为。
 */
const TEST_CALL = /(?:^|[^\w.$])(it|test|describe|desktop|mobile|small|check)\s*\(\s*(['"`])([^'"`\n]{1,400}?)\2/g

export function readTestNames(root) {
  const files = new Set()
  for (const file of walk(path.join(root, 'packages'), (name) => /\.test\.(?:ts|tsx)$/.test(name))) {
    files.add(file)
  }
  const packagesDir = path.join(root, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      for (const file of walk(path.join(packagesDir, pkg, 'test'), (name) => /\.(?:ts|tsx)$/.test(name))) {
        files.add(file)
      }
    }
  }
  for (const file of walk(path.join(root, 'e2e'), (name) => name.endsWith('.mjs'))) files.add(file)
  for (const file of walk(path.join(root, 'scripts'), (name) => name.endsWith('.test.mjs'))) files.add(file)

  const names = []
  for (const file of [...files].sort()) {
    const text = readText(file)
    const lineOf = lineLookup(text)
    for (const match of text.matchAll(TEST_CALL)) {
      // match[0] 以调用名前的分隔字符开头；用调用名的位置算行号，避免记到上一行。
      const at = (match.index ?? 0) + match[0].indexOf(match[1])
      names.push({
        file: relPath(root, file),
        line: lineOf(at),
        kind: match[1],
        name: match[3],
      })
    }
  }
  return names
}

/** decisions-check 的条目（id、所在行、全文），用于「条目引用的编号必须存在」与影响清单。 */
export function readDecisions(root) {
  const file = path.join(root, 'scripts/decisions-check.mjs')
  const text = readText(file)
  const start = text.indexOf('const DECISIONS = [')
  if (start < 0) return []
  const bodyStart = text.indexOf('\n', start) + 1
  const body = text.slice(bodyStart)
  const firstLine = text.slice(0, bodyStart).split('\n').length
  const entries = []
  let current = null
  body.split('\n').forEach((line, index) => {
    if (/^  \{\s*$/.test(line)) {
      current = { id: '', line: firstLine + index, text: '' }
      entries.push(current)
      return
    }
    if (/^  \}[,]?\s*$/.test(line)) {
      current = null
      return
    }
    if (!current) return
    current.text += `${line}\n`
    const id = line.match(/\bid:\s*'([^']+)'/)
    if (id) current.id = id[1]
  })
  return entries
}

/** 条目的一句话摘要（decision 字段，去掉引号与换行拼接）。 */
export function decisionSummary(entry, max = 120) {
  const match = entry.text.match(/decision:\s*([\s\S]*?)(?=\n\s*(?:files|need|deny):|\n\s*$)/)
  const raw = (match?.[1] ?? entry.text)
    .replace(/['"`]/g, '')
    .replace(/\s*\+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

/** product/approved/ 下的截图（意图的参照物）。 */
export function readApproved(root) {
  return walk(path.join(root, 'product/approved'), (name) => /\.(?:png|jpe?g|webp|gif|svg)$/i.test(name)).map(
    (file) => relPath(root, file),
  )
}
