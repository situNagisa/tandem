import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type {
  ContentBlock,
  ModelPriceInfo,
  PermissionMode,
  Profile,
  ReasoningEffort,
  SlashCommand,
} from '@tandem/protocol'
import {
  ArrowUp,
  AtSign,
  Brain,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  Image as ImageIcon,
  Loader2,
  Map,
  Paperclip,
  PencilLine,
  Shield,
  ShieldOff,
  Slash as SlashIcon,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { isTargetFocused, useSessionTarget, useSessionView } from './session/SessionScope'
import { useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { groupName, profileModelGroups } from '../lib/profileModels'
import {
  EFFORTS,
  EFFORT_LABEL,
  defaultEffortsForKind,
  effortSuffix,
  loadLastEffort,
  nearestEffort,
  rememberEffort,
} from '../lib/effort'
import {
  loadDraft,
  loadSentHistory,
  pushSentHistory,
  saveDraft,
} from '../lib/storage'
import { ContextMeter } from './chat/ContextMeter'
import { Button, IconButton } from './ui/Button'
import { VoiceButton, type VoiceButtonHandle } from './voice/VoiceButton'
import { Menu, MenuItem, MenuList } from './ui/Menu'
import { popoverSurfaceClass } from './ui/Popover'
import {
  setThinkingMode,
  THINKING_MODE_META,
  useThinkingMode,
  type ThinkingMode,
} from './ThinkingBlock'
import '../styles/chat.css'

const EMPTY_PROFILES: Profile[] = []
const EMPTY_COMMANDS: SlashCommand[] = []
const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  builtin: '内置',
  project: '项目',
  user: '用户',
  skill: '技能',
}
import { detectCompletion, type Completion, type CompletionEntry } from './composer/completion'
import { CompletionMenu } from './composer/CompletionMenu'
import { ModelMenu } from './composer/ModelMenu'
import {
  MODES,
  MobileMoreMenu,
  PermissionModeMenu,
  ThinkingModeMenu,
} from './composer/ComposerMenus'

interface Attachment {
  id: string
  mediaType: string
  dataBase64: string
  name: string
}

interface PastedText {
  id: string
  text: string
  lines: number
}

const PASTE_COLLAPSE_THRESHOLD = 2000


function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 剪贴板常把同一张图以多个 File 实例给出，用 类型+大小+头部字节 去重。 */
async function imageFingerprint(file: File): Promise<string> {
  let head = ''
  try {
    const bytes = new Uint8Array(await file.slice(0, 96).arrayBuffer())
    for (const b of bytes) head += b.toString(16).padStart(2, '0')
  } catch {
    head = file.name
  }
  return `${file.type}:${file.size}:${head}`
}

const MAX_ATTACHMENTS = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface ComposerProps {
  /** 覆盖默认发送。返回 false（或 reject）时保留输入内容，其余返回视为成功并清空。 */
  onSubmit?: (content: ContentBlock[]) => unknown | Promise<unknown>
  /** 无会话模式：模型、权限模式由外部受控，running 也由外部提供。 */
  sessionless?: boolean
  model?: string
  profileId?: string
  groupId?: string
  permissionMode?: PermissionMode
  onModelChange?: (profileId: string, groupId: string | undefined, model: string) => void
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** 无会话模式的思考强度；缺省读上次使用值。 */
  effort?: ReasoningEffort
  onEffortChange?: (effort: ReasoningEffort) => void
  /** 文件补全与斜杠命令使用的 Host / 工作目录；缺省用当前会话。 */
  hostId?: string
  cwd?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  /** 外部覆盖运行状态（新会话页首条消息提交后使用）。 */
  running?: boolean
  onStop?: () => void
  /** 窄窗格：工具栏收起为图标，避免发送按钮被挤出。 */
  compact?: boolean
}

export function Composer({
  onSubmit,
  sessionless = false,
  model: modelProp,
  profileId: profileIdProp,
  groupId: groupIdProp,
  permissionMode: permissionModeProp,
  onModelChange,
  onPermissionModeChange,
  effort: effortProp,
  onEffortChange,
  hostId: hostIdProp,
  cwd: cwdProp,
  placeholder,
  autoFocus = false,
  disabled = false,
  className,
  running: runningProp,
  onStop,
  compact = false,
}: ComposerProps) {
  const isMobile = useIsMobile()
  const scopeTarget = useSessionTarget() ?? undefined
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const summary = useSessionView((s) => s?.summary ?? null)
  const storeRunning = useSessionView((s) => s?.running ?? false)
  const storeStopping = useSessionView((s) => s?.stopping ?? false)
  const activeHostId = useSessionView((s) => s?.hostId ?? null)
  const hostStatus = useAppStore((s) =>
    (hostIdProp ?? activeHostId) ? (s.runtimes[hostIdProp ?? activeHostId!]?.status ?? 'offline') : 'offline',
  )
  const commands = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.commands ?? EMPTY_COMMANDS)
      : EMPTY_COMMANDS,
  )
  const commandsLoaded = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.commandsLoaded ?? false)
      : false,
  )
  const profiles = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.profiles ?? EMPTY_PROFILES)
      : EMPTY_PROFILES,
  )
  const profilesLoading = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.profilesLoading ?? false)
      : false,
  )
  const send = useAppStore((s) => s.send)
  const hosts = useAppStore((s) => s.hosts)
  const ensureWorktree = useAppStore((s) => s.ensureWorktree)
  const interrupt = useAppStore((s) => s.interrupt)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const setModel = useAppStore((s) => s.setModel)
  const updateSession = useAppStore((s) => s.updateSession)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const refreshCommands = useAppStore((s) => s.refreshCommands)
  const seed = useUiStore((s) => s.promptSeed)
  const clearPromptSeed = useUiStore((s) => s.clearPromptSeed)
  const composerResetNonce = useUiStore((s) => s.composerResetNonce)
  const toast = useUiStore((s) => s.toast)
  const openSettings = useUiStore((s) => s.openSettings)
  const openScheduleComposer = useUiStore((s) => s.openScheduleComposer)
  const openMemoryEditor = useUiStore((s) => s.openMemoryEditor)

  const effectiveHostId = hostIdProp ?? activeHostId
  const effectiveHost = hosts.find((h) => h.id === effectiveHostId)
  const cwd = cwdProp ?? summary?.cwd
  const running = runningProp ?? storeRunning
  const stopping = runningProp === undefined && storeStopping
  const mode = sessionless ? (permissionModeProp ?? 'default') : (summary?.permissionMode ?? 'default')
  const currentModel = sessionless ? (modelProp ?? '') : (summary?.model ?? '')
  const autoRoute = sessionless ? currentModel === 'auto' : summary?.autoRoute === true
  const routedModel = summary?.route?.model
  const currentProfileId = sessionless ? (profileIdProp ?? '') : (summary?.profileId ?? '')
  const currentGroupId = sessionless ? groupIdProp : summary?.groupId
  const [localEffort, setLocalEffort] = useState<ReasoningEffort>(loadLastEffort)
  const [modelEfforts, setModelEfforts] = useState<ReasoningEffort[] | undefined>(undefined)
  const currentProfile = profiles.find((p) => p.id === currentProfileId)
  const currentGroup = currentProfile?.groups?.find((g) => g.id === currentGroupId)
  const currentKind = currentGroup?.kind ?? currentProfile?.kind
  const supportedEfforts = modelEfforts ?? defaultEffortsForKind(currentKind)
  const effort = sessionless ? (effortProp ?? localEffort) : (summary?.effort ?? 'off')
  const draftKey = sessionId ? `${activeHostId ?? ''}:${sessionId}` : `new:${effectiveHostId ?? ''}`

  const [text, setText] = useState(() => loadDraft(draftKey))
  const [pasted, setPasted] = useState<PastedText[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [completion, setCompletion] = useState<Completion | null>(null)
  const [index, setIndex] = useState(0)
  const [fileItems, setFileItems] = useState<string[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [priceCache, setPriceCache] = useState<
    Record<string, Record<string, ModelPriceInfo> | 'loading'>
  >({})

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const voiceRef = useRef<VoiceButtonHandle>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const worktreeBusyRef = useRef(false)
  const fileSeq = useRef(0)
  const prevSessionRef = useRef<string | null>(draftKey)
  const textRef = useRef(text)
  textRef.current = text

  // 切换会话时保存上一条草稿，并恢复目标会话的草稿
  useEffect(() => {
    if (prevSessionRef.current === draftKey) return
    if (prevSessionRef.current) saveDraft(prevSessionRef.current, textRef.current)
    prevSessionRef.current = draftKey
    setText(loadDraft(draftKey))
    setPasted([])
    setAttachments([])
    setCompletion(null)
  }, [draftKey])

  // 输入过程中防抖保存草稿
  useEffect(() => {
    const timer = window.setTimeout(() => saveDraft(draftKey, text), 180)
    return () => window.clearTimeout(timer)
  }, [draftKey, text])

  useEffect(
    () => () => {
      saveDraft(prevSessionRef.current ?? '', textRef.current)
    },
    [],
  )

  useEffect(() => {
    if (disabled) return
    // 会话模式沿用自动聚焦；无会话页只在 autoFocus 时聚焦。
    if (!autoFocus && (isMobile || sessionless)) return
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [sessionId, isMobile, autoFocus, sessionless, disabled])

  useEffect(() => {
    if (!seed || !isTargetFocused(scopeTarget ?? null)) return
    setText(seed.text)
    clearPromptSeed()
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.text.length, seed.text.length)
    })
  }, [seed, clearPromptSeed, scopeTarget])

  useEffect(() => {
    if (!composerResetNonce) return
    setText('')
    setPasted([])
    setAttachments([])
    setCompletion(null)
    saveDraft(draftKey, '')
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = '28px'
      el.focus()
    })
    // 只响应“新会话”按钮的显式重置，不随草稿 key 变化重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerResetNonce])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.max(120, Math.round(window.innerHeight * 0.4))
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), max)}px`
  }, [text])

  useEffect(() => {
    if (completion?.kind === 'slash' && effectiveHostId) void refreshCommands(effectiveHostId)
  }, [completion?.kind, effectiveHostId, refreshCommands])

  // 当前模型支持哪些思考强度；请求失败按 provider 默认处理
  useEffect(() => {
    setModelEfforts(undefined)
    if (!effectiveHostId || !currentProfileId || !currentModel || autoRoute) return
    const host = useAppStore.getState().hosts.find((h) => h.id === effectiveHostId)
    if (!host) return
    let cancelled = false
    api
      .modelCapabilities(host, currentProfileId, currentGroupId, currentModel)
      .then((info) => {
        if (!cancelled) setModelEfforts(info.efforts)
      })
      .catch(() => {
        /* 能力未知时保留默认档位 */
      })
    return () => {
      cancelled = true
    }
  }, [effectiveHostId, currentProfileId, currentGroupId, currentModel, autoRoute])

  useEffect(() => {
    if (!completion || completion.kind !== 'file') {
      fileSeq.current++
      setFileItems([])
      setFileLoading(false)
      return
    }
    const seq = ++fileSeq.current
    if (!cwd) {
      setFileItems([])
      setFileLoading(false)
      return
    }
    setFileLoading(true)
    const timer = window.setTimeout(() => {
      const host = useAppStore.getState().hosts.find((h) => h.id === effectiveHostId)
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
  }, [completion?.kind, completion?.query, effectiveHostId, cwd])

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
    if (item.kind === 'slash' && item.value.toLowerCase() === 'model') {
      setText(before + after)
      setCompletion(null)
      if (effectiveHostId && profiles.length === 0 && !profilesLoading) {
        void refreshProfiles(effectiveHostId)
      }
      setModelMenuOpen(true)
      return
    }
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
      const candidates = files.filter((f) => f.type.startsWith('image/'))
      if (!candidates.length) return
      const signatures = await Promise.all(candidates.map(imageFingerprint))
      const seen = new Set<string>()
      const images = candidates.filter((_, i) => {
        if (seen.has(signatures[i])) return false
        seen.add(signatures[i])
        return true
      })
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
    // items 是剪贴板图片的规范来源；files 仅作兜底。两者同时遍历时，
    // 同一张图会以不同 File 实例出现，导致粘贴一次添加多张。
    const files: File[] = []
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) {
      for (const f of Array.from(clipboard.files)) {
        if (f.type.startsWith('image/')) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      void addImages(files)
      return
    }
    // 大段文本折叠成胶囊，避免把输入框撑满；发送时再展开。
    const plain = clipboard.getData('text/plain')
    if (plain.length > PASTE_COLLAPSE_THRESHOLD) {
      e.preventDefault()
      const lines = plain.split('\n').length
      setPasted((prev) => [
        ...prev,
        {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: plain,
          lines,
        },
      ])
    }
  }

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void addImages(files)
  }

  const pastedText = pasted.map((p) => p.text).join('\n\n')
  const outgoingText = [text.trim(), pastedText].filter(Boolean).join('\n\n')
  const hasContent = outgoingText.length > 0 || attachments.length > 0
  const canSend = hasContent && !disabled && (onSubmit ? true : !!summary)

  const resetInput = () => {
    setText('')
    setPasted([])
    setAttachments([])
    setCompletion(null)
    saveDraft(draftKey, '')
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = '28px'
      if (!isMobile) el.focus()
    })
  }

  const rememberSent = (value: string) => {
    if (!value) return
    pushSentHistory(draftKey, value)
  }

  const handleSend = async () => {
    if (!canSend) return
    // /schedule 只打开创建界面，不作为消息发送
    if (!attachments.length && outgoingText.trim() === '/schedule') {
      openScheduleComposer()
      resetInput()
      return
    }
    // /memory 直接打开当前项目的记忆编辑器
    if (!attachments.length && outgoingText.trim() === '/memory') {
      if (summary?.cwd) openMemoryEditor({ scope: 'project', project: summary.cwd })
      else toast('当前会话没有项目目录', 'info')
      resetInput()
      return
    }
    const blocks: ContentBlock[] = []
    if (outgoingText) blocks.push({ type: 'text', text: outgoingText })
    for (const a of attachments) {
      blocks.push({ type: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64 })
    }
    if (onSubmit) {
      let result: unknown
      try {
        result = await onSubmit(blocks)
      } catch {
        return
      }
      if (result === false) return
      rememberSent(outgoingText)
      resetInput()
      return
    }
    if (!summary) return
    if (hostStatus !== 'online') {
      toast('主机未连接，消息未发送', 'error')
      return
    }
    // worktree 开关只记录意图：真正发送前才创建隔离分支（创建后 cwd 已切换）。
    if (activeHostId) {
      if (worktreeBusyRef.current) return
      worktreeBusyRef.current = true
      const ready = await ensureWorktree(activeHostId, summary.id)
      worktreeBusyRef.current = false
      if (!ready) return
    }
    if (!send(blocks, scopeTarget)) return
    rememberSent(outgoingText)
    resetInput()
  }

  const stop = () => {
    if (stopping) return
    if (onStop) onStop()
    else interrupt(scopeTarget)
  }

  const changeMode = (next: PermissionMode) => {
    if (sessionless) onPermissionModeChange?.(next)
    else void setPermissionMode(next, scopeTarget)
  }

  const cycleMode = () => {
    const idx = MODES.indexOf(mode)
    changeMode(MODES[(idx + 1) % MODES.length])
  }

  const changeModel = (
    nextProfileId: string,
    nextGroupId: string | undefined,
    nextModel: string,
  ) => {
    if (sessionless) onModelChange?.(nextProfileId, nextGroupId, nextModel)
    else void setModel(nextProfileId, nextGroupId, nextModel, scopeTarget)
  }

  const loadModelPrices = useCallback(
    (profileId: string, groupId: string | undefined) => {
      if (!effectiveHost || !profileId) return
      const key = `${profileId}:${groupId ?? ''}`
      setPriceCache((prev) => (prev[key] ? prev : { ...prev, [key]: 'loading' }))
      api
        .modelPrices(effectiveHost, profileId, groupId)
        .then((res) => setPriceCache((prev) => ({ ...prev, [key]: res.prices })))
        .catch(() =>
          setPriceCache((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          }),
        )
    },
    [effectiveHost],
  )

  const priceKey = `${currentProfileId}:${currentGroupId ?? ''}`
  const cachedPrices = priceCache[priceKey]
  const modelPrices = cachedPrices === 'loading' ? undefined : cachedPrices

  const changeAutoRoute = () => {
    const profile = currentProfileId || profiles[0]?.id
    if (!profile) return
    const group = currentGroupId ?? profileModelGroups(profiles.find((p) => p.id === profile) ?? null)[0]?.groupId
    changeModel(profile, group, 'auto')
  }

  const changeEffort = (next: ReasoningEffort, remember = true) => {
    if (remember) rememberEffort(next)
    setLocalEffort(next)
    if (sessionless) {
      onEffortChange?.(next)
      return
    }
    if (activeHostId && summary) {
      void updateSession(activeHostId, summary.id, { effort: next })
    }
  }

  // 切换模型后当前强度不再受支持：降到最近的可用档；完全不支持思考则回到关
  useEffect(() => {
    if (modelEfforts === undefined) return
    if (modelEfforts.length === 0) {
      if (effort !== 'off') changeEffort('off', false)
      return
    }
    if (!modelEfforts.includes(effort)) {
      changeEffort(nearestEffort(modelEfforts, effort), false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelEfforts, effort])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229
    if (
      !composing &&
      completion &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')
    ) {
      setCompletion(null)
    }
    if (completion) {
      if (composing) return
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
        stop()
      }
      return
    }
    if (
      e.key === 'ArrowUp' &&
      !composing &&
      !completion &&
      text.length === 0 &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const el = textareaRef.current
      if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
        const last = loadSentHistory(draftKey)[0]
        if (last) {
          e.preventDefault()
          setText(last)
          window.requestAnimationFrame(() => {
            const box = textareaRef.current
            if (!box) return
            box.setSelectionRange(last.length, last.length)
          })
        }
      }
      return
    }
    if (e.key === 'Enter') {
      if (composing) return
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        void handleSend()
        return
      }
      if (isMobile || e.shiftKey) return
      e.preventDefault()
      void handleSend()
      return
    }
    // 不劫持 Shift+Tab：反向 Tab 必须能离开输入框（键盘可达性）。
    // 权限模式切换改用 Alt+Shift+Tab，仍保留单手键盘操作。
    if (e.key === 'Tab' && e.shiftKey && e.altKey) {
      if (composing) return
      e.preventDefault()
      cycleMode()
    }
  }

  const onChange = (value: string, caret: number) => {
    setText(value)
    setCompletion(detectCompletion(value, caret))
  }

  // 语音转写结果插入光标处，不自动发送。
  const insertVoiceText = (spoken: string) => {
    const node = textareaRef.current
    const value = textRef.current
    const start = node?.selectionStart ?? value.length
    const end = node?.selectionEnd ?? value.length
    const before = value.slice(0, start)
    const after = value.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const insert = `${prefix}${spoken}${suffix}`
    const caret = start + insert.length
    onChange(before + insert + after, caret)
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  // 桌面快捷键：按住 Ctrl+Shift+Space 说话，松开转写。
  useEffect(() => {
    const onVoiceKeyDown = (e: KeyboardEvent) => {
      if (!isTargetFocused(scopeTarget ?? null)) return
      if (!e.ctrlKey || !e.shiftKey || e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      const editable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (editable && target !== textareaRef.current) return
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen) return
      if (disabled) return
      e.preventDefault()
      voiceRef.current?.startHold()
    }
    const onVoiceKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') voiceRef.current?.stopHold()
    }
    window.addEventListener('keydown', onVoiceKeyDown)
    window.addEventListener('keyup', onVoiceKeyUp)
    return () => {
      window.removeEventListener('keydown', onVoiceKeyDown)
      window.removeEventListener('keyup', onVoiceKeyUp)
    }
  }, [disabled, scopeTarget])

  const sendState = running ? 'running' : canSend ? 'ready' : 'idle'

  return (
    <div className={cn('relative', className)}>
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
        data-dragging={dragging}
        className="composer-card"
      >
        {dragging && (
          <div className="composer-drop">
            <ImageIcon size={16} />
            松开以添加图片
          </div>
        )}
        <div className="px-3.5 pb-0.5 pt-3">
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
                    className="size-full object-contain p-0.5"
                  />
                  <IconButton
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    label="移除图片"
                    className="absolute right-0 top-0 rounded-bl-lg rounded-tr-lg bg-[color-mix(in_srgb,var(--t-text)_62%,transparent)] text-[var(--t-bg)] opacity-80 hover:bg-[color-mix(in_srgb,var(--t-text)_72%,transparent)] hover:text-[var(--t-bg)] hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {pasted.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pasted.map((p) => (
                <div
                  key={p.id}
                  title={`${p.lines} 行 · ${p.text.length} 字`}
                  className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-text-soft"
                >
                  <FileText size={13} className="shrink-0 text-muted" />
                  <span className="truncate">粘贴的文本 · {p.lines} 行</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted">
                    {p.text.length > 999 ? `${(p.text.length / 1000).toFixed(1)}k` : p.text.length} 字
                  </span>
                  <IconButton
                    size="sm"
                    onClick={() => setPasted((prev) => prev.filter((x) => x.id !== p.id))}
                    label="移除粘贴的文本"
                    className="size-6! [&_svg]:size-3"
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) =>
              onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }
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
            disabled={disabled}
            aria-label="消息输入框"
            placeholder={
              placeholder ??
              (running ? '运行中，可继续输入，消息会排队发送…' : '给 Tandem 发消息…')
            }
            className="composer-textarea max-sm:min-h-11"
          />
        </div>

        <div className="flex min-w-0 flex-nowrap items-center gap-1 px-2 pb-2 pt-1">
          <IconButton
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            label="添加图片"
            tooltipSide="top"
            className="max-sm:size-11"
          >
            <Paperclip size={16} />
          </IconButton>
          <VoiceButton
            ref={voiceRef}
            onText={insertVoiceText}
            disabled={disabled}
            tooltipSide="top"
          />
          {isMobile || compact ? (
            <MobileMoreMenu mode={mode} disabled={disabled} onChange={changeMode} />
          ) : (
            <>
              <ThinkingModeMenu />
              <PermissionModeMenu mode={mode} disabled={disabled} onChange={changeMode} />
            </>
          )}
          <span className="min-w-0 flex-1" />
          {!sessionless && summary && !compact && (
            <span className="contents max-sm:hidden">
              <ContextMeter compactDisabled={running} />
            </span>
          )}
          <ModelMenu
            compact={compact}
            profiles={profiles}
            profileId={currentProfileId}
            groupId={currentGroupId}
            model={currentModel}
            autoRoute={autoRoute}
            autoModel={autoRoute ? routedModel : undefined}
            prices={modelPrices}
            effort={effort}
            efforts={supportedEfforts}
            loading={profilesLoading}
            disabled={disabled || (!sessionless && !summary)}
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            onSelect={changeModel}
            onSelectAuto={changeAutoRoute}
            onLoadPrices={loadModelPrices}
            onEffortChange={changeEffort}
            onManage={() => openSettings('profiles')}
            onOpen={() => {
              if (effectiveHostId && profiles.length === 0 && !profilesLoading) {
                void refreshProfiles(effectiveHostId)
              }
            }}
          />
          <Button
            variant="accent"
            onClick={running ? stop : () => void handleSend()}
            disabled={running ? stopping : !canSend}
            data-state={sendState}
            tooltip={running ? '停止生成 (Esc)' : '发送 (Enter)'}
            tooltipSide="top"
            aria-label={running ? '停止生成' : '发送消息'}
            className="composer-send ml-0.5 shrink-0 disabled:cursor-not-allowed"
          >
            <span key={sendState} className="send-icon flex items-center justify-center">
              {running ? (
                stopping ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Square size={11} className="fill-current" />
                )
              ) : (
                <ArrowUp size={17} strokeWidth={2.2} />
              )}
            </span>
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length) void addImages(files)
          }}
        />
      </div>
    </div>
  )
}

