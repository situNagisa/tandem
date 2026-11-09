import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Bot, Loader2, MoreHorizontal, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { PermissionDecision, PermissionRequest, PermissionRule, TeamMember } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { isTargetFocused, useSessionTarget, useSessionView } from './session/SessionScope'
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
      description="规则保存在主机上，立即对后续请求生效；当前这次请求仍需手动允许或拒绝。"
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
            匹配模式
            {rule.tool === 'Bash'
              ? '（命令前缀，可用 * 通配）'
              : '（文件 glob、绝对路径或 ~/目录，留空匹配全部）'}
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
  const scopeTarget = useSessionTarget() ?? undefined
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const subagentSummary = useSessionView(
    (s) => s?.subagents[request.sessionId]?.summary ?? null,
  )
  const subagentTitle = subagentSummary?.title ?? request.sourceTitle ?? null
  const sourceDepth = request.depth ?? subagentSummary?.depth ?? 1
  const cwd = useSessionView((s) => s?.summary?.cwd ?? '')
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const teamRole = useAppStore((s) =>
    hostId ? s.runtimes[hostId]?.team?.role : undefined,
  )
  const [approvers, setApprovers] = useState<TeamMember[]>([])
  const [approversLoaded, setApproversLoaded] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<PermissionRule | null>(null)
  const [learning, setLearning] = useState(false)
  const [denyOpen, setDenyOpen] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  // 反馈12#09：像 Claude Code 一样在会话流里用编号选项询问，↑↓ 选择、Enter 确认。
  const [selected, setSelected] = useState(0)
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

  const handle = (decision: PermissionDecision) => decide(request.id, decision, undefined, scopeTarget)

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

  const alwaysLabel = request.learned ? '总是允许（本项目）' : '总是允许（本会话）'
  const choose = (index: number) => {
    if (index === 0) decide(request.id, 'allow', undefined, scopeTarget)
    else if (index === 1) {
      if (request.learned) void applyLearned()
      else decide(request.id, 'allow_always', undefined, scopeTarget)
    } else openDeny()
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
        choose(0)
      } else if (e.key === '2') {
        e.preventDefault()
        choose(1)
      } else if (e.key === '3') {
        e.preventDefault()
        choose(2)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((value) => (e.key === 'ArrowDown' ? (value + 1) % 3 : (value + 2) % 3))
      } else if (e.key === 'Enter') {
        if (target?.tagName === 'BUTTON' || target?.tagName === 'A') return
        e.preventDefault()
        choose(selected)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request.id, decide, scopeTarget, selected])

  // 新审批出现时，若焦点在空的输入框里，把焦点交给「允许」：
  // 键盘用户可以直接按 1/2/3，不必先 Tab 一圈；正在输入排队消息时不抢焦点。
  useEffect(() => {
    if (!isTargetFocused(scopeTarget ?? null)) return
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
  }, [request.id, scopeTarget])

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

  // 同类请求已在本项目批准多次：一键添加项目规则，然后放行这一次。
  const applyLearned = async () => {
    const learned = request.learned
    if (!host || !learned || learning) return
    setLearning(true)
    try {
      await api.addPermissionRule(host, {
        tool: toolName,
        pattern: learned.pattern,
        action: 'allow',
        project: learned.project,
      })
      useUiStore.getState().toast('已添加项目规则，以后自动允许', 'success')
      decide(request.id, 'allow', undefined, scopeTarget)
    } catch (err) {
      useUiStore.getState().toast(err instanceof Error ? err.message : '添加规则失败', 'error')
    } finally {
      setLearning(false)
    }
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

  const askTarget =
    toolName === 'Bash'
      ? command.split('\n')[0]?.trim() || ''
      : filePath || str(input.path) || request.description || ''
  const askVerb =
    toolName === 'Bash'
      ? '允许运行'
      : toolName === 'Read'
        ? '允许读取'
        : toolName === 'Write'
          ? '允许写入'
          : toolName === 'Edit'
            ? '允许编辑'
            : toolName === 'Glob'
              ? '允许列出文件'
              : toolName === 'Grep'
                ? '允许搜索'
                : toolName === 'WebFetch'
                  ? '允许访问'
                  : '允许使用'
  const options = [
    { label: '允许', note: '' },
    { label: alwaysLabel, note: '' },
    { label: '拒绝，并说明…', note: '' },
  ]

  return (
    <div ref={cardRef} className="permission-card mb-2.5">
      <div className="px-3.5 pb-2 pt-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-6 text-text">
          <span className="text-muted">需要你的许可</span>
          <span className="text-muted">·</span>
          <span className="min-w-0">
            {askTarget ? (
              <>
                {askVerb}{' '}
                <code className="break-all rounded bg-[color-mix(in_srgb,var(--t-bg-active)_70%,transparent)] px-1 py-0.5 font-mono text-[12px] text-text-soft">
                  {askTarget.length > 140 ? `${askTarget.slice(0, 140)}…` : askTarget}
                </code>
                ？
              </>
            ) : (
              <>允许这次 {toolName} 操作？</>
            )}
          </span>
          {more > 0 && <span className="ml-auto text-[12px] text-muted">另有 {more} 个待审批</span>}
        </div>
        {subagentTitle && (
          <div className="mt-1 flex items-center gap-1 text-[12px] text-muted">
            <Bot size={11} className="shrink-0" />
            <span className="min-w-0 truncate">
              来自子代理：{subagentTitle}
            </span>
          </div>
        )}
        {request.transferredFrom && (
          <div className="mt-1 text-[12px] text-text-soft">
            由 {request.transferredFrom.name} 转交
            {request.assignedTo ? ` · 待 ${request.assignedTo.name} 处理` : ''}
          </div>
        )}
        {request.description &&
          !(
            toolName === 'Bash' &&
            !!command &&
            request.description.replace(/\s+/g, ' ').includes(command.replace(/\s+/g, ' '))
          ) && (
          <button
            type="button"
            onClick={() => setDescOpen((value) => !value)}
            aria-expanded={descOpen}
            data-tip={`${request.description}${descOpen ? '' : '（点击展开全文）'}`}
            className={cn(
              'mt-1 block w-full whitespace-pre-wrap break-words text-left text-[12px] leading-[1.55] text-muted',
              !descOpen && 'line-clamp-2',
            )}
          >
            {request.description}
          </button>
        )}
        {request.sandbox && (
          <p
            data-permission-sandbox=""
            className="mt-1 flex items-start gap-1 text-[12px] leading-[1.5] text-warning"
          >
            <ShieldAlert size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{request.sandbox.reason}</span>
          </p>
        )}
      </div>
      {preview && (
        <div className="max-h-[min(30dvh,240px)] overflow-y-auto px-3.5 pb-2">
          <div className="text-[12px]">{preview}</div>
        </div>
      )}
      {request.learned && (
        <div className="px-3.5 pb-1" data-permission-learned="">
          <button
            type="button"
            onClick={() => void applyLearned()}
            disabled={learning}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:min-h-11"
            data-tip={`已在本项目批准 ${request.learned.allows} 次；添加后同类命令不再询问，可随时在设置 → 权限中删除`}
          >
            {learning ? (
              <Loader2 size={12} className="shrink-0 animate-spin" />
            ) : (
              <ShieldCheck size={12} className="shrink-0" />
            )}
            <span className="min-w-0 truncate">
              以后在本项目自动允许 <code className="font-mono">{request.learned.pattern}</code>
            </span>
          </button>
        </div>
      )}
      <div className="px-3.5 pb-2" role="radiogroup" aria-label="审批选项">
        {options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected === index}
            {...(index === 0 ? { 'data-permission-allow': '' } : {})}
            onMouseEnter={() => setSelected(index)}
            onFocus={() => setSelected(index)}
            onClick={() => choose(index)}
            className={cn(
              'flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors max-sm:min-h-11',
              selected === index
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
            )}
          >
            <span className="w-4 shrink-0 text-right text-[12px] tabular-nums text-muted">
              {index + 1}
            </span>
            <span className={cn('min-w-0', index === 0 && 'font-medium')}>{option.label}</span>
            {index === 2 && <span className="ml-auto text-[11px] text-muted">可补充原因</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3.5 pb-2 text-[11px] text-muted">
        <span className="min-w-0 flex-1">↑↓ 选择 · Enter 确认 · 数字键快速选择</span>
        <Menu
          side="top"
          align="end"
          aria-label="更多审批操作"
          className="w-[260px]"
          onOpenChange={(open) => {
            if (open) loadApprovers()
          }}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-[12px] text-muted hover:text-text max-sm:min-h-11"
            >
              <MoreHorizontal size={12} /> 更多
            </Button>
          }
        >
          <Menu.Item
            icon={<Plus size={12} />}
            onSelect={() => setRuleDraft(quickRule(toolName, input, cwd))}
          >
            添加为规则…
          </Menu.Item>
          {canTransfer && (
            <Menu.Sub>
              <Menu.SubTrigger icon={<ArrowRightLeft size={12} />} disabled={transferring}>
                转给…
              </Menu.SubTrigger>
              <Menu.SubContent className="w-[240px]" aria-label="转交审批">
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
              </Menu.SubContent>
            </Menu.Sub>
          )}
          <Menu.Separator />
          <Menu.Item icon={<X size={12} />} onSelect={() => decide(request.id, 'deny', undefined, scopeTarget)}>
            拒绝（不说明）
          </Menu.Item>
        </Menu>
      </div>
      {denyOpen && (
        <div className="border-t border-border/60 px-3.5 py-2.5">
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
              onClick={() => decide(request.id, 'deny', denyReason.trim() || undefined, scopeTarget)}
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
