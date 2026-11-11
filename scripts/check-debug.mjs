#!/usr/bin/env node
/**
 * 调试产物扫描：debug 构建后确认 web / desktop main+preload / 内置 Host
 * 都是 debug 常量，且自动登录路由与反馈草稿 IPC 都在产物里。
 * 需先运行 `npm run build`（debug）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEBUG_DESKTOP_FILES,
  readDesktopFlavor,
  readServerFlavor,
  readWebFlavor,
} from './lib/artifact-flavor.mjs'
import { writeDesktopFlavor, writeServerFlavor } from './write-flavor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function read(relative) {
  const file = path.join(ROOT, relative)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function expectContains(file, needle, label = needle) {
  if (!read(file).includes(needle)) errors.push(`${file} 缺少 ${label}`)
}

// 先把 debug 常量写死，避免沿用上一次 release 构建的产物。
writeServerFlavor('debug')
writeDesktopFlavor('debug')

// Host：常量 + 自动登录路由 + 启动钩子。
const server = readServerFlavor(path.join(ROOT, 'packages/server/dist'))
if (server.flavor !== 'debug') errors.push(`server dist/flavor.js=${server.flavor || '缺失'}，期望 debug`)
if (server.readsEnv) errors.push('server dist/flavor.js 仍在运行时读 TANDEM_FLAVOR')
expectContains('packages/server/dist/workstation/server.js', 'IS_DEBUG_FLAVOR', 'debug 风味判断')
expectContains('packages/server/dist/workstation/server.js', 'debug/workstationService.js', '调试账号初始化')
expectContains('packages/server/dist/workstation/server.js', 'debug/hosts.js', '调试主机自动登记')
expectContains(
  'packages/server/dist/debug/workstationService.js',
  '/api/debug/auto-login',
  '自动登录路由',
)
expectContains('packages/server/dist/debug/hosts.js', 'ensureDebugHosts', '调试主机入口')

// Desktop：main / preload / 草稿模块。
if (readDesktopFlavor(path.join(ROOT, 'packages/desktop/flavor.generated.js')) !== 'debug') {
  errors.push('flavor.generated.js 不是 debug 常量')
}
expectContains('packages/desktop/main.js', "require('./flavor.generated.js')", '构建期 flavor')
expectContains('packages/desktop/main.js', "require('./feedback-drafts.js')", '草稿落盘模块')
expectContains('packages/desktop/main.js', '--tandem-flavor=', 'preload 启动参数')
for (const handler of [
  'feedback:sync-draft',
  'feedback:mark-exported',
  'feedback:remove-draft',
  'feedback:export-archive',
]) {
  expectContains('packages/desktop/preload.js', handler, `preload ${handler}`)
  expectContains('packages/desktop/feedback-drafts.js', handler, `草稿 IPC ${handler}`)
}
for (const file of DEBUG_DESKTOP_FILES) {
  if (!read(`packages/desktop/${file.slice(1)}`)) {
    errors.push(`调试专用桌面文件缺失：${file}`)
  }
}
for (const file of [
  ...DEBUG_DESKTOP_FILES,
  '/flavor-core.js',
  '/flavor.generated.js',
]) {
  if (!read('packages/desktop/electron-builder.yml').includes(`- ${file.slice(1)}`)) {
    errors.push(`electron-builder.yml files 白名单缺少 ${file.slice(1)}`)
  }
}

// Web：debug 构建必须带反馈模式/调试标识。
const web = readWebFlavor(path.join(ROOT, 'packages/web/dist'))
if (web !== 'debug') errors.push(`web dist flavor=${web || '缺失'}，期望 debug`)

// 安装包内的最终检查在 dist-win 打包后用 verifyDesktopBundle 做（含 app.asar 文件清单），
// 这里只验源产物，避免读到上一次 prepare-resources 留下的旧 resources。

// Node 级产物测试：不带任何风味环境变量，直接 require 构建期常量。
const env = { ...process.env }
delete env.TANDEM_FLAVOR
delete env.TANDEM_EXPECT_FLAVOR
const testResult = spawnSync(
  process.execPath,
  ['--test', 'packages/desktop/test/flavor.test.js'],
  { cwd: ROOT, stdio: 'inherit', env },
)
if (testResult.status !== 0) errors.push('flavor.test.js 未通过')

if (errors.length) {
  console.error('\n[check-debug] 调试产物检查失败：')
  for (const error of errors) console.error(`  ✗ ${error}`)
  process.exit(1)
}
console.log('\n[check-debug] 调试产物一致：web / desktop main+preload / 内置 Host 均为 debug')
