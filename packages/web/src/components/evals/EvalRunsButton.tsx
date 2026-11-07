import { useEffect } from 'react'
import { FlaskConical } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useEvalStore } from '../../store/useEvalStore'
import { useUiStore } from '../../store/useUiStore'
import { IconButton } from '../ui/Button'

const EMPTY_RUNS: import('@tandem/protocol').EvalRunSummary[] = []

/** 顶栏「评测」：后台运行中的评测进度入口。 */
export function EvalRunsButton() {
  const hosts = useAppStore((state) => state.hosts)
  const activeHostId = useAppStore((state) => state.activeHostId)
  const role = useAppStore((state) =>
    state.activeHostId ? state.runtimes[state.activeHostId]?.team?.role : undefined,
  )
  const host = hosts.find((item) => item.id === activeHostId) ?? hosts[0]
  const runs = useEvalStore((state) => (host ? state.byHost[host.id]?.runs ?? EMPTY_RUNS : EMPTY_RUNS))
  const refreshRuns = useEvalStore((state) => state.refreshRuns)
  const openSettings = useUiStore((state) => state.openSettings)
  const running = runs.filter((run) => run.status === 'running').length

  useEffect(() => {
    if (!host || role !== 'owner') return
    void refreshRuns(host)
    if (running === 0) return
    const timer = window.setInterval(() => void refreshRuns(host), 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, running])

  if (!host || role !== 'owner') return null
  return (
    <IconButton
      onClick={() => openSettings('evals')}
      label="评测"
      tooltip="评测与轨迹回放"
      className="relative text-text! max-sm:size-11"
    >
      <FlaskConical size={16} />
      {running > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex size-[14px] items-center justify-center rounded-full bg-accent-strong text-[9px] font-medium tabular-nums text-on-accent">
          {running > 9 ? '9+' : running}
        </span>
      )}
    </IconButton>
  )
}
