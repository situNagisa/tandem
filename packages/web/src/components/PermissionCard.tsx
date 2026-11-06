import { useEffect, useMemo, useState } from 'react'
import { Bot, Loader2, Plus, ShieldAlert } from 'lucide-react'
import type { PermissionDecision, PermissionRequest, PermissionRule } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { CodeBlock } from './CodeBlock'
import { DiffView } from './DiffView'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input, SegmentedControl, Select } from './ui/Controls'

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
const TOOL_OPTIONS = ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', '*']
const ACTIONS: Array<{ value: PermissionRule['action']; label: string }> = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '询问' },
  { value: 'deny', label: '拒绝' },
]

/** 从审批请求推断一条规则的预填：Bash 取命令前两个词作为前缀，文件工具取路径。 */
function quickRule(toolName: string, input: Record<string, unknown>, cwd: string): PermissionRule {
  if (toolName === 'Bash') {
    const command = str(input.command).split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
    const parts = command.split(' ').filter(Boolean)
    const prefix = parts.slice(0, Math.min(2, parts.length)).join(' ')
    return { tool: toolName, ...(prefix ? { pattern: `${prefix}*` } : {}), action: 'allow' }
  }
  if (FILE_TOOLS.has(toolName)) {
    let filePath = str(input.file_path) || str(input.path)
    const root = cwd.replace(/\/+$/, '')
    if (filePath && root && filePath.startsWith(`${root}/`)) filePath = filePath.slice(root.length + 1)
    return { tool: toolName, ...(filePath ? { pattern: filePath } : {}), action: 'allow' }
  }
  return { tool: toolName, action: 'allow' }
}

function AddRuleDialog({
  draft,
  hostId,
  onClose,
}: {
  draft: PermissionRule
  hostId: string | null
  onClose: () => void
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const toast = useUiStore((s) => s.toast)
  const [rule, setRule] = useState<PermissionRule>(draft)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!host || saving) return
    setSaving(true)
    try {
      const list = await api.permissions(host)
      await api.setPermissions(host, [...list, { ...rule, pattern: rule.pattern?.trim() || undefined }])
      toast('已添加权限规则', 'success')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加规则失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="添加为权限规则"
      description="规则保存在 Host 上，立即对后续请求生效；当前这次请求仍需手动允许或拒绝。"
      className="max-w-md"
      footer={
        <>
          <Button size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            size="lg"
            variant="primary"
            onClick={() => void save()}
            disabled={saving || !host}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            添加规则
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[13px] text-muted">工具</span>
          <Select
            value={rule.tool}
            onChange={(e) => setRule((r) => ({ ...r, tool: e.target.value }))}
            className="font-mono"
          >
            {!TOOL_OPTIONS.includes(rule.tool) && <option value={rule.tool}>{rule.tool}</option>}
            {TOOL_OPTIONS.map((tool) => (
              <option key={tool} value={tool}>
                {tool === '*' ? '全部工具' : tool}
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1">
          <span className="text-[13px] text-muted">
            匹配模式{rule.tool === 'Bash' ? '（命令前缀，可用 * 通配）' : '（文件 glob，留空匹配全部）'}
          </span>
          <Input
            value={rule.pattern ?? ''}
            onChange={(e) => setRule((r) => ({ ...r, pattern: e.target.value }))}
            placeholder={rule.tool === 'Bash' ? 'npm test*' : 'src/**/*.ts'}
            className="font-mono"
          />
        </label>
        <div className="space-y-1">
          <span className="text-[13px] text-muted">动作</span>
          <SegmentedControl
            aria-label="规则动作"
            className="flex w-full"
            options={ACTIONS.map((action) => ({ value: action.value, label: action.label }))}
            value={rule.action}
            onChange={(action) => setRule((r) => ({ ...r, action }))}
          />
        </div>
      </div>
    </Modal>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function Kbd({ children, inverse }: { children: React.ReactNode; inverse?: boolean }) {
  return (
    <kbd
      className={cn(
        'ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 text-[12px] font-normal leading-none',
        inverse
          ? 'bg-[color-mix(in_srgb,var(--t-primary-fg)_12%,transparent)] text-[color-mix(in_srgb,var(--t-primary-fg)_55%,transparent)]'
          : 'text-[var(--t-text-tertiary)]',
      )}
    >
      {children}
    </kbd>
  )
}

export function PermissionCard({
  request,
  more,
}: {
  request: PermissionRequest
  more: number
}) {
  const decide = useAppStore((s) => s.decidePermission)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const subagentSummary = useAppStore(
    (s) => s.active?.subagents[request.sessionId]?.summary ?? null,
  )
  const subagentTitle = subagentSummary?.title ?? request.sourceTitle ?? null
  const sourceDepth = request.depth ?? subagentSummary?.depth ?? 1
  const cwd = useAppStore((s) => s.active?.summary?.cwd ?? '')
  const [ruleDraft, setRuleDraft] = useState<PermissionRule | null>(null)
  const input = useMemo(() => asRecord(request.input), [request.input])
  const toolName = request.toolName
  const command = str(input.command)
  const filePath = str(input.file_path)
  const oldString = str(input.old_string)
  const newString = str(input.new_string)
  const content = str(input.content)

  const handle = (decision: PermissionDecision) => decide(request.id, decision)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState()
      if (
        ui.settingsOpen ||
        ui.newSessionOpen ||
        ui.searchOpen ||
        ui.mobileSidebar ||
        ui.mobilePanel
      ) {
        return
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.key === '1') {
        e.preventDefault()
        decide(request.id, 'allow')
      } else if (e.key === '2') {
        e.preventDefault()
        decide(request.id, 'allow_always')
      } else if (e.key === '3') {
        e.preventDefault()
        decide(request.id, 'deny')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request.id, decide])

  let preview: React.ReactNode = null
  if (toolName === 'Bash' && command) {
    preview = (
      <div className="max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[color-mix(in_srgb,var(--t-bg)_55%,transparent)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-text">
        <span className="select-none text-muted">$ </span>
        {command}
      </div>
    )
  } else if (toolName === 'Edit' && (oldString || newString)) {
    preview = (
      <DiffView
        oldText={oldString}
        newText={newString}
        fileName={filePath || 'Edit'}
        maxHeight={240}
      />
    )
  } else if (toolName === 'Write' && content) {
    preview = <CodeBlock code={content} fileName={filePath} maxHeight={180} />
  } else if (filePath) {
    preview = (
      <div className="truncate rounded-lg bg-[color-mix(in_srgb,var(--t-surface-2)_60%,transparent)] px-3 py-2 font-mono text-[12px] text-text-soft">
        {filePath}
      </div>
    )
  } else if (Object.keys(input).length > 0) {
    preview = (
      <CodeBlock
        code={JSON.stringify(input, null, 2)}
        language="json"
        showHeader={false}
        maxHeight={150}
      />
    )
  }

  return (
    <div className="permission-card mb-2.5">
      <div className="flex items-start gap-2 px-3.5 pb-2 pt-2.5">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--t-text-tertiary)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--t-text-tertiary)]">
              需要你的许可
            </span>
            <span className="font-mono text-[12px] text-text-soft">{toolName}</span>
            {more > 0 && (
              <span className="text-[12px] text-muted">另有 {more} 个待审批</span>
            )}
          </div>
          {subagentTitle && (
            <div className="mt-1 flex items-center gap-1 text-[12px] text-muted">
              <Bot size={11} className="shrink-0 text-accent/80" />
              <span className="min-w-0 truncate">
                来自{sourceDepth === 1 ? '子代理' : sourceDepth === 2 ? '孙代理' : `第${sourceDepth}层代理`}：{subagentTitle}
              </span>
            </div>
          )}
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-text-soft">
            {request.description}
          </p>
        </div>
      </div>
      {preview && (
        <div className="max-h-[min(34dvh,320px)] overflow-y-auto px-3.5 pb-2.5">{preview}</div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRuleDraft(quickRule(toolName, input, cwd))}
          tooltip="把这条件添加为 Host 级权限规则"
          tooltipSide="top"
          className="h-7 px-1.5 text-[12px] text-[var(--t-text-tertiary)] hover:text-text"
        >
          <Plus size={11} /> 添加为规则…
        </Button>
        <div className="permission-actions flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={() => handle('deny')}
            className="max-sm:min-h-11"
          >
            拒绝
            <Kbd>3</Kbd>
          </Button>
          <Button
            variant="secondary"
            onClick={() => handle('allow_always')}
            className="max-sm:min-h-11"
          >
            总是允许
            <Kbd>2</Kbd>
          </Button>
          <Button
            variant="primary"
            onClick={() => handle('allow')}
            className="max-sm:min-h-11"
          >
            允许
            <Kbd inverse>1</Kbd>
          </Button>
        </div>
      </div>
      {ruleDraft && (
        <AddRuleDialog draft={ruleDraft} hostId={hostId} onClose={() => setRuleDraft(null)} />
      )}
    </div>
  )
}
