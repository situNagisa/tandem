import { useEffect, useState } from 'react'
import type { FsEntry } from '@tandem/protocol'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Search,
} from 'lucide-react'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'
import { cn } from '../lib/cn'
import { normalizeFileRefPath } from '../lib/fileLinks'
import { Input } from './ui/Controls'
import '../styles/file-browser.css'
import { IconButton } from './ui/Button'

/** 文件树里不展示的目录。 */
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg'])

function visibleEntries(entries: FsEntry[]): FsEntry[] {
  return entries.filter((entry) => !HIDDEN_DIRS.has(entry.name))
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${name}`
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function useDirChildren(host: HostConfig, path: string, enabled: boolean) {
  const [children, setChildren] = useState<FsEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled || children !== null) return
    let cancelled = false
    setLoading(true)
    api
      .fsList(host, path, { files: true })
      .then((list) => {
        if (!cancelled) setChildren(visibleEntries(list))
      })
      .catch(() => {
        if (!cancelled) {
          setChildren([])
          setFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, path, enabled, children])

  return { children, loading, failed }
}

function RowIcon({ entry, open }: { entry: FsEntry; open: boolean }) {
  if (entry.isDir) {
    return open ? (
      <FolderOpen size={13} className="shrink-0 text-muted" aria-hidden />
    ) : (
      <Folder size={13} className="shrink-0 text-muted" aria-hidden />
    )
  }
  return <FileText size={13} className="shrink-0 text-muted" aria-hidden />
}

function DirNode({
  host,
  entry,
  depth,
  selectedPath,
  onPick,
}: {
  host: HostConfig
  entry: FsEntry
  depth: number
  selectedPath: string
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { children, loading } = useDirChildren(host, entry.path, open)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: 6 + depth * 12 }}
        className="flex h-6 w-full items-center gap-1 rounded pr-2 text-left text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        title={entry.path}
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-muted" aria-hidden />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-muted" aria-hidden />
        )}
        <RowIcon entry={entry} open={open} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {loading && <Loader2 size={11} className="shrink-0 animate-spin text-muted" />}
      </button>
      {open &&
        children?.map((child) =>
          child.isDir ? (
            <DirNode
              key={child.path}
              host={host}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onPick={onPick}
            />
          ) : (
            <FileRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onPick={onPick}
            />
          ),
        )}
      {open && children?.length === 0 && (
        <p
          style={{ paddingLeft: 22 + depth * 12 }}
          className="py-0.5 text-[12px] text-muted"
        >
          空目录
        </p>
      )}
    </div>
  )
}

function FileRow({
  entry,
  depth,
  selectedPath,
  onPick,
}: {
  entry: FsEntry
  depth: number
  selectedPath: string
  onPick: (path: string) => void
}) {
  const selected = selectedPath === normalizeFileRefPath(entry.path)
  return (
    <button
      type="button"
      onClick={() => onPick(normalizeFileRefPath(entry.path))}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn(
        'file-row flex h-6 w-full items-center gap-1 rounded pr-2 text-left transition-colors',
        selected
          ? 'bg-[var(--t-bg-active)] text-text'
          : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
      )}
      title={entry.path}
    >
      <span className="w-[11px] shrink-0" aria-hidden />
      <RowIcon entry={entry} open={false} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </button>
  )
}

function RootNode({
  host,
  cwd,
  selectedPath,
  onPick,
}: {
  host: HostConfig
  cwd: string
  selectedPath: string
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  const { children, loading, failed } = useDirChildren(host, cwd, open)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-full items-center gap-1 rounded pl-1.5 pr-2 text-left font-medium text-text transition-colors hover:bg-[var(--t-bg-hover)]"
        title={cwd}
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-muted" aria-hidden />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-muted" aria-hidden />
        )}
        <Folder size={13} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{baseName(cwd)}</span>
        {loading && <Loader2 size={11} className="shrink-0 animate-spin text-muted" />}
      </button>
      {open && failed && <p className="py-1 pl-6 text-[12px] text-danger">无法读取目录</p>}
      {open &&
        children?.map((child) =>
          child.isDir ? (
            <DirNode
              key={child.path}
              host={host}
              entry={child}
              depth={1}
              selectedPath={selectedPath}
              onPick={onPick}
            />
          ) : (
            <FileRow
              key={child.path}
              entry={child}
              depth={1}
              selectedPath={selectedPath}
              onPick={onPick}
            />
          ),
        )}
    </div>
  )
}

/**
 * 预览面板左侧的文件浏览器：以会话 cwd 为根懒加载目录，过滤 .git/node_modules。
 * 顶部输入过滤时改为在 cwd 下模糊查找文件（Host 端 /api/fs/complete）。
 */
export function FileBrowser({
  host,
  cwd,
  selectedPath,
  onPick,
}: {
  host: HostConfig
  cwd: string
  selectedPath: string
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<string[] | null>(null)
  const [searching, setSearching] = useState(false)
  const trimmed = query.trim()

  useEffect(() => {
    if (!trimmed) {
      setMatches(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      api
        .fsComplete(host, cwd, trimmed)
        .then((list) => {
          if (!cancelled) setMatches(list)
        })
        .catch(() => {
          if (!cancelled) setMatches([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, host, cwd])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <Search size={12} className="shrink-0 text-muted" aria-hidden />
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="过滤文件"
          aria-label="过滤文件"
          className="h-7 border-0 bg-transparent px-0 focus:border-transparent"
        />
        {query && (
          <IconButton
            size="sm"
            label="清除过滤"
            onClick={() => setQuery('')}
            className="size-6 [&_svg]:size-3"
          >
            <span className="text-[13px] leading-none text-muted">×</span>
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1 text-[12.5px]">
        {trimmed ? (
          searching && !matches ? (
            <div className="flex items-center justify-center py-6 text-muted">
              <Loader2 size={13} className="animate-spin" />
            </div>
          ) : matches && matches.length > 0 ? (
            matches.map((rel) => (
              <button
                key={rel}
                type="button"
                onClick={() => onPick(normalizeFileRefPath(joinPath(cwd, rel)))}
                className={cn(
                  'file-row flex h-6 w-full items-center gap-1 rounded pl-1.5 pr-2 text-left transition-colors',
                  selectedPath === normalizeFileRefPath(joinPath(cwd, rel))
                    ? 'bg-[var(--t-bg-active)] text-text'
                    : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
                )}
                title={joinPath(cwd, rel)}
              >
                <FileText size={12} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{rel}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-4 text-center text-[12px] text-muted">
              {searching ? '查找中…' : '没有匹配的文件'}
            </p>
          )
        ) : (
          <RootNode key={cwd} host={host} cwd={cwd} selectedPath={selectedPath} onPick={onPick} />
        )}
      </div>
    </div>
  )
}
