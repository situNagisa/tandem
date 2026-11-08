import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ClipboardCopy,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react'
import type {
  WorkspaceHostInfo,
  WorkstationAccountSummary,
  WorkstationBindCode,
  WorkspaceRole,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { ApiError, workstationApi } from '../../lib/api'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { toast } from '../../store/appStore/helpers'

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  collaborator: '协作者',
  approver: '审批者',
  observer: '观察者',
}

const GRANT_ROLES: WorkspaceRole[] = ['collaborator', 'approver', 'observer']

export function WorkstationSection() {
  const account = useAppStore((s) => s.account)
  const hosts = useAppStore((s) => s.hosts)
  const logout = useAppStore((s) => s.workspaceLogout)
  const syncHosts = useAppStore((s) => s.syncWorkstationHosts)
  const [remoteHosts, setRemoteHosts] = useState<WorkspaceHostInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bind, setBind] = useState<WorkstationBindCode | null>(null)
  const [bindOpen, setBindOpen] = useState(false)
  const [grantFor, setGrantFor] = useState<WorkspaceHostInfo | null>(null)
  const [registration, setRegistration] = useState<'open' | 'invite'>('open')
  const [invite, setInvite] = useState<string | null>(null)

  const base = account?.centerUrl ?? ''
  const token = account?.accessToken ?? ''

  const refresh = useCallback(async () => {
    if (!base || !token) return
    setBusy(true)
    setError(null)
    try {
      try {
        setRemoteHosts(await workstationApi.hosts(base, token))
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err
        if (!(await useAppStore.getState().refreshWorkspace())) throw err
        const fresh = useAppStore.getState().account
        if (!fresh) throw err
        setRemoteHosts(await workstationApi.hosts(fresh.centerUrl, fresh.accessToken))
      }
      await syncHosts()
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取工作站主机')
    } finally {
      setBusy(false)
    }
  }, [base, token, syncHosts])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!account) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-5">
          <div className="flex items-center gap-2 text-[15px] font-medium">
            <Server size={17} /> 工作站
          </div>
          <p className="mt-2 text-[13px] leading-6 text-[var(--t-text-secondary)]">
            工作站负责账号与主机登记。登录后只看到自己添加的主机，以及别人授权给你的主机；即使本机也要显式添加。
          </p>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => {
              localStorage.setItem('tandem.onboarding.force', '1')
              window.location.reload()
            }}
          >
            <LogIn size={14} /> 连接工作站
          </Button>
        </div>
        <p className="text-[12px] leading-5 text-[var(--t-text-tertiary)]">
          单机模式（地址 + token）保持不变：不登录也能继续使用已添加的主机。
        </p>
      </div>
    )
  }

  const own = remoteHosts.filter((h) => h.ownerId === account.account.id)
  const granted = remoteHosts.filter((h) => h.ownerId !== account.account.id)
  const localHosts = hosts.filter((h) => h.accountId === account.account.id)
  const localHost =
    hosts.find((h) => {
      try {
        return new URL(h.url).origin === window.location.origin
      } catch {
        return false
      }
    }) ?? hosts[0]
  const [joiningLocal, setJoiningLocal] = useState(false)

  const joinLocalHost = async () => {
    if (!localHost || !bind) return
    setJoiningLocal(true)
    setError(null)
    try {
      await workstationApi.join(localHost, { workstationUrl: base, code: bind.code })
      toast('这台电脑已添加为你的主机', 'success')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加本机失败（需要在该主机上用主 token 打开）')
    } finally {
      setJoiningLocal(false)
    }
  }

  const generateBind = async () => {
    setBusy(true)
    setError(null)
    try {
      setBind(await workstationApi.bindCode(base, token))
      setBindOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成绑定码失败')
    } finally {
      setBusy(false)
    }
  }

  const removeHost = async (host: WorkspaceHostInfo) => {
    setBusy(true)
    try {
      await workstationApi.removeHost(base, token, host.id)
      toast(`已移除主机「${host.name}」`, 'success')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--t-text)]">
              <ShieldCheck size={15} className="text-[var(--t-accent-strong)]" />
              {account.workspace.name}
            </div>
            <div className="mt-1 text-[12.5px] text-[var(--t-text-secondary)]">
              {account.account.name}（{account.account.username}）· {ROLE_LABELS[account.account.role] ?? account.account.role}
              <span className="mx-1.5 text-[var(--t-text-tertiary)]">·</span>
              <span className="font-mono text-[11.5px]">{base}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 刷新
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              退出登录
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-[var(--t-danger)]">{error}</p>}
      </div>

      {(account.account.role === 'admin' || account.account.role === 'owner') && (
        <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-4">
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
                onChange={async (e) => {
                  const next = e.target.value === 'invite' ? 'invite' : 'open'
                  setRegistration(next)
                  try {
                    await workstationApi.settings(base, token, { registration: next })
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
                    const result = await workstationApi.invite(base, token)
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
      )}

      <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[14px] font-medium">我的主机</div>
            <div className="mt-0.5 text-[12px] text-[var(--t-text-tertiary)]">
              客户端只连工作站；主机主动连出。在线状态来自工作站的隧道。
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={() => void generateBind()} disabled={busy}>
            <Plus size={14} /> 添加主机
          </Button>
        </div>

        <div className="mt-3 space-y-1.5">
          {remoteHosts.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--t-border)] px-3 py-6 text-center text-[12.5px] text-[var(--t-text-tertiary)]">
              还没有主机。点「添加主机」生成绑定码，在主机那台机器上输入；或在这台电脑上完成。
            </div>
          )}
          {[...own, ...granted].map((host) => {
            const isOwn = host.ownerId === account.account.id
            const local = localHosts.find((h) => h.hostId === host.id)
            return (
              <div
                key={host.id}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: host.online ? 'var(--t-success)' : 'var(--t-text-tertiary)' }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-[13px] text-[var(--t-text)]">
                    {host.name}
                    <span className="rounded bg-[var(--t-bg-active)] px-1.5 py-0.5 text-[10.5px] text-[var(--t-text-secondary)]">
                      {isOwn ? '我的' : '获授权'}
                    </span>
                    {local && <span className="text-[11px] text-[var(--t-text-tertiary)]">本机</span>}
                  </div>
                  <div className="truncate text-[11.5px] text-[var(--t-text-tertiary)]">
                    {host.id} · {host.online ? '在线' : '离线'}
                    {host.fingerprint ? ` · ${host.fingerprint.slice(0, 12)}…` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {isOwn && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setGrantFor(host)}>
                        <UserPlus size={13} /> 授权
                      </Button>
                      <Button variant="danger-ghost" size="sm" onClick={() => void removeHost(host)} disabled={busy}>
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-4">
        <div className="text-[14px] font-medium">添加主机的方式</div>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-6 text-[var(--t-text-secondary)]">
          <li>在工作站页面点「添加主机」，生成一次性绑定码（10 分钟）。</li>
          <li>在主机那台机器打开 Tandem →「设置 → 工作站 → 加入工作站」，填工作站地址和绑定码；或命令行执行 <code className="rounded bg-[var(--t-bg-subtle)] px-1">tandem-host join &lt;工作站地址&gt; --code &lt;绑定码&gt;</code>。</li>
          <li>主机自动生成密钥对并建立出站隧道，出现在「我的主机」里。</li>
        </ol>
      </div>

      <Modal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        title="添加主机"
        description="绑定码只显示一次，10 分钟内有效。"
        layer={70}
        className="max-w-[520px]"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-[11.5px] text-[var(--t-text-tertiary)]">绑定码只显示一次</span>
            <div className="flex gap-2">
              {localHost && (
                <Button variant="primary" onClick={() => void joinLocalHost()} disabled={joiningLocal || !bind}>
                  {joiningLocal ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  在这台电脑上完成
                </Button>
              )}
              <Button variant="secondary" onClick={() => setBindOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{bind?.code ?? '—'}</code>
            <Button
              variant="ghost"
              size="sm"
              disabled={!bind}
              onClick={() => {
                if (bind) void navigator.clipboard?.writeText(bind.code)
                toast('绑定码已复制', 'success')
              }}
            >
              <ClipboardCopy size={13} /> 复制
            </Button>
          </div>
          <p className="text-[12.5px] leading-6 text-[var(--t-text-secondary)]">
            在主机那台机器上打开 Tandem 桌面端，进入「设置 → 工作站 → 加入工作站」，填工作站地址
            <code className="mx-1 rounded bg-[var(--t-bg-subtle)] px-1 font-mono text-[11.5px]">{base}</code>
            和上面的绑定码。也可在主机上执行：
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2 font-mono text-[11.5px] leading-5">
{`tandem-host join ${base} --code ${bind?.code ?? '<绑定码>'}`}
          </pre>
          <div className="flex items-start gap-2 text-[12px] leading-5 text-[var(--t-text-tertiary)]">
            <Check size={14} className="mt-0.5 shrink-0" />
            登记后主机不会开放入站端口；客户端经工作站访问，内容端到端加密。
          </div>
        </div>
      </Modal>

      <GrantDialog
        host={grantFor}
        base={base}
        token={token}
        onClose={() => setGrantFor(null)}
        onDone={() => {
          setGrantFor(null)
          void refresh()
        }}
      />
    </div>
  )
}

function GrantDialog({
  host,
  base,
  token,
  onClose,
  onDone,
}: {
  host: WorkspaceHostInfo | null
  base: string
  token: string
  onClose: () => void
  onDone: () => void
}) {
  const [accounts, setAccounts] = useState<WorkstationAccountSummary[]>([])
  const [accountId, setAccountId] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('collaborator')
  const [dirs, setDirs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    if (!host) return
    setAccountId('')
    setRole('collaborator')
    setDirs('')
    setError(null)
    workstationApi
      .accounts(base, token)
      .then((list) => setAccounts(list.filter((a) => !a.disabled)))
      .catch((err) => setError(err instanceof Error ? err.message : '无法读取账号列表'))
  }, [host, base, token])

  if (!host) return null

  const nameOf = (id: string) => {
    const found = accounts.find((a) => a.id === id)
    return found ? `${found.name}（${found.username}）` : id.slice(0, 8)
  }

  const removeGrant = async (accountId: string) => {
    setRemoving(accountId)
    setError(null)
    try {
      await workstationApi.removeGrant(base, token, host.id, accountId)
      toast('授权已撤销', 'success')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销授权失败')
    } finally {
      setRemoving(null)
    }
  }

  const submit = async () => {
    if (!accountId) {
      setError('请选择要授权的账号')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await workstationApi.setGrant(base, token, host.id, {
        accountId,
        role,
        ...(dirs.trim()
          ? { projectDirs: dirs.split('\n').map((d) => d.trim()).filter(Boolean) }
          : {}),
      })
      toast('授权已保存', 'success')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '授权失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!host}
      onClose={onClose}
      title={`授权「${host.name}」`}
      description="被授权账号会看到这台主机；角色沿用 协作者/审批者/观察者。"
      layer={70}
      className="max-w-[480px]"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />} 保存授权
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[12px] text-[var(--t-text-tertiary)]">账号</span>
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">选择账号…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.username}）
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-[var(--t-text-tertiary)]">角色</span>
          <Select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
            {GRANT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </label>
        {(host.grants?.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            <div className="text-[12px] text-[var(--t-text-tertiary)]">已有授权</div>
            {host.grants!.map((grant) => (
              <div key={grant.accountId} className="flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{nameOf(grant.accountId)}</span>
                <span className="text-[11.5px] text-[var(--t-text-tertiary)]">{ROLE_LABELS[grant.role] ?? grant.role}</span>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={removing === grant.accountId}
                  onClick={() => void removeGrant(grant.accountId)}
                >
                  {removing === grant.accountId ? <Loader2 size={12} className="animate-spin" /> : '撤销'}
                </Button>
              </div>
            ))}
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-[12px] text-[var(--t-text-tertiary)]">限定项目目录（可选，每行一个绝对路径）</span>
          <textarea
            value={dirs}
            onChange={(e) => setDirs(e.target.value)}
            rows={3}
            placeholder="/home/chen/project"
            className="w-full resize-y rounded-lg border border-[var(--t-border)] bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[13px] text-[var(--t-text)] outline-none focus:border-[var(--t-border-strong)]"
          />
        </label>
        {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
        <p className="text-[12px] leading-5 text-[var(--t-text-tertiary)]">
          不能授权给主机主人自己；撤销后对方刷新「我的主机」即不再可见，主机端也会立即按新令牌拒绝。
        </p>
      </div>
    </Modal>
  )
}
