// 调试版登录页的「使用调试账号登录」入口（只在 __TANDEM_DEBUG__ 分支里惰性加载）。
import { useEffect, useState } from 'react'
import { Bug, Loader2 } from 'lucide-react'
import { Button } from '../ui/Button'
import {
  debugLoginAt,
  localDebugWorkstationUrls,
  probeDebugWorkstation,
  setDebugAutoLoginEnabled,
} from '../../lib/debugAccount'

export function DebugLoginBox({ workstationUrl }: { workstationUrl: string }) {
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const candidates = [workstationUrl, ...(await localDebugWorkstationUrls())].filter(Boolean)
      for (const url of candidates) {
        if (await probeDebugWorkstation(url)) {
          if (alive) setTarget(url)
          return
        }
      }
      if (alive) setTarget(null)
    })()
    return () => {
      alive = false
    }
  }, [workstationUrl])

  if (!target) return null

  const login = async () => {
    setBusy(true)
    setError(null)
    // 主动点调试登录说明想用它：恢复下次启动的自动登录。
    setDebugAutoLoginEnabled(true)
    const ok = await debugLoginAt(target)
    if (!ok) setError('调试账号登录失败：只有在本机回环地址访问调试版工作站时可用。')
    setBusy(false)
  }

  return (
    <div
      data-testid="login-debug"
      className="mb-4 rounded-2xl border border-dashed border-border-strong bg-[var(--t-bg-subtle)] p-3.5"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-text">
        <Bug size={14} /> 调试版
      </div>
      <p className="mt-1 text-[12px] leading-5 text-muted">
        本机回环地址可以一键登录内置的调试账号：自动带上这台电脑和演示主机，不用注册。
      </p>
      <Button
        variant="accent"
        size="lg"
        data-testid="login-debug-button"
        className="mt-2.5 w-full justify-center"
        disabled={busy}
        onClick={() => void login()}
      >
        {busy && <Loader2 size={15} className="animate-spin" />}
        使用调试账号登录
      </Button>
      {error && <p className="mt-2 text-[12px] text-[var(--t-danger)]">{error}</p>}
    </div>
  )
}
