import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import {
  Check,
  Copy,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import type {
  CreateTeamInviteResult,
  MemberRole,
  TeamAuditEntry,
  TeamInvite,
  TeamMember,
  TeamOverview,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatDateTime } from '../../lib/format'
import { useCopy } from '../../lib/useCopy'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { Menu } from '../ui/Menu'
import { Card } from '../ui/Card'
import { SettingRow } from '../ui/SettingRow'

const ROLE_LABEL: Record<MemberRole, string> = {
  observer: '观察者',
  approver: '审批者',
  collaborator: '协作者',
}
const ROLE_DESC: Record<MemberRole, string> = {
  observer: '只读会话列表与内容',
  approver: '只读 + 处理审批',
  collaborator: '审批 + 在授权项目发消息、建会话',
}
const ROLE_OPTIONS: Array<{ value: MemberRole; label: string; title: string }> = (
  Object.keys(ROLE_LABEL) as MemberRole[]
).map((role) => ({ value: role, label: ROLE_LABEL[role], title: ROLE_DESC[role] }))

const AUDIT_LABEL: Record<TeamAuditEntry['action'], string> = {
  'invite.create': '创建邀请',
  'invite.accept': '接受邀请',
  'member.update': '修改成员',
  'member.revoke': '吊销成员',
  'session.create': '新建会话',
  'message.send': '发送消息',
  'permission.decide': '处理审批',
  'permission.transfer': '转交审批',
}

/** 审计里可能带原始枚举（角色、审批决定），展示前换成中文。 */
function auditDetailText(entry: TeamAuditEntry): string {
  return (entry.detail ?? '')
    .replace(/\b(observer|approver|collaborator)\b/g, (role) => ROLE_LABEL[role as MemberRole])
    .replace(/\ballow_always\b/g, '总是允许')
    .replace(/\ballow\b/g, '允许')
    .replace(/\bdeny\b/g, '拒绝')
}

function DirEditor({
  dirs,
  onChange,
  suggestions,
}: {
  dirs: string[]
  onChange: (dirs: string[]) => void
  suggestions: string[]
}) {
  const [value, setValue] = useState('')
  const add = () => {
    const dir = value.trim()
    if (!dir || dirs.includes(dir)) return
    onChange([...dirs, dir])
    setValue('')
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {dirs.length === 0 && <span className="text-[12px] text-muted">还没有选择项目目录</span>}
        {dirs.map((dir) => (
          <span
            key={dir}
            className="flex max-w-full items-center gap-1 rounded-md bg-[var(--t-bg-active)] px-1.5 py-0.5 font-mono text-[12px] text-text-soft"
          >
            <span className="truncate" data-tip={dir}>
              {dir}
            </span>
            <button data-raw-button
              type="button"
              aria-label={`移除 ${dir}`}
              className="shrink-0 text-muted hover:text-danger"
              onClick={() => onChange(dirs.filter((item) => item !== dir))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="/home/you/project"
          className="min-w-0 flex-1 font-mono text-[12.5px]"
          spellCheck={false}
        />
        <Button size="sm" variant="secondary" onClick={add} disabled={!value.trim()}>
          添加
        </Button>
        {suggestions.length > 0 && (
          <Menu
            trigger={
              <Button size="sm" variant="ghost">
                从会话选择
              </Button>
            }
          >
            {suggestions.map((dir) => (
              <Menu.Item
                key={dir}
                hint={dirs.includes(dir) ? '已添加' : undefined}
                onSelect={() => {
                  if (!dirs.includes(dir)) onChange([...dirs, dir])
                }}
              >
                {dir}
              </Menu.Item>
            ))}
          </Menu>
        )}
      </div>
    </div>
  )

}

function MemberEditDialog({
  host,
  member,
  suggestions,
  onClose,
  onSaved,
}: {
  host: Parameters<typeof api.updateTeamMember>[0]
  member: TeamMember
  suggestions: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useUiStore((s) => s.toast)
  const [name, setName] = useState(member.name)
  const [role, setRole] = useState<MemberRole>(member.role)
  const [dirs, setDirs] = useState(member.projectDirs)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    if (!dirs.length) {
      toast('至少选择一个项目目录', 'error')
      return
    }
    setSaving(true)
    try {
      await api.updateTeamMember(host, member.id, { name, role, projectDirs: dirs })
      toast('成员已更新', 'success')
      onSaved()
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="编辑成员"
      description="角色与项目目录立即生效；已连接的成员下一次请求即按新权限执行。"
      className="max-w-lg"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving && <Spinner size={13} />}
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="text-[13px] text-muted">显示名</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <div className="space-y-1">
          <span className="text-[13px] text-muted">角色</span>
          <SegmentedControl
            aria-label="成员角色"
            className="flex w-full"
            options={ROLE_OPTIONS}
            value={role}
            onChange={setRole}
          />
          <p className="text-[12px] text-muted">{ROLE_DESC[role]}</p>
        </div>
        <div className="space-y-1">
          <span className="text-[13px] text-muted">项目目录</span>
          <DirEditor dirs={dirs} onChange={setDirs} suggestions={suggestions} />
        </div>
      </div>
    </Modal>
  )
}

export function TeamSection() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtimes = useAppStore((s) => s.runtimes)
  const toast = useUiStore((s) => s.toast)
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [audit, setAudit] = useState<TeamAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<MemberRole>('observer')
  const [dirs, setDirs] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreateTeamInviteResult | null>(null)
  const [qr, setQr] = useState('')
  const { copied, copy } = useCopy({
    resetAfter: 0,
    onSuccess: () => toast('邀请链接已复制', 'success'),
  })
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [deletingInvite, setDeletingInvite] = useState<TeamInvite | null>(null)
  const [editMember, setEditMember] = useState<TeamMember | null>(null)
  const [revoking, setRevoking] = useState(false)

  const suggestions = useMemo(() => {
    if (!host) return []
    const list = runtimes[host.id]?.sessions ?? []
    return [...new Set(list.map((session) => session.cwd))].slice(0, 20)
  }, [host, runtimes])

  const load = useCallback(async (silent = false) => {
    if (!host) {
      setOverview(null)
      setAudit([])
      return
    }
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [members, entries] = await Promise.all([
        api.teamMembers(host),
        api.teamAudit(host, 200),
      ])
      setOverview(members)
      setAudit(entries)
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : '读取成员失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [host])

  useEffect(() => {
    void load()
  }, [load])

  // 同事从邀请链接入职或审批转交后，成员/在线状态与审计应自动更新。
  useEffect(() => {
    if (!host) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [host, load])

  useEffect(() => {
    if (!created) {
      setQr('')
      return
    }
    let cancelled = false
    QRCode.toString(created.url, {
      type: 'svg',
      margin: 1,
      width: 176,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f1e1d', light: '#ffffff' },
    })
      .then((svg) => {
        if (!cancelled) setQr(svg)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [created])

  const createInvite = async () => {
    if (!host || creating) return
    if (!dirs.length) {
      toast('至少选择一个项目目录', 'error')
      return
    }
    setCreating(true)
    try {
      const result = await api.createTeamInvite(host, { role, projectDirs: dirs })
      setCreated(result)
      toast('邀请已生成，24 小时内有效', 'success')
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成邀请失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  const copyLink = () => {
    if (created) void copy(created.url)
  }

  const revoke = async (member: TeamMember) => {
    if (!host || revoking) return
    setRevoking(true)
    try {
      await api.revokeTeamMember(host, member.id)
      setRevokeId(null)
      toast(`已吊销 ${member.name}`, 'success')
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '吊销失败', 'error')
    } finally {
      setRevoking(false)
    }
  }

  const removeInvite = async (id: string) => {
    if (!host) return
    try {
      await api.deleteTeamInvite(host, id)
      setDeletingInvite(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  if (!host) {
    return <p className="py-6 text-[13px] text-muted">请先连接一台主机。</p>
  }

  const members = overview?.members ?? []
  const invites = overview?.invites ?? []

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-medium">
            <Users size={15} className="text-muted" />
            成员
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            仅限可信内网。同事用一次性邀请链接加入，Host 为其签发独立 token；随时可吊销。
            Key、设置、权限规则只有你能修改。
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
          刷新
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <Card data-setting-id="team.invite-role">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <UserPlus size={13} className="text-muted" />
          邀请成员
        </h3>
        <div className="mt-3 space-y-3">
          <SettingRow label="邀请角色" hint={ROLE_DESC[role]}>
            <SegmentedControl
              aria-label="邀请角色"
              className="flex w-full"
              options={ROLE_OPTIONS}
              value={role}
              onChange={setRole}
            />
          </SettingRow>
          <DirEditor dirs={dirs} onChange={setDirs} suggestions={suggestions} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted">邀请码 24 小时有效，只能使用一次。</span>
            <Button
              variant="primary"
              onClick={() => void createInvite()}
              disabled={creating || !dirs.length}
            >
              {creating && <Spinner size={13} />}
              生成邀请链接
            </Button>
          </div>
        </div>

        {created && (
          <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-3 sm:flex-row sm:items-center">
            <div
              className="shrink-0 self-center rounded-md bg-white p-1.5 [&_svg]:block"
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[12px] text-muted">
                <ShieldCheck size={12} className="text-accent-text" />
                仅展示一次，请通过可信渠道发给同事
              </div>
              <div className="break-all rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 font-mono text-[12px] leading-5 text-text-soft">
                {created.url}
              </div>
              <div className="text-[12px] text-muted">
                {ROLE_LABEL[created.invite.role]} · {formatDateTime(created.invite.expiresAt)} 到期
              </div>
              {created.warning && (
                <p className="flex items-start gap-1.5 text-[12px] leading-5 text-warning">
                  <TriangleAlert size={12} className="mt-1 shrink-0" />
                  <span>{created.warning}</span>
                </p>
              )}
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={copyLink}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? '已复制' : '复制链接'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  收起
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <section data-setting-id="team.members" className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <h3 className="text-[13px] font-medium">成员（{members.length}）</h3>
          <span className="text-[12px] text-muted">
            {members.filter((member) => member.online).length} 在线
          </span>
        </div>
        {members.length === 0 && (
          <EmptyState variant="plain" title={<>还没有成员，先生成邀请链接。</>} />
        )}
        {members.map((member) => (
          <div
            key={member.id}
            className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0 sm:flex-row sm:items-center"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t-bg-active)] text-[13px] font-medium text-text-soft">
              {member.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{member.name}</span>
                <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[11px] text-text-tertiary">
                  {ROLE_LABEL[member.role]}
                </span>
                <span
                  className={cn(
                    'flex items-center gap-1 text-[11px]',
                    member.online ? 'text-success' : 'text-muted',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      member.online ? 'bg-success' : 'bg-[var(--t-text-tertiary)]',
                    )}
                  />
                  {member.revokedAt ? '已吊销' : member.online ? '在线' : '离线'}
                </span>
                {member.lastSeenAt && (
                  <span className="text-[12px] text-muted">最近 {formatDateTime(member.lastSeenAt)}</span>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-[12px] text-muted" data-tip={member.projectDirs.join('\n')}>
                {member.projectDirs.join(' · ')}
              </div>
            </div>
            {!member.revokedAt && (
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditMember(member)}>
                  编辑
                </Button>
                {revokeId === member.id ? (
                  <>
                    <span className="text-[12px] text-muted">立即断开并失效</span>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => void revoke(member)}
                      disabled={revoking}
                    >
                      {revoking && <Spinner size={12} />}
                      确认吊销
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRevokeId(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <IconButton
                    size="sm"
                    label="吊销成员"
                    tooltip="吊销成员"
                    onClick={() => setRevokeId(member.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      {invites.length > 0 && (
        <section data-setting-id="team.invites" className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border px-3 py-2.5">
            <h3 className="text-[13px] font-medium">邀请记录</h3>
          </div>
          {invites.map((invite) => {
            const expired = invite.expiresAt <= Date.now()
            return (
              <div
                key={invite.id}
                className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="font-medium">{ROLE_LABEL[invite.role]}</span>
                    <span className="text-muted">{formatDateTime(invite.createdAt)}</span>
                    {invite.usedAt ? (
                      <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[11px] text-muted">
                        已由 {invite.usedByName ?? '成员'} 使用
                      </span>
                    ) : expired ? (
                      <span className="rounded bg-warning-soft px-1.5 py-px text-[11px] text-warning">
                        已过期
                      </span>
                    ) : (
                      <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[11px] text-text-tertiary">
                        {formatDateTime(invite.expiresAt)} 到期
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[12px] text-muted">
                    {invite.projectDirs.join(' · ')}
                  </div>
                </div>
                <IconButton
                  size="sm"
                  label="删除邀请"
                  tooltip="删除邀请记录"
                  onClick={() => setDeletingInvite(invite)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            )
          })}
        </section>
      )}

      <section data-setting-id="team.audit" className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <h3 className="text-[13px] font-medium">审计日志</h3>
          <span className="text-[12px] text-muted">最近 {audit.length} 条</span>
        </div>
        {audit.length === 0 ? (
          <EmptyState variant="plain" title={<>还没有记录。</>} />
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            {audit.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0"
              >
                <span className="mt-0.5 w-[74px] shrink-0 text-[12px] text-muted">
                  {formatDateTime(entry.at)}
                </span>
                <span className="w-[86px] shrink-0 truncate text-[12px] font-medium" data-tip={entry.actorName}>
                  {entry.actorName}
                </span>
                <span className="w-[76px] shrink-0 text-[12px] text-text-soft">
                  {AUDIT_LABEL[entry.action]}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-muted"
                  data-tip={[entry.sessionTitle, auditDetailText(entry)].filter(Boolean).join(' · ')}
                >
                  {entry.sessionTitle ?? ''}
                  {entry.sessionTitle && entry.detail ? ' · ' : ''}
                  {auditDetailText(entry)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {editMember && (
        <MemberEditDialog
          host={host}
          member={editMember}
          suggestions={suggestions}
          onClose={() => setEditMember(null)}
          onSaved={() => void load()}
        />
      )}

      <Modal
        open={!!deletingInvite}
        onClose={() => setDeletingInvite(null)}
        title="删除邀请记录"
        className="max-w-sm"
        footer={
          <>
            <Button size="lg" onClick={() => setDeletingInvite(null)}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={() => deletingInvite && void removeInvite(deletingInvite.id)}
            >
              删除
            </Button>
          </>
        }
      >
        {deletingInvite && (
          <p className="text-[13px] leading-6 text-text-soft">
            删除 {ROLE_LABEL[deletingInvite.role]} · {formatDateTime(deletingInvite.createdAt)} 的邀请记录？
            {deletingInvite.usedAt ? '记录已使用，删除后不影响已加入的成员。' : '未使用的邀请将立即失效。'}
          </p>
        )}
      </Modal>
    </div>
  )
}
