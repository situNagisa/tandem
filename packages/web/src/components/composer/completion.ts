export interface Completion {
  kind: 'slash' | 'file'
  start: number
  end: number
  query: string
}

export interface CompletionEntry {
  kind: 'slash' | 'file'
  value: string
  label: string
  description?: string
  badge?: string
  /** @ 补全里的文件夹：可继续进入，也可直接选中为路径标记。 */
  isDir?: boolean
}

export function detectCompletion(value: string, caret: number): Completion | null {
  const upto = value.slice(0, caret)
  const lineStart = upto.lastIndexOf('\n') + 1
  const line = upto.slice(lineStart)
  if (line.startsWith('/') && line.length <= 48 && !/\s/.test(line.slice(1))) {
    return { kind: 'slash', start: lineStart, end: caret, query: line.slice(1) }
  }
  const match = /(^|\s)@([^\s@]*)$/.exec(upto)
  if (match) {
    const query = match[2]
    return { kind: 'file', start: caret - query.length - 1, end: caret, query }
  }
  return null
}

