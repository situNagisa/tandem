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
  /** 模型长度；显示文本与模型文本不同时使用 */
  len?: number
  /** token 在原文中的完整文本 */
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

function splitTokens(content: string, base: number): Array<{ text: string; os: number }> {
  return content ? [{ text: content, os: base }] : []
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
    runs.push(...inlineRuns(part.text, part.os))
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
