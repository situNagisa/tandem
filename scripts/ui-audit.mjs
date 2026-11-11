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
  {
    // 反馈1601#01：弹层里的行必须由 ui/ 原语渲染，手写的 menuitem 会带自己的内边距/分隔。
    id: 'role-menuitem',
    label: '手写 role="menuitem"：改用 ui/Menu.Item / ui/ListRow',
    // 选择器字符串里的 [role="menuitem"] 不是手写行，只匹配 JSX 属性。
    re: /(?<!\[)role="menuitem(?:radio|checkbox)?"/g,
  },
  { id: 'popover-panel', label: '手写 popover-panel 弹层', re: /popover-panel/g },
  { id: 'menu-row-height', label: '硬编码菜单行高 h-[26..29px]', re: /(?<![\w-])h-\[2[6-9]px\]/g },
  { id: 'native-select', label: '原生 <select>，应改用 ui/MenuSelect', re: /<select\b/g },
  { id: 'native-datalist', label: '原生 <datalist>，应改用 ui/Combobox', re: /<datalist\b/g },
  { id: 'native-input-list', label: '输入框 list= 原生候选（浏览器自带下拉），应改用 ui/Combobox', re: /\blist=/g },
]

async function walk(dir, filePattern = /\.(tsx?|jsx?)$/) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, filePattern)))
    else if (filePattern.test(entry.name)) out.push(full)
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
    // 反馈13#03：警告色统一走 --status-warn 派生 token，不散落 amber/yellow 色值。
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

const allFiles = await walk(SRC)
const files = allFiles.filter((file) => !file.startsWith(UI_DIR + '/'))
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

// 弹层列表的分组标题与分隔线也必须用 ui/ 原语（反馈1601#01 / R01）：手写的 <p> 标题和
// border-t 分隔会给同一个弹层多一圈内边距，看起来比其他下拉「边更厚」。
const MENU_CHROME_CHECKS = [
  {
    id: 'menu-handwritten-divider',
    label: '手写菜单分隔线：改用 ui/Menu.Separator',
    re: /<div\b[^>]*\bborder-t\b[^>]*>\s*<(?:MenuList|Menu)\b/g,
  },
  {
    id: 'menu-handwritten-label',
    label: '手写菜单分组标题：改用 ui/Menu.Label',
    re: /<p\b[^>]*\btext-\[1[12]px\][^>]*>[^<]{1,16}<\/p>\s*<(?:MenuList|Menu)\b/g,
  },
]
for (const file of files) {
  const text = await readFile(file, 'utf8')
  for (const check of MENU_CHROME_CHECKS) {
    check.re.lastIndex = 0
    let match
    while ((match = check.re.exec(text))) {
      const line = text.slice(0, match.index).split('\n').length
      issues.push({
        file: relative(ROOT, file),
        line,
        check: check.id,
        label: check.label,
        text: match[0].split('\n')[0].trim().slice(0, 160),
      })
    }
  }
}

// tooltip 不能出现 0 宽度（否则每行一个字，反馈 #01）：全局样式必须有 min-width。
// 找不到目标时按失败处理，避免样式改名后静默跳过。
let indexCss = ''
try {
  indexCss = await readFile(join(SRC, 'index.css'), 'utf8')
} catch {
  issues.push({
    file: 'packages/web/src/index.css',
    line: 1,
    check: 'tooltip-min-width',
    label: '找不到 index.css：tooltip 最小宽度与全局样式无法检查',
    text: 'packages/web/src/index.css',
  })
}
const tipBlock = indexCss.match(/\.ui-tip\s*\{([\s\S]*?)\}/)
if (indexCss && !tipBlock) {
  issues.push({
    file: 'packages/web/src/index.css',
    line: 1,
    check: 'tooltip-min-width',
    label: '找不到 .ui-tip 样式块：tooltip 最小宽度无法检查',
    text: '.ui-tip',
  })
} else if (tipBlock && !/min-width\s*:/.test(tipBlock[1])) {
  issues.push({
    file: 'packages/web/src/index.css',
    line: 1,
    check: 'tooltip-min-width',
    label: '.ui-tip 缺少 min-width，窄内容可能退化成每行一个字',
    text: '.ui-tip',
  })
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

for (const file of allFiles) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    // 加载转圈统一走 ui/Spinner：ui/ 外直接引用 Loader2 会绕过统一的 animate-spin，
    // 尺寸也容易散落。新增加载态请用 <Spinner size={原尺寸} className={等价 class} />。
    if (/\bLoader2\b/.test(line)) {
      issues.push({
        file: relative(ROOT, file),
        line: i + 1,
        check: 'direct-loader-icon',
        label: '直接使用 Loader2：加载态统一用 ui/Spinner（按原尺寸传 size）',
        text: line.trim().slice(0, 160),
      })
    }
    // 存储统一走 lib/storage：localStorage 在隐私模式会抛异常，各模块自己 try/catch
    // 容易漏（40+ 模块曾各自实现）。新键请加在 storage.ts，并保持原键名与序列化格式。
    if (
      file !== join(SRC, 'lib/storage.ts') &&
      /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear|key)\b/.test(line)
    ) {
      issues.push({
        file: relative(ROOT, file),
        line: i + 1,
        check: 'raw-storage',
        label: '直接读写 localStorage/sessionStorage：统一走 lib/storage（键名与格式不变）',
        text: line.trim().slice(0, 160),
      })
    }
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
for (const file of allFiles) {
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

// 引用了未定义的 CSS 变量：浏览器会静默丢弃整条声明，背景/边框直接消失
// （反馈：一批弹窗背景变透明，因为用了从未定义的 --t-bg-elevated）。
// 定义来源 = 所有 CSS 的 `--x:` + JS 运行时注入（setProperty / style 对象）
// + 库注入的 --radix-*。模板拼接（--graph-lane-${n}）以 `-` 结尾时，
// 只要存在同前缀定义即视为已定义。
{
  const webFiles = await walk(SRC, /\.(?:tsx?|jsx?|css)$/)
  const defined = new Set()
  for (const file of webFiles) {
    const text = await readFile(file, 'utf8')
    if (file.endsWith('.css')) {
      for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1])
      continue
    }
    for (const match of text.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) defined.add(match[1])
    for (const match of text.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(match[1])
  }
  const LIBRARY_PREFIXES = ['--radix-']
  const isDefined = (name) =>
    defined.has(name) ||
    LIBRARY_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (name.endsWith('-') && [...defined].some((candidate) => candidate.startsWith(name)))
  for (const file of webFiles) {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.includes('ui-audit-ignore')) continue
      const reported = new Set()
      for (const match of line.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = match[1]
        if (reported.has(name) || isDefined(name)) continue
        reported.add(name)
        issues.push({
          file: relative(ROOT, file),
          line: i + 1,
          check: 'undefined-css-var',
          label: `引用了未定义的 CSS 变量 ${name}：浏览器会丢弃整条声明（背景透明/边框消失）`,
          text: line.trim().slice(0, 160),
        })
      }
    }
  }
}

// 打分卡 U2-A：卡片统一走 ui/Card；ui/ 外不再手写卡片 class 组合。
// fixed/absolute/sticky 的是浮层（Popover、对话框、导览），不是卡片：它们的
// 背景/阴影由浮层自己决定，本规则不适用于它们。
for (const file of files) {
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('ui-audit-ignore')) continue
    if (!line.includes('rounded-xl border border-border bg-surface')) continue
    if (/\b(?:fixed|absolute|sticky)\b/.test(line) || isFloatingClassConstant(text, line)) continue
    issues.push({
      file: relative(ROOT, file),
      line: i + 1,
      check: 'card-class',
      label: '手写卡片 class：统一用 ui/Card（12px 圆角、16/18 内边距、无阴影）',
      text: line.trim().slice(0, 160),
    })
  }
}

/** 行内 `${POSITION}` 常量若声明了 fixed/absolute/sticky，说明这行是浮层而不是卡片。 */
function isFloatingClassConstant(text, line) {
  for (const match of line.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)/g)) {
    const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const declaration = new RegExp(`const\\s+${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`).exec(text)
    if (declaration && /\b(?:fixed|absolute|sticky)\b/.test(declaration[2])) return true
  }
  return false
}

// 打分卡 U1-A：按钮统一走 ui/Button 或 ui/IconButton；结构性按钮（整行可点、折叠区、
// 选项卡、浮层标记）保留原生，但必须显式标 data-raw-button 说明是有意为之。
for (const file of files) {
  // lib/previewElement 生成的是给 iframe/预览用的 HTML 字符串，不是应用 UI。
  if (file.endsWith('/lib/previewElement.ts')) continue
  const text = await readFile(file, 'utf8')
  const tagRe = /<button\b/g
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
    const line = text.slice(0, match.index).split('\n').length
    if (span.includes('ui-audit-ignore') || span.includes('data-raw-button')) continue
    issues.push({
      file: relative(ROOT, file),
      line,
      check: 'native-button',
      label: '手写 <button>：改用 ui/Button 或 ui/IconButton；结构性按钮保留时标 data-raw-button',
      text: span.replace(/\s+/g, ' ').slice(0, 160),
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
