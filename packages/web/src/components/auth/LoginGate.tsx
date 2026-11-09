import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowRight, Loader2, LogIn, MonitorSmartphone, ShieldCheck } from 'lucide-react'
import type { WorkstationPublicStatus } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { workstationApi } from '../../lib/api'
import { loadLastWorkstationUrl } from '../../lib/storage'
import { findLocalControl, pageIsLoopback } from '../../lib/localHosts'
import { BrandMark } from '../BrandMark'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'

// 调试版专用入口：发布构建里条件为常量 false，模块不会进入产物。
const DebugLoginBox = __TANDEM_DEBUG__
  ? lazy(() => import('./DebugLoginBox').then((mod) => ({ default: mod.DebugLoginBox })))
  : null

type Stage = 'probing' | 'connect' | 'login' | 'register' | 'setup'

const normalize = (url: string): string => url.trim().replace(/\/+$/, '')

async function probe(url: string): Promise<WorkstationPublicStatus | null> {
  try {
    return await workstationApi.publicStatus(url)
  } catch {
    return null
  }
}

/**
 * 登录门：打开 Tandem 先登录工作站，登录后才进入工作台。
 * 工作站地址依次尝试：上次登录的地址 → 页面本身（页面由工作站托管）→ 本机 Host 内嵌的工作站
 * （页面在回环地址打开时，若还没启动就自动启动，个人使用不用再选一次）。
 */
export function LoginGate() {
  const [stage, setStage] = useState<Stage>('probing')
  const [status, setStatus] = useState<WorkstationPublicStatus | null>(null)
  const [workstationUrl, setWorkstationUrl] = useState('')
  const [name, setName] = useState('我的工作站')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const control = findLocalControl()

  const accept = (url: string, info: WorkstationPublicStatus) => {
    setWorkstationUrl(normalize(url))
    setStatus(info)
    setError(null)
    setStage(info.initialized ? 'login' : 'setup')
  }

  const useLocalWorkstation = async (autoStart: boolean): Promise<boolean> => {
    if (!control) return false
    try {
      const local = await workstationApi.localStatus(control)
      let urls = local.embedded.running ? local.embedded.urls : []
      if (urls.length === 0 && autoStart) {
        urls = (await workstationApi.enableLocal(control)).urls
      }
      for (const url of urls.filter((u) => /127\.0\.0\.1|localhost/.test(u)).concat(urls)) {
        const info = await probe(url)
        if (info) {
          accept(url, info)
          return true
        }
      }
    } catch {
      /* 本机 Host 不可用或没有权限 */
    }
    return false
  }

  useEffect(() => {
    let alive = true
    const boot = async () => {
      const last = loadLastWorkstationUrl()
      if (last) {
        const info = await probe(last)
        if (!alive) return
        if (info) return accept(last, info)
      }
      // 页面由 Host 托管时（有本机凭据）它没有公开的工作站状态接口，不必探测。
      if (!control) {
        const origin = window.location.origin
        const info = await probe(origin)
        if (!alive) return
        if (info) return accept(origin, info)
      }
      if (await useLocalWorkstation(pageIsLoopback())) return
      if (!alive) return
      setWorkstationUrl(last)
      if (last) setError(`无法连接 ${last}，请检查地址或网络。`)
      setStage('connect')
    }
    void boot()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    const url = normalize(workstationUrl)
    if (!/^https?:\/\//i.test(url)) {
      setError('请填写工作站地址，例如 http://192.168.1.10:8481')
      return
    }
    setBusy(true)
    setError(null)
    const info = await probe(url)
    setBusy(false)
    if (!info) {
      setError('无法连接这个地址的工作站，请检查地址、网络与工作站是否已启动。')
      return
    }
    accept(url, info)
  }

  const run = async (task: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (stage === 'connect') return void connect()
    if (!username.trim() || (stage !== 'login' && password.length < 8) || !password) {
      setError(stage === 'login' ? '请填写用户名和密码' : '请填写用户名和至少 8 位密码')
      return
    }
    if (stage === 'setup') {
      if (!name.trim()) return setError('请填写工作站名称')
      void run(async () => {
        const result = await workstationApi.setup(workstationUrl, {
          name: name.trim(),
          username: username.trim(),
          password,
        })
        useAppStore.getState().applyWorkstationLogin(workstationUrl, result)
      }, '创建工作站失败')
    } else if (stage === 'register') {
      void run(
        () =>
          useAppStore.getState().workspaceRegister({
            workstationUrl,
            username: username.trim(),
            password,
            ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
          }),
        '注册失败',
      )
    } else {
      void run(
        () =>
          useAppStore.getState().workspaceLogin({
            centerUrl: workstationUrl,
            username: username.trim(),
            password,
          }),
        '登录失败',
      )
    }
  }

  const title = {
    probing: '正在连接工作站…',
    connect: '连接工作站',
    login: '登录 Tandem',
    register: '注册账号',
    setup: '创建工作站',
  }[stage]
  const hint = {
    probing: '检查工作站状态。',
    connect: '填写团队服务器或这台电脑上的工作站地址，连接后登录或注册。',
    login: '登录后查看主机和会话。',
    register:
      status?.registration === 'invite'
        ? '当前为仅邀请注册，请填写管理员给你的邀请码。'
        : '内网开放注册；注册后添加你自己的主机。',
    setup: '第一次使用：第一个账号就是管理员。工作站只登记主机与转发加密连接，不运行任务。',
  }[stage]
  const fields = stage === 'login' || stage === 'register' || stage === 'setup'

  return (
    <div
      data-testid="login-gate"
      className="flex min-h-[var(--app-height,100dvh)] items-center justify-center overflow-y-auto bg-bg px-4 py-10 text-text"
    >
      <div className="anim-slide-up w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-2.5">
          <BrandMark size={32} />
          <div>
            <div className="font-serif text-[22px] leading-7">Tandem</div>
            <div className="text-[12px] leading-4 text-muted">先登录，再添加主机，然后开始会话</div>
          </div>
        </div>

        {DebugLoginBox && stage !== 'probing' && (
          <Suspense fallback={null}>
            <DebugLoginBox workstationUrl={workstationUrl} />
          </Suspense>
        )}

        <div className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--t-shadow-md)]">
          <h1 className="text-[22px] font-medium leading-8 tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 text-[13px] leading-5 text-muted">{hint}</p>

          {stage === 'probing' && (
            <div className="mt-5 flex items-center gap-2 text-[13px] text-text-secondary">
              <Loader2 size={15} className="animate-spin" /> 正在探测…
            </div>
          )}

          {stage === 'connect' && (
            <div className="mt-4 space-y-3">
              <label className="block space-y-1">
                <span className="text-[12px] text-muted">工作站地址</span>
                <Input
                  size="lg"
                  data-testid="login-url"
                  value={workstationUrl}
                  onChange={(e) => setWorkstationUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="http://192.168.1.10:8481"
                  disabled={busy}
                  autoFocus
                />
              </label>
              {control && (
                <Button
                  variant="secondary"
                  className="w-full justify-center"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!(await useLocalWorkstation(true))) throw new Error('无法启动这台电脑的工作站')
                    }, '无法启动这台电脑的工作站')
                  }
                >
                  <MonitorSmartphone size={14} /> 使用这台电脑的工作站
                </Button>
              )}
            </div>
          )}

          {fields && (
            <div className="mt-4 space-y-3">
              {stage === 'setup' && (
                <label className="block space-y-1">
                  <span className="text-[12px] text-muted">工作站名称</span>
                  <Input size="lg" data-testid="login-workspace-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="公司内网 / 我的电脑" />
                </label>
              )}
              <label className="block space-y-1">
                <span className="text-[12px] text-muted">用户名</span>
                <Input
                  size="lg"
                  data-testid="login-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={stage === 'login' ? '用户名' : '3–32 位'}
                  autoFocus
                  disabled={busy}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[12px] text-muted">密码</span>
                <Input
                  size="lg"
                  type="password"
                  data-testid="login-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={stage === 'login' ? '密码' : '至少 8 位'}
                  disabled={busy}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
              </label>
              {stage === 'register' && status?.registration === 'invite' && (
                <label className="block space-y-1">
                  <span className="text-[12px] text-muted">邀请码</span>
                  <Input
                    size="lg"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="管理员生成的一次性邀请码"
                    disabled={busy}
                  />
                </label>
              )}
            </div>
          )}

          {error && (
            <p role="alert" data-testid="login-error" className="mt-3 text-[12.5px] leading-5 text-[var(--t-danger)]">
              {error}
            </p>
          )}

          {stage !== 'probing' && (
            <Button
              variant="primary"
              size="lg"
              data-testid="login-submit"
              className="mt-4 w-full justify-center"
              disabled={busy || (stage === 'connect' && !workstationUrl.trim())}
              onClick={submit}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : stage === 'connect' ? <ArrowRight size={15} /> : <LogIn size={15} />}
              {stage === 'connect' ? '连接' : stage === 'setup' ? '创建并登录' : stage === 'register' ? '注册并登录' : '登录'}
            </Button>
          )}

          {(stage === 'login' || stage === 'register') && (
            <div className="mt-3 text-center text-[12.5px] text-muted">
              {stage === 'login' ? (
                <>
                  还没有账号？
                  <button
                    type="button"
                    data-testid="login-to-register"
                    className="ml-1 text-accent-text hover:underline"
                    onClick={() => {
                      setStage('register')
                      setError(null)
                    }}
                  >
                    {status?.registration === 'invite' ? '用邀请码注册' : '注册'}
                  </button>
                </>
              ) : (
                <>
                  已有账号？
                  <button
                    type="button"
                    className="ml-1 text-accent-text hover:underline"
                    onClick={() => {
                      setStage('login')
                      setError(null)
                    }}
                  >
                    去登录
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {stage !== 'probing' && stage !== 'connect' && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-[12px] leading-5 text-muted">
            <ShieldCheck size={13} className="shrink-0" />
            <span className="min-w-0 truncate" data-tip={workstationUrl}>
              {status?.name ? `「${status.name}」` : '工作站'} · {workstationUrl}
            </span>
            <button
              type="button"
              data-testid="login-url-change"
              className="shrink-0 text-accent-text hover:underline"
              onClick={() => {
                setStage('connect')
                setError(null)
              }}
            >
              更改
            </button>
          </p>
        )}
        {stage === 'connect' && (
          <p className="mt-4 text-center text-[12px] leading-5 text-muted">
            只在可信内网 / VPN 使用；工作站只转发端到端加密的会话。
          </p>
        )}
      </div>
    </div>
  )
}
