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
} from 'react'
import type {
  ContentBlock,
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
  Ellipsis,
  FileText,
  Image as ImageIcon,
  Loader2,
  Map,
  Paperclip,
  PencilLine,
  Search,
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
import { Popover } from './ui/Popover'
import { ContextMeter } from './chat/ContextMeter'
import { Button, IconButton } from './ui/Button'
import { SegmentedControl } from './ui/Controls'
import { MenuDivider, MenuItem, MenuList } from './ui/Menu'
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
}
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const MODE_META: Record<
  PermissionMode,
  {
    label: string
    hint: string
    icon: typeof Shield
  }
> = {
  default: { label: '询问', hint: '每次执行工具前询问', icon: Shield },
  acceptEdits: {
    label: '自动接受编辑',
    hint: '自动接受文件修改，其他仍询问',
    icon: PencilLine,
  },
  plan: { label: '计划模式', hint: '只做规划，不直接执行改动', icon: Map },
  bypassPermissions: {
    label: '全部允许',
    hint: '不再询问，请谨慎使用',
    icon: ShieldOff,
  },
}

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
}

function prettyModel(id: string): string {
  if (!id) return '选择模型'
  const known: Record<string, string> = {
    'claude-opus-4-1': 'Claude Opus 4.1',
    'claude-opus-4': 'Claude Opus 4',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-3-7-sonnet': 'Claude Sonnet 3.7',
    'gpt-5': 'GPT-5',
    'gpt-4o': 'GPT-4o',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
  }
  if (known[id]) return known[id]
  const family = /^claude-(\d+)-(\d+)-(sonnet|opus|haiku)/.exec(id)
  if (family) {
    return `Claude ${family[3][0].toUpperCase()}${family[3].slice(1)} ${family[1]}.${family[2]}`
  }
  const family2 = /^claude-(sonnet|opus|haiku)-(\d+)-(\d+)/.exec(id)
  if (family2) {
    return `Claude ${family2[1][0].toUpperCase()}${family2[1].slice(1)} ${family2[2]}.${family2[3]}`
  }
  const family3 = /^claude-(\d+)-(sonnet|opus|haiku)/.exec(id)
  if (family3) {
    return `Claude ${family3[2][0].toUpperCase()}${family3[2].slice(1)} ${family3[1]}`
  }
  let s = id.replace(/^claude-/, 'Claude ')
  s = s.replace(/-\d{8}$/, '')
  s = s.replace(/-(\d+)-(\d+)$/, ' $1.$2')
  s = s.replace(/-(\d+)$/, ' $1')
  if (!/^claude/i.test(s)) s = s.replace(/[-_]/g, ' ')
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 手机底栏窄，去掉「Claude」前缀，把宽度让给权限与发送。 */
function shortModelName(id: string): string {
  return prettyModel(id).replace(/^Claude\s+/i, '')
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="chat-match">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function PermissionModeRows({
  mode,
  close,
  onChange,
}: {
  mode: PermissionMode
  close: () => void
  onChange: (mode: PermissionMode) => void
}) {
  return (
    <>
      {MODES.map((m) => {
        const item = MODE_META[m]
        const ItemIcon = item.icon
        return (
          <MenuItem
            key={m}
            icon={
              <ItemIcon
                className={m === 'bypassPermissions' ? 'text-danger' : 'text-text-secondary'}
              />
            }
            hint={item.hint}
            selected={m === mode}
            danger={m === 'bypassPermissions'}
            role="menuitemradio"
            ariaChecked={m === mode}
            onSelect={() => {
              close()
              if (m !== mode) onChange(m)
            }}
          >
            {item.label}
          </MenuItem>
        )
      })}
    </>
  )
}

function PermissionModeItems({
  mode,
  close,
  onChange,
}: {
  mode: PermissionMode
  close: () => void
  onChange: (mode: PermissionMode) => void
}) {
  return (
    <MenuList aria-label="权限模式">
      <PermissionModeRows mode={mode} close={close} onChange={onChange} />
    </MenuList>
  )
}

function PermissionModeMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const meta = MODE_META[mode]
  const Icon = meta.icon
  return (
    <Popover
      side="top"
      align="left"
      padded={false}
      panelClassName="w-[220px]"
      trigger={({ open, toggle }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          tooltip={open ? undefined : `权限模式：${meta.label}（Shift+Tab 切换）`}
          tooltipSide="top"
          aria-label={`权限模式：${meta.label}`}
          className={cn(
            'max-w-[170px] max-sm:min-h-11',
            open && 'bg-[var(--t-bg-hover)] text-text',
          )}
        >
          <Icon
            size={13}
            className={cn(
              'shrink-0',
              mode === 'bypassPermissions' ? 'text-danger' : 'text-text-secondary',
            )}
          />
          <span className={cn('truncate', mode === 'bypassPermissions' && 'text-danger')}>
            {meta.label}
          </span>
          <ChevronDown size={11} className="shrink-0 opacity-50" />
        </Button>
      )}
    >
      {(close) => (
        <PermissionModeItems mode={mode} close={close} onChange={onChange} />
      )}
    </Popover>
  )
}

const THINKING_MODES: ThinkingMode[] = ['show', 'collapse', 'hidden']

function ThinkingModeMenu() {
  const mode = useThinkingMode()
  const meta = THINKING_MODE_META[mode]
  return (
    <Popover
      side="top"
      align="left"
      padded={false}
      panelClassName="w-[188px]"
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          label={`思考过程：${meta.label}`}
          tooltip={open ? '' : undefined}
          tooltipSide="top"
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-hover)] text-text-soft')}
        >
          <Brain size={16} />
        </IconButton>
      )}
    >
      {(close) => <ThinkingModeItems close={close} />}
    </Popover>
  )
}

function ThinkingModeRows({ close }: { close: () => void }) {
  const mode = useThinkingMode()
  return (
    <>
      {THINKING_MODES.map((item) => (
        <MenuItem
          key={item}
          hint={THINKING_MODE_META[item].hint}
          selected={item === mode}
          role="menuitemradio"
          ariaChecked={item === mode}
          onSelect={() => {
            close()
            setThinkingMode(item)
          }}
        >
          {THINKING_MODE_META[item].label}
        </MenuItem>
      ))}
    </>
  )
}

function ThinkingModeItems({ close }: { close: () => void }) {
  return (
    <MenuList aria-label="思考过程">
      <ThinkingModeRows close={close} />
    </MenuList>
  )
}

/** 手机底栏空间有限：思考过程与权限模式收进「更多」菜单。 */
function MobileMoreMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const meta = MODE_META[mode]
  return (
    <Popover
      side="top"
      align="left"
      padded={false}
      panelClassName="w-[232px] max-w-[calc(100vw-1.5rem)]"
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          label={`更多设置 · 权限模式：${meta.label}`}
          tooltip={open ? '' : undefined}
          tooltipSide="top"
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-hover)] text-text-soft')}
        >
          <span className="relative flex items-center justify-center">
            <Ellipsis size={17} />
            {mode !== 'default' && (
              <span
                className={cn(
                  'absolute -right-1 -top-0.5 size-1.5 rounded-full',
                  mode === 'bypassPermissions' ? 'bg-danger' : 'bg-accent',
                )}
              />
            )}
          </span>
        </IconButton>
      )}
    >
      {(close) => (
        <MenuList aria-label="更多设置">
          <ThinkingModeRows close={close} />
          <MenuDivider />
          <PermissionModeRows mode={mode} close={close} onChange={onChange} />
        </MenuList>
      )}
    </Popover>
  )
}

function ModelPanel({
  profiles,
  profileId,
  groupId,
  model,
  effort,
  efforts,
  loading,
  onSelect,
  onEffortChange,
  onManage,
  close,
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  close: () => void
}) {
  const [query, setQuery] = useState('')
  const tabs = useMemo(() => {
    return profiles.flatMap((profile) => {
      const groups = profileModelGroups(profile)
      const multi = (profile.groups?.length ?? 0) > 1
      return groups.map((group) => ({
        key: `${profile.id}:${group.groupId ?? 'default'}`,
        profile,
        groupId: group.groupId,
        label: multi ? `${profile.name} › ${group.name}` : profile.name,
        models: group.models,
      }))
    })
  }, [profiles])
  const currentKey = `${profileId}:${groupId ?? 'default'}`
  const [activeKey, setActiveKey] = useState(currentKey)

  useEffect(() => {
    if (tabs.some((tab) => tab.key === activeKey)) return
    setActiveKey(tabs.some((tab) => tab.key === currentKey) ? currentKey : (tabs[0]?.key ?? ''))
  }, [tabs, activeKey, currentKey])

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0]
  const showSearch = tabs.reduce((n, tab) => n + tab.models.length, 0) > 8
  const q = query.trim().toLowerCase()
  const models = activeTab
    ? activeTab.models.filter(
        (m) => !q || m.toLowerCase().includes(q) || prettyModel(m).toLowerCase().includes(q),
      )
    : []

  const choose = (nextModel: string) => {
    if (!activeTab) return
    close()
    if (
      activeTab.profile.id !== profileId ||
      (activeTab.groupId ?? undefined) !== (groupId ?? undefined) ||
      nextModel !== model
    ) {
      onSelect(activeTab.profile.id, activeTab.groupId, nextModel)
    }
  }

  return (
    <div className="w-[360px] max-w-[calc(100vw-1.5rem)]">
      <MenuList aria-label="选择模型" className="p-0">
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setActiveKey(tab.key)
                setQuery('')
              }}
              className={cn(
                'h-7 shrink-0 whitespace-nowrap rounded-md px-2 text-[12px] transition-colors',
                tab.key === activeKey
                  ? 'bg-[var(--t-bg-active)] text-text'
                  : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {showSearch && (
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2.5 text-muted">
            <Search size={12} className="shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型"
              aria-label="搜索模型"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-muted"
            />
          </div>
        )}
        <div className="max-h-[300px] shrink-0 overflow-y-auto p-1">
          {loading && profiles.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-4 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> 加载账号…
            </div>
          )}
          {!loading && models.length === 0 && (
            <div className="px-2 py-3 text-[12px] leading-5 text-muted">
              {profiles.length === 0
                ? '这台 Host 还没有配置账号。'
                : activeTab
                  ? '没有匹配的模型。'
                  : '没有可用模型。'}
            </div>
          )}
          {models.map((m) => {
            const selected =
              !!activeTab &&
              activeTab.profile.id === profileId &&
              (activeTab.groupId ?? undefined) === (groupId ?? undefined) &&
              m === model
            return (
              <MenuItem
                key={m}
                selected={selected}
                title={m}
                role="menuitemradio"
                ariaChecked={selected}
                onMouseDown={(e) => e.preventDefault()}
                onSelect={() => choose(m)}
              >
                <span className="text-[12.5px]">
                  <Highlight text={prettyModel(m)} query={query} />
                </span>
              </MenuItem>
            )
          })}
        </div>
      </MenuList>
      <div className="border-t border-border p-1.5">
        <div className="flex items-center justify-between gap-2">
          {efforts.length > 0 && (
            <SegmentedControl
              size="sm"
              aria-label="思考强度"
              value={efforts.includes(effort) ? effort : nearestEffort(efforts, effort)}
              options={efforts.map((value) => ({ value, label: EFFORT_LABEL[value] }))}
              onChange={onEffortChange}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              close()
              onManage()
            }}
            className="shrink-0 px-1.5 text-[12px]"
          >
            管理账号…
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModelMenu({
  profiles,
  profileId,
  groupId,
  model,
  effort,
  efforts,
  loading,
  disabled,
  onSelect,
  onEffortChange,
  onManage,
  onOpen,
  open,
  onOpenChange,
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  disabled?: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  onOpen?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const currentProfile = profiles.find((p) => p.id === profileId) ?? null
  const currentGroup = groupName(currentProfile ?? undefined, groupId)
  const showEffort = efforts.length > 0 && efforts.includes(effort)
  const label = model
    ? `${shortModelName(model)}${showEffort ? effortSuffix(effort) : ''}`
    : '选择模型'
  return (
    <Popover
      side="top"
      align="right"
      padded={false}
      open={open}
      onOpenChange={onOpenChange}
      panelClassName="w-[360px] max-w-[calc(100vw-1.5rem)]"
      trigger={({ open: isOpen, toggle }) => (
        <Button
          variant="ghost"
          onClick={() => {
            if (!isOpen) onOpen?.()
            toggle()
          }}
          disabled={disabled}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          tooltip={
            isOpen
              ? undefined
              : currentProfile
                ? `${currentProfile.name}${currentGroup ? ` › ${currentGroup}` : ''} · ${model}`
                : '选择账号与模型'
          }
          tooltipSide="top"
          aria-label="选择模型"
          className={cn(
            'min-w-0 max-w-[220px] justify-start gap-1 px-2 font-normal max-sm:min-h-11 max-sm:max-w-[40vw]',
            isOpen && 'bg-[var(--t-bg-hover)] text-text-soft',
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Button>
      )}
    >
      {(close) => (
        <ModelPanel
          profiles={profiles}
          profileId={profileId}
          groupId={groupId}
          model={model}
          effort={effort}
          efforts={efforts}
          loading={loading}
          onSelect={onSelect}
          onEffortChange={onEffortChange}
          onManage={onManage}
          close={close}
        />
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
  let emptyText: ReactNode = '没有匹配项'
  if (completion.kind === 'slash' && loading) emptyText = '加载命令…'
  else if (completion.kind === 'file' && loading) emptyText = '搜索文件…'
  else if (completion.kind === 'slash') emptyText = '没有匹配的命令'
  else if (completion.kind === 'file') emptyText = '没有匹配的文件'

  return (
    <div className="absolute inset-x-0 bottom-full z-40 mb-2">
      <div
        className="completion-panel popover-panel relative w-[600px] max-w-full"
        data-side="top"
        data-align="left"
      >
        <MenuList
          aria-label="补全"
          activeIndex={items.length ? index : undefined}
          onActiveIndexChange={onIndex}
          keyboard={false}
          className="max-h-[232px] overflow-y-auto"
        >
          {loading && items.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {emptyText}
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-muted">{emptyText}</div>
          )}
          {items.map((item) => {
            const isDir = item.kind === 'file' && item.label.endsWith('/')
            const clean = isDir ? item.label.slice(0, -1) : item.label
            const cut = item.kind === 'file' ? clean.lastIndexOf('/') : -1
            const name = cut < 0 ? item.label : clean.slice(cut + 1) + (isDir ? '/' : '')
            const dir = cut < 0 ? '' : clean.slice(0, cut + 1)
            return (
              <MenuItem
                key={`${item.kind}:${item.value}`}
                icon={
                  item.kind === 'slash' ? (
                    <Terminal size={12} className="text-muted" />
                  ) : (
                    <FileText size={12} className="text-muted" />
                  )
                }
                hint={item.kind === 'slash' ? item.description || '无说明' : item.label}
                trailing={item.badge && item.badge !== '内置' ? item.badge : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onSelect={() => onSelect(item)}
              >
                <span className="font-mono text-[13px]">
                  {item.kind === 'file' ? (
                    <>
                      <Highlight text={name} query={completion.query} />
                      {dir && (
                        <span className="ml-1.5 text-[11.5px] text-muted">
                          <Highlight text={dir} query={completion.query} />
                        </span>
                      )}
                    </>
                  ) : (
                    <Highlight text={item.label} query={completion.query} />
                  )}
                </span>
              </MenuItem>
            )
          })}
        </MenuList>
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
}: ComposerProps) {
  const isMobile = useIsMobile()
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const storeRunning = useAppStore((s) => s.active?.running ?? false)
  const storeStopping = useAppStore((s) => s.active?.stopping ?? false)
  const activeHostId = useAppStore((s) => s.active?.hostId ?? null)
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

  const effectiveHostId = hostIdProp ?? activeHostId
  const cwd = cwdProp ?? summary?.cwd
  const running = runningProp ?? storeRunning
  const stopping = runningProp === undefined && storeStopping
  const mode = sessionless ? (permissionModeProp ?? 'default') : (summary?.permissionMode ?? 'default')
  const currentModel = sessionless ? (modelProp ?? '') : (summary?.model ?? '')
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

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
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
    if (!effectiveHostId || !currentProfileId || !currentModel) return
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
  }, [effectiveHostId, currentProfileId, currentGroupId, currentModel])

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
      toast('Host 未连接，消息未发送', 'error')
      return
    }
    if (!send(blocks)) return
    rememberSent(outgoingText)
    resetInput()
  }

  const stop = () => {
    if (stopping) return
    if (onStop) onStop()
    else interrupt()
  }

  const changeMode = (next: PermissionMode) => {
    if (sessionless) onPermissionModeChange?.(next)
    else void setPermissionMode(next)
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
    else void setModel(nextProfileId, nextGroupId, nextModel)
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
                  className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[11.5px] text-text-soft"
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
            className="composer-textarea"
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
          {isMobile ? (
            <MobileMoreMenu mode={mode} disabled={disabled} onChange={changeMode} />
          ) : (
            <>
              <ThinkingModeMenu />
              <PermissionModeMenu mode={mode} disabled={disabled} onChange={changeMode} />
            </>
          )}
          <span className="min-w-0 flex-1" />
          {!sessionless && summary && <ContextMeter compactDisabled={running} />}
          <ModelMenu
            profiles={profiles}
            profileId={currentProfileId}
            groupId={currentGroupId}
            model={currentModel}
            effort={effort}
            efforts={supportedEfforts}
            loading={profilesLoading}
            disabled={disabled || (!sessionless && !summary)}
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            onSelect={changeModel}
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
