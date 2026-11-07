import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Bot, Loader2, MessageSquare, Plus, ShieldAlert, X } from 'lucide-react'
import type { PermissionDecision, PermissionRequest, PermissionRule, TeamMember } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { CodeBlock } from './CodeBlock'
import { DiffView } from './DiffView'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input, SegmentedControl, Select, Textarea } from './ui/Controls'
import { VoiceButton } from './voice/VoiceButton'
import { Menu } from './ui/Menu'

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
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const teamRole = useAppStore((s) =>
    s.active?.hostId ? s.runtimes[s.active.hostId]?.team?.role : undefined,
  )
  const [approvers, setApprovers] = useState<TeamMember[]>([])
  const [approversLoaded, setApproversLoaded] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<PermissionRule | null>(null)
  const [denyOpen, setDenyOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const [denyReason, setDenyReason] = useState('')
  const denyRef = useRef<HTMLTextAreaElement>(null)
  const input = useMemo(() => asRecord(request.input), [request.input])
  const toolName = request.toolName
  const command = str(input.command)
  const filePath = str(input.file_path)
  const oldString = str(input.old_string)
  const newString = str(input.new_string)
  const content = str(input.content)

  const handle = (decision: PermissionDecision) => decide(request.id, decision)

  const insertDenyText = (spoken: string) => {
    const node = denyRef.current
    const start = node?.selectionStart ?? denyReason.length
    const end = node?.selectionEnd ?? denyReason.length
    const before = denyReason.slice(0, start)
    const after = denyReason.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const insert = `${prefix}${spoken}${suffix}`
    const next = before + insert + after
    setDenyReason(next)
    window.requestAnimationFrame(() => {
      denyRef.current?.focus()
      denyRef.current?.setSelectionRange(start + insert.length, start + insert.length)
    })
  }

  const openDeny = () => {
    setDenyOpen(true)
    window.requestAnimationFrame(() => denyRef.current?.focus())
  }

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

  // 新审批出现时，若焦点在空的输入框里，把焦点交给「允许」：
  // 键盘用户可以直接按 1/2/3，不必先 Tab 一圈；正在输入排队消息时不抢焦点。
  useEffect(() => {
    const focusable = () => {
      const now = document.activeElement as HTMLElement | null
      const composer = now?.closest('.composer-card')
      const idleComposer =
        !!composer && !(composer.querySelector('textarea') as HTMLTextAreaElement | null)?.value.trim()
      const neutral = !now || now === document.body
      return idleComposer || neutral
    }
    if (!focusable()) return
    // 新会话建立后 Composer 会在 60ms 后自动聚焦，稍等一拍再接管。
    const timer = window.setTimeout(() => {
      if (!focusable()) return
      cardRef.current?.querySelector<HTMLElement>('[data-permission-allow]')?.focus()
    }, 120)
    return () => window.clearTimeout(timer)
  }, [request.id])

  const canTransfer = teamRole === 'owner' || teamRole === 'approver' || teamRole === 'collaborator'
  const loadApprovers = () => {
    if (!host || !canTransfer) return
    api
      .teamApprovers(host)
      .then((list) => {
        setApprovers(list.filter((member) => member.online && !member.revokedAt))
        setApproversLoaded(true)
      })
      .catch(() => setApproversLoaded(true))
  }

  const transfer = async (toMemberId: string) => {
    if (!host || transferring) return
    setTransferring(true)
    try {
      await api.transferPermission(host, request.id, toMemberId)
      useUiStore.getState().toast('已转交审批', 'success')
    } catch (err) {
      useUiStore.getState().toast(err instanceof Error ? err.message : '转交失败', 'error')
    } finally {
      setTransferring(false)
    }
  }

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
    <div ref={cardRef} className="permission-card mb-2.5">
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
              <Bot size={11} className="shrink-0 text-accent-text" />
              <span className="min-w-0 truncate">
                来自{sourceDepth === 1 ? '子代理' : sourceDepth === 2 ? '孙代理' : `第${sourceDepth}层代理`}：{subagentTitle}
              </span>
            </div>
          )}
          {request.transferredFrom && (
            <div className="mt-1 text-[12px] text-accent-text">
              由 {request.transferredFrom.name} 转交
              {request.assignedTo ? ` · 待 ${request.assignedTo.name} 处理` : ''}
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
        <div className="flex flex-wrap items-center gap-1">
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
                    {canTransfer && (
            <Menu
              side="top"
              align="start"
              onOpenChange={(open) => {
                if (open) loadApprovers()
              }}
              trigger={
                <Button variant="ghost" className="max-sm:min-h-11" disabled={transferring}>
                  <ArrowRightLeft size={13} /> 转给…
                </Button>
              }
            >
              {approvers.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-muted">
                  {approversLoaded ? '暂无在线的审批者' : '正在读取成员…'}
                </div>
              ) : (
                approvers.map((member) => (
                  <Menu.Item
                    key={member.id}
                    icon={<span className="text-[11px]">{member.name.slice(0, 1).toUpperCase()}</span>}
                    hint={member.role === 'approver' ? '审批者' : '协作者'}
                    selected={request.assignedTo?.memberId === member.id}
                    onSelect={() => void transfer(member.id)}
                  >
                    {member.name}
                  </Menu.Item>
                ))
              )}
            </Menu>
          )}
        </div>
        <div className="permission-actions flex flex-wrap items-center gap-1.5 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
          <Button
            variant="ghost"
            onClick={() => (denyOpen ? setDenyOpen(false) : openDeny())}
            aria-expanded={denyOpen}
            className="max-sm:order-4 max-sm:min-h-11 max-sm:w-full"
          >
            <MessageSquare size={13} /> 拒绝并说明
          </Button>
          <Button
            variant="ghost"
            onClick={() => handle('deny')}
            className="max-sm:order-3 max-sm:min-h-11 max-sm:w-full"
          >
            拒绝
            <Kbd>3</Kbd>
          </Button>
          <Button
            variant="secondary"
            onClick={() => handle('allow_always')}
            className="max-sm:order-2 max-sm:min-h-11 max-sm:w-full"
          >
            总是允许
            <Kbd>2</Kbd>
          </Button>
          <Button
            variant="primary"
            onClick={() => handle('allow')}
            data-permission-allow=""
            className="max-sm:order-1 max-sm:min-h-11 max-sm:w-full"
          >
            允许
            <Kbd inverse>1</Kbd>
          </Button>
        </div>
      </div>
      {denyOpen && (
        <div className="border-t border-border/70 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`deny-reason-${request.id}`} className="text-[12px] text-muted">
              说明拒绝原因（可选，会作为工具结果返回给 agent）
            </label>
            <button
              type="button"
              onClick={() => setDenyOpen(false)}
              className="rounded p-0.5 text-muted hover:text-text"
              aria-label="收起拒绝说明"
            >
              <X size={13} />
            </button>
          </div>
          <div className="mt-1.5 flex items-end gap-1.5">
            <Textarea
              id={`deny-reason-${request.id}`}
              ref={denyRef}
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={2}
              placeholder="例如：先不要删这个文件，改成增量修改；或说出你的顾虑…"
              size="sm"
              className="min-h-[52px] flex-1"
            />
            <VoiceButton onText={insertDenyText} size="md" tooltipSide="top" />
          </div>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setDenyOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => decide(request.id, 'deny', denyReason.trim() || undefined)}
            >
              拒绝并提交
            </Button>
          </div>
        </div>
      )}
      {ruleDraft && (
        <AddRuleDialog draft={ruleDraft} hostId={hostId} onClose={() => setRuleDraft(null)} />
      )}
    </div>
  )
}
