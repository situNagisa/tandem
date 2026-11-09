#!/usr/bin/env node
/**
 * 发布产物扫描：确认调试专用模块没有进入 web dist / server dist。
 * 需先运行 `node scripts/build-flavor.mjs release`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDist = path.join(ROOT, 'packages', 'web', 'dist')
const serverDist = path.join(ROOT, 'packages', 'server', 'dist')

const WEB_FORBIDDEN = [
  '演示',
  '反馈模式',
  '体验清单',
  '组件画廊',
  '调试版',
  '手机预览',
  'MobilePreview',
  'mobile-preview',
  'setTouchEmulationEnabled',
  'setEmitTouchEventsForMouse',
  'FeedbackMode',
  'FeedbackAnnotator',
  'FeedbackDrawer',
  'useFeedbackStore',
  'feedbackCapture',
  'feedbackTrace',
  // 反馈草稿实时落盘与 .tfb 包（调试版专用）
  'feedbackArchive',
  'feedbackDrafts',
  'createZip',
  'feedback:sync-draft',
  'tandem.feedback.snapshotPrefs',
  'DemoDialog',
  'ChecklistDialog',
  'UiGallery',
  'useDemoStore',
  'DemoDeviceStage',
  'demo-model',
  // 调试版内置工作站账号
  '调试账号',
  '/api/debug/auto-login',
  'debug-account',
  'tandem.debug.account.autologin',
]

const SERVER_FORBIDDEN = [
  '演示',
  '反馈模式',
  '体验清单',
  '组件画廊',
  '/api/demo',
  'demo-model',
  'DEMO_SCENARIOS',
  'streamDemo',
  // 调试版内置工作站账号
  '调试账号',
  '/api/debug/auto-login',
  'debug-account',
]

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(file, exts))
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(file)
  }
  return out
}

function scan(label, files, forbidden) {
  const failures = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const token of forbidden) {
      if (text.includes(token)) {
        failures.push(`${path.relative(ROOT, file)} 含「${token}」`)
      }
    }
  }
  if (failures.length) {
    console.error(`[scan-release] ${label} 未通过：`)
    for (const item of failures) console.error(`  - ${item}`)
    return false
  }
  console.log(`[scan-release] ${label} 通过（${files.length} 个文件）`)
  return true
}

let ok = true
const webFiles = listFiles(webDist, ['.js'])
if (!webFiles.length) {
  console.error('[scan-release] 未找到 web dist JS，请先构建 release。')
  ok = false
} else {
  ok = scan('web dist', webFiles, WEB_FORBIDDEN) && ok
}

const serverFiles = listFiles(serverDist, ['.js'])
if (!serverFiles.length) {
  console.error('[scan-release] 未找到 server dist JS，请先构建 release。')
  ok = false
} else {
  ok = scan('server dist', serverFiles, SERVER_FORBIDDEN) && ok
}

const flavorFile = path.join(serverDist, 'flavor.js')
if (!fs.existsSync(flavorFile) || !fs.readFileSync(flavorFile, 'utf8').includes("FLAVOR = 'release'")) {
  console.error('[scan-release] server dist/flavor.js 未固定为 release')
  ok = false
}

if (!ok) {
  console.error('\n[scan-release] 发现调试专用内容，发布构建失败')
  process.exit(1)
}
console.log('\n[scan-release] 全部通过')
