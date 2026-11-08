#!/usr/bin/env node
/**
 * 发布一个新版本：
 *   node scripts/release.mjs 0.2.0 [--dry-run] [--no-commit] [--no-tag] [--allow-empty-tour]
 *
 * - 统一更新根目录与 packages/* 的 package.json（含内部 @tandem/* 依赖）和 package-lock.json；
 * - 用 git log 生成 CHANGELOG.md 的版本一节（新功能/修复/性能/重构）；
 * - 新功能导览 packages/web/src/lib/changelog.ts 不自动生成：要求该版本已有手写条目，
 *   否则打印提示并中止；本版确实没有面向用户的更新时加 --allow-empty-tour 跳过；
 * - 默认提交这些文件并打本地标签 v<版本>（不 push）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 正式发布只允许 release flavor；调试包用 apk / dist:win:debug 单独出。
if (process.env.TANDEM_FLAVOR && process.env.TANDEM_FLAVOR !== 'release') {
  console.error(`[release] 发布必须使用 release flavor（当前 TANDEM_FLAVOR=${process.env.TANDEM_FLAVOR}）`)
  process.exit(1)
}
process.env.TANDEM_FLAVOR = 'release'
const args = process.argv.slice(2)
const version = args.find((arg) => !arg.startsWith('-'))
const dryRun = args.includes('--dry-run')
const noCommit = args.includes('--no-commit')
const noTag = args.includes('--no-tag')
const allowEmptyTour = args.includes('--allow-empty-tour')

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    '用法：node scripts/release.mjs <主>.<次>.<修订> [--dry-run] [--no-commit] [--no-tag] [--allow-empty-tour]',
  )
  process.exit(1)
}
const tagName = `v${version}`
const tourFile = path.join(ROOT, 'packages', 'web', 'src', 'lib', 'changelog.ts')

function hasTourEntry() {
  if (!fs.existsSync(tourFile)) return false
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`version:\\s*['"]${escaped}['"]`).test(fs.readFileSync(tourFile, 'utf8'))
}

if (!allowEmptyTour && !hasTourEntry()) {
  console.error(
    `[release] ${path.relative(ROOT, tourFile)} 还没有 ${version} 的新功能导览条目。\n` +
      '请先人工补充：面向用户的一句话标题与说明、稳定的语义 id，以及指向真实位置的 target；\n' +
      '补完后重新运行本脚本。若本版确实没有面向用户的更新，可加 --allow-empty-tour 跳过。',
  )
  process.exit(1)
}

function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const packageFiles = [
  path.join(ROOT, 'package.json'),
  ...fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ROOT, 'packages', entry.name, 'package.json'))
    .filter((file) => fs.existsSync(file)),
]

const changed = []
const manifests = packageFiles.map((file) => ({ file, pkg: readJson(file) }))
const workspaceNames = new Set(manifests.map(({ pkg }) => pkg.name).filter(Boolean))

function bumpDeps(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, range] of Object.entries(deps)) {
      if (workspaceNames.has(name) && /^\d+\.\d+\.\d+$/.test(String(range))) deps[name] = version
    }
  }
}

for (const { file, pkg } of manifests) {
  let touched = false
  if (pkg.version !== version) {
    pkg.version = version
    touched = true
  }
  bumpDeps(pkg)
  if (touched) changed.push(file)
  if (!dryRun) writeJson(file, pkg)
}

// package-lock：根版本、各 workspace 版本与内部依赖版本同步。
const lockFile = path.join(ROOT, 'package-lock.json')
if (fs.existsSync(lockFile)) {
  const lock = readJson(lockFile)
  let touched = false
  if (lock.version !== version) {
    lock.version = version
    touched = true
  }
  const rootEntry = lock.packages?.['']
  if (rootEntry && rootEntry.version !== version) {
    rootEntry.version = version
    touched = true
  }
  for (const { pkg } of manifests) {
    const entry = Object.entries(lock.packages ?? {}).find(
      ([key, value]) => key.startsWith('packages/') && value?.name === pkg.name,
    )
    if (!entry) continue
    const [, value] = entry
    if (value.version !== version) {
      value.version = version
      touched = true
    }
    bumpDeps(value)
  }
  if (touched) changed.push(lockFile)
  if (!dryRun) writeJson(lockFile, lock)
}

// ---------- CHANGELOG.md ----------

const GROUPS = [
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
]

function previousTag() {
  try {
    const tags = git(['tag', '--list', 'v*', '--sort=-v:refname'])
      .split('\n')
      .filter((tag) => tag && tag !== tagName)
    return tags[0] ?? ''
  } catch {
    return ''
  }
}

function parseCommit(subject) {
  const match = /^(feat|fix|perf|refactor)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
  if (!match) return undefined
  return { type: match[1], scope: match[2] ?? '', title: match[3].trim() }
}

function listCommits() {
  const range = previousTag() ? `${previousTag()}..HEAD` : 'HEAD'
  const raw = git(['log', range, '--pretty=format:%h%x09%s'])
  if (!raw) return []
  return raw
    .split('\n')
    .map((line) => {
      const [hash, subject] = line.split('\t')
      const parsed = parseCommit(subject ?? '')
      return parsed ? { hash, ...parsed } : undefined
    })
    .filter(Boolean)
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|')
}

const commits = listCommits()
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())

function buildChangelogSection() {
  const lines = [`## ${version} — ${today}`, '']
  let count = 0
  for (const [type, label] of GROUPS) {
    const items = commits.filter((commit) => commit.type === type)
    if (!items.length) continue
    lines.push(`### ${label}`, '')
    for (const commit of items) {
      const scope = commit.scope ? `**${escapeCell(commit.scope)}**：` : ''
      lines.push(`- ${scope}${escapeCell(commit.title)}（${commit.hash}）`)
      count++
    }
    lines.push('')
  }
  if (!count) {
    lines.push('### 维护', '', '- 本次发布包含依赖更新与内部维护。', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

const changelogFile = path.join(ROOT, 'CHANGELOG.md')
const section = buildChangelogSection()

function updateChangelog() {
  const fallback = '# 更新日志\n\n'
  let text = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : fallback
  if (!/^#\s/m.test(text)) text = `${fallback}${text}`
  const parts = text.split(/\n(?=## )/)
  const header = parts.shift().trimEnd()
  const index = parts.findIndex((part) => part.startsWith(`## ${version}`))
  if (index >= 0) parts[index] = section.trimEnd()
  else parts.unshift(section.trimEnd())
  text = `${header}\n\n${parts.join('\n\n')}\n`
  if (!dryRun) fs.writeFileSync(changelogFile, text)
  if (!changed.includes(changelogFile)) changed.push(changelogFile)
  return text
}

updateChangelog()

// ---------- 输出 / 提交 / 打标签 ----------

if (dryRun) {
  console.log(`[release] 演练 ${version}（不写文件、不提交、不打标签）`)
  console.log('\n将更新：')
  for (const file of changed) console.log(`  ${path.relative(ROOT, file)}`)
  console.log('\n----- CHANGELOG 新一节 -----\n')
  console.log(section)
  console.log('----- 新功能导览 -----\n')
  console.log(hasTourEntry() ? `${version} 已有手写条目，保持原样。` : '本次跳过（--allow-empty-tour）。')
  process.exit(0)
}

console.log(`[release] 已写入 ${changed.length} 个文件`)
if (changed.includes(changelogFile)) console.log(`  CHANGELOG.md 增加 ${version}`)
console.log(
  hasTourEntry()
    ? `  新功能导览：沿用 ${version} 的手写条目`
    : '  新功能导览：本次跳过（--allow-empty-tour）',
)

if (noCommit) {
  console.log('\n[release] 已跳过提交与标签（--no-commit）。检查改动后自行提交：')
  console.log(`  git add ${changed.map((file) => path.relative(ROOT, file)).join(' ')}`)
  process.exit(0)
}

const staged = git(['diff', '--cached', '--name-only'])
if (staged) {
  console.error('\n[release] 暂存区已有改动，为避免把无关文件带进发布提交，已停止。\n请先提交或取消暂存后重试。')
  process.exit(1)
}

git(['add', ...changed.map((file) => path.relative(ROOT, file))])
git(['commit', '-m', `chore(release): ${version}`])
console.log(`[release] 已提交 chore(release): ${version}`)

if (!noTag) {
  try {
    git(['rev-parse', '--verify', `refs/tags/${tagName}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    console.error(`[release] 标签 ${tagName} 已存在，未重复创建。`)
    process.exit(1)
  } catch {
    // 不存在，继续
  }
  git(['tag', '-a', tagName, '-m', `Tandem ${version}`])
  console.log(`[release] 已创建本地标签 ${tagName}（未 push）`)
}
