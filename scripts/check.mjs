#!/usr/bin/env node
/**
 * 提交前检查：构建 → UI 原语审计 → 单元测试 → 端到端冒烟。
 *
 * 用法：
 *   node scripts/check.mjs                 全量
 *   node scripts/check.mjs --skip-smoke    子代理最低要求（build + ui-audit + test）
 *   node scripts/check.mjs --skip-build    已有构建产物时只跑测试
 *   node scripts/check.mjs --keep-going    某一步失败后仍继续后续步骤
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const args = new Set(process.argv.slice(2))
const skipSmoke = args.has('--skip-smoke')
const skipBuild = args.has('--skip-build')
const keepGoing = args.has('--keep-going')

const steps = [
  {
    name: 'build',
    command: 'npm',
    args: ['run', 'build'],
    skip: skipBuild,
  },
  {
    name: 'ui-audit',
    command: process.execPath,
    args: ['scripts/ui-audit.mjs'],
  },
  {
    name: 'test',
    command: 'npm',
    args: ['test'],
  },
  {
    name: 'smoke',
    command: 'npm',
    args: ['run', 'smoke'],
    skip: skipSmoke,
  },
]

const results = []
let failed = false
for (const step of steps) {
  if (failed && !keepGoing) {
    results.push({ name: step.name, status: 'skipped', ms: 0 })
    continue
  }
  if (step.skip) {
    results.push({ name: step.name, status: 'skipped', ms: 0 })
    continue
  }
  console.log(`\n=== check: ${step.name} ===`)
  const started = Date.now()
  const child = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })
  const ms = Date.now() - started
  const ok = child.status === 0
  results.push({ name: step.name, status: ok ? 'pass' : 'fail', ms })
  if (!ok) failed = true
}

console.log('\n=== check 汇总 ===')
for (const result of results) {
  const mark = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '–'
  const label =
    result.status === 'pass' ? '通过' : result.status === 'fail' ? '失败' : '跳过'
  console.log(`${mark} ${result.name.padEnd(10)} ${label}${result.ms ? `  ${(result.ms / 1000).toFixed(1)}s` : ''}`)
}
if (failed) {
  console.log('\ncheck: 未通过')
  process.exitCode = 1
} else {
  console.log('\ncheck: 全部通过')
}
