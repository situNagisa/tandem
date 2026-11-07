#!/usr/bin/env node
/**
 * UI 原语防回退检查：除 packages/web/src/components/ui/ 外，不允许再手写
 * 菜单 / 列表弹层 / 下拉。发现可疑模式时输出 file:line 并以 1 退出。
 *
 * 用法：node scripts/ui-audit.mjs [--json]
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'packages/web/src')
const UI_DIR = join(SRC, 'components/ui')
const json = process.argv.includes('--json')

const CHECKS = [
  { id: 'role-menu', label: '手写 role="menu"/"listbox"', re: /role="(?:menu|listbox)"/g },
  { id: 'popover-panel', label: '手写 popover-panel 弹层', re: /popover-panel/g },
  { id: 'menu-row-height', label: '硬编码菜单行高 h-[26..29px]', re: /(?<![\w-])h-\[2[6-9]px\]/g },
  { id: 'native-select', label: '原生 <select>，应改用 ui/MenuSelect', re: /<select\b/g },
]

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = (await walk(SRC)).filter((file) => !file.startsWith(UI_DIR + '/'))
const issues = []
for (const file of files) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    for (const check of CHECKS) {
      check.re.lastIndex = 0
      if (!check.re.test(line)) continue
      issues.push({
        file: relative(ROOT, file),
        line: i + 1,
        check: check.id,
        label: check.label,
        text: line.trim().slice(0, 160),
      })
    }
  }
}

if (json) {
  console.log(JSON.stringify({ count: issues.length, issues }, null, 2))
} else if (issues.length === 0) {
  console.log('ui-audit: 通过，ui/ 目录以外没有手写菜单/弹层/下拉。')
} else {
  for (const issue of issues) {
    console.log(`${issue.file}:${issue.line}  [${issue.label}]  ${issue.text}`)
  }
  console.log(`\nui-audit: ${issues.length} 处可疑模式。样式请收口到 src/components/ui/。`)
}
process.exitCode = issues.length > 0 ? 1 : 0
