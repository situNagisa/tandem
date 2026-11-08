#!/usr/bin/env node
/**
 * 按风味构建：node scripts/build-flavor.mjs debug|release
 *
 * - debug（默认）：包含反馈模式、演示工作区、体验清单、组件画廊等调试工具；
 * - release：Web 用 Vite define 剔除调试入口与模块，server 构建后移除演示路由、
 *   演示剧本与内置演示模型，并把 dist/flavor.js 固定为 release。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flavor = process.argv[2] === 'release' ? 'release' : 'debug'

function run(step, command, args) {
  console.log(`\n[build:${flavor}] $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TANDEM_FLAVOR: flavor },
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`${step} 失败（退出码 ${result.status}）`)
  }
}

try {
  run('构建', 'npm', ['run', 'build'])
  if (flavor === 'release') {
    run('剔除调试模块', process.execPath, ['scripts/strip-debug-dist.mjs'])
  }
  console.log(`\n[build:${flavor}] 完成`)
} catch (err) {
  console.error(`\n[build:${flavor}] 失败：${err.message}`)
  process.exit(1)
}
