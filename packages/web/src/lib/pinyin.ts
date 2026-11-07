import { pinyin } from 'pinyin-pro'

/** 中文首字母（新会话 → xhh）与全拼（新会话 → xinhuihua）；非中文按原字符保留。 */
const initialsCache = new Map<string, string>()
const fullCache = new Map<string, string>()

export function pinyinInitials(text: string): string {
  const hit = initialsCache.get(text)
  if (hit !== undefined) return hit
  let value = ''
  try {
    value = pinyin(text, {
      pattern: 'first',
      toneType: 'none',
      type: 'array',
      nonZh: 'removed',
    })
      .join('')
      .toLowerCase()
  } catch {
    value = ''
  }
  initialsCache.set(text, value)
  return value
}

export function pinyinFull(text: string): string {
  const hit = fullCache.get(text)
  if (hit !== undefined) return hit
  let value = ''
  try {
    value = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
      .join('')
      .toLowerCase()
  } catch {
    value = ''
  }
  fullCache.set(text, value)
  return value
}

/** 文本是否匹配查询：直接包含、中文首字母或全拼包含。 */
export function textMatches(text: string, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return true
  const raw = text.toLowerCase()
  if (raw.replace(/\s+/g, '').includes(q)) return true
  if (pinyinInitials(text).includes(q)) return true
  return pinyinFull(text).includes(q)
}
