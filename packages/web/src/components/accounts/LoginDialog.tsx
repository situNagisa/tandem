import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'
import { Modal } from '../ui/Modal'

interface LoginDialogProps {
  open: boolean
  onClose: () => void
  /** 预填工作站地址（通常是当前主机）。 */
  defaultCenterUrl?: string
}

/** 工作区登录页：工作站地址 + 用户名 + 密码（可选 TOTP）。 */
export function LoginDialog({ open, onClose, defaultCenterUrl = '' }: LoginDialogProps) {
  const login = useAppStore((s) => s.workspaceLogin)
  const register = useAppStore((s) => s.workspaceRegister)
  const [centerUrl, setCenterUrl] = useState(defaultCenterUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debugAvailable, setDebugAvailable] = useState(false)

  useEffect(() => {
    if (open && !centerUrl && defaultCenterUrl) setCenterUrl(defaultCenterUrl)
  }, [open, defaultCenterUrl, centerUrl])

  // 调试版：仅当对方也是调试版工作站、且地址在本机回环时提供调试账号入口。
  useEffect(() => {
    if (!__TANDEM_DEBUG__) return
    setDebugAvailable(false)
    if (!open || !centerUrl.trim()) return
    let alive = true
    const timer = window.setTimeout(() => {
      void import('../../lib/debugAccount')
        .then((mod) => mod.probeDebugWorkstation(centerUrl))
        .then((ok) => {
          if (alive) setDebugAvailable(ok)
        })
        .catch(() => undefined)
    }, 350)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [open, centerUrl])

  const submitDebug = async () => {
    if (!__TANDEM_DEBUG__) return
    setBusy(true)
    setError(null)
    try {
      const mod = await import('../../lib/debugAccount')
      if (!(await mod.debugLoginAt(centerUrl))) throw new Error('调试账号不可用')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '调试账号登录失败')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!centerUrl.trim() || !username.trim() || !password) {
      setError('请填写工作站地址、用户名和密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register') await register({ workstationUrl: centerUrl, username, password, inviteCode })
      else await login({ centerUrl, username, password, totp })
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
      title={mode === 'register' ? '注册工作站账号' : '登录工作站'}
      description="工作站负责账号与主机登记；登录后只看到自己的主机与获授权的主机。"
      className="max-w-[440px]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[12px] text-muted">只在可信内网 / VPN 使用</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? '注册账号' : '去登录'}
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? <Spinner size={14} /> : <KeyRound size={14} />}
              {mode === 'login' ? '登录' : '注册并登录'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] text-text-soft">
          <ShieldCheck size={15} className="shrink-0" />
          不连接公网或第三方账号服务；账号与令牌由你自己的工作站签发。
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] text-muted">工作站地址</span>
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
        {mode === 'login' ? (
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
        ) : (
          <label className="block space-y-1">
            <span className="text-[12px] text-muted">邀请码（工作站设为仅邀请时填写）</span>
            <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="可留空" />
          </label>
        )}
        {__TANDEM_DEBUG__ && debugAvailable && mode === 'login' && (
          <Button variant="secondary" className="w-full justify-center" onClick={() => void submitDebug()} disabled={busy}>
            <KeyRound size={14} /> 用调试账号登录
          </Button>
        )}
        {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
        <p className="text-[12px] leading-5 text-muted">
          没有账号？内网可直接注册；工作站管理员也可以把注册方式改为「仅邀请」并发放邀请码。即使本机也要在登录后显式「添加主机」。
        </p>
      </div>
    </Modal>
  )
}
