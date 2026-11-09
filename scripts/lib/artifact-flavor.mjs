// 产物风味检查的共享实现：web / server / desktop 产物里的 flavor 必须一致。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

export const DEBUG_DESKTOP_FILES = [
  '/feedback-drafts.js',
  '/feedback-drafts-core.js',
  '/mobile-preview.js',
]

export const DESKTOP_REQUIRED_FILES = {
  all: ['/main.js', '/preload.js', '/flavor.generated.js', '/package.json'],
  debug: DEBUG_DESKTOP_FILES,
}

/** web 产物是 debug 还是 release：debug 包带反馈模式/调试角标，release 包被扫描禁止。 */
export function readWebFlavor(webDir) {
  const assets = path.join(webDir, 'assets')
  if (!fs.existsSync(assets)) return null
  for (const file of fs.readdirSync(assets)) {
    if (!file.endsWith('.js')) continue
    const text = fs.readFileSync(path.join(assets, file), 'utf8')
    if (text.includes('FeedbackMode') || text.includes('调试版')) return 'debug'
  }
  return fs.existsSync(path.join(webDir, 'index.html')) ? 'release' : null
}

/** server dist/flavor.js 必须是写死的常量，不能读运行环境。 */
export function readServerFlavor(serverDist) {
  const file = path.join(serverDist, 'flavor.js')
  if (!fs.existsSync(file)) return { flavor: null, readsEnv: false, source: '' }
  const source = fs.readFileSync(file, 'utf8')
  const match = /export const FLAVOR = '(debug|release)'/.exec(source)
  return {
    flavor: match ? match[1] : null,
    readsEnv: source.includes('process.env.TANDEM_FLAVOR'),
    source,
  }
}

/** 桌面 flavor.generated.js 的常量。 */
export function readDesktopFlavor(file) {
  if (!fs.existsSync(file)) return null
  const match = /FLAVOR:\s*'(debug|release)'/.exec(fs.readFileSync(file, 'utf8'))
  return match ? match[1] : null
}

export function readAsarFile(archive, name) {
  return asar.extractFile(archive, name.replace(/^\//, '')).toString('utf8')
}

export function listAsar(archive) {
  return asar.listPackage(archive)
}

/**
 * 检查安装包内 resources 目录：flavor.txt、app.asar 里的桌面模块、内置 server/web。
 * 返回错误列表（空数组表示通过）。
 */
export function verifyDesktopBundle(resourcesDir, expectedFlavor) {
  const errors = []
  const flavorFile = path.join(resourcesDir, 'flavor.txt')
  const flavorText = fs.existsSync(flavorFile)
    ? fs.readFileSync(flavorFile, 'utf8').trim()
    : ''
  if (flavorText !== expectedFlavor) {
    errors.push(`resources/flavor.txt=${JSON.stringify(flavorText)}，期望 ${expectedFlavor}`)
  }

  const archive = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(archive)) {
    errors.push('缺少 resources/app.asar')
  } else {
    const entries = new Set(listAsar(archive))
    for (const file of DESKTOP_REQUIRED_FILES.all) {
      if (!entries.has(file)) errors.push(`app.asar 缺少 ${file}`)
    }
    if (expectedFlavor === 'debug') {
      for (const file of DESKTOP_REQUIRED_FILES.debug) {
        if (!entries.has(file)) errors.push(`调试版 app.asar 缺少 ${file}`)
      }
    } else {
      for (const file of DEBUG_DESKTOP_FILES) {
        if (entries.has(file)) errors.push(`发布版 app.asar 不应包含 ${file}`)
      }
    }
    try {
      const generated = readAsarFile(archive, 'flavor.generated.js')
      const match = /FLAVOR:\s*'(debug|release)'/.exec(generated)
      if (!match || match[1] !== expectedFlavor) {
        errors.push(`app.asar 内 flavor.generated.js 不是 ${expectedFlavor}`)
      }
      const main = readAsarFile(archive, 'main.js')
      if (!main.includes("require('./flavor.generated.js')")) {
        errors.push('app.asar 内 main.js 没有读取构建期 flavor.generated.js')
      }
      if (expectedFlavor === 'debug') {
        const preload = readAsarFile(archive, 'preload.js')
        for (const handler of [
          'feedback:sync-draft',
          'feedback:mark-exported',
          'feedback:remove-draft',
          'feedback:export-archive',
        ]) {
          if (!preload.includes(handler)) errors.push(`app.asar 内 preload.js 缺少 ${handler}`)
        }
        const drafts = readAsarFile(archive, 'feedback-drafts.js')
        for (const handler of [
          'feedback:sync-draft',
          'feedback:mark-exported',
          'feedback:remove-draft',
          'feedback:export-archive',
        ]) {
          if (!drafts.includes(handler)) errors.push(`app.asar 内 feedback-drafts.js 缺少 ${handler}`)
        }
      }
    } catch (err) {
      errors.push(`读取 app.asar 失败：${err.message}`)
    }
  }

  const server = readServerFlavor(path.join(resourcesDir, 'server', 'dist'))
  if (server.flavor !== expectedFlavor) {
    errors.push(`内置 server flavor=${server.flavor || '缺失'}，期望 ${expectedFlavor}`)
  }
  if (server.readsEnv) {
    errors.push('内置 server flavor.js 仍在运行时读 TANDEM_FLAVOR')
  }
  if (expectedFlavor === 'debug') {
    const bootstrap = path.join(resourcesDir, 'server', 'dist', 'debug', 'workstationBootstrap.js')
    const service = path.join(resourcesDir, 'server', 'dist', 'debug', 'workstationService.js')
    if (!fs.existsSync(bootstrap)) errors.push('内置 server 缺少调试账号启动钩子')
    if (!fs.existsSync(service) || !fs.readFileSync(service, 'utf8').includes('/api/debug/auto-login')) {
      errors.push('内置 server 缺少 /api/debug/auto-login')
    }
  }

  const web = readWebFlavor(path.join(resourcesDir, 'web', 'dist'))
  if (web !== expectedFlavor) {
    errors.push(`内置 web flavor=${web || '缺失'}，期望 ${expectedFlavor}`)
  }
  return errors
}
