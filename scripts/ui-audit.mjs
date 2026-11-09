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
  { id: 'native-datalist', label: '原生 <datalist>，应改用 ui/Combobox', re: /<datalist\b/g },
  { id: 'native-input-list', label: '输入框 list= 原生候选（浏览器自带下拉），应改用 ui/Combobox', re: /\blist=/g },
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

const GLOBAL_CHECKS = [
  {
    id: 'contains-related-target',
    label: '直接 contains(…relatedTarget)：relatedTarget 可能是 Window，应改用 lib/overlay 的 nodeContains',
    re: /\.contains\(\s*[A-Za-z_$][\w$]*\.relatedTarget/g,
  },
  {
    // 反馈8#03/#09：执行方式与委派倾向统一用规范术语，文案只在 lib/routeLabels.ts 定义。
    id: 'deprecated-route-copy',
    label:
      '已废弃的口语化路由文案：用「单代理 / 低成本 / 多代理协作」与「仅规划 / 积极 / 适度 / 关闭」（lib/routeLabels.ts）',
    re: /(?:少派|多派|便宜直做|本会话保持|label:\s*['"]不派['"])/g,
  },
]

const files = (await walk(SRC)).filter((file) => !file.startsWith(UI_DIR + '/'))
const issues = []
// 菜单项必须是单行（用户第 5 轮反馈 #15/#16）：说明走 hint/Tooltip，
// 额外操作放行尾。这里扫描 ui/ 以外的 JSX 菜单项块，禁止 flex-col / h-auto / 多行说明。
const MENU_ITEM_TAGS = ['Menu.Item', 'Menu.RadioItem', 'Menu.CheckItem', 'MenuItem']
for (const file of files) {
  const text = await readFile(file, 'utf8')
  for (const tagName of MENU_ITEM_TAGS) {
    const openRe = new RegExp(`<${tagName.replace('.', '\\.')}\\b`, 'g')
    let match
    while ((match = openRe.exec(text))) {
      const tagEnd = text.indexOf('>', match.index)
      if (tagEnd < 0) continue
      const tag = text.slice(match.index, tagEnd + 1)
      if (tag.endsWith('/>')) continue
      const close = text.indexOf(`</${tagName}>`, tagEnd)
      if (close < 0) continue
      const block = text.slice(tagEnd + 1, close)
      const line = text.slice(0, match.index).split('\n').length
      const multiline =
        /\bflex-col\b/.test(block) ||
        /\bh-auto\b|\bmin-h-\[/.test(tag) ||
        /\bdescription=/.test(tag)
      if (multiline) {
        issues.push({
          file: relative(ROOT, file),
          line,
          check: 'menu-multiline',
          label: '菜单项写成了多行（说明放 hint/Tooltip，额外操作放行尾）',
          text: tag.trim().slice(0, 160),
        })
      }
    }
  }
}

// tooltip 不能出现 0 宽度（否则每行一个字，反馈 #01）：全局样式必须有 min-width。
try {
  const css = await readFile(join(SRC, 'index.css'), 'utf8')
  const tipBlock = css.match(/\.ui-tip\s*\{([\s\S]*?)\}/)
  if (tipBlock && !/min-width\s*:/.test(tipBlock[1])) {
    issues.push({
      file: 'packages/web/src/index.css',
      line: 1,
      check: 'tooltip-min-width',
      label: '.ui-tip 缺少 min-width，窄内容可能退化成每行一个字',
      text: '.ui-tip',
    })
  }
} catch {
  // index.css 不存在时忽略
}

// 反馈10#07：菜单/按钮/分段控件里的文字行高必须 ≥ 1.4。这些行大多带 truncate
// （overflow:hidden），leading-none 会把中英文字形上下缘裁掉。共享组件里禁止出现。
for (const name of ['Menu.tsx', 'Controls.tsx', 'Button.tsx', 'ListRow.tsx', 'Combobox.tsx']) {
  try {
    const text = await readFile(join(UI_DIR, name), 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('ui-audit-ignore')) continue
      if (!/leading-none/.test(lines[i])) continue
      issues.push({
        file: relative(ROOT, join(UI_DIR, name)),
        line: i + 1,
        check: 'clipped-line-height',
        label: '文本行使用 leading-none 会被截断：行高必须 ≥ 1.4（反馈10#07）',
        text: lines[i].trim().slice(0, 160),
      })
    }
  } catch {
    // 文件不存在时忽略
  }
}

// 模型级联必须是真正的飞出子菜单（用户 #7-04）：禁止在同一面板里显示「返回上一级」。
try {
  const cascade = await readFile(join(UI_DIR, 'ModelCascade.tsx'), 'utf8')
  const backPatterns = [
    { re: /ChevronLeft/, label: 'ModelCascade 仍有返回箭头（原地替换内容）' },
    { re: /\bconst\s+back\s*=/, label: 'ModelCascade 仍有 back() 原地返回实现' },
    { re: /返回上一级/, label: 'ModelCascade 仍有「返回上一级」文案' },
  ]
  for (const check of backPatterns) {
    if (!check.re.test(cascade)) continue
    issues.push({
      file: 'packages/web/src/components/ui/ModelCascade.tsx',
      line: 1,
      check: 'model-cascade-back',
      label: check.label,
      text: '账号 › 分组 › 模型必须逐级飞出，不允许返回行或同面板替换',
    })
  }
} catch {
  // ModelCascade 不存在时忽略
}

for (const file of files) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    // 选择器查询（querySelector/closest）里的 role 字符串不是手写弹层，跳过。
    if (/\b(?:querySelector|querySelectorAll|closest|matches)\(/.test(line)) continue
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

// ui/ 浮层组件：Portal 内容必须带统一标记，反馈模式命中测试才认得出。
for (const file of await walk(UI_DIR)) {
  const text = await readFile(file, 'utf8')
  if (!/createPortal\(|\.Portal>/.test(text)) continue
  if (/PORTAL_ATTR|portalLayer\(/.test(text)) continue
  issues.push({
    file: relative(ROOT, file),
    line: 1,
    check: 'portal-marker',
    label: 'Portal 浮层未打 data-portal-layer 标记（lib/overlay 的 portalLayer）',
    text: 'createPortal / Radix Portal',
  })
}

// 所有源码：relatedTarget 必须是 Node，直接 contains 会在离开窗口时抛 TypeError。
for (const file of await walk(SRC)) {
  const text = await readFile(file, 'utf8')
  if (file.endsWith('lib/overlay.ts')) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('ui-audit-ignore')) continue
    for (const check of GLOBAL_CHECKS) {
      check.re.lastIndex = 0
      if (!check.re.test(lines[i])) continue
      issues.push({
        file: relative(ROOT, file),
        line: i + 1,
        check: check.id,
        label: check.label,
        text: lines[i].trim().slice(0, 160),
      })
    }
  }
}

// 反馈9：原生 title 提示统一走 ui/Tooltip（data-tip）。DOM 小写标签上禁止直接写 title；
// 组件 props（大写开头，如 Modal title）不算；iframe/abbr 的 title 是必要的无障碍名称。
const NATIVE_TITLE_SKIP = new Set(['iframe', 'abbr', 'object', 'embed'])
for (const file of files) {
  const text = await readFile(file, 'utf8')
  const tagRe = /<([a-z][a-zA-Z0-9]*)\b/g
  let match
  while ((match = tagRe.exec(text))) {
    const tag = match[1]
    if (NATIVE_TITLE_SKIP.has(tag)) continue
    let i = tagRe.lastIndex
    let depth = 0
    let quote = null
    for (; i < text.length; i += 1) {
      const ch = text[i]
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1)
      } else if (ch === '>' && depth === 0) {
        break
      }
    }
    const span = text.slice(match.index, i + 1)
    if (!/\stitle=/.test(span)) continue
    const line = text.slice(0, match.index).split('\n').length
    issues.push({
      file: relative(ROOT, file),
      line,
      check: 'native-title',
      label: 'DOM 上的原生 title：改用 data-tip（ui/Tooltip 统一提示）',
      text: span.replace(/\s+/g, ' ').slice(0, 160),
    })
  }
}

// 反馈9：滚动条只能由全局 overlay（index.css 的 .overlay-scrollbar）实现；
// 组件里再写 scrollbar-width / ::-webkit-scrollbar 会出现第二条滚动条。
const SCROLLBAR_FILES = (await walk(SRC)).filter(
  (file) => !file.endsWith('/index.css') && !file.endsWith('index.css'),
)
for (const file of SCROLLBAR_FILES) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    if (!/scrollbar-width\s*:|scrollbar-color\s*:|::-webkit-scrollbar/.test(line)) continue
    issues.push({
      file: relative(ROOT, file),
      line: i + 1,
      check: 'custom-scrollbar',
      label: '自定义滚动条：原生条已全局隐藏，统一用 overlay 滚动条，组件内不要再画',
      text: line.trim().slice(0, 160),
    })
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
