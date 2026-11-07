import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { X } from 'lucide-react'
import type { SessionTarget, SplitLayout } from '../../lib/types'
import { boardIdOfPane, isBoardPane, paneKey } from '../../lib/split'
import { useBoardStore } from '../../store/useBoardStore'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useIsMobile } from '../../lib/hooks'
import { cn } from '../../lib/cn'
import {
  closeSplitPaneAt,
  focusSplitPane,
  openSplitSessionAt,
} from '../../lib/splitActions'
import { ChatView } from '../ChatView'
import { IconButton } from '../ui/Button'
import { SessionScopeProvider } from '../session/SessionScope'
import { BoardView } from '../board/BoardView'

interface AxisItem {
  key: string
  node: ReactNode
}

/** 分屏根：桌面多窗格，手机左右滑动切换。 */
export function SplitWorkspace() {
  const isMobile = useIsMobile()
  const panes = useUiStore((s) => s.splitPanes)
  const layout = useUiStore((s) => s.splitLayout)
  const cols = useUiStore((s) => s.splitCols)
  const rows = useUiStore((s) => s.splitRows)
  const focusedHostId = useAppStore((s) => s.active?.hostId ?? null)
  const focusedSessionId = useAppStore((s) => s.active?.sessionId ?? null)

  useEffect(() => {
    if (panes.length < 2) return
    for (const pane of panes) {
      if (isBoardPane(pane)) continue
      useAppStore.getState().openSessionView(pane.hostId, pane.sessionId)
    }
  }, [panes])

  if (panes.length < 2) return isMobile ? <ChatView /> : <SinglePaneDrop />
  const focusedKey =
    focusedHostId && focusedSessionId ? paneKey(focusedHostId, focusedSessionId) : null
  return isMobile ? (
    <MobileSplitPager panes={panes} focusedKey={focusedKey} />
  ) : (
    <DesktopSplit
      panes={panes}
      layout={layout}
      cols={cols}
      rows={rows}
      focusedKey={focusedKey}
    />
  )
}

function SinglePaneDrop() {
  const [drop, setDrop] = useState<'left' | 'right' | 'bottom' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const zoneAt = (event: React.DragEvent): 'left' | 'right' | 'bottom' => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return 'right'
    const rx = (event.clientX - box.left) / Math.max(1, box.width)
    const ry = (event.clientY - box.top) / Math.max(1, box.height)
    if (ry > 0.6) return 'bottom'
    return rx < 0.5 ? 'left' : 'right'
  }
  return (
    <div
      ref={rootRef}
      data-split-root=""
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('application/x-tandem-split')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDrop(zoneAt(event))
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDrop(null)
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData('application/x-tandem-split')
        setDrop(null)
        if (!raw) return
        event.preventDefault()
        try {
          const target = JSON.parse(raw) as SessionTarget
          if (typeof target.hostId !== 'string' || typeof target.sessionId !== 'string') return
          openSplitSessionAt(target, zoneAt(event))
        } catch {
          // 忽略非会话拖拽
        }
      }}
    >
      <ChatView />
      {drop && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            className={cn(
              'absolute flex items-center justify-center border-2 border-dashed border-[var(--t-accent-strong)] bg-[var(--t-accent-soft)]/25 text-[12px] font-medium text-accent-text backdrop-blur-[1px]',
              drop === 'left' && 'inset-y-0 left-0 w-1/2',
              drop === 'right' && 'inset-y-0 right-0 w-1/2',
              drop === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
            )}
          >
            {drop === 'left' ? '在左侧分屏打开' : drop === 'right' ? '在右侧分屏打开' : '在下方分屏打开'}
          </div>
        </div>
      )}
    </div>
  )
}

function PaneFrame({ pane, focused }: { pane: SessionTarget; focused: boolean }) {
  const key = paneKey(pane.hostId, pane.sessionId)
  const boardId = boardIdOfPane(pane)
  const boardName = useBoardStore((s) =>
    boardId ? s.summaries[pane.hostId]?.find((item) => item.id === boardId)?.name : undefined,
  )
  const summary = useAppStore((s) => s.sessionViews[key]?.summary ?? null)
  const running = useAppStore((s) => s.sessionViews[key]?.running ?? false)
  const status = summary?.status
  const title = summary?.title || '未命名会话'
  const dot =
    status === 'waiting_permission'
      ? 'bg-accent'
      : status === 'error'
        ? 'bg-danger'
        : running || status === 'running' || status === 'retrying'
          ? 'bg-text-secondary running-dot'
          : 'bg-border-strong'

  const focus = () => {
    if (boardId || focused) return
    focusSplitPane(pane)
  }

  if (boardId) {
    return (
      <div
        data-split-pane={key}
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg ring-1 ring-inset ring-border/70"
      >
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/60 px-2 text-[11.5px] text-text-secondary">
          <span className="size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={boardName ?? '任务看板'}>
            任务看板{boardName ? ` · ${boardName}` : ''}
          </span>
          <IconButton
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              closeSplitPaneAt(pane)
            }}
            label="关闭窗格"
            tooltip="关闭窗格 (Ctrl+W)"
            className="size-6! [&_svg]:size-3!"
          >
            <X size={12} />
          </IconButton>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <BoardView route={{ hostId: pane.hostId, boardId }} />
        </div>
      </div>
    )
  }

  return (
    <div
      data-split-pane={key}
      data-focused={focused ? 'true' : undefined}
      onPointerDownCapture={focus}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg ring-1 ring-inset transition-shadow',
        focused
          ? 'z-[1] ring-[var(--t-accent-strong)]'
          : 'ring-border/70 hover:ring-border-strong',
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/60 px-2 text-[11.5px] text-text-secondary">
        <span className={cn('size-1.5 shrink-0 rounded-full', dot)} aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        <IconButton
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            closeSplitPaneAt(pane)
          }}
          label="关闭窗格"
          tooltip="关闭窗格 (Ctrl+W)"
          className="size-6! [&_svg]:size-3!"
        >
          <X size={12} />
        </IconButton>
      </div>
      <SessionScopeProvider target={pane}>
        <ChatView />
      </SessionScopeProvider>
    </div>
  )
}

function SplitAxis({
  axis,
  weights,
  onChange,
  items,
}: {
  axis: 'x' | 'y'
  weights: number[]
  onChange: (weights: number[]) => void
  items: AxisItem[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<number[] | null>(null)
  const latest = useRef<number[] | null>(null)
  const drag = useRef<{
    index: number
    start: number
    weights: number[]
    size: number
  } | null>(null)
  const current = draft ?? weights

  useEffect(() => {
    setDraft(null)
  }, [weights])

  const startDrag = (event: React.PointerEvent, index: number) => {
    if (event.button !== 0) return
    event.preventDefault()
    const box = ref.current
    if (!box) return
    drag.current = {
      index,
      start: axis === 'x' ? event.clientX : event.clientY,
      weights: current.slice(),
      size: axis === 'x' ? box.clientWidth : box.clientHeight,
    }
    const move = (ev: PointerEvent) => {
      const info = drag.current
      if (!info) return
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - info.start
      const pair = info.weights[info.index]! + info.weights[info.index + 1]!
      const min = Math.min(0.35, 220 / Math.max(1, info.size))
      const next = info.weights.slice()
      let left = info.weights[info.index]! + (delta / Math.max(1, info.size)) * pair
      left = Math.max(min, Math.min(pair - min, left))
      next[info.index] = left
      next[info.index + 1] = pair - left
      latest.current = next
      setDraft(next)
    }
    const up = () => {
      const info = drag.current
      const final = latest.current
      drag.current = null
      latest.current = null
      setDraft(null)
      if (info && final && final.some((value, i) => Math.abs(value - info.weights[i]!) > 0.001)) {
        onChange(final)
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={ref}
      className={cn('flex h-full w-full min-h-0 min-w-0', axis === 'y' && 'flex-col')}
    >
      {items.map((item, index) => (
        <Fragment key={item.key}>
          <div
            className="flex min-h-0 min-w-0"
            style={{ flexGrow: current[index] ?? 1, flexBasis: 0 }}
          >
            {item.node}
          </div>
          {index < items.length - 1 && (
            <div
              role="separator"
              data-split-splitter={axis}
              aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
              aria-label="拖动调整窗格大小，双击均分"
              onPointerDown={(event) => startDrag(event, index)}
              onDoubleClick={() => {
                const next = weights.map(() => 1 / weights.length)
                onChange(next)
              }}
              className={cn(
                'group relative z-[2] flex shrink-0 touch-none items-center justify-center bg-border/50 transition-colors hover:bg-[var(--t-accent-strong)]/50',
                axis === 'x' ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize',
                draft && 'bg-[var(--t-accent-strong)]',
              )}
            >
              <span className="pointer-events-none absolute inset-[-4px]" />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}

function DesktopSplit({
  panes,
  layout,
  cols,
  rows,
  focusedKey,
}: {
  panes: SessionTarget[]
  layout: SplitLayout
  cols: number[]
  rows: number[]
  focusedKey: string | null
}) {
  const setSplitColWeights = useUiStore((s) => s.setSplitColWeights)
  const setSplitRowWeights = useUiStore((s) => s.setSplitRowWeights)
  const [drop, setDrop] = useState<'left' | 'right' | 'bottom' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 布局随窗格数量收敛：2 个窗格只会是左右/上下，3 个默认三列，4 个必为 2×2。
  const effectiveLayout: SplitLayout =
    panes.length >= 4
      ? 'grid2x2'
      : panes.length === 3
        ? layout === 'grid2x2'
          ? 'grid2x2'
          : 'cols3'
        : layout === 'rows2'
          ? 'rows2'
          : 'cols2'

  const frame = (pane: SessionTarget) => {
    const key = paneKey(pane.hostId, pane.sessionId)
    return <PaneFrame key={key} pane={pane} focused={key === focusedKey} />
  }
  const axisItems = (list: SessionTarget[]): AxisItem[] =>
    list.map((pane) => ({
      key: paneKey(pane.hostId, pane.sessionId),
      node: frame(pane),
    }))

  const zoneAt = (event: React.DragEvent): 'left' | 'right' | 'bottom' => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return 'right'
    const rx = (event.clientX - box.left) / Math.max(1, box.width)
    const ry = (event.clientY - box.top) / Math.max(1, box.height)
    if (ry > 0.6) return 'bottom'
    return rx < 0.5 ? 'left' : 'right'
  }

  let content: ReactNode
  if (effectiveLayout === 'cols3' && panes.length >= 3) {
    content = (
      <SplitAxis axis="x" weights={cols} onChange={setSplitColWeights} items={axisItems(panes.slice(0, 3))} />
    )
  } else if (effectiveLayout === 'rows2' && panes.length === 2) {
    content = (
      <SplitAxis axis="y" weights={rows} onChange={setSplitRowWeights} items={axisItems(panes)} />
    )
  } else if (effectiveLayout === 'grid2x2' && panes.length >= 3) {
    const top = panes.slice(0, 2)
    const bottom = panes.slice(2, 4)
    content = (
      <SplitAxis
        axis="y"
        weights={rows}
        onChange={setSplitRowWeights}
        items={[
          { key: 'grid-top', node: <SplitAxis axis="x" weights={cols} onChange={setSplitColWeights} items={axisItems(top)} /> },
          {
            key: 'grid-bottom',
            node:
              bottom.length > 1 ? (
                <SplitAxis axis="x" weights={cols} onChange={setSplitColWeights} items={axisItems(bottom)} />
              ) : (
                frame(bottom[0]!)
              ),
          },
        ]}
      />
    )
  } else {
    content = (
      <SplitAxis
        axis="x"
        weights={panes.length === 2 ? [cols[0] ?? 0.5, cols[1] ?? 0.5] : cols}
        onChange={setSplitColWeights}
        items={axisItems(panes.slice(0, effectiveLayout === 'cols2' ? 2 : 3))}
      />
    )
  }

  return (
    <div
      ref={rootRef}
      data-split-root=""
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-border/40"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('application/x-tandem-split')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDrop(zoneAt(event))
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDrop(null)
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData('application/x-tandem-split')
        setDrop(null)
        if (!raw) return
        event.preventDefault()
        try {
          const parsed = JSON.parse(raw) as SessionTarget
          if (typeof parsed.hostId !== 'string' || typeof parsed.sessionId !== 'string') return
          openSplitSessionAt(parsed, zoneAt(event))
        } catch {
          // 忽略非会话拖拽
        }
      }}
    >
      {content}
      {drop && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            className={cn(
              'absolute flex items-center justify-center border-2 border-dashed border-[var(--t-accent-strong)] bg-[var(--t-accent-soft)]/25 text-[12px] font-medium text-accent-text backdrop-blur-[1px]',
              drop === 'left' && 'inset-y-0 left-0 w-1/2',
              drop === 'right' && 'inset-y-0 right-0 w-1/2',
              drop === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
            )}
          >
            {drop === 'left' ? '在左侧分屏打开' : drop === 'right' ? '在右侧分屏打开' : '在下方分屏打开'}
          </div>
        </div>
      )}
    </div>
  )
}

function MobileSplitPager({
  panes,
  focusedKey,
}: {
  panes: SessionTarget[]
  focusedKey: string | null
}) {
  const current = Math.max(
    0,
    panes.findIndex((pane) => paneKey(pane.hostId, pane.sessionId) === focusedKey),
  )
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; locked: boolean | null; dx: number } | null>(null)
  const swipedRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const goTo = (index: number) => {
    const target = panes[Math.max(0, Math.min(panes.length - 1, index))]
    if (!target) return
    setDragX(0)
    setDragging(false)
    focusSplitPane(target)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex h-8 shrink-0 items-center justify-center border-b border-border/60">
        <div role="tablist" aria-label="分屏会话切换" className="flex items-center gap-2">
          {panes.map((pane, index) => (
            <button
              key={paneKey(pane.hostId, pane.sessionId)}
              type="button"
              role="tab"
              aria-selected={index === current}
              aria-label={`第 ${index + 1} 个会话，共 ${panes.length} 个`}
              onClick={() => goTo(index)}
              className="flex size-6 items-center justify-center rounded-full"
            >
              <span
                className={cn(
                  'rounded-full transition-all duration-150',
                  index === current
                    ? 'size-2 bg-[var(--t-accent-strong)]'
                    : 'size-1.5 bg-border-strong',
                )}
              />
            </button>
          ))}
        </div>
        <IconButton
          size="sm"
          onClick={() => closeSplitPaneAt(panes[current]!)}
          label="关闭当前窗格"
          tooltip="关闭当前窗格"
          className="absolute right-1 size-7! [&_svg]:size-3.5!"
        >
          <X size={13} />
        </IconButton>
      </div>
      <div
        ref={rootRef}
        data-split-pager=""
        className="relative min-h-0 flex-1 touch-pan-y overflow-hidden"
        onTouchStart={(event) => {
          if (event.touches.length !== 1) return
          const target = event.target as HTMLElement | null
          if (
            target?.closest(
              'input, textarea, select, [contenteditable="true"], .overflow-x-auto, [data-no-split-swipe]',
            )
          ) {
            start.current = null
            return
          }
          const touch = event.touches[0]!
          start.current = { x: touch.clientX, y: touch.clientY, locked: null, dx: 0 }
        }}
        onTouchMove={(event) => {
          const info = start.current
          if (!info) return
          const touch = event.touches[0]
          if (!touch) return
          const dx = touch.clientX - info.x
          const dy = touch.clientY - info.y
          if (info.locked === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
            info.locked = Math.abs(dx) > Math.abs(dy) * 1.2
            if (!info.locked) {
              start.current = null
              return
            }
            setDragging(true)
          }
          if (!info.locked) return
          info.dx = dx
          const resisted =
            (current === 0 && dx > 0) || (current === panes.length - 1 && dx < 0)
              ? dx * 0.32
              : dx
          setDragX(resisted)
        }}
        onClickCapture={(event) => {
          if (!swipedRef.current) return
          swipedRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }}
        onTouchEnd={() => {
          const info = start.current
          start.current = null
          setDragging(false)
          if (!info?.locked) {
            setDragX(0)
            return
          }
          const threshold = Math.min(72, (rootRef.current?.clientWidth ?? 320) * 0.18)
          if (Math.abs(info.dx) > threshold) {
            swipedRef.current = true
            window.setTimeout(() => {
              swipedRef.current = false
            }, 350)
          }
          if (info.dx < -threshold) goTo(current + 1)
          else if (info.dx > threshold) goTo(current - 1)
          else setDragX(0)
        }}
        onTouchCancel={() => {
          start.current = null
          setDragging(false)
          setDragX(0)
        }}
      >
        <div
          className="flex h-full"
          style={{
            width: `${panes.length * 100}%`,
            transform: `translateX(calc(${(-current * 100) / panes.length}% + ${dragX}px))`,
            transition: dragging ? 'none' : 'transform 220ms var(--t-ease-out)',
          }}
        >
          {panes.map((pane) => {
            const boardId = boardIdOfPane(pane)
            return (
              <div
                key={paneKey(pane.hostId, pane.sessionId)}
                className="flex h-full min-w-0 flex-col"
                style={{ width: `${100 / panes.length}%` }}
              >
                {boardId ? (
                  <BoardView route={{ hostId: pane.hostId, boardId }} />
                ) : (
                  <SessionScopeProvider target={pane}>
                    <ChatView />
                  </SessionScopeProvider>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        第 {current + 1} 个会话，共 {panes.length} 个
      </div>
    </div>
  )
}
