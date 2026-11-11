/**
 * 输入框富文本渲染模型：Markdown 源码逐行/逐段切成可样式化的片段。
 * 只描述「怎么显示」，不改发送内容（仍是原始 Markdown）。
 */
import { FENCE_RE } from './markdownInput'

export interface EditorRun {
  /** 显示文本 */
  text: string
  /** 在完整文本中的起始偏移 */
  os: number
  /** 额外的样式类 */
  cls?: string
  /** 模型长度；仅当显示文本与模型文本不同（已选路径标记）时设置 */
  len?: number
  /** token 在原文中的完整文本（例如 `src/a.ts`） */
  src?: string
  /** 悬停提示 */
  title?: string
}

export interface EditorLine {
  start: number
  end: number
  cls?: string
  /** 列表缩进层级（前导空格数），用于额外缩进 */
  indent?: number
  runs: EditorRun[]
}

/** 本次输入里通过补全插入过的路径；只有这些完整路径会显示成不可拆分的名字标记。 */
const knownTokens = new Set<string>()
let tokenPattern: RegExp | null = null

export function registerToken(src: string): void {
  knownTokens.add(src)
  tokenPattern = null
  if (knownTokens.size > 200) {
    const first = knownTokens.values().next().value
    if (first) knownTokens.delete(first)
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tokenRe(): RegExp | null {
  if (!knownTokens.size) return null
  if (!tokenPattern) {
    const alternatives = [...knownTokens]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|')
    tokenPattern = new RegExp(`(^|[\\s([{'"\`，。；：])(${alternatives})(?=\\s|$)`, 'g')
  }
  return tokenPattern
}

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** 把一行切成「已选中路径」与普通文本块；路径按登记表整段匹配。 */
function splitTokens(content: string, base: number): Array<{
  text: string
  os: number
  token?: string
}> {
  const pattern = tokenRe()
  if (!pattern) return content ? [{ text: content, os: base }] : []
  const parts: Array<{ text: string; os: number; token?: string }> = []
  let cursor = 0
  pattern.lastIndex = 0
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0
    const prefix = match[1] ?? ''
    const path = match[2] ?? ''
    const at = index + prefix.length
    if (at > cursor) parts.push({ text: content.slice(cursor, at), os: base + cursor })
    parts.push({ text: path, os: base + at, token: path })
    cursor = at + path.length
  }
  if (cursor < content.length) parts.push({ text: content.slice(cursor), os: base + cursor })
  return parts
}

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g

function inlineRuns(content: string, base: number): EditorRun[] {
  const runs: EditorRun[] = []
  let cursor = 0
  const push = (text: string, os: number, cls?: string) => {
    if (!text) return
    runs.push(cls ? { text, os, cls } : { text, os })
  }
  for (const match of content.matchAll(INLINE_RE)) {
    const index = match.index ?? 0
    push(content.slice(cursor, index), base + cursor)
    const part = match[0]
    if (part.startsWith('`')) {
      push(part, base + index, 'ce-inline-code')
    } else if (part.startsWith('**')) {
      push('**', base + index, 'ce-mark')
      push(part.slice(2, -2), base + index + 2, 'ce-strong')
      push('**', base + index + part.length - 2, 'ce-mark')
    } else if (part.startsWith('[')) {
      push(part, base + index, 'ce-link')
    } else {
      push('*', base + index, 'ce-mark')
      push(part.slice(1, -1), base + index + 1, 'ce-em')
      push('*', base + index + part.length - 1, 'ce-mark')
    }
    cursor = index + part.length
  }
  push(content.slice(cursor), base + cursor)
  return runs
}

function contentRuns(content: string, base: number): EditorRun[] {
  const runs: EditorRun[] = []
  for (const part of splitTokens(content, base)) {
    if (part.token === undefined) {
      runs.push(...inlineRuns(part.text, part.os))
      continue
    }
    const isDir = part.token.endsWith('/')
    const name = basename(part.token) + (isDir ? '/' : '')
    runs.push({
      text: name,
      os: part.os,
      cls: 'ce-path',
      len: part.text.length,
      src: part.text,
      title: part.token,
    })
  }
  return runs
}

/** 解析完整文本；每行保留原文偏移，供光标映射使用。 */
export function parseEditor(text: string): EditorLine[] {
  const lines: EditorLine[] = []
  let start = 0
  let inCode = false
  for (const raw of text.split('\n')) {
    const end = start + raw.length
    const fence = FENCE_RE.test(raw)
    const code = inCode || fence
    if (fence) inCode = !inCode
    if (code) {
      lines.push({
        start,
        end,
        cls: fence ? 'ce-line-code ce-line-fence' : 'ce-line-code',
        runs: raw ? [{ text: raw, os: start }] : [],
      })
      start = end + 1
      continue
    }
    const heading = /^(\s{0,3})(#{1,6})(\s+)(.*)$/.exec(raw)
    if (heading) {
      lines.push({
        start,
        end,
        cls: 'ce-line-heading',
        runs: [
          { text: heading[1] + heading[2] + heading[3], os: start, cls: 'ce-mark' },
          ...contentRuns(heading[4], start + heading[1].length + heading[2].length + heading[3].length),
        ],
      })
      start = end + 1
      continue
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      lines.push({
        start,
        end,
        runs: [{ text: raw, os: start, cls: 'ce-mark' }],
      })
      start = end + 1
      continue
    }
    const quote = /^(\s{0,3}(?:>\s?)+)(.*)$/.exec(raw)
    if (quote) {
      lines.push({
        start,
        end,
        cls: 'ce-line-quote',
        runs: [
          { text: quote[1], os: start, cls: 'ce-mark' },
          ...contentRuns(quote[2], start + quote[1].length).map((run) => ({
            ...run,
            cls: run.cls ? `${run.cls} ce-quote` : 'ce-quote',
          })),
        ],
      })
      start = end + 1
      continue
    }
    const list = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(raw)
    if (list) {
      const indent = list[1].length
      const markerEnd = list[1].length + list[2].length + list[3].length
      const task = /^\[[ xX]\]\s+/.exec(list[4])
      const runs: EditorRun[] = [
        { text: list[1] + list[2] + list[3], os: start, cls: 'ce-list-mark' },
      ]
      if (task) {
        runs.push({ text: task[0], os: start + markerEnd, cls: 'ce-mark' })
        runs.push(...contentRuns(list[4].slice(task[0].length), start + markerEnd + task[0].length))
      } else {
        runs.push(...contentRuns(list[4], start + markerEnd))
      }
      lines.push({ start, end, cls: 'ce-line-list', indent, runs })
      start = end + 1
      continue
    }
    lines.push({ start, end, runs: contentRuns(raw, start) })
    start = end + 1
  }
  return lines
}

/**
 * 光标附近要整体删除的 @token 范围。
 * Backspace 删光标前紧邻的 token，Delete 删光标后紧邻的 token；没有则返回 null。
 */
export function tokenDeleteRange(
  text: string,
  caret: number,
  key: 'Backspace' | 'Delete',
): { start: number; end: number } | null {
  for (const line of parseEditor(text)) {
    for (const run of line.runs) {
      if (!run.src) continue
      const start = run.os
      const end = run.os + run.len!
      if (key === 'Backspace' && end === caret) return { start, end }
      if (key === 'Delete' && start === caret) return { start, end }
    }
  }
  return null
}
