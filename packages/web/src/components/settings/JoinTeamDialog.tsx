import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { acceptTeamInvite } from '../../lib/api'
import { navigate } from '../../lib/router'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'
import { Modal } from '../ui/Modal'

/** 打开邀请链接后：填写名字，凭邀请码换取成员 token 并添加主机。 */
export function JoinTeamDialog() {
  const invite = useUiStore((s) => s.joinInvite)
  const close = useUiStore((s) => s.closeJoinInvite)
  const toast = useUiStore((s) => s.toast)
  const addHost = useAppStore((s) => s.addHost)
  const [name, setName] = useState('')
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (invite) {
      setError(null)
      setJoining(false)
      setName((prev) => prev || localStorage.getItem('tandem.memberName') || '')
    }
  }, [invite])

  const join = async () => {
    if (!invite || joining) return
    if (!name.trim()) {
      setError('请填写你的名字，便于主机记录审计')
      return
    }
    setJoining(true)
    setError(null)
    try {
      const result = await acceptTeamInvite(invite.baseUrl, invite.code, name.trim())
      localStorage.setItem('tandem.memberName', name.trim())
      const host = addHost({
        name: result.host.name || '团队 Host',
        url: invite.baseUrl,
        token: result.token,
      })
      toast(`已加入 ${host.name}（${result.member.role === 'observer' ? '观察者' : result.member.role === 'approver' ? '审批者' : '协作者'}）`, 'success')
      useAppStore.getState().activateHost(host.id)
      navigate({ kind: 'host', hostId: host.id })
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入失败')
    } finally {
      setJoining(false)
    }
  }

  return (
    <Modal
      open={!!invite}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Users size={14} className="text-muted" />
          加入团队 Host
        </span>
      }
      description="邀请码只能使用一次。加入后你会获得独立的成员 token，主机只保存哈希。"
      className="max-w-md"
      footer={
        <>
          <Button onClick={close} disabled={joining}>
            稍后再说
          </Button>
          <Button variant="primary" onClick={() => void join()} disabled={joining || !name.trim()}>
            {joining && <Spinner size={13} />}
            接受邀请
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[13px] text-muted">你的名字</span>
          <Input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void join()
              }
            }}
            placeholder="如 张三"
          />
        </label>
        <p className="break-all rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 font-mono text-[12px] text-muted">
          {invite?.baseUrl}
        </p>
        {error && <p className="text-[12px] leading-5 text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
