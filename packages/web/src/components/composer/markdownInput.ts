/**
 * 输入框里的轻量 Markdown 编辑：代码围栏、列表续号、Tab 缩进。
 * 只做文本变换，不解析富文本；发送内容保持原始 Markdown（反馈8#02）。
 */

/** 最多 3 个前置空格，``` 或 ~~~ 围栏。 */
export const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

export interface TextEdit {
  text: string
  caret: number
}

function lineInfo(text: string, caret: number): {
  lineStart: number
  lineEnd: number
  lineIndex: number
  line: string
} {
  const pos = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  const nextBreak = text.indexOf('\n', pos)
  const lineEnd = nextBreak < 0 ? text.length : nextBreak
  const lineIndex = text.slice(0, lineStart).split('\n').length - 1
  return { lineStart, lineEnd, lineIndex, line: text.slice(lineStart, lineEnd) }
}

function fenceCountBefore(text: string, lineIndex: number): number {
  const lines = text.split('\n').slice(0, lineIndex)
  return lines.filter((line) => FENCE_RE.test(line)).length
}

/** 光标所在行之前是否已有未闭合的代码围栏。 */
export function isInsideFence(text: string, caret: number): boolean {
  const { lineIndex } = lineInfo(text, caret)
  return fenceCountBefore(text, lineIndex) % 2 === 1
}

function insertAt(text: string, caret: number, insert: string): TextEdit {
  return {
    text: text.slice(0, caret) + insert + text.slice(caret),
    caret: caret + insert.length,
  }
}

function continueList(
  text: string,
  lineStart: number,
  lineEnd: number,
  line: string,
  caret: number,
): TextEdit | null {
  if (caret < lineEnd) return null
  const ordered = /^(\s{0,3})(\d+)([.)])(\s+)(.*)$/.exec(line)
  if (ordered) {
    const [, indent, number, punct, space, content] = ordered
    if (!content.trim()) {
      return { text: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart }
    }
    return insertAt(text, caret, `\n${indent}${Number(number) + 1}${punct}${space}`)
  }
  const bullet = /^(\s{0,3})([-*+])(\s+)(.*)$/.exec(line)
  if (bullet) {
    const [, indent, marker, space, content] = bullet
    if (!content.trim()) {
      return { text: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart }
    }
    const task = /^\[[ xX]\]\s+/.test(content)
    return insertAt(text, caret, `\n${indent}${marker}${space}${task ? '[ ] ' : ''}`)
  }
  return null
}

/**
 * Enter 的 Markdown 处理。返回 null 表示交给原逻辑（本次消息发送）。
 * - 代码块内：换行，不发送；在开围栏行回车自动补一对闭合围栏。
 * - 列表项末尾：续号 / 续项；空列表项回车退出列表。
 * - 其他位置：保持 Enter 发送。
 */
export function handleMarkdownEnter(text: string, caret: number): TextEdit | null {
  const pos = Math.max(0, Math.min(caret, text.length))
  const { lineStart, lineEnd, lineIndex, line } = lineInfo(text, pos)
  const inside = fenceCountBefore(text, lineIndex) % 2 === 1
  const fence = FENCE_RE.exec(line)
  const atLineEnd = pos >= lineEnd

  if (inside) {
    if (fence && atLineEnd) {
      // 当前是闭合围栏：回车在围栏后新起一行，光标落到新行。
      return insertAt(text, lineEnd, '\n')
    }
    return insertAt(text, pos, '\n')
  }

  if (fence && atLineEnd) {
    // 开围栏行回车：补一个空行和同缩进的闭合围栏，光标停在空行。
    const [, indent, marker] = fence
    const close = marker[0] === '~' ? '~~~' : '```'
    return {
      text: text.slice(0, pos) + `\n\n${indent}${close}\n` + text.slice(pos),
      caret: pos + 1,
    }
  }

  return continueList(text, lineStart, lineEnd, line, pos)
}

/** 代码块内 Tab 插入两个空格；其他位置不拦截，保留键盘可达性。 */
export function handleMarkdownTab(text: string, caret: number): TextEdit | null {
  if (!isInsideFence(text, caret)) return null
  return insertAt(text, caret, '  ')
}
