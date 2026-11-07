import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Square, SquareTerminal } from 'lucide-react'
import type { BackgroundTask } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useTaskStore } from '../store/useTaskStore'
import { useUiStore } from '../store/useUiStore'
import { useNow } from '../lib/hooks'
import { formatElapsed, firstLine } from '../lib/format'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

const EMPTY_TASKS: BackgroundTask[] = []
const EMPTY_OUTPUTS: Record<string, { text: string; since: number; truncated?: boolean }> = {}

const STATUS_LABEL: Record<BackgroundTask['status'], string> = {
  running: '运行中',
  exited: '已结束',
  killed: '已终止',
  lost: '已丢失',
}

const STATUS_STYLE: Record<BackgroundTask['status'], string> = {
  running: 'bg-text-secondary/90',
  exited: 'bg-success',
  killed: 'bg-text-tertiary/50',
  lost: 'bg-warning',
}

function statusText(task: BackgroundTask): string {
  if (task.status === 'exited') {
    return task.exitCode === undefined ? '已结束' : `已结束 · 退出码 ${task.exitCode}`
  }
  return STATUS_LABEL[task.status]
}

/** 后台任务面板：列表 + 实时输出（可暂停跟随）+ 终止。 */
export function BackgroundTasksPanel() {
  const panel = useUiStore((s) => s.backgroundPanel)
  const close = useUiStore((s) => s.closeBackgroundTasks)
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === panel?.hostId)
  const tasks = useTaskStore((s) => (panel ? s.byHost[panel.hostId] ?? EMPTY_TASKS : EMPTY_TASKS))
  const outputs = useTaskStore((s) => (panel ? s.outputs[panel.hostId] ?? EMPTY_OUTPUTS : EMPTY_OUTPUTS))
  const refresh = useTaskStore((s) => s.refresh)
  const loadOutput = useTaskStore((s) => s.loadOutput)
  const kill = useTaskStore((s) => s.kill)
  const [selected, setSelected] = useState<string | undefined>(panel?.taskId)
  const [follow, setFollow] = useState(true)
  const [killedBusy, setKilledBusy] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  const visible = useMemo(
    () => tasks.filter((task) => !panel || task.sessionId === panel.sessionId),
    [tasks, panel],
  )
  const current = visible.find((task) => task.id === selected) ?? visible[0]
  const output = current ? outputs[current.id] : undefined
  const now = useNow(visible.some((task) => task.status === 'running'))

  useEffect(() => {
    if (!panel) return
    setSelected(panel.taskId)
    if (!host) return
    void refresh(host)
  }, [panel?.sessionId, panel?.taskId, host?.id])

  // 打开或切换任务时拉取全量输出
  useEffect(() => {
    if (!panel || !host || !current) return
    const existing = outputs[current.id]
    void loadOutput(host, current.id, existing?.since ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, host?.id])

  // 轮询兜底：WS 断线时仍能看到新输出
  useEffect(() => {
    if (!panel || !host || !current || current.status !== 'running') return
    const timer = window.setInterval(() => {
      void refresh(host)
      const existing = useTaskStore.getState().outputs[host.id]?.[current.id]
      void loadOutput(host, current.id, existing?.since ?? 0)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [panel?.sessionId, host?.id, current?.id, current?.status])

  useEffect(() => {
    if (!follow) return
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output?.text, follow])

  if (!panel || !host) return null

  const killCurrent = async () => {
    if (!current || current.status !== 'running' || killedBusy) return
    setKilledBusy(true)
    await kill(host, current.id)
    setKilledBusy(false)
  }

  return (
    <Modal
      open
      onClose={close}
      ariaLabel="后台任务"
      title={
        <span className="flex items-center gap-2">
          <SquareTerminal size={14} className="text-muted" />
          后台任务
        </span>
      }
      className="h-[clamp(440px,72vh,760px)] w-[min(94vw,980px)] max-w-none max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <div className="flex h-[38%] w-full shrink-0 flex-col border-b border-border sm:h-auto sm:w-[280px] sm:border-b-0 sm:border-r">
          <div className="flex items-center gap-1 px-3 py-2 text-[12px] font-medium text-text-tertiary">
            <span>本会话</span>
            <span className="ml-auto tabular-nums">{visible.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {visible.length === 0 ? (
              <p className="px-2.5 py-3 text-[12.5px] leading-5 text-muted">
                没有后台任务。agent 在后台运行命令（例如跑测试、起服务）时会出现在这里。
              </p>
            ) : (
              visible.map((task) => {
                const active = task.id === current?.id
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelected(task.id)}
                    className={cn(
                      'mb-0.5 flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors duration-[80ms]',
                      active ? 'bg-[var(--t-bg-active)] text-text' : 'text-text-soft hover:bg-[var(--t-bg-hover)]',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_STYLE[task.status], task.status === 'running' && 'running-dot')} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                        {firstLine(task.command, 80) || task.id}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 pl-3.5 text-[11px] text-muted">
                      <span>{statusText(task)}</span>
                      <span className="ml-auto tabular-nums">
                        {formatElapsed((task.endedAt ?? now) - task.startedAt)}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <span className={cn('size-2 shrink-0 rounded-full', STATUS_STYLE[current.status], current.status === 'running' && 'running-dot')} />
                <span className="text-[12.5px] font-medium text-text">{statusText(current)}</span>
                <span className="font-mono text-[11px] text-muted">{current.id}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFollow((v) => !v)}
                    icon={follow ? <Pause size={13} /> : <Play size={13} />}
                    tooltip={follow ? '暂停自动滚动' : '恢复自动滚动'}
                    className="max-sm:h-11"
                  >
                    {follow ? '跟随中' : '已暂停'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={current.status !== 'running' || killedBusy}
                    onClick={() => void killCurrent()}
                    icon={<Square size={12} />}
                    className="max-sm:h-11"
                  >
                    终止
                  </Button>
                </span>
              </div>
              <div className="border-b border-border px-3 py-2">
                <div className="break-all font-mono text-[12px] leading-5 text-text">{current.command}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  <span title={new Date(current.startedAt).toLocaleString()}>
                    开始 {new Date(current.startedAt).toLocaleTimeString()}
                  </span>
                  <span>{current.cwd}</span>
                </div>
              </div>
              <div className="relative min-h-0 flex-1 bg-[color-mix(in_srgb,var(--t-bg)_55%,transparent)]">
                <pre
                  ref={outputRef}
                  className="h-full overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-[1.65] text-text"
                >
                  {output?.text || (current.status === 'running' ? '等待输出…' : '(无输出)')}
                </pre>
                {output?.truncated && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 bg-[var(--t-bg-hover)] px-3 py-1 text-[11px] text-text-soft">
                    较早输出已超出 1MB 缓冲，仅显示最近部分
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <SquareTerminal size={22} className="text-muted" />
              <p className="text-[12.5px] text-muted">选择左侧任务查看输出</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** 顶栏按钮的角标：本会话运行中的后台任务数（由调用方传入）。 */
export function backgroundTaskBadge(tasks: BackgroundTask[], sessionId?: string): number {
  return tasks.filter(
    (task) => task.status === 'running' && (!sessionId || task.sessionId === sessionId),
  ).length
}

