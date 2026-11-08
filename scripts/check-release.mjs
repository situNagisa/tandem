#!/usr/bin/env node
/**
 * 发布风味检查：构建 release → 扫描产物 → 跑发布版页面回归 → 恢复 debug 构建。
 * 回归测试本身仍在 debug flavor 下运行；这一步只验证发布产物。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(label, command, args) {
  console.log(`\n=== release: ${label} ===`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`${label} 失败（退出码 ${result.status}）`)
}

let failed = false
try {
  run('构建', process.execPath, ['scripts/build-flavor.mjs', 'release'])
  run('扫描产物', process.execPath, ['scripts/scan-release.mjs'])
  run('页面回归', process.execPath, ['e2e/release-flavor.mjs'])
} catch (err) {
  failed = true
  console.error(`\n[release] ${err.message}`)
} finally {
  // 后续开发与回归继续使用 debug 构建。
  try {
    run('恢复 debug 构建', process.execPath, ['scripts/build-flavor.mjs', 'debug'])
  } catch (err) {
    failed = true
    console.error(`\n[release] 恢复 debug 构建失败：${err.message}`)
  }
}

if (failed) process.exit(1)
console.log('\n[release] 发布风味检查通过')
