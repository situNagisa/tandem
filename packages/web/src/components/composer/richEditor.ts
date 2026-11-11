/**
 * 输入框里已选中路径（@ 文件/文件夹）的识别。
 * 只描述「哪些文本是标记、完整路径是什么」，不改发送内容（仍是原始 Markdown）。
 */

export interface PathToken {
  /** 在完整文本中的起始偏移 */
  from: number
  /** 结束偏移（不含） */
  to: number
  /** 原文里的完整路径，例如 `src/a.ts` */
  src: string
  /** 显示名：文件名，文件夹保留结尾 `/` */
  name: string
  /** 是否文件夹 */
  dir: boolean
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

let cachedText = ''
let cachedTokens: PathToken[] = []

/** 全文里所有已登记路径的范围（按出现顺序）。 */
export function pathTokens(text: string): PathToken[] {
  if (text === cachedText) return cachedTokens
  const pattern = tokenRe()
  if (!pattern) {
    cachedText = text
    cachedTokens = []
    return cachedTokens
  }
  const tokens: PathToken[] = []
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    const prefix = match[1] ?? ''
    const src = match[2] ?? ''
    const from = index + prefix.length
    const dir = src.endsWith('/')
    tokens.push({
      from,
      to: from + src.length,
      src,
      name: basename(src) + (dir ? '/' : ''),
      dir,
    })
  }
  cachedText = text
  cachedTokens = tokens
  return tokens
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
  for (const token of pathTokens(text)) {
    if (key === 'Backspace' && token.to === caret) return { start: token.from, end: token.to }
    if (key === 'Delete' && token.from === caret) return { start: token.from, end: token.to }
  }
  return null
}
