import { useEffect, useState } from 'react'
import type {
  WorkstationAccountSummary,
  WorkspaceHostInfo,
  WorkspaceRole,
} from '@tandem/protocol'
import { Spinner } from '../ui/Spinner'
import { workstationApi } from '../../lib/api'
import { withWorkstationSession } from '../../lib/workspaceSession'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Select } from '../ui/Controls'
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

/** 主机主人把主机授权给工作站账号；角色沿用 协作者/审批者/观察者。 */
export function HostGrantDialog({
  host,
  onClose,
  onDone,
}: {
  host: WorkspaceHostInfo | null
  onClose: () => void
  onDone: () => void
}) {
  const me = useAppStore((s) => s.account?.account.id)
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
    withWorkstationSession((base, token) => workstationApi.accounts(base, token))
      .then((list) => setAccounts(list.filter((a) => !a.disabled && a.id !== me)))
      .catch((err) => setError(err instanceof Error ? err.message : '无法读取账号列表'))
  }, [host, me])

  if (!host) return null

  const nameOf = (id: string) => {
    const found = accounts.find((a) => a.id === id)
    return found ? `${found.name}（${found.username}）` : id.slice(0, 8)
  }

  const removeGrant = async (target: string) => {
    setRemoving(target)
    setError(null)
    try {
      await withWorkstationSession((base, token) =>
        workstationApi.removeGrant(base, token, host.id, target),
      )
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
      await withWorkstationSession((base, token) =>
        workstationApi.setGrant(base, token, host.id, {
          accountId,
          role,
          ...(dirs.trim()
            ? { projectDirs: dirs.split('\n').map((d) => d.trim()).filter(Boolean) }
            : {}),
        }),
      )
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
            {busy && <Spinner size={14} />} 保存授权
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
                  {removing === grant.accountId ? <Spinner size={12} /> : '撤销'}
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
          不能授权给主机主人自己；撤销后对方刷新「主机」列表即不再可见，主机端也会立即按新令牌拒绝。
        </p>
      </div>
    </Modal>
  )
}
