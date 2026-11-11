import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Clock, Plus } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { WorkspaceHostInfo, WorkstationBindCode, WorkstationPublicStatus } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { workstationApi } from '../../lib/api'
import { withWorkstationSession } from '../../lib/workspaceSession'
import {
  buildAddHostCommands,
  defaultAddHostPlatform,
  isLoopbackUrl,
  normalizeWorkstationUrl,
  pickShareUrl,
  type AddHostPlatform,
} from '../../lib/addHostCommand'
import { pageIsLoopback } from '../../lib/localHosts'
import { toast } from '../../store/appStore/helpers'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { SegmentedControl, Switch } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { CodeBlock } from '../CodeBlock'

const PLATFORM_OPTIONS = [
  {
    value: 'windows' as const,
    label: <span data-testid="addhost-platform-windows">Windows</span>,
  },
  {
    value: 'macos' as const,
    label: <span data-testid="addhost-platform-macos">macOS</span>,
  },
  {
    value: 'linux' as const,
    label: <span data-testid="addhost-platform-linux">Linux</span>,
  },
]

type HostPhase = 'waiting' | 'registered' | 'connected'

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function AddHostDialog() {
  const open = useUiStore((s) => s.addHostOpen)
  const setOpen = useUiStore((s) => s.setAddHostOpen)
  const account = useAppStore((s) => s.account)
  const base = account?.centerUrl ?? ''

  const [platform, setPlatform] = useState<AddHostPlatform>(() =>
    defaultAddHostPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  )
  const [autostart, setAutostart] = useState(false)
  const [status, setStatus] = useState<WorkstationPublicStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [bind, setBind] = useState<WorkstationBindCode | null>(null)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [phase, setPhase] = useState<HostPhase>('waiting')
  const [newHost, setNewHost] = useState<WorkspaceHostInfo | null>(null)
  const [tokenUsed, setTokenUsed] = useState(false)
  const connectedRef = useRef(false)
  const baselineRef = useRef<Set<string> | null>(null)
  const chosenIdRef = useRef<string | null>(null)

  const localAvailable = open && pageIsLoopback()
  const [joiningLocal, setJoiningLocal] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const share = useMemo(() => pickShareUrl(base, status?.urls ?? []), [base, status])
  const url = selectedUrl ?? share.url
  const statusReady = !!status || !!statusError
  const centerIsLoopback = isLoopbackUrl(base)
  const shareUrlReplaced = centerIsLoopback && !share.loopbackOnly && url !== normalizeWorkstationUrl(base)

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  // 工作站状态：公开接口，用来读取对外地址与错误状态。
  useEffect(() => {
    if (!open || !base) {
      setStatus(null)
      setStatusError(null)
      return
    }
    let cancelled = false
    setStatus(null)
    setStatusError(null)
    workstationApi
      .publicStatus(base)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus(null)
        setStatusError(err instanceof Error ? err.message : '无法读取工作站地址')
      })
    return () => {
      cancelled = true
    }
  }, [open, base])

  useEffect(() => {
    setSelectedUrl(share.url)
  }, [share.url])

  // 每次打开（或点「重新生成」）都换一枚一次性注册令牌；关闭后不保留。
  useEffect(() => {
    if (!open || !base) return
    let cancelled = false
    setBind(null)
    setError(null)
    setTokenUsed(false)
    void withWorkstationSession((b, token) => workstationApi.bindCode(b, token))
      .then((next) => {
        if (!cancelled) {
          setBind(next)
          setNow(Date.now())
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '生成注册令牌失败')
      })
    return () => {
      cancelled = true
    }
  }, [open, base, generation])

  // 每次打开都重新取一次基线：打开之后出现的主机才算「新主机」。
  useEffect(() => {
    baselineRef.current = null
    chosenIdRef.current = null
    connectedRef.current = false
    setPhase('waiting')
    setNewHost(null)
  }, [open])

  // 打开时记下已有主机；此后每 1.5s 轮询，出现新主机即推进状态。
  useEffect(() => {
    if (!open || !base) return
    let cancelled = false

    const tick = async () => {
      if (cancelled || connectedRef.current) return
      try {
        const list = await withWorkstationSession((b, token) => workstationApi.hosts(b, token))
        if (cancelled) return
        if (!baselineRef.current) {
          baselineRef.current = new Set(list.map((host) => host.id))
          return
        }
        const fresh = list.filter((host) => !baselineRef.current!.has(host.id))
        if (fresh.length === 0) return
        const target =
          fresh.find((host) => host.id === chosenIdRef.current) ??
          fresh.find((host) => host.online) ??
          fresh[0]!
        chosenIdRef.current = target.id
        setNewHost(target)
        setTokenUsed(true)
        if (target.online) {
          connectedRef.current = true
          setPhase('connected')
          toast(`已连接主机「${target.name}」`, 'success')
          void useAppStore
            .getState()
            .syncWorkstationHosts()
            .catch(() => undefined)
        } else {
          setPhase('registered')
        }
      } catch {
        /* 轮询失败不打断界面；下一次继续 */
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, base, account?.accessToken])

  const close = useCallback(() => {
    setOpen(false)
    setBind(null)
    setSelectedUrl(null)
  }, [setOpen])

  const remaining = bind ? Math.max(0, bind.expiresAt - now) : 0
  const expired = !!bind && remaining <= 0
  const tokenInvalid = expired || tokenUsed
  const commands = buildAddHostCommands({
    workstationUrl: url,
    token: bind?.code ?? '',
    platform,
    service: autostart,
  })
  const joinLocal = async () => {
    setJoiningLocal(true)
    setLocalError(null)
    try {
      await withWorkstationSession((b, token) => workstationApi.addLocalHost(b, token))
      // 登记后由上面的轮询把新主机识别为「已连接」。
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '添加本机失败')
    } finally {
      setJoiningLocal(false)
    }
  }

  const statusNode =
    phase === 'connected' ? (
      <>
        <Check size={15} className="shrink-0 text-[var(--t-success)]" />
        <span>已连接 {newHost?.name ?? ''}</span>
      </>
    ) : phase === 'registered' ? (
      <>
        <Spinner size={15} className="shrink-0 text-[var(--t-text-tertiary)]" />
        <span>已注册 {newHost?.name ?? ''}，等待上线…</span>
      </>
    ) : (
      <>
        <Spinner size={15} className="shrink-0 text-[var(--t-text-tertiary)]" />
        <span>等待主机连接…</span>
      </>
    )

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加主机"
      description={
        <>
          在目标机器上执行一次命令，它就会以当前账号身份持续连接工作站。
          <br />
          目标机器只需能访问工作站，不需要安装 Node.js。
        </>
      }
      layer={70}
      className="max-w-[560px]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11.5px] text-[var(--t-text-tertiary)]">
            注册令牌一次性、15 分钟有效
          </span>
          {phase === 'connected' ? (
            <Button variant="primary" onClick={close}>
              完成
            </Button>
          ) : (
            <Button variant="secondary" onClick={close}>
              关闭
            </Button>
          )}
        </div>
      }
    >
      {!account ? (
        <p className="text-[13px] leading-6 text-[var(--t-text-secondary)]">请先登录工作站，再添加主机。</p>
      ) : (
        <div className="space-y-3 text-[12.5px] leading-6">
          <SegmentedControl
            size="sm"
            aria-label="选择目标机器系统"
            className="w-full"
            itemClassName="flex-1"
            value={platform}
            onChange={setPlatform}
            options={PLATFORM_OPTIONS}
          />

          <div className="flex items-center gap-2 text-[12px] text-[var(--t-text-secondary)]">
            <Switch checked={autostart} onChange={setAutostart} label="开机自启（需要相应权限）" />
            <span>开机自启（需要相应权限）</span>
          </div>

          {share.loopbackOnly && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-bg-subtle)] px-3 py-2 text-[12px] leading-5 text-[var(--t-warning)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                工作站只监听本机回环，其他机器无法访问；用{' '}
                <code className="rounded bg-[var(--t-bg-active)] px-1 font-mono text-[11.5px]">--host 0.0.0.0</code>{' '}
                启动工作站。
              </span>
            </div>
          )}
          {shareUrlReplaced && (
            <p className="text-[12px] leading-5 text-[var(--t-text-tertiary)]">
              工作站地址是本机回环，其他机器无法访问；已改用局域网地址。
            </p>
          )}
          {statusError && (
            <p className="text-[12px] leading-5 text-[var(--t-danger)]">无法读取工作站状态：{statusError}</p>
          )}

          {share.candidates.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[12px] text-[var(--t-text-tertiary)]">工作站地址</span>
              <MenuSelect
                size="sm"
                aria-label="工作站地址"
                value={url}
                onChange={setSelectedUrl}
                options={share.candidates.map((candidate) => ({ value: candidate, label: candidate }))}
                wrapperClassName="w-full"
                className="font-mono text-[12px]"
                panelClassName="min-w-[220px] max-w-[calc(100vw-64px)]"
              />
            </div>
          )}

          {phase === 'connected' ? null : !statusReady ? (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2 text-[12px] text-[var(--t-text-tertiary)]">
              <Spinner size={14} />
              正在读取工作站状态…
            </div>
          ) : !bind ? (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--t-bg-subtle)] px-3 py-2 text-[12px] text-[var(--t-text-tertiary)]">
              <Spinner size={14} />
              正在生成注册令牌…
            </div>
          ) : tokenInvalid ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-bg-subtle)] px-3 py-2 text-[12px] text-[var(--t-text-secondary)]"
              data-testid="addhost-expiry"
            >
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} className="shrink-0 text-[var(--t-text-tertiary)]" />
                令牌已失效{tokenUsed ? '（已被使用）' : ''}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setGeneration((value) => value + 1)}>
                重新生成
              </Button>
            </div>
          ) : (
            <div data-testid="addhost-command">
              <CodeBlock
                code={commands.oneLiner}
                language={platform === 'windows' ? 'powershell' : 'bash'}
                fileName={platform === 'windows' ? 'PowerShell' : '终端'}
                toolsAlwaysVisible
                maxHeight={null}
              />
            </div>
          )}

          <div
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px]',
              phase === 'connected'
                ? 'bg-[var(--t-bg-subtle)] text-[var(--t-success)]'
                : 'bg-[var(--t-bg-subtle)] text-[var(--t-text-secondary)]',
            )}
            data-testid="addhost-status"
            aria-live="polite"
          >
            {statusNode}
          </div>

          {bind && !tokenInvalid && (
            <div
              className="flex items-center gap-1.5 text-[11.5px] text-[var(--t-text-tertiary)]"
              data-testid="addhost-expiry"
            >
              <Clock size={12} className="shrink-0" />
              令牌 <span className="font-mono tabular-nums text-[var(--t-text-secondary)]">{formatCountdown(remaining)}</span> 后失效
            </div>
          )}

          {error && <p className="text-[12px] leading-5 text-[var(--t-danger)]">{error}</p>}
          {localError && <p className="text-[12px] leading-5 text-[var(--t-danger)]">{localError}</p>}

          {localAvailable && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="addhost-local"
              disabled={joiningLocal}
              onClick={() => void joinLocal()}
            >
              {joiningLocal ? <Spinner size={13} /> : <Plus size={13} />}
              添加这台电脑
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}
