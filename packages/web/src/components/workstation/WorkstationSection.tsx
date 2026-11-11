import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Server, ShieldCheck, UserPlus, Users } from 'lucide-react'
import type { WorkspaceAccount } from '@tandem/protocol'
import { Spinner } from '../ui/Spinner'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Controls'
import { useAppStore } from '../../store/useAppStore'
import { workstationApi } from '../../lib/api'
import { withWorkstationSession } from '../../lib/workspaceSession'
import { formatDateTime } from '../../lib/format'
import { toast } from '../../store/appStore/helpers'

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  collaborator: '协作者',
  approver: '审批者',
  observer: '观察者',
}

function isAdmin(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner'
}

/** 设置 → 工作站：仅管理员；只放工作站级设置（名称、注册方式、邀请码、成员）。 */
export function WorkstationSection() {
  const account = useAppStore((s) => s.account)
  const logout = useAppStore((s) => s.workspaceLogout)
  const [name, setName] = useState('')
  const [registration, setRegistration] = useState<'open' | 'invite'>('open')
  const [members, setMembers] = useState<WorkspaceAccount[]>([])
  const [invite, setInvite] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const admin = isAdmin(account?.account.role)

  const refresh = useCallback(async () => {
    if (!account || !admin) return
    setBusy(true)
    setError(null)
    try {
      const [overview, status] = await Promise.all([
        withWorkstationSession((base, token) => workstationApi.overview(base, token)),
        withWorkstationSession((base) => workstationApi.publicStatus(base)),
      ])
      setName(overview.workspace.name)
      setMembers(overview.accounts)
      setRegistration(status.registration)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取工作站信息')
    } finally {
      setBusy(false)
    }
  }, [account, admin])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!account) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5">
          <div className="flex items-center gap-2 text-[15px] font-medium">
            <Server size={17} /> 工作站
          </div>
          <p className="mt-2 text-[13px] leading-6 text-[var(--t-text-secondary)]">
            工作站负责账号与主机登记。登录后只看到自己添加的主机，以及别人授权给你的主机。
          </p>
        </div>
      </div>
    )
  }

  const saveName = async () => {
    const next = name.trim()
    if (!next) {
      toast('工作站名称不能为空', 'error')
      return
    }
    setSavingName(true)
    setError(null)
    try {
      await withWorkstationSession((base, token) =>
        workstationApi.settings(base, token, { name: next }),
      )
      toast('工作站名称已保存', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存工作站名称失败')
    } finally {
      setSavingName(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--t-text)]">
              <ShieldCheck size={15} className="text-[var(--t-accent-strong)]" />
              {account.workspace.name}
            </div>
            <div className="mt-1 text-[12.5px] text-[var(--t-text-secondary)]">
              {account.account.name}（{account.account.username}）· {ROLE_LABELS[account.account.role] ?? account.account.role}
              <span className="mx-1.5 text-[var(--t-text-tertiary)]">·</span>
              <span className="font-mono text-[11.5px]">{account.centerUrl}</span>
            </div>
          </div>
          <div className="flex gap-2">
            {admin && (
              <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
                {busy ? <Spinner size={13} /> : <RefreshCw size={13} />} 刷新
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              退出登录
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-[var(--t-danger)]">{error}</p>}
      </div>

      {!admin ? (
        <p className="text-[12.5px] leading-5 text-muted">
          只有工作站管理员可以修改注册方式与查看成员。
        </p>
      ) : (
        <>
          <div data-setting-id="accounts.name" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
            <div className="text-[14px] font-medium">工作站名称</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="max-w-[320px] flex-1"
                aria-label="工作站名称"
              />
              <Button variant="secondary" onClick={() => void saveName()} disabled={savingName || !name.trim()}>
                {savingName && <Spinner size={13} />} 保存
              </Button>
            </div>
          </div>

          <div data-setting-id="accounts.registration" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[14px] font-medium">注册与邀请</div>
                <div className="mt-0.5 text-[12px] text-[var(--t-text-tertiary)]">
                  默认内网开放注册；改「仅邀请」后，新账号需要管理员生成的邀请码。
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={registration}
                  aria-label="注册方式"
                  onChange={async (e) => {
                    const next = e.target.value === 'invite' ? 'invite' : 'open'
                    setRegistration(next)
                    try {
                      await withWorkstationSession((base, token) =>
                        workstationApi.settings(base, token, { registration: next }),
                      )
                      toast(next === 'invite' ? '已改为仅邀请注册' : '已改为开放注册', 'success')
                    } catch (err) {
                      setError(err instanceof Error ? err.message : '保存注册方式失败')
                    }
                  }}
                >
                  <option value="open">开放注册</option>
                  <option value="invite">仅邀请注册</option>
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      const result = await withWorkstationSession((base, token) =>
                        workstationApi.invite(base, token),
                      )
                      setInvite(result.code)
                      await navigator.clipboard?.writeText(result.code).catch(() => undefined)
                      toast('邀请码已生成并复制', 'success')
                    } catch (err) {
                      setError(err instanceof Error ? err.message : '生成邀请码失败')
                    }
                  }}
                >
                  <UserPlus size={13} /> 生成邀请码
                </Button>
              </div>
            </div>
            {invite && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-2.5 py-1.5">
                <span className="text-[11.5px] text-[var(--t-text-tertiary)]">邀请码</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{invite}</code>
              </div>
            )}
          </div>

          <div data-setting-id="accounts.members" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
            <div className="flex items-center gap-2">
              <Users size={15} className="text-muted" />
              <div className="text-[14px] font-medium">成员</div>
              <span className="text-[12px] text-[var(--t-text-tertiary)]">{members.length} 个账号</span>
            </div>
            <div className="mt-3 space-y-1.5">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--t-text)]">
                      <span className="truncate">{member.name}</span>
                      <span className="text-[11.5px] text-[var(--t-text-tertiary)]">@{member.username}</span>
                      <Badge tone="neutral">{ROLE_LABELS[member.role] ?? member.role}</Badge>
                      {member.debug && <Badge tone="neutral">调试</Badge>}
                      {member.disabled && <Badge tone="warn">已禁用</Badge>}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--t-text-tertiary)]">
                      最近登录 {formatDateTime(member.lastLoginAt, { year: true })}
                    </div>
                  </div>
                </div>
              ))}
              {members.length === 0 && (
                <p className="px-1 py-2 text-[12px] text-muted">还没有成员。</p>
              )}
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[var(--t-text-tertiary)]">
              账号停用待接入工作站接口；当前只能查看成员与角色。
            </p>
          </div>
        </>
      )}
    </div>
  )
}
