import { useState } from 'react'
import { Loader2, MonitorSmartphone, Plus, Server } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { addThisComputer, canAddThisComputer } from '../../lib/addLocalHost'
import { pageIsLoopback } from '../../lib/localHosts'
import { Button } from '../ui/Button'

/** 登录后账号下还没有主机：不能开会话，引导添加一台主机。 */
export function NoHostsView() {
  const setAddHostOpen = useUiStore((s) => s.setAddHostOpen)
  const toast = useUiStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = canAddThisComputer()

  const addLocal = async () => {
    setBusy(true)
    setError(null)
    try {
      const name = await addThisComputer()
      toast(`已添加主机「${name}」`, 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="no-hosts" className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="anim-slide-up w-full max-w-[420px] text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-surface shadow-[var(--t-shadow-sm)] ring-1 ring-border">
          <Server size={22} className="text-text-soft" />
        </div>
        <h1 className="mt-5 text-[27px] font-medium leading-tight tracking-[-0.01em] md:text-[30px]">
          先添加一台主机
        </h1>
        <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-6 text-muted">
          主机是实际执行任务的机器。账号下还没有主机，所以现在不能新建会话；添加后就能开始。
        </p>
        <div className="mx-auto mt-6 flex max-w-[300px] flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            data-testid="no-hosts-add"
            className="w-full justify-center"
            onClick={() => setAddHostOpen(true)}
          >
            <Plus size={15} /> 添加主机
          </Button>
          {local && (
            <Button
              variant="secondary"
              size="lg"
              data-testid="no-hosts-add-local"
              className="w-full justify-center"
              disabled={busy}
              onClick={() => void addLocal()}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <MonitorSmartphone size={15} />}
              {pageIsLoopback() ? '添加这台电脑' : '添加此页面所在的主机'}
            </Button>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-[12.5px] leading-5 text-[var(--t-danger)]">{error}</p>}
        <p className="mt-5 text-[12px] leading-5 text-muted">
          {local
            ? '在另一台机器上添加：点「添加主机」，复制一行命令到那台机器执行。'
            : '点「添加主机」，复制一行命令到目标机器执行即可，不需要输入主机地址。'}
        </p>
      </div>
    </div>
  )
}
