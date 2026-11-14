#!/usr/bin/env node
/**
 * 对比拆分前后的用例名列表，确保拆分只搬代码、不增不减。
 *
 * 用法：
 *   node e2e/regression/compare-cases.mjs <拆分前的 regression.mjs>
 *   node e2e/regression/compare-cases.mjs --before <文件> [--after <文件>]
 *
 * 默认「拆分后」取当前 e2e/regression/ 下的功能文件（注册一遍收集名称）。
 * 名称按出现次数比较（重名用例也要一致）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname)

function namesFromSingleFile(file) {
  const names = []
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const helper = line.match(/^\s*(?:desktop|mobile|small|fb2102|fbAdjust|fbAdjustMobile)\(\s*(['"])(.*?)\1/)
    if (helper) {
      names.push(helper[2])
      continue
    }
    if (/^\s*checks\.push\(\{/.test(line)) {
      const inline = line.match(/name:\s*(['"])(.*?)\1/)
      if (inline) {
        names.push(inline[2])
        continue
      }
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const name = lines[j].match(/^\s*name:\s*(['"])(.*?)\1/)
        if (name) {
          names.push(name[2])
          break
        }
      }
    }
  }
  return names
}

async function namesFromModules(dir) {
  const names = []
  const checks = []
  const register = (name) => checks.push({ name })
  const ctx = {
    desktop: register,
    mobile: register,
    small: register,
    fb2102: register,
    fbAdjust: register,
    fbAdjustMobile: register,
  }
  const { readdirSync } = await import('node:fs')
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.mjs') || ['map.mjs', 'compare-cases.mjs'].includes(file)) continue
    const module = await import(pathToFileURL(path.join(dir, file)).href)
    if (typeof module.register !== 'function') continue
    module.register(checks, ctx)
  }
  for (const item of checks) names.push(item.name)
  return names
}

const argv = process.argv.slice(2)
const beforeIndex = argv.indexOf('--before')
const afterIndex = argv.indexOf('--after')
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !['--before', '--after'].includes(argv[i - 1] ?? ''))
const before = beforeIndex >= 0 ? argv[beforeIndex + 1] : positional[0]
const after = afterIndex >= 0 ? argv[afterIndex + 1] : path.join(ROOT, 'e2e/regression')

if (!before) {
  console.error('用法：node e2e/regression/compare-cases.mjs --before <拆分前的 regression.mjs> [--after <功能文件目录>]')
  process.exit(2)
}

const beforeNames = namesFromSingleFile(path.resolve(before))
const afterNames = after.endsWith('.mjs')
  ? namesFromSingleFile(path.resolve(after))
  : await namesFromModules(path.resolve(after))

const count = (names) => {
  const map = new Map()
  for (const name of names) map.set(name, (map.get(name) ?? 0) + 1)
  return map
}
const a = count(beforeNames)
const b = count(afterNames)
const missing = [...a].flatMap(([name, n]) => Array.from({ length: n - (b.get(name) ?? 0) }, () => name))
const extra = [...b].flatMap(([name, n]) => Array.from({ length: n - (a.get(name) ?? 0) }, () => name))

console.log(`拆分前 ${beforeNames.length} 条，拆分后 ${afterNames.length} 条`)
if (missing.length || extra.length) {
  for (const name of missing) console.log(`- 缺少：${name}`)
  for (const name of extra) console.log(`+ 多出：${name}`)
  process.exit(1)
}
console.log('用例名列表完全一致')
