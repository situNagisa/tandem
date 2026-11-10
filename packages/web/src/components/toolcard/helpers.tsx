import type { ComponentType } from 'react'
import {
  Bot, Brain, Camera, FilePenLine, FilePlus2, FileText, Globe, Keyboard, ListChecks,
  ListTree, MousePointerClick, ScrollText, Search, Sparkles, Square, Terminal, Wrench,
} from 'lucide-react'
import { diffLines } from 'diff'
import type { ContentBlock } from '@tandem/protocol'
import { useNow } from '../../lib/hooks'
import { runningSince } from '../../lib/runClock'
import { formatElapsed, truncate } from '../../lib/format'

export type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

export interface ToolMeta {
  icon: ComponentType<{ size?: number | string; className?: string }>
  verb: string
}

export const TOOL_META: Record<string, ToolMeta> = {
  Bash: { icon: Terminal, verb: '运行' },
  BashOutput: { icon: Terminal, verb: '读取后台输出' },
  KillBash: { icon: Square, verb: '终止后台任务' },
  Read: { icon: FileText, verb: '读取' },
  Write: { icon: FilePlus2, verb: '写入' },
  Edit: { icon: FilePenLine, verb: '编辑' },
  Glob: { icon: Search, verb: '列出' },
  Grep: { icon: Search, verb: '搜索' },
  TodoWrite: { icon: ListChecks, verb: '更新待办' },
  WebFetch: { icon: Globe, verb: '获取' },
  Task: { icon: Bot, verb: '子代理' },
  Skill: { icon: Sparkles, verb: '使用技能' },
  Memory: { icon: Brain, verb: '记住' },
  browser_navigate: { icon: Globe, verb: '浏览器 · 打开' },
  browser_snapshot: { icon: ListTree, verb: '浏览器 · 快照' },
  browser_click: { icon: MousePointerClick, verb: '浏览器 · 点击' },
  browser_type: { icon: Keyboard, verb: '浏览器 · 输入' },
  browser_screenshot: { icon: Camera, verb: '浏览器 · 截图' },
  browser_console: { icon: ScrollText, verb: '浏览器 · 控制台' },
  browser_close: { icon: Square, verb: '浏览器 · 关闭' },
}

/** mcp__server__tool → { server, tool }。 */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const idx = rest.indexOf('__')
  if (idx <= 0 || idx >= rest.length - 2) return null
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 反馈12#03：层级无限，界面统一叫「子代理」，不再用「子」「孙」文字标签。 */
export function agentKind(): string {
  return '子代理'
}

/** target 是否为 ancestor 的后代（用于定位时逐层展开祖先 Task 卡片）。 */
export function isAgentDescendant(
  subagents: Record<string, { summary: SessionSummaryLike | null }> | undefined,
  targetId: string,
  ancestorId: string,
): boolean {
  let cursor = subagents?.[targetId]
  const seen = new Set<string>()
  while (cursor?.summary?.parentId && !seen.has(cursor.summary.parentId)) {
    if (cursor.summary.parentId === ancestorId) return true
    seen.add(cursor.summary.parentId)
    cursor = subagents?.[cursor.summary.parentId]
  }
  return false
}

export interface SessionSummaryLike {
  id: string
  parentId?: string
  depth?: number
}

export function AgentElapsed({ id, since, running }: { id: string; since: number; running: boolean }) {
  const now = useNow(running)
  if (!running) return null
  const start = runningSince(`agent:${id}`, since)
  return <span className="tabular-nums">{formatElapsed(now - start)}</span>
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function previewValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value, 36)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return truncate(value.map(String).join(', '), 36)
  if (value && typeof value === 'object') return truncate(JSON.stringify(value), 36)
  return ''
}

/** 从流式半截 JSON 里尽力取出某个字符串字段，让摘要能在生成过程中出现。 */
export function partialString(raw: string, key: string): string | undefined {
  if (!raw) return undefined
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = raw.match(re)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

/** 会话 cwd 内的路径显示为相对路径，和 Claude Code 一致。 */
export function shortPath(path: string, cwd?: string): string {
  if (!path) return ''
  if (!cwd) return path
  const normalized = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === base) return '.'
  if (normalized.startsWith(base + '/')) return normalized.slice(base.length + 1)
  return path
}

export function urlHost(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return truncate(url, 60)
  }
}

export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  if (!oldText && !newText) return { added: 0, removed: 0 }
  const oldSafe = oldText.length > 50_000 ? oldText.slice(0, 50_000) : oldText
  const newSafe = newText.length > 50_000 ? newText.slice(0, 50_000) : newText
  try {
    let added = 0
    let removed = 0
    for (const change of diffLines(oldSafe, newSafe)) {
      const lines = change.value.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      if (change.added) added += lines.length
      else if (change.removed) removed += lines.length
    }
    return { added, removed }
  } catch {
    return { added: 0, removed: 0 }
  }
}

