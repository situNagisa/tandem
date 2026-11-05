import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react'
import type { ContentBlock, PermissionMode, Profile, SlashCommand } from '@tandem/protocol'
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  Loader2,
  Map,
  PencilLine,
  Settings2,
  Shield,
  ShieldOff,
  Slash,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { PERMISSION_MODE_LABELS, PROVIDER_KIND_LABELS } from '../lib/types'
import { Popover } from './ui/Popover'

const EMPTY_PROFILES: Profile[] = []
const EMPTY_COMMANDS: SlashCommand[] = []
const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  builtin: '内置',
  project: '项目',
  user: '用户',
}
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
const MODE_ICONS = {
  default: Shield,
  acceptEdits: PencilLine,
  plan: Map,
  bypassPermissions: ShieldOff,
} as const
const MODE_HINTS: Record<PermissionMode, string> = {
  default: '每次执行工具前询问',
  acceptEdits: '自动接受文件修改，其他仍询问',
  plan: '只读规划，不直接执行改动',
  bypassPermissions: '不再询问，请谨慎使用',
}

interface Attachment {
  id: string
  mediaType: string
  dataBase64: string
  name: string
}

interface Completion {
  kind: 'slash' | 'file'
  start: number
  end: number
  query: string
}

interface CompletionEntry {
  kind: 'slash' | 'file'
  value: string
  label: string
  description?: string
  badge?: string
}

type ModeIcon = (typeof MODE_ICONS)[PermissionMode]

function PermissionModeMenu() {
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const setMode = useAppStore((s) => s.setPermissionMode)
  const mode = summary?.permissionMode ?? 'default'
  const Icon: ModeIcon = MODE_ICONS[mode]

  return (
    <Popover
      side="top"
      panelClassName="w-[268px]"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          disabled={!summary}
          title={`权限模式：${PERMISSION_MODE_LABELS[mode]}（Shift+Tab 切换）`}
          className={cn(
            'flex h-11 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50 md:h-8',
            open && 'bg-surface-2 text-text',
          )}
        >
          <Icon size={13.5} />
          <span className="hidden max-w-[86px] truncate sm:inline">
            {PERMISSION_MODE_LABELS[mode]}
          </span>
          <ChevronDown size={11} className="hidden opacity-60 sm:block" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">
            权限模式
          </div>
          {MODES.map((m) => {
            const ModeIcon = MODE_ICONS[m]
            return (
              <button
                key={m}
                onClick={() => {
                  close()
                  if (summary) void setMode(m)
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2',
                  m === mode && 'bg-surface-2/70',
                )}
              >
                <ModeIcon size={14} className="mt-0.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium">
                    {PERMISSION_MODE_LABELS[m]}
                  </span>
                  <span className="block text-[11px] leading-4 text-muted">{MODE_HINTS[m]}</span>
                </span>
                {m === mode && <Check size={14} className="mt-0.5 shrink-0 text-accent" />}
              </button>
            )
          })}
          <div className="mt-1 border-t border-border px-2.5 pb-0.5 pt-1.5 text-[10px] text-muted">
            Shift+Tab 快速切换
          </div>
        </div>
      )}
    </Popover>
  )
}

function ModelMenu() {
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const profiles = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.profiles ?? EMPTY_PROFILES) : EMPTY_PROFILES,
  )
  const loading = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.profilesLoading ?? false) : false,
  )
  const setModel = useAppStore((s) => s.setModel)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const openSettings = useUiStore((s) => s.openSettings)
  const currentProfile = profiles.find((p) => p.id === summary?.profileId) ?? null

  return (
    <Popover
      side="top"
      panelClassName="w-[310px] max-w-[calc(100vw-1.5rem)]"
      trigger={({ open, toggle }) => (
        <button
          onClick={() => {
            if (!open && hostId && profiles.length === 0 && !loading) void refreshProfiles(hostId)
            toggle()
          }}
          disabled={!summary}
          title={currentProfile ? `${currentProfile.name} · ${summary?.model}` : '选择账号与模型'}
          className={cn(
            'flex h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50 md:h-8',
            open && 'bg-surface-2 text-text',
          )}
        >
          <Cpu size={13.5} className="shrink-0" />
          {currentProfile && (
            <>
              <span className="hidden max-w-[110px] truncate text-muted md:inline">
                {currentProfile.name}
              </span>
              <span className="hidden text-border-strong md:inline">·</span>
            </>
          )}
          <span className="max-w-[130px] truncate text-text-soft sm:max-w-[180px]">
            {summary?.model || '选择模型'}
          </span>
          <ChevronDown size={11} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
            <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted">
              账号与模型
            </span>
            <span className="text-[10px] text-muted">{profiles.length} 个账号</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {loading && profiles.length === 0 && (
              <div className="flex items-center gap-2 px-2.5 py-4 text-[12px] text-muted">
                <Loader2 size={13} className="animate-spin" /> 加载账号…
              </div>
            )}
            {!loading && profiles.length === 0 && (
              <div className="px-2.5 py-3 text-[12px] leading-5 text-muted">
                这台 Host 还没有配置账号。
              </div>
            )}
            {profiles.map((p) => {
              const models = p.models.length ? p.models : [p.defaultModel].filter(Boolean)
              return (
                <div key={p.id} className="pb-1">
                  <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-2">
                    <span className="truncate text-[11.5px] font-semibold text-text-soft">
                      {p.name}
                    </span>
                    <span className="shrink-0 rounded border border-border/70 px-1 text-[9.5px] text-muted">
                      {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                    </span>
                    <span className="ml-auto truncate font-mono text-[9.5px] text-muted/80">
                      {p.apiKeyMasked}
                    </span>
                  </div>
                  {models.map((m) => {
                    const selected = summary?.profileId === p.id && summary?.model === m
                    return (
                      <button
                        key={`${p.id}:${m}`}
                        onClick={() => {
                          close()
                          if (!selected) void setModel(p.id, m)
                        }}
                        className={cn(
                          'flex w-full min-h-9 items-center gap-2 rounded-lg pl-4 pr-2.5 text-left text-[12px] transition-colors hover:bg-surface-2',
                          selected ? 'text-accent' : 'text-text-soft',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
                        {selected && <Check size={13} className="shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              onClick={() => {
                close()
                openSettings('profiles')
              }}
              className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
            >
              <Settings2 size={13} /> 管理账号与模型
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}

function CompletionMenu({
  completion,
  items,
  index,
  loading,
  onIndex,
  onSelect,
}: {
  completion: Completion
  items: CompletionEntry[]
  index: number
  loading: boolean
  onIndex: (i: number) => void
  onSelect: (item: CompletionEntry) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index, items.length])

  return (
    <div className="anim-slide-up absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-[0_18px_50px_-16px_rgba(30,24,18,0.45)]">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-2/30 px-3 py-1.5 text-[10.5px] text-muted">
        {completion.kind === 'slash' ? <Slash size={11} /> : <AtSign size={11} />}
        <span className="font-medium uppercase tracking-wide">
          {completion.kind === 'slash' ? '斜杠命令' : '文件补全'}
        </span>
        <span className="text-border-strong">·</span>
        <span className="truncate">
          {completion.kind === 'slash' ? `/${completion.query}` : `@${completion.query}`}
        </span>
        <span className="ml-auto hidden shrink-0 sm:inline">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {loading && items.length === 0 && (
          <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-muted">
            <Loader2 size={13} className="animate-spin" />
            {completion.kind === 'slash' ? '加载命令…' : '搜索文件…'}
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="px-2.5 py-3 text-[12px] text-muted">
            {completion.kind === 'slash' ? '没有匹配的命令' : '没有匹配的文件'}
          </div>
        )}
        {items.map((item, i) => (
          <button
            key={`${item.kind}:${item.value}`}
            data-index={i}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onIndex(i)}
            onClick={() => onSelect(item)}
            className={cn(
              'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
              i === index ? 'bg-surface-2' : 'hover:bg-surface-2/60',
            )}
          >
            {item.kind === 'slash' ? (
              <Terminal size={13} className="shrink-0 text-muted" />
            ) : (
              <FileText size={13} className="shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px] text-text">{item.label}</span>
              {item.description && (
                <span className="block truncate text-[10.5px] text-muted">{item.description}</span>
              )}
            </span>
            {item.badge && (
              <span className="shrink-0 rounded border border-border/70 px-1 text-[9.5px] text-muted">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function detectCompletion(value: string, caret: number): Completion | null {
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

const MAX_ATTACHMENTS = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function Composer() {
  const isMobile = useIsMobile()
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const stopping = useAppStore((s) => s.active?.stopping ?? false)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const hostStatus = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.status ?? 'offline') : 'offline',
  )
  const commands = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.commands ?? EMPTY_COMMANDS) : EMPTY_COMMANDS,
  )
  const commandsLoaded = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.commandsLoaded ?? false) : false,
  )
  const send = useAppStore((s) => s.send)
  const interrupt = useAppStore((s) => s.interrupt)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const refreshCommands = useAppStore((s) => s.refreshCommands)
  const seed = useUiStore((s) => s.promptSeed)
  const clearPromptSeed = useUiStore((s) => s.clearPromptSeed)
  const toast = useUiStore((s) => s.toast)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [completion, setCompletion] = useState<Completion | null>(null)
  const [index, setIndex] = useState(0)
  const [fileItems, setFileItems] = useState<string[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [dragging, setDragging] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const fileSeq = useRef(0)
  const prevSessionRef = useRef<string | null>(sessionId)

  // 切换会话时清空输入，避免把草稿发到另一个会话
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      setText('')
      setAttachments([])
      setCompletion(null)
    }
  }, [sessionId])

  useEffect(() => {
    if (isMobile) return
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [sessionId, isMobile])

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    clearPromptSeed()
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.text.length, seed.text.length)
    })
  }, [seed, clearPromptSeed])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), 224)}px`
  }, [text])

  useEffect(() => {
    if (completion?.kind === 'slash' && hostId) void refreshCommands(hostId)
  }, [completion?.kind, hostId, refreshCommands])

  useEffect(() => {
    if (!completion || completion.kind !== 'file') {
      fileSeq.current++
      setFileItems([])
      setFileLoading(false)
      return
    }
    const seq = ++fileSeq.current
    const cwd = summary?.cwd
    if (!cwd) {
      setFileItems([])
      setFileLoading(false)
      return
    }
    setFileLoading(true)
    const timer = window.setTimeout(() => {
      const host = useAppStore.getState().hosts.find((h) => h.id === hostId)
      if (!host) {
        setFileLoading(false)
        return
      }
      api
        .fsComplete(host, cwd, completion.query)
        .then((items) => {
          if (seq !== fileSeq.current) return
          setFileItems(items.slice(0, 60))
          setFileLoading(false)
        })
        .catch(() => {
          if (seq !== fileSeq.current) return
          setFileItems([])
          setFileLoading(false)
        })
    }, 140)
    return () => window.clearTimeout(timer)
  }, [completion?.kind, completion?.query, hostId, summary?.cwd])

  useEffect(() => {
    setIndex(0)
  }, [completion?.kind, completion?.query])

  useEffect(() => {
    if (!completion) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target) || textareaRef.current?.contains(target)) return
      setCompletion(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [completion])

  const items = useMemo<CompletionEntry[]>(() => {
    if (!completion) return []
    if (completion.kind === 'file') {
      return fileItems.map((path) => ({ kind: 'file' as const, value: path, label: path }))
    }
    const q = completion.query.toLowerCase()
    return commands
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
      .slice(0, 40)
      .map((c) => {
        const name = c.name.replace(/^\/+/, '')
        return {
          kind: 'slash' as const,
          value: name,
          label: `/${name}`,
          description: c.description,
          badge: SOURCE_LABEL[c.source],
        }
      })
  }, [completion, fileItems, commands])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  const selectItem = (item: CompletionEntry) => {
    if (!completion) return
    const before = text.slice(0, completion.start)
    const after = text.slice(completion.end)
    const insertion = `${item.value} `
    const next = before + insertion + after
    setText(next)
    setCompletion(null)
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const pos = before.length + insertion.length
      el.setSelectionRange(pos, pos)
    })
  }

  const addImages = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (!images.length) return
      const room = MAX_ATTACHMENTS - attachments.length
      if (room <= 0) {
        toast(`最多添加 ${MAX_ATTACHMENTS} 张图片`, 'info')
        return
      }
      const picked = images.slice(0, room)
      if (images.length > room) {
        toast(`最多添加 ${MAX_ATTACHMENTS} 张图片`, 'info')
      }
      for (const file of picked) {
        if (file.size > MAX_IMAGE_BYTES) {
          toast(`图片 ${file.name || ''} 超过 10MB，已跳过`, 'error')
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const comma = dataUrl.indexOf(',')
          if (comma < 0) continue
          const attachment: Attachment = {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            mediaType: file.type || 'image/png',
            dataBase64: dataUrl.slice(comma + 1),
            name: file.name || '粘贴的图片',
          }
          setAttachments((prev) =>
            prev.length >= MAX_ATTACHMENTS ? prev : [...prev, attachment],
          )
        } catch {
          toast('读取图片失败', 'error')
        }
      }
    },
    [attachments.length, toast],
  )

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = e.clipboardData
    if (!clipboard) return
    const files: File[] = []
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    for (const f of Array.from(clipboard.files)) {
      if (f.type.startsWith('image/') && !files.includes(f)) files.push(f)
    }
    if (files.length) {
      e.preventDefault()
      void addImages(files)
    }
  }

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void addImages(files)
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !!summary

  const handleSend = () => {
    if (!summary) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (hostStatus !== 'online') {
      toast('Host 未连接，消息未发送', 'error')
      return
    }
    const blocks: ContentBlock[] = []
    if (trimmed) blocks.push({ type: 'text', text: trimmed })
    for (const a of attachments) {
      blocks.push({ type: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64 })
    }
    if (!send(blocks)) return
    setText('')
    setAttachments([])
    setCompletion(null)
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.style.height = '28px'
        el.focus()
      }
    })
  }

  const cycleMode = () => {
    if (!summary) return
    const idx = MODES.indexOf(summary.permissionMode)
    const next = MODES[(idx + 1) % MODES.length]
    void setPermissionMode(next)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229
    if (
      completion &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')
    ) {
      setCompletion(null)
    }
    if (completion) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setCompletion(null)
        return
      }
      if (items.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setIndex((i) => Math.min(items.length - 1, i + 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setIndex((i) => Math.max(0, i - 1))
          return
        }
        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
          if (composing) return
          e.preventDefault()
          const item = items[index]
          if (item) selectItem(item)
          return
        }
      }
    }
    if (e.key === 'Escape') {
      if (composing) return
      if (running) {
        e.preventDefault()
        e.stopPropagation()
        interrupt()
      }
      return
    }
    if (e.key === 'Enter') {
      if (composing) return
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        handleSend()
        return
      }
      if (isMobile || e.shiftKey) return
      e.preventDefault()
      handleSend()
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      if (composing) return
      e.preventDefault()
      cycleMode()
    }
  }

  const onChange = (value: string, caret: number) => {
    setText(value)
    setCompletion(detectCompletion(value, caret))
  }

  return (
    <div className="relative">
      {completion && (
        <div ref={menuRef}>
          <CompletionMenu
            completion={completion}
            items={items}
            index={index}
            loading={completion.kind === 'file' ? fileLoading : !commandsLoaded}
            onIndex={setIndex}
            onSelect={selectItem}
          />
        </div>
      )}

      <div
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={onDrop}
        className={cn(
          'relative rounded-2xl border bg-surface shadow-[0_2px_12px_-4px_rgba(40,30,20,0.12)] transition-colors duration-150',
          dragging ? 'border-accent/60' : 'border-border-strong/60 focus-within:border-border-strong',
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft/80 text-[13px] font-medium text-accent backdrop-blur-[1px]">
            松开以添加图片
          </div>
        )}
        <div className="px-3 pt-2.5">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative size-14 overflow-hidden rounded-lg border border-border bg-surface-2"
                >
                  <img
                    src={`data:${a.mediaType};base64,${a.dataBase64}`}
                    alt={a.name}
                    className="size-full object-cover"
                  />
                  <button
                    onClick={() =>
                      setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                    }
                    aria-label="移除图片"
                    className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-80 transition-opacity hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setCompletion(null)}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            rows={1}
            spellCheck={false}
            aria-label="消息输入框"
            placeholder={
              running
                ? '运行中，可继续输入，消息会排队发送…'
                : '给 Tandem 发消息…'
            }
            className="composer-textarea block max-h-[224px] min-h-7 w-full resize-none bg-transparent px-1 py-1 text-[16px] leading-6 text-text outline-none placeholder:text-muted md:text-[14.5px]"
          />
        </div>

        <div className="flex items-center gap-0.5 px-1.5 pb-1.5 pt-1">
          <PermissionModeMenu />
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <ModelMenu />
          <span className="flex-1" />
          {!summary && (
            <span className="mr-1 hidden text-[10.5px] text-muted sm:block">会话加载中…</span>
          )}
          {running && (
            <button
              onClick={interrupt}
              disabled={stopping}
              title="停止生成 (Esc)"
              aria-label="停止生成"
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60 md:size-9"
            >
              {stopping ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Square size={12} className="fill-current" />
              )}
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={!canSend}
            title={running ? '排队发送 (Enter)' : '发送 (Enter)'}
            aria-label="发送消息"
            className={cn(
              'ml-0.5 flex size-11 shrink-0 items-center justify-center rounded-full transition-all duration-150 md:size-9',
              canSend
                ? 'bg-accent text-on-accent hover:bg-accent-hover active:scale-95'
                : 'bg-surface-2 text-muted/50',
            )}
          >
            <ArrowUp size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2 px-1 text-[10.5px] leading-4 text-muted">
        <span className="min-w-0 truncate">
          {running
            ? '运行中 · Enter 排队发送 · Esc 停止'
            : isMobile
              ? 'Enter 换行 · 点击右侧按钮发送'
              : 'Enter 发送 · Shift+Enter 换行 · / 命令 · @ 文件 · 可粘贴图片'}
        </span>
        <span className="ml-auto hidden shrink-0 md:inline">Shift+Tab 切换权限</span>
      </div>
    </div>
  )
}
