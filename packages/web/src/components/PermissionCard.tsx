import { useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, Bot, Loader2, MoreHorizontal, Plus, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import type { PermissionDecision, PermissionRequest, PermissionRule, TeamMember } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { isTargetFocused, useSessionTarget, useSessionView } from './session/SessionScope'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { permissionExplain, permissionTarget } from '../lib/permissionLabel'
import type { PermissionTrailEntry } from '../lib/types'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input, SegmentedControl, Select } from './ui/Controls'
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

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 text-[12px] font-normal leading-none text-[var(--t-text-tertiary)]">
      {children}
    </kbd>
  )
}

/**
 * 审批请求作为对话流里的一条消息（反馈14#07，参考 Claude Code Desktop）：
 * 标题一句问句 + 一行灰色说明 + 右下角「拒绝 / 允许一次」，更多操作收进菜单；
 * 不再停靠在输入框上方，也不遮挡输入框。
 */
export function PermissionCard({
  request,
  active = false,
}: {
  request: PermissionRequest
  /** 当前待处理的是这一张：只有它响应 Ctrl+Enter / Esc。 */
  active?: boolean
}) {
  const decide = useAppStore((s) => s.decidePermission)
  const scopeTarget = useSessionTarget() ?? undefined
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const subagentSummary = useSessionView(
    (s) => s?.subagents[request.sessionId]?.summary ?? null,
  )
  const subagentTitle = subagentSummary?.title ?? request.sourceTitle ?? null
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
  const cardRef = useRef<HTMLDivElement>(null)
  const input = asRecord(request.input)
  const toolName = request.toolName
  const { verb, target } = permissionTarget(request)
  const explain = permissionExplain(request)
  const alwaysLabel = '本会话总是允许'

  const decideWith = (decision: PermissionDecision) => decide(request.id, decision, undefined, scopeTarget)
  const deny = () => decideWith('deny')
  const allow = () => decideWith('allow')

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

  // Ctrl/Cmd+Enter 允许一次、Esc 拒绝：焦点在卡片里，或输入框为空（不打断正在写的说明）。
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey) return
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
      const focusInCard = cardRef.current?.contains(document.activeElement as Node | null) ?? false
      const inTarget = isTargetFocused(scopeTarget ?? null)
      const targetEl = e.target as HTMLElement | null
      const composer = targetEl?.closest('.composer-card') ?? null
      const textarea = composer?.querySelector('textarea') as HTMLTextAreaElement | null
      const idleComposer = inTarget && !!composer && !textarea?.value.trim()
      if (!focusInCard && !idleComposer) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        allow()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        deny()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [active, request.id, decide, scopeTarget])

  return (
    <div
      ref={cardRef}
      className="permission-card msg-row mb-1"
      data-permission-id={request.id}
      data-permission-active={active ? 'true' : undefined}
    >
      <div className="rounded-xl border border-border bg-[color-mix(in_srgb,var(--t-surface)_94%,transparent)] px-3.5 py-3">
        <div className="flex min-w-0 items-baseline gap-1 text-[13px] leading-[1.5] text-text">
          <span className="shrink-0">{verb}</span>
          <code
            data-tip={target}
            className="min-w-0 truncate font-mono text-[12.5px] text-text"
          >
            {target}
          </code>
          <span className="shrink-0">？</span>
        </div>
        <p className="mt-1 text-[12px] leading-[1.5] text-muted">{explain}</p>
        {subagentTitle && (
          <div className="mt-1 flex items-center gap-1 text-[12px] leading-[1.5] text-muted">
            <Bot size={11} className="shrink-0" />
            <span className="min-w-0 truncate">来自子代理：{subagentTitle}</span>
          </div>
        )}
        {request.transferredFrom && (
          <div className="mt-1 text-[12px] leading-[1.5] text-text-soft">
            由 {request.transferredFrom.name} 转交
            {request.assignedTo ? ` · 待 ${request.assignedTo.name} 处理` : ''}
          </div>
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
        {request.learned && (
          <div className="mt-1.5" data-permission-learned="">
            <button
              type="button"
              onClick={() => void applyLearned()}
              disabled={learning}
              className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] leading-[1.5] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:min-h-11"
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
        <div className="mt-2.5 flex items-center gap-1.5 max-sm:flex-wrap">
          <Menu
            side="top"
            align="start"
            aria-label="更多审批操作"
            className="w-[240px]"
            onOpenChange={(open) => {
              if (open) loadApprovers()
            }}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5 text-[12px] text-muted hover:text-text max-sm:min-h-11"
              >
                <MoreHorizontal size={13} /> 更多
              </Button>
            }
          >
            <Menu.Item
              icon={<ShieldCheck size={12} />}
              hint="本会话内同类请求不再询问"
              onSelect={() => decideWith('allow_always')}
            >
              {alwaysLabel}
            </Menu.Item>
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
          </Menu>
          <span className="min-w-0 flex-1" />
          <Button
            size="sm"
            variant="secondary"
            data-permission-deny=""
            onClick={deny}
            className="max-sm:min-h-11"
          >
            拒绝
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-permission-allow=""
            onClick={allow}
            className="border-border-strong bg-[var(--t-bg-active)] text-text hover:bg-[var(--t-bg-hover)] max-sm:min-h-11"
          >
            允许一次
            <span className="flex items-center gap-0.5 text-[11px] text-muted">
              <Kbd>Ctrl</Kbd>
              <Kbd>⏎</Kbd>
            </span>
          </Button>
        </div>
      </div>
      {ruleDraft && (
        <AddRuleDialog draft={ruleDraft} hostId={hostId} onClose={() => setRuleDraft(null)} />
      )}
    </div>
  )
}

/** 审批完成后留在对话流里的一行结果：「已允许 · git status --short」/「已拒绝」。 */
export function PermissionResultLine({ entry }: { entry: PermissionTrailEntry }) {
  const denied = entry.decision === 'deny'
  return (
    <div
      className="permission-result mb-1 flex min-w-0 items-center gap-1.5 px-0.5 text-[12px] leading-5 text-muted"
      data-permission-result={entry.id}
    >
      {denied ? (
        <ShieldX size={12} className="shrink-0" />
      ) : (
        <ShieldCheck size={12} className="shrink-0" />
      )}
      <span className="shrink-0">{denied ? '已拒绝' : '已允许'}</span>
      {!denied && entry.label && (
        <span className="min-w-0 truncate text-text-soft" data-tip={entry.label}>
          · {entry.label}
        </span>
      )}
    </div>
  )
}
