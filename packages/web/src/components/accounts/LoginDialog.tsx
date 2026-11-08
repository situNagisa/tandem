import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'
import { Modal } from '../ui/Modal'

interface LoginDialogProps {
  open: boolean
  onClose: () => void
  /** 预填账号中心地址（通常是当前主机）。 */
  defaultCenterUrl?: string
}

/** 工作区登录页：账号中心地址 + 用户名 + 密码（可选 TOTP）。 */
export function LoginDialog({ open, onClose, defaultCenterUrl = '' }: LoginDialogProps) {
  const login = useAppStore((s) => s.workspaceLogin)
  const [centerUrl, setCenterUrl] = useState(defaultCenterUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && !centerUrl && defaultCenterUrl) setCenterUrl(defaultCenterUrl)
  }, [open, defaultCenterUrl, centerUrl])

  const submit = async () => {
    if (!centerUrl.trim() || !username.trim() || !password) {
      setError('请填写账号中心地址、用户名和密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await login({ centerUrl, username, password, totp })
      setPassword('')
      setTotp('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="登录工作区"
      description="账号中心自托管在你的某台主机上；登录一次即可看到全部可访问的机器。"
      className="max-w-[440px]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[12px] text-muted">只在可信内网 / VPN 使用</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              登录
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] text-text-soft">
          <ShieldCheck size={15} className="shrink-0" />
          不连接公网或第三方账号服务；令牌由你自己的 Host 签发。
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] text-muted">账号中心地址</span>
          <Input
            value={centerUrl}
            onChange={(e) => setCenterUrl(e.target.value)}
            placeholder="http://192.168.1.10:8270"
            autoFocus
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[12px] text-muted">用户名</span>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] text-muted">密码</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] text-muted">动态验证码（账号开启 TOTP 时填写）</span>
          <Input
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            placeholder="6 位数字，可留空"
            inputMode="numeric"
            maxLength={6}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>
        {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
        <p className="text-[12px] leading-5 text-muted">
          没有账号？在你的一台主机上「设置 → 成员与分享 → 工作区」创建工作区；同事加入后由所有者分配角色与范围。
        </p>
      </div>
    </Modal>
  )
}
