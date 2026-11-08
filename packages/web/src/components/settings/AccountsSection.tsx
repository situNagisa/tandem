import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  Globe2,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react'
import type {
  WorkspaceAccount,
  WorkspaceOverview,
  WorkspaceRole,
  WorkspaceScope,
  WorkspaceStatus,
} from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { accountApi, ApiError } from '../../lib/api'
import { LoginDialog } from '../accounts/LoginDialog'
import { Button, IconButton } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Controls'
import { Modal } from '../ui/Modal'

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: '所有者',
  admin: '管理员',
  collaborator: '协作者',
  approver: '审批者',
  observer: '观察者',
}
const SCOPE_LABELS: Record<WorkspaceScope, string> = {
  all: '全部机器',
  hosts: '指定机器',
  projects: '指定项目',
}
const ROLE_OPTIONS: WorkspaceRole[] = ['admin', 'collaborator', 'approver', 'observer']

function sameHost(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.hostname === ub.hostname && ua.port === ub.port
  } catch {
    return false
  }
}

function roleLabel(role: WorkspaceRole): string {
  return ROLE_LABELS[role] ?? role
}

export function AccountsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const account = useAppStore((s) => s.account)
  const logout = useAppStore((s) => s.workspaceLogout)
  const refreshSession = useAppStore((s) => s.refreshWorkspace)
  const toast = useUiStore((s) => s.toast)
  const activeHost = hosts.find((h) => h.id === activeHostId) ?? hosts[0]
  const centerHost = useMemo(() => {
    if (!account) return undefined
    return hosts.find((h) => sameHost(h.url, account.centerUrl)) ?? activeHost
  }, [account, activeHost, hosts])

  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [joinCode, setJoinCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    if (!activeHost) return
    setLoading(true)
    setError(null)
    try {
      const st = await accountApi.status(activeHost.url)
      setStatus(st)
      if (centerHost && account) {
        try {
          setOverview(await accountApi.workspace(centerHost))
        } catch (err) {
          setOverview(null)
          if (err instanceof ApiError && err.status !== 403) setError(err.message)
        }
      } else {
        setOverview(null)
      }
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : '无法读取工作区状态')
    } finally {
      setLoading(false)
    }
  }, [account, activeHost, centerHost])

  useEffect(() => {
    void load()
  }, [load])

  const isCenter = status?.mode === 'center'
  const isMember = status?.mode === 'member'
  const canManage = !!account && (account.account.role === 'owner' || account.account.role === 'admin')
  const isOwner = account?.account.role === 'owner'

  const createJoinCode = async () => {
    if (!centerHost) return
    try {
      const result = await accountApi.joinCode(centerHost)
      setJoinCode(result)
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成加入码失败', 'error')
    }
  }

  return (
    <div className="space-y-5" data-setting-id="accounts.workspace">
      <header className="space-y-1">
        <h2 className="text-[15px] font-semibold text-text">工作区与账号</h2>
        <p className="text-[12.5px] leading-5 text-muted">
          一个人管多台机器只登录一次；同事加入一次后按账号授权到机器与项目。账号中心完全自托管在内网 Host 上。
        </p>
      </header>

      {/* 当前账号 */}
      <section className="rounded-xl border border-border bg-[var(--t-bg-subtle)]/40 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--t-bg-active)] text-[13px] font-semibold">
              {(account?.account.name || account?.account.username || '未').slice(0, 1)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium text-text">
                {account
                  ? account.account.name === roleLabel(account.account.role)
                    ? account.account.name
                    : `${account.account.name} · ${roleLabel(account.account.role)}`
                  : '未登录工作区'}
              </div>
              <div className="truncate text-[12px] text-muted">
                {account
                  ? `${account.workspace.name} · ${account.centerUrl}`
                  : '单机模式：继续使用主机地址 + token，或登录工作区账号'}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {account ? (
              <>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const ok = await refreshSession()
                    toast(ok ? '访问令牌已刷新' : '刷新失败，账号中心可能离线', ok ? 'success' : 'error')
                  }}
                >
                  <RefreshCw size={14} /> 刷新令牌
                </Button>
                <Button variant="ghost" onClick={() => void logout()}>
                  <LogOut size={14} /> 退出登录
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setLoginOpen(true)}>
                <LogIn size={14} /> 登录工作区
              </Button>
            )}
          </div>
        </div>
      </section>

      {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
      {loading && (
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin" /> 正在读取工作区…
        </p>
      )}

      {/* 未加入：创建 / 加入 */}
      {!status?.workspace && activeHost && (
        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded-xl border border-border p-3.5">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
              <Shield size={14} /> 在这台主机创建工作区
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              把「{activeHost.name}」设为账号中心，稍后可在工作区页添加其他机器。
            </p>
            <CreateWorkspaceForm
              hostToken={activeHost}
              onDone={async (username, password) => {
                await useAppStore.getState().workspaceLogin({
                  centerUrl: activeHost.url,
                  username,
                  password,
                })
                await load()
              }}
            />
          </section>
          <section className="rounded-xl border border-border p-3.5">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
              <Globe2 size={14} /> 加入已有工作区
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              让所有者在其工作区页生成一次性加入码，然后在这台主机上加入。
            </p>
            <JoinWorkspaceForm hostToken={activeHost} onDone={() => void load()} />
          </section>
        </div>
      )}

      {/* 工作区信息 */}
      {status?.workspace && (
        <section className="rounded-xl border border-border p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[13px] font-medium">
                {status.workspace.name}
                <span className="ml-2 rounded-md bg-[var(--t-bg-active)] px-1.5 py-0.5 text-[11px] text-text-soft">
                  {isCenter ? '账号中心' : '成员主机'}
                </span>
              </h3>
              <p className="mt-1 text-[12px] text-muted">
                {isMember ? `中心：${status.center?.url ?? '—'}` : `本机 ${activeHost?.url ?? ''}`}
                {status.lastSyncAt ? ` · 最近同步 ${new Date(status.lastSyncAt).toLocaleTimeString()}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              {isOwner && isCenter && (
                <Button variant="secondary" onClick={() => void createJoinCode()}>
                  <Plus size={14} /> 生成加入码
                </Button>
              )}
              {isMember && activeHost && (
                <Button
                  variant="danger-ghost"
                  onClick={async () => {
                    try {
                      await accountApi.leave(activeHost)
                      toast('本机已退出工作区', 'success')
                      await load()
                    } catch (err) {
                      toast(err instanceof Error ? err.message : '退出失败', 'error')
                    }
                  }}
                >
                  <LogOut size={14} /> 本机退出工作区
                </Button>
              )}
            </div>
          </div>
          {joinCode && (
            <div className="mt-3 rounded-lg border border-border bg-[var(--t-bg-subtle)] p-2.5">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{joinCode.code}</code>
                <IconButton
                  label="复制加入码"
                  onClick={async () => {
                    await navigator.clipboard.writeText(joinCode.code).catch(() => undefined)
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
              </div>
              <p className="mt-1 text-[12px] text-muted">
                24 小时内一次性有效。在另一台主机的「设置 → 成员与分享 → 工作区」填入本机地址
                {activeHost ? `（${activeHost.url}）` : ''} 与该码。
              </p>
            </div>
          )}
        </section>
      )}

      {/* Host 列表 */}
      {overview && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
              <Globe2 size={14} /> 工作区主机（{overview.hosts.length}）
            </h3>
            {!isOwner && <span className="text-[12px] text-muted">仅所有者可增删主机</span>}
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            {overview.hosts.map((h) => (
              <div key={h.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                <span className="size-1.5 rounded-full bg-[var(--t-text-tertiary)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{h.name}</div>
                  <div className="truncate text-[11.5px] text-muted">{h.urls.join(' · ')}</div>
                </div>
                {h.id === overview.workspace.centerHostId && (
                  <span className="rounded bg-[var(--t-bg-active)] px-1.5 py-0.5 text-[11px]">中心</span>
                )}
                {isOwner && h.id !== overview.workspace.centerHostId && centerHost && (
                  <IconButton
                    label={`移除主机 ${h.name}`}
                    onClick={async () => {
                      try {
                        await accountApi.removeHost(centerHost, h.id)
                        await load()
                      } catch (err) {
                        toast(err instanceof Error ? err.message : '移除失败', 'error')
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
          <p className="text-[12px] text-muted">
            移除主机只停止中心向它推送快照；该主机仍保留本地信任，需在其「工作区」页退出。
          </p>
        </section>
      )}

      {/* 账号列表 */}
      {overview && canManage && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
              <Users size={14} /> 账号与授权（{overview.accounts.length}）
            </h3>
            {isOwner && (
              <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                <UserPlus size={14} /> 新建账号
              </Button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            {centerHost && overview.accounts.map((acc) => (
              <AccountRow
                key={acc.id}
                account={acc}
                hosts={overview.hosts}
                centerHost={centerHost}
                canEdit={isOwner && acc.role !== 'owner'}
                onChanged={() => void load()}
              />
            ))}
          </div>
          <p className="text-[12px] leading-5 text-muted">
            吊销立即生效：各 Host 收到中心签名快照后拒绝该账号并断开现有连接。密码登录只存 scrypt
            哈希；账号中心离线时，已签发的访问令牌在有效期内仍可用。
          </p>
        </section>
      )}

      {status?.mode === 'member' && !overview && account && (
        <p className="text-[12.5px] text-muted">
          本机已加入工作区；工作区账号与 Host 列表由账号中心维护，所有者登录后可在本页管理。
        </p>
      )}

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} defaultCenterUrl={activeHost?.url} />
      {centerHost && (
        <CreateAccountDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          hosts={overview?.hosts ?? []}
          centerHost={centerHost}
          onDone={() => {
            setCreateOpen(false)
            void load()
          }}
        />
      )}
    </div>
  )
}

function CreateWorkspaceForm({
  hostToken,
  onDone,
}: {
  hostToken: ReturnType<typeof useAppStore.getState>['hosts'][number]
  onDone: (username: string, password: string) => Promise<void>
}) {
  const [name, setName] = useState('我的工作区')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await accountApi.setup(hostToken, { name, username, password })
      await onDone(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 space-y-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="工作区名称" aria-label="工作区名称" />
      <Input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="所有者用户名（3–32 位）"
        aria-label="所有者用户名"
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="密码（至少 8 位）"
        aria-label="所有者密码"
      />
      {error && <p className="text-[12px] text-[var(--t-danger)]">{error}</p>}
      <Button variant="primary" onClick={() => void submit()} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />} 创建工作区并登录
      </Button>
    </div>
  )
}

function JoinWorkspaceForm({
  hostToken,
  onDone,
}: {
  hostToken: ReturnType<typeof useAppStore.getState>['hosts'][number]
  onDone: () => void
}) {
  const [centerUrl, setCenterUrl] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useUiStore((s) => s.toast)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await accountApi.join(hostToken, { centerUrl, code })
      toast('已加入工作区，请用工作区账号登录', 'success')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 space-y-2">
      <Input
        value={centerUrl}
        onChange={(e) => setCenterUrl(e.target.value)}
        placeholder="账号中心地址 http://192.168.1.10:8270"
        aria-label="账号中心地址"
      />
      <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="加入码 acj_…" aria-label="加入码" />
      {error && <p className="text-[12px] text-[var(--t-danger)]">{error}</p>}
      <Button variant="primary" onClick={() => void submit()} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} 加入工作区
      </Button>
    </div>
  )
}

function AccountRow({
  account,
  hosts,
  centerHost,
  canEdit,
  onChanged,
}: {
  account: WorkspaceAccount
  hosts: WorkspaceOverview['hosts']
  centerHost: ReturnType<typeof useAppStore.getState>['hosts'][number]
  canEdit: boolean
  onChanged: () => void
}) {
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const hostNames = account.role === 'owner' || account.scope === 'all'
    ? '全部机器'
    : hosts.filter((h) => account.hostIds.includes(h.id)).map((h) => h.name).join('、') || '未授权机器'
  const updateRole = async (role: WorkspaceRole) => {
    setBusy(true)
    try {
      await accountApi.updateAccount(centerHost, account.id, { role })
      onChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : '修改失败', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--t-bg-subtle)] text-[12px] font-medium">
        {(account.name || account.username).slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13px]">
          {account.name}
          <span className="text-[11.5px] text-muted">@{account.username}</span>
          {account.disabled && <span className="text-[11px] text-[var(--t-danger)]">已吊销</span>}
        </div>
        <div className="truncate text-[11.5px] text-muted">
          {SCOPE_LABELS[account.scope]} · {hostNames}
          {account.totpEnabled ? ' · TOTP' : ''}
        </div>
      </div>
      {canEdit ? (
        <Select
          size="sm"
          value={account.role}
          onChange={(e) => {
            const next = e.target.value as WorkspaceRole
            if (next !== account.role) void updateRole(next)
          }}
          disabled={busy}
          aria-label={`${account.username} 的角色`}
          className="w-[104px]"
        >
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </Select>
      ) : (
        <span className="text-[12px] text-muted">{ROLE_LABELS[account.role]}</span>
      )}
      {canEdit && (
        <IconButton
          label={`吊销账号 ${account.username}`}
          onClick={async () => {
            if (!window.confirm(`吊销 ${account.name}？其所有主机上的登录将立即失效。`)) return
            setBusy(true)
            try {
              await accountApi.revokeAccount(centerHost, account.id)
              onChanged()
            } catch (err) {
              toast(err instanceof Error ? err.message : '吊销失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      )}
    </div>
  )
}

function CreateAccountDialog({
  open,
  onClose,
  hosts,
  centerHost,
  onDone,
}: {
  open: boolean
  onClose: () => void
  hosts: WorkspaceOverview['hosts']
  centerHost: ReturnType<typeof useAppStore.getState>['hosts'][number]
  onDone: () => void
}) {
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('collaborator')
  const [scope, setScope] = useState<WorkspaceScope>('all')
  const [selectedHosts, setSelectedHosts] = useState<string[]>([])
  const [dirsText, setDirsText] = useState('')
  const [totp, setTotp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const dirs: Record<string, string[]> = {}
      if (scope === 'projects') {
        for (const line of dirsText.split('\n')) {
          const [hostId, dir] = line.split('|').map((s) => s.trim())
          if (!hostId || !dir) continue
          ;(dirs[hostId] ??= []).push(dir)
        }
      }
      const created = await accountApi.createAccount(centerHost, {
        username,
        name,
        password,
        role,
        scope,
        hostIds: scope === 'all' ? [] : selectedHosts,
        projectDirsByHost: dirs,
        totp,
      })
      if (created.totpSecret) {
        window.alert(`TOTP 密钥（只显示一次）：${created.totpSecret}\n\n${created.totpUrl ?? ''}`)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建工作区账号"
      description="按账号授权到机器与项目；吊销后该账号在所有主机上立即失效。"
      className="max-w-[520px]"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} 创建
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[12px] text-muted">用户名</span>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="chen" />
          </label>
          <label className="space-y-1">
            <span className="text-[12px] text-muted">显示名</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="陈同事" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] text-muted">初始密码（至少 8 位）</span>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[12px] text-muted">角色</span>
            <Select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
              {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[12px] text-muted">范围</span>
            <Select value={scope} onChange={(e) => setScope(e.target.value as WorkspaceScope)}>
              <option value="all">全部机器</option>
              <option value="hosts">指定机器</option>
              <option value="projects">指定项目</option>
            </Select>
          </label>
        </div>
        {scope !== 'all' && (
          <div className="space-y-1">
            <span className="text-[12px] text-muted">授权机器</span>
            <div className="grid gap-1 rounded-lg border border-border p-2 sm:grid-cols-2">
              {hosts.map((h) => {
                const checked = selectedHosts.includes(h.id)
                return (
                  <label key={h.id} className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedHosts((prev) =>
                          checked ? prev.filter((id) => id !== h.id) : [...prev, h.id],
                        )
                      }
                    />
                    <span className="truncate">{h.name}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
        {scope === 'projects' && (
          <label className="block space-y-1">
            <span className="text-[12px] text-muted">项目目录（每行：主机 id | 绝对路径）</span>
            <Textarea
              value={dirsText}
              onChange={(e) => setDirsText(e.target.value)}
              placeholder={`${hosts[0]?.id ?? 'host-id'} | /home/you/project`}
              rows={3}
            />
            <span className="block text-[11.5px] text-muted">
              主机 id 可在上方主机列表悬停地址栏查看；v1 只支持绝对路径。
            </span>
          </label>
        )}
        <label className="flex items-center gap-2 text-[12.5px] text-text-soft">
          <input type="checkbox" checked={totp} onChange={(e) => setTotp(e.target.checked)} />
          要求 TOTP 二次验证（创建后显示一次密钥）
        </label>
        {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
