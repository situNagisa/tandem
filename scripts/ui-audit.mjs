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
  {
    // 字重下限：次要文字不用 300 细体，标题 500–600、正文 400。
    id: 'font-weight-floor',
    label: '过细字重（font-light/300）：标题 500–600、按钮 500、正文 400（design P06）',
    re: /\bfont-light\b|font-weight:\s*300\b/g,
  },
  {
    // 反馈14#01/#02：带 aria-haspopup 的触发器不能按压缩放，否则弹层跟着抖。
    id: 'trigger-active-scale',
    label: '弹层触发器按下缩放：带 aria-haspopup 的元素禁用 active:scale（R52）',
    re: /(?:aria-haspopup[^\n]{0,200}active:scale|active:scale[^\n]{0,200}aria-haspopup)/g,
  },
  {
    // 色板 v3：选中态一律中性，不用 accent/橙边框、橙 ring、橙点。
    id: 'selected-accent',
    label: '选中态用了强调色：选中一律中性灰（--border-strong/--bg-active）',
    re: /(?:aria-selected|data-selected|data-active)[^\n]{0,160}(?:bg-accent|text-accent|border-accent|accent-strong)/g,
  },
  {
    // 反馈13#03：警告色统一走 --status-warn 派生 token，不再散落 amber/yellow 色值。
    id: 'hardcoded-warning-color',
    label:
      '硬编码黄色/amber：警告统一用 text-warning / bg-warning-soft（design.md --t-status-warn）',
    re: /(?:^|[\s"'`])(?:bg|text|border|ring|from|via|to|fill|stroke|divide)-(?:amber|yellow)-\d{2,3}\b|#(?:f59e0b|fbbf24|fcd34d|d97706|b45309|a16207|92400e|78350f|fef3c7|fffbeb)\b/gi,
  },
]

function matchingBrace(text, start) {
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      i += 1
    } else if (char === '/' && next === '*') {
      blockComment = true
      i += 1
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

async function checkSelectionCollapseHandlers(file, text) {
  const listenerRe = /\.addEventListener\(\s*(['"])(mouseup|selectionchange)\1\s*,/g
  let listener
  while ((listener = listenerRe.exec(text))) {
    const argStart = listenerRe.lastIndex
    const rest = text.slice(argStart)
    const named = rest.match(/^\s*([A-Za-z_$][\w$]*)\s*[,)]/)
    let bodyStart = -1
    if (named) {
      const name = named[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const declaration = new RegExp(
        `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{|function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`,
      ).exec(text)
      if (declaration) bodyStart = text.indexOf('{', declaration.index + declaration[0].length - 1)
    } else {
      const arrow = rest.indexOf('=>')
      const functionExpr = rest.indexOf('function')
      if (arrow >= 0 && (functionExpr < 0 || arrow < functionExpr)) {
        const brace = rest.indexOf('{', arrow + 2)
        if (brace >= 0) bodyStart = argStart + brace
      } else if (functionExpr >= 0) {
        const brace = rest.indexOf('{', functionExpr)
        if (brace >= 0) bodyStart = argStart + brace
      }
    }
    if (bodyStart < 0) continue
    const bodyEnd = matchingBrace(text, bodyStart)
    const body = text.slice(bodyStart, bodyEnd)
    if (body.includes('ui-audit-selection-input-whitelist')) continue
    const forbidden = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:removeAllRanges|collapse)\s*\(/.exec(body)
    if (!forbidden) continue
    issues.push({
      file: relative(ROOT, file),
      line: text.slice(0, bodyStart + forbidden.index).split('\n').length,
      check: 'selection-collapse-on-pointer-up',
      label: 'mouseup/selectionchange 中禁止收起选区（输入框内部逻辑须显式白名单）',
      text: body.slice(forbidden.index, forbidden.index + 100).replace(/\s+/g, ' '),
    })
  }
}

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
  await checkSelectionCollapseHandlers(file, text)
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

// 反馈14#01/#02（R52 复发）：Radix 把定位 transform 写在外层 Content 元素上；
// 动画/transform 只能放到内层包裹元素，否则首帧位置错误、点开时抖动。
// 这里扫描所有 *Content（Radix Popover/Menu/Select/ContextMenu/Tooltip）的起始标签。
for (const file of await walk(SRC)) {
  const text = await readFile(file, 'utf8')
  const tagRe = /<(?:[A-Za-z_$][\w$]*\.)?Content\b/g
  let match
  while ((match = tagRe.exec(text))) {
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
    if (!/className=/.test(span)) continue
    const forbidden = /\banimate-|\btransition-transform\b|\btransform-|\b(?:scale|translate|rotate)-\d|\bpopover-panel\b/.exec(span)
    if (!forbidden) continue
    issues.push({
      file: relative(ROOT, file),
      line: text.slice(0, match.index).split('\n').length,
      check: 'content-transform',
      label: 'Radix Content 上出现动画/transform：会覆盖定位 transform，动画只能放在内层包裹元素（R52 复发）',
      text: span.replace(/\s+/g, ' ').slice(0, 160),
    })
  }
}


// 反馈16#06（R14 复发）：右侧会话信息面板的宽度只由拖拽决定；卡片自己不能按内容收缩，
// 否则展开/折叠明细时面板和卡片会一起变宽变窄（用户：经常有卡片点开后宽度发生改变）。
const RIGHT_PANEL_DIRS = [
  join(SRC, 'components/right-panel'),
  join(SRC, 'components/sessionGraph'),
]
const rightPanelFiles = (await walk(SRC)).filter((file) =>
  RIGHT_PANEL_DIRS.some((dir) => file.startsWith(dir + '/')) || file.endsWith('/components/RightPanel.tsx'),
)
for (const file of rightPanelFiles) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    const m = /\bw-(?:fit|max)\b|\b(?:max|min)-content\b|\binline-flex\b/.exec(line)
    if (!m) continue
    issues.push({
      file: relative(ROOT, file),
      line: i + 1,
      check: 'right-panel-content-width',
      label: '右侧面板卡片不能按内容定宽（禁 w-fit / w-max / max-content / inline-flex）：宽度只由面板拖拽宽度决定，展开/折叠只改变高度',
      text: line.trim().slice(0, 160),
    })
  }
}
try {
  const card = await readFile(join(SRC, 'components/right-panel/shared.tsx'), 'utf8')
  if (!/group\/card w-full min-w-0/.test(card)) {
    issues.push({
      file: 'packages/web/src/components/right-panel/shared.tsx',
      line: 1,
      check: 'right-panel-card-width',
      label: '共享 Card 外层缺少 w-full min-w-0：卡片会按内容收缩，展开/折叠时宽度抖动',
      text: 'Card section className',
    })
  }
} catch {
  // shared.tsx 不存在时忽略
}
for (const file of ['components/RightPanel.tsx', 'components/ExternalSessionPanel.tsx']) {
  try {
    const text = await readFile(join(SRC, file), 'utf8')
    if (!/scrollbarGutter: 'stable'/.test(text)) {
      issues.push({
        file: `packages/web/src/${file}`,
        line: 1,
        check: 'right-panel-scrollbar-gutter',
        label: '会话信息面板滚动容器缺少 scrollbar-gutter: stable：滚动条出现/消失会改变卡片宽度',
        text: 'PanelBody style',
      })
    }
  } catch {
    // 文件不存在时忽略
  }
}

// 全局动效与图表 token：reduced-motion 必须有；会话图泳道 8 色在深浅两套都定义。
try {
  const css = await readFile(join(SRC, 'index.css'), 'utf8')
  if (!/@media \(prefers-reduced-motion: reduce\)/.test(css)) {
    issues.push({
      file: 'packages/web/src/index.css',
      line: 1,
      check: 'reduced-motion',
      label: '缺少 prefers-reduced-motion 块：系统要求减少动效时必须关闭位移动画（design P07）',
      text: '@media (prefers-reduced-motion: reduce)',
    })
  }
  const lanes = css.match(/--graph-lane-[0-7]:/g) ?? []
  if (lanes.length < 16) {
    issues.push({
      file: 'packages/web/src/index.css',
      line: 1,
      check: 'graph-lane-tokens',
      label: `会话图泳道 token 不足：深浅两套各 8 色，当前 ${lanes.length} 个（2026-11-09 用户决定）`,
      text: '--graph-lane-0..7',
    })
  }
} catch {
  // index.css 不存在时忽略
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
