#!/usr/bin/env node
/**
 * Windows/macOS 文件系统不区分大小写：同一目录里主体名只差大小写的模块（如 Foo.tsx 与 foo.ts），
 * 在 Linux 上能构建，在 Windows 上 `import './Foo'` 会解析到另一个文件。这里在 Linux 上提前拦下。
 *
 * 用法：node scripts/case-check.mjs
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const groups = new Map()
for (const file of files) {
  const dir = path.posix.dirname(file)
  // 模块解析会省略扩展名，所以按「目录 + 去扩展名的主体名」比较。
  const stem = path.posix.basename(file).replace(/\.(tsx?|jsx?|mjs|cjs|d\.ts)$/, '')
  const key = `${dir}/${stem}`.toLowerCase()
  const list = groups.get(key) ?? []
  list.push(file)
  groups.set(key, list)
}

const problems = []
for (const list of groups.values()) {
  const stems = new Set(list.map((file) => file.replace(/\.(tsx?|jsx?|mjs|cjs|d\.ts)$/, '')))
  if (stems.size > 1) problems.push(list.join('  ↔  '))
}

if (problems.length > 0) {
  console.log('case-check: 以下文件名只差大小写，在 Windows 上会互相遮挡：')
  for (const problem of problems) console.log(`  ${problem}`)
  process.exitCode = 1
} else {
  console.log(`case-check: 通过（${files.length} 个文件）`)
}
