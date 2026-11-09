#!/usr/bin/env node
/**
 * 文档治理检查（快速步骤，接入 scripts/check.mjs）：
 * 1. Markdown 里的相对链接/图片必须存在；
 * 2. docs/ 根目录只允许 README 与现行文档，其余必须放进 features/、archive/、test-guides/；
 * 3. 现行文档的「更新：YYYY-MM-DD」不得早于 30 天（缺日期或过期只警告）；
 * 4. 行数上限：design ≤150、ledger ≤80、每份 features ≤80、PROGRESS ≤60、HANDOFF ≤60、AGENTS ≤50。
 *
 * 用法：node scripts/docs-check.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const DOCS = path.join(ROOT, 'docs')
const DAY = 24 * 60 * 60 * 1000
const MAX_AGE_DAYS = 30

// docs/ 根目录允许的现行文件；新增文件必须归入三个子目录之一。
const ROOT_ALLOW = new Set([
  'README.md',
  'HANDOFF.md',
  'design.md',
  'architecture.md',
  'feedback-ledger.md',
  'PROGRESS.md',
  'workstation.md',
])
const ROOT_ALLOW_DIRS = new Set(['features', 'archive', 'test-guides'])

const errors = []
const warnings = []

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

// 1. 根目录白名单
for (const name of readdirSync(DOCS)) {
  const full = path.join(DOCS, name)
  if (statSync(full).isDirectory()) {
    if (!ROOT_ALLOW_DIRS.has(name)) errors.push(`docs/${name}/：根目录只允许 features/、archive/、test-guides/ 三个子目录`)
  } else if (!ROOT_ALLOW.has(name)) {
    errors.push(`docs/${name}：现行文档请放进 features/，一次性记录放进 archive/，代测步骤放进 test-guides/`)
  }
}

// 2. 相对链接
const files = [...walk(DOCS), path.join(ROOT, 'README.md'), path.join(ROOT, 'AGENTS.md')]
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
for (const file of files) {
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8')
  // 去掉围栏代码块与行内代码，避免把示例链接当成真链接
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  for (const match of text.matchAll(LINK)) {
    const href = match[1]
    if (!href || /^(https?:|mailto:|tel:|data:|#|\/)/i.test(href)) continue
    if (/[{}*$<>]/.test(href)) continue
    const target = href.split('#')[0].split('?')[0]
    if (!target) continue
    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {
      // 保留原样
    }
    const resolved = path.resolve(path.dirname(file), decoded)
    if (!existsSync(resolved)) {
      errors.push(`${path.relative(ROOT, file)}：链接目标不存在 → ${href}`)
    }
  }
}

// 3. 现行文档更新日期
const now = Date.now()
const living = [
  ...[...ROOT_ALLOW].map((name) => path.join(DOCS, name)),
  ...walk(path.join(DOCS, 'features')),
  ...walk(path.join(DOCS, 'test-guides')),
]
for (const file of [...new Set(living)]) {
  if (!existsSync(file)) continue
  const rel = path.relative(ROOT, file)
  const content = readFileSync(file, 'utf8')
  const match = content.match(/更新[：:]\s*(\d{4})-(\d{2})-(\d{2})/)
  if (!match) {
    warnings.push(`${rel}：缺少「更新：YYYY-MM-DD」`)
    continue
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`)
  const age = Math.floor((now - date.getTime()) / DAY)
  if (age > MAX_AGE_DAYS) warnings.push(`${rel}：更新于 ${match[1]}-${match[2]}-${match[3]}，已 ${age} 天未更新`)
}

// 4. 现行文档行数上限：防止按反馈批次无限堆积；新事实写原则/检查，不写流水。
const MAX_LINES = {
  'docs/design.md': 150,
  'docs/feedback-ledger.md': 80,
  'docs/PROGRESS.md': 60,
  'docs/HANDOFF.md': 60,
  'AGENTS.md': 50,
}
const FEATURE_MAX_LINES = 80
const lineCount = (file) => readFileSync(file, 'utf8').split('\n').length
for (const [rel, max] of Object.entries(MAX_LINES)) {
  const full = path.join(ROOT, rel)
  if (!existsSync(full)) continue
  const count = lineCount(full)
  if (count > max) errors.push(`${rel}：${count} 行，超过上限 ${max} 行（写原则/检查，不写流水）`)
}
for (const file of walk(path.join(DOCS, 'features'))) {
  const count = lineCount(file)
  if (count > FEATURE_MAX_LINES) {
    errors.push(`${path.relative(ROOT, file)}：${count} 行，超过上限 ${FEATURE_MAX_LINES} 行`)
  }
}

for (const warning of warnings) console.log(`警告 ${warning}`)
for (const error of errors) console.log(`错误 ${error}`)
if (errors.length) {
  console.log(`\ndocs-check: ${errors.length} 个错误，${warnings.length} 个警告`)
  process.exit(1)
}
console.log(`\ndocs-check: 通过（${warnings.length} 个警告）`)
