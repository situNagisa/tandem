// 会话里的文件引用：识别 Markdown 链接、行内代码和纯文本路径，解析出路径与行号范围。
export interface FileRef {
  path: string
  lineStart?: number
  lineEnd?: number
}

const EXTERNAL_HREF = /^(?:https?:|mailto:)/i
const OTHER_PROTOCOL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/
const WINDOWS_DRIVE_ANY = /^\/?([a-zA-Z]):[\\/]([\s\S]*)$/

/**
 * 文件引用路径归一化：Windows 盘符路径（`D:\`、`D:/`、`/D:/`、`file:///D:/`）
 * 统一成 `D:/...`，其余路径的反斜杠也转成正斜杠，便于服务端与前端一致解析。
 */
export function normalizeFileRefPath(input: string): string {
  let value = input.trim()
  if (/^file:/i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      value = value.replace(/^file:\/\//i, '')
    }
  }
  const drive = WINDOWS_DRIVE_ANY.exec(value)
  if (drive) return `${drive[1]}:/${drive[2].replace(/\\/g, '/')}`
  return value.includes('\\') ? value.replace(/\\/g, '/') : value
}

export function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF.test(href.trim())
}

/** 页内锚点（#section），不是文件行号。 */
export function isAnchorHref(href: string): boolean {
  const s = href.trim()
  return s.startsWith('#') && !/^#L?\d/i.test(s)
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseLineSuffix(value: string): FileRef {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(value)
  if (!match) return { path: value }
  const lineStart = match[2] ? Number(match[2]) : undefined
  const lineEnd = match[3] ? Number(match[3]) : undefined
  return {
    path: match[1],
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}

function stripHashLine(value: string): FileRef {
  const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(value)
  if (!hash) return parseLineSuffix(value)
  const lineStart = Number(hash[2])
  const lineEnd = hash[3] ? Number(hash[3]) : undefined
  return {
    path: hash[1],
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}

/** Markdown 链接 href → 文件引用；外链和页内锚点返回 null。 */
export function parseFileHref(href: string): FileRef | null {
  let raw = href.trim()
  if (!raw || isExternalHref(raw) || isAnchorHref(raw) || /^javascript:/i.test(raw)) return null
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      raw = decode(url.pathname)
      if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1)
    } catch {
      raw = decode(raw.replace(/^file:\/\//i, ''))
    }
  } else {
    if (OTHER_PROTOCOL.test(raw) && !WINDOWS_DRIVE.test(raw)) return null
    raw = decode(raw)
  }
  raw = normalizeFileRefPath(raw)
  let ref = stripHashLine(raw)
  if (!ref.path.trim() || ref.path.startsWith('#')) return null
  return ref
}

const EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'md', 'markdown', 'mdx', 'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini',
  'sql', 'diff', 'patch', 'txt', 'log', 'csv', 'xml', 'svg', 'png', 'jpg',
  'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'pdf', 'lock', 'env',
]

const EXT = `(?:${EXTENSIONS.join('|')})`
const PATH_BODY = `[^\\s<>()\\[\\]{}"'\`，。；：！？、]+`
const PLAIN_PATH_SOURCE = `(?<![\\w./@-])(file:\\/\\/[^\\s<>()\\[\\]{}"'\`]+|[A-Za-z]:[\\\\/]${PATH_BODY}|(?:~|\\.{1,2})?\\/${PATH_BODY}|(?:[\\w.@+-]+\\/)+[\\w.@+-]+\\.${EXT}|[\\w.@+-]+\\.${EXT})(?::\\d+(?:-\\d+)?)?`
const PLAIN_PATH = new RegExp(PLAIN_PATH_SOURCE)

function trimTrailing(value: string): string {
  return value.replace(/[.,;:!?，。；：！？、]+$/, '')
}

/** 行内代码等短语：整段就是一个路径（可带行号）时返回文件引用。 */
export function parseInlinePath(text: string): FileRef | null {
  const value = text.trim()
  if (!value || /\s/.test(value)) return null
  if (isExternalHref(value)) return null
  if (!new RegExp(PLAIN_PATH_SOURCE).test(value)) return null
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(value)
  if (!match) return null
  const raw = normalizeFileRefPath(match[1])
  const hasExt = new RegExp(`\\.${EXT}$`, 'i').test(raw)
  if (!raw.includes('/') && !hasExt) return null
  const lineStart = match[2] ? Number(match[2]) : undefined
  const lineEnd = match[3] ? Number(match[3]) : undefined
  return {
    path: raw,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}

export type TextSegment = string | { ref: FileRef; text: string }

/** 把一段纯文本切成普通文字和文件引用片段。 */
export function splitFileRefs(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  const re = new RegExp(PLAIN_PATH_SOURCE, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const raw = trimTrailing(match[0])
    const start = match.index
    if (!raw) continue
    if (start > last) segments.push(text.slice(last, start))
    const ref = parseInlinePath(raw)
    if (ref) segments.push({ ref, text: raw })
    else segments.push(text.slice(start, start + raw.length))
    last = start + raw.length
    re.lastIndex = start + raw.length
  }
  if (last < text.length) segments.push(text.slice(last))
  return segments
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path)
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function lineLabel(ref: { lineStart?: number; lineEnd?: number }): string {
  if (!ref.lineStart) return ''
  return ref.lineEnd && ref.lineEnd !== ref.lineStart
    ? `${ref.lineStart}-${ref.lineEnd}`
    : String(ref.lineStart)
}
