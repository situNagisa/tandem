#!/usr/bin/env node
/**
 * 把构建风味写死进产物（构建期常量，运行时不读环境变量）：
 * - packages/server/dist/flavor.js（Host / 工作站）
 * - packages/desktop/flavor.generated.js（主进程）
 * - packages/desktop/resources/flavor.txt（安装包内的可读标记）
 * - packages/web 由 Vite define 在构建时注入，不在这里处理。
 *
 * 用法：node scripts/write-flavor.mjs [--flavor=debug|release] [--scope=all|server|desktop]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_FLAVOR_FILE = path.join(ROOT, 'packages', 'server', 'dist', 'flavor.js')
const SERVER_FLAVOR_MAP = `${SERVER_FLAVOR_FILE}.map`
const DESKTOP_FLAVOR_FILE = path.join(ROOT, 'packages', 'desktop', 'flavor.generated.js')
const DESKTOP_RESOURCES = path.join(ROOT, 'packages', 'desktop', 'resources')
const DESKTOP_FLAVOR_TXT = path.join(DESKTOP_RESOURCES, 'flavor.txt')

export function resolveBuildFlavor(value) {
  return value === 'release' ? 'release' : 'debug'
}

export function serverFlavorSource(flavor) {
  const resolved = resolveBuildFlavor(flavor)
  return `// 由 scripts/write-flavor.mjs 在构建时写死，勿手改。\nexport const FLAVOR = '${resolved}';\nexport const IS_DEBUG_FLAVOR = ${resolved === 'debug'};\n`
}

export function writeServerFlavor(flavor) {
  const resolved = resolveBuildFlavor(flavor)
  fs.mkdirSync(path.dirname(SERVER_FLAVOR_FILE), { recursive: true })
  fs.writeFileSync(SERVER_FLAVOR_FILE, serverFlavorSource(resolved))
  fs.rmSync(SERVER_FLAVOR_MAP, { force: true })
  return resolved
}

export function writeDesktopFlavor(flavor) {
  const resolved = resolveBuildFlavor(flavor)
  fs.mkdirSync(path.dirname(DESKTOP_FLAVOR_FILE), { recursive: true })
  fs.writeFileSync(
    DESKTOP_FLAVOR_FILE,
    `'use strict';\n// 由 scripts/write-flavor.mjs 在构建时写死，勿手改。\nmodule.exports = { FLAVOR: '${resolved}', IS_DEBUG_FLAVOR: ${resolved === 'debug'} };\n`,
  )
  if (fs.existsSync(DESKTOP_RESOURCES)) {
    fs.writeFileSync(DESKTOP_FLAVOR_TXT, `${resolved}\n`)
  }
  return resolved
}

function main() {
  const args = new Map(
    process.argv
      .slice(2)
      .filter((arg) => arg.startsWith('--'))
      .map((arg) => {
        const [key, value = ''] = arg.replace(/^--/, '').split('=')
        return [key, value]
      }),
  )
  const flavor = resolveBuildFlavor(args.get('flavor') ?? process.env.TANDEM_FLAVOR)
  const scope = args.get('scope') ?? 'all'
  if (scope === 'all' || scope === 'server') writeServerFlavor(flavor)
  if (scope === 'all' || scope === 'desktop') writeDesktopFlavor(flavor)
  console.log(`[flavor] ${scope} = ${flavor}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
