import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, MonitorSmartphone, Server, ShieldCheck, Sparkles } from 'lucide-react'
import type { WorkstationPublicStatus } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { workstationApi } from '../../lib/api'
import { loadAccountSession } from '../../lib/storage'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'

type Stage = 'loading' | 'choice' | 'connect' | 'setup' | 'login' | 'register'

interface Props {
  onDone: () => void
}

const ONBOARD_KEY = 'tandem.onboarded.v1'

/** 首次打开：先连工作站（注册/登录），再看「我的主机」；本机也要显式添加。 */
export function WorkstationOnboarding({ onDone }: Props) {
  const [stage, setStage] = useState<Stage>('loading')
  const [status, setStatus] = useState<WorkstationPublicStatus | null>(null)
  const [workstationUrl, setWorkstationUrl] = useState('')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [isHostOrigin, setIsHostOrigin] = useState(false)

  const finish = () => {
    localStorage.setItem(ONBOARD_KEY, '1')
    localStorage.removeItem('tandem.onboarding.force')
    onDone()
  }

  // 已登录的会话直接恢复，不重复打扰。
  useEffect(() => {
    let alive = true
    const boot = async () => {
      const session = loadAccountSession()
      if (session && session.refreshExpiresAt > Date.now()) {
        try {
          await useAppStore.getState().syncWorkstationHosts()
          if (alive) return finish()
        } catch {
          /* 令牌过期或工作站不可达，走登录 */
        }
      }
      try {
        const origin = window.location.origin
        const local = await fetch(`${origin}/api/workstation/local/status`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        if (local.ok) {
          setIsHostOrigin(true)
          const body = (await local.json()) as { embedded?: { running: boolean; urls: string[] } }
          if (body.embedded?.running && body.embedded.urls.length) {
            const url = body.embedded.urls[0]!
            if (await probe(url)) return
          }
          setStage('choice')
          setWorkstationUrl('')
          return
        }
      } catch {
        /* 不是 Host 页面 */
      }
      if (await probe(origin)) return
      setStage('connect')
      setWorkstationUrl('')
    }
    const probe = async (url: string): Promise<boolean> => {
      try {
        const info = await workstationApi.publicStatus(url)
        if (!alive) return true
        setWorkstationUrl(url.replace(/\/+$/, ''))
        setStatus(info)
        if (!info.initialized) setStage('setup')
        else setStage('login')
        return true
      } catch {
        return false
      }
    }
    void boot()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const origin = window.location.origin
  const currentHost = useMemo(
    () => useAppStore.getState().hosts.find((h) => h.url.startsWith(origin)) ?? useAppStore.getState().hosts[0],
    [origin],
  )

  const connect = async (url: string) => {
    setBusy(true)
    setError(null)
    try {
      const info = await workstationApi.publicStatus(url)
      setWorkstationUrl(url.trim().replace(/\/+$/, ''))
      setStatus(info)
      if (!info.initialized) setStage('setup')
      else setStage('login')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接工作站')
    } finally {
      setBusy(false)
    }
  }

  const enableLocal = async () => {
    if (!currentHost) {
      setError('请从桌面端或带 token 的地址打开本机 Host 后再启动本机工作站。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const info = await workstationApi.enableLocal(currentHost)
      const url = info.urls.find((u) => !/127\.0\.0\.1|localhost/.test(u)) ?? info.urls[0]!
      setWorkstationUrl(url)
      setNote(`本机工作站已启动：${url}`)
      const statusInfo = await workstationApi.publicStatus(url)
      setStatus(statusInfo)
      setStage(statusInfo.initialized ? 'login' : 'setup')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法启动本机工作站')
    } finally {
      setBusy(false)
    }
  }

  const submitSetup = async () => {
    if (!name.trim() || !username.trim() || password.length < 8) {
      setError('请填写工作站名称、用户名和至少 8 位密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await workstationApi.setup(workstationUrl, {
        name: name.trim(),
        username: username.trim(),
        password,
      })
      useAppStore.getState().applyWorkstationLogin(workstationUrl, result)
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建工作站失败')
    } finally {
      setBusy(false)
    }
  }

  const submitLogin = async () => {
    if (!username.trim() || !password) {
      setError('请填写用户名和密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await useAppStore.getState().workspaceLogin({
        centerUrl: workstationUrl,
        username: username.trim(),
        password,
      })
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  const submitRegister = async () => {
    if (!username.trim() || password.length < 8) {
      setError('请填写用户名和至少 8 位密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await useAppStore.getState().workspaceRegister({
        workstationUrl,
        username: username.trim(),
        password,
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      })
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--t-bg)] px-5 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-7 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--t-bg-active)] text-[var(--t-accent-strong)]">
            <Sparkles size={18} />
          </span>
          <div>
            <div className="font-serif text-[22px] leading-7 text-[var(--t-text)]">Tandem</div>
            <div className="text-[12px] text-[var(--t-text-tertiary)]">内网工作站 · 客户端-服务模式</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--t-border)] bg-[var(--t-bg-elevated)] p-6 shadow-[var(--shadow-md)]">
          <h1 className="font-serif text-[26px] leading-8 text-[var(--t-text)]">
            {stage === 'loading' && '正在连接…'}
            {stage === 'choice' && '开始使用 Tandem'}
            {stage === 'connect' && '连接工作站'}
            {stage === 'setup' && '创建工作站'}
            {stage === 'login' && '登录工作站'}
            {stage === 'register' && '注册账号'}
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-[var(--t-text-secondary)]">
            {stage === 'loading' && '检查本机与工作站状态。'}
            {stage === 'choice' && '工作站负责账号与主机登记；即使这台电脑也要显式添加为主机。'}
            {stage === 'connect' && '填写团队工作站或本机工作站地址，注册/登录后就能看到自己的主机。'}
            {stage === 'setup' && '第一个注册的账号是管理员；工作站不运行 agent，只登记主机与转发加密连接。'}
            {stage === 'login' && '登录后只显示你添加的主机，以及别人授权给你的主机。'}
            {stage === 'register' && (status?.registration === 'invite' ? '当前为仅邀请注册，请填写管理员给你的邀请码。' : '内网开放注册；注册后添加你自己的主机。')}
          </p>

          {stage === 'loading' && (
            <div className="mt-6 flex items-center gap-2 text-[13px] text-[var(--t-text-secondary)]">
              <Loader2 size={16} className="animate-spin" /> 正在探测…
            </div>
          )}

          {stage === 'choice' && (
            <div className="mt-5 space-y-2.5">
              <Button
                variant="primary"
                size="lg"
                className="w-full justify-between"
                onClick={() => {
                  setStage('connect')
                  setError(null)
                }}
              >
                <span className="flex items-center gap-2">
                  <Server size={16} /> 连接工作站
                </span>
                <ArrowRight size={15} />
              </Button>
              {isHostOrigin && (
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full justify-between"
                  disabled={busy}
                  onClick={() => void enableLocal()}
                >
                  <span className="flex items-center gap-2">
                    <MonitorSmartphone size={16} /> 把这台电脑作为工作站
                  </span>
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                </Button>
              )}
              <Button variant="ghost" size="lg" className="w-full" onClick={finish}>
                仅本机使用（保留地址 + token 模式）
              </Button>
              {note && <p className="text-[12.5px] text-[var(--t-text-secondary)]">{note}</p>}
              {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
            </div>
          )}

          {(stage === 'connect' || stage === 'setup' || stage === 'login' || stage === 'register') && (
            <div className="mt-5 space-y-3">
              <label className="block space-y-1">
                <span className="text-[12px] text-[var(--t-text-tertiary)]">工作站地址</span>
                <div className="flex gap-2">
                  <Input
                    value={workstationUrl}
                    onChange={(e) => setWorkstationUrl(e.target.value)}
                    placeholder="http://192.168.1.10:8481"
                    disabled={busy}
                  />
                  <Button
                    variant="secondary"
                    disabled={busy || !workstationUrl.trim()}
                    onClick={() => void connect(workstationUrl)}
                  >
                    连接
                  </Button>
                </div>
              </label>

              {status && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] text-[var(--t-text-secondary)]">
                  <ShieldCheck size={14} className="shrink-0" />
                  {status.name ? `「${status.name}」` : '工作站'}
                  {status.initialized ? ` · ${status.registration === 'invite' ? '仅邀请注册' : '开放注册'}` : ' · 尚未初始化'}
                </div>
              )}

              {stage === 'setup' && (
                <label className="block space-y-1">
                  <span className="text-[12px] text-[var(--t-text-tertiary)]">工作站名称</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="公司内网 / 我的电脑" />
                </label>
              )}

              {(stage === 'setup' || stage === 'login' || stage === 'register') && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="text-[12px] text-[var(--t-text-tertiary)]">用户名</span>
                    <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="3–32 位" autoFocus />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[12px] text-[var(--t-text-tertiary)]">密码</span>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="至少 8 位"
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        if (stage === 'setup') void submitSetup()
                        else if (stage === 'login') void submitLogin()
                        else void submitRegister()
                      }}
                    />
                  </label>
                </div>
              )}

              {stage === 'register' && status?.registration === 'invite' && (
                <label className="block space-y-1">
                  <span className="text-[12px] text-[var(--t-text-tertiary)]">邀请码</span>
                  <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="管理员生成的一次性邀请码" />
                </label>
              )}

              {error && <p className="text-[12.5px] text-[var(--t-danger)]">{error}</p>}
              {note && <p className="text-[12.5px] text-[var(--t-text-secondary)]">{note}</p>}

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button variant="ghost" onClick={() => setStage('choice')} disabled={busy}>
                  返回
                </Button>
                <div className="flex gap-2">
                  {stage === 'login' && status?.registration !== 'invite' && (
                    <Button variant="ghost" onClick={() => setStage('register')} disabled={busy}>
                      注册
                    </Button>
                  )}
                  {stage === 'register' && (
                    <Button variant="ghost" onClick={() => setStage('login')} disabled={busy}>
                      去登录
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy || !workstationUrl.trim()}
                    onClick={() => {
                      if (stage === 'setup') void submitSetup()
                      else if (stage === 'login') void submitLogin()
                      else if (stage === 'register') void submitRegister()
                      else void connect(workstationUrl)
                    }}
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {stage === 'setup' ? '创建工作站' : stage === 'register' ? '注册并登录' : '登录'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {note && stage === 'choice' && null}
        </div>

        <p className="mt-4 text-center text-[12px] leading-5 text-[var(--t-text-tertiary)]">
          只在可信内网 / VPN 使用；工作站只转发端到端加密会话，看不到会话内容。
        </p>
      </div>
    </div>
  )
}

export const ONBOARDING_KEY = ONBOARD_KEY
