import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState } from './ui/EmptyState'
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  Brain,
  Check,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  FileDiff,
  FolderGit2,
  Gauge,
  GitBranch,
  GitFork,
  GripVertical,
  Info,
  KeyRound,
  ListTodo,
  Maximize2,
  ScrollText,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import type { MemoryFile, Todo } from '@tandem/protocol'
import { countTurns } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from '../lib/types'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useSessionChanges } from '../lib/useChanges'
import { cn } from '../lib/cn'
import { useCopy } from '../lib/useCopy'
import { api } from '../lib/api'
import { useIsMobile, useNow } from '../lib/hooks'
import { prettyModel } from '../lib/modelName'
import { runningSince } from '../lib/runClock'
import {
  formatCost,
  formatElapsed,
  formatRelative,
  formatTime,
  formatTokens,
} from '../lib/format'
import { PERMISSION_MODE_LABELS } from '../lib/types'
import { quotaLine } from '../lib/quota'
import { stripMemoryMeta } from '../lib/memory'
import { ConnectionDot } from './StatusDot'
import { Markdown } from './Markdown'
import { useContextBreakdown } from './chat/ContextMeter'
import { Modal } from './ui/Modal'
import { Menu } from './ui/Menu'
import { Button, IconButton } from './ui/Button'
import { PanelBody } from './ui/Panel'
import { ResizeHandle } from './ui/ResizeHandle'
import { rememberWikiHost, useWikiStore } from '../store/useWikiStore'

const EMPTY_TODOS: Todo[] = []
const EMPTY_MESSAGES: UiMessage[] = []

const TODO_ICONS = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const
import {
  CHANGE_MARK,
  Card,
  DetailRow,
  GROUP_META,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  loadCollapsedGroups,
  loadPanelWidth,
  saveCollapsedGroups,
  savePanelWidth,
  setPanelAvailability,
  setPanelPrefs,
  usePanelGroups,
  type GroupId,
} from './right-panel/shared'
import { SessionGraphCard } from './sessionGraph/SessionGraphCard'
import { useRightPanelData } from './right-panel/useRightPanelData'
import { cardSummary as renderCardSummary } from './right-panel/CardSummary'
import { PanelActions } from './right-panel/PanelActions'
import { PanelBodyContent } from './right-panel/PanelBodyContent'

export function RightPanel() {
  const {
    isMobile,
    panelWidth,
    setPanelWidth,
    dragWidth,
    setDragWidth,
    sessionId,
    summary,
    todos,
    plan,
    agentCount,
    turnCount,
    forkCount,
    openSettings,
    host,
    hostStatus,
    profileName,
    profilesLoaded,
    profilesLoading,
    setChangesOpen,
    openWiki,
    copied,
    copy,
    prefs,
    planOpen,
    setPlanOpen,
    graphExpanded,
    setGraphExpanded,
    collapsedGroups,
    setCollapsedGroups,
    dragging,
    setDragging,
    handleDownRef,
    lastTargetRef,
    cardRefs,
    positionsRef,
    asideRef,
    visibilityLayoutRef,
    visibleIdsRef,
    orderKeyRef,
    sessionKeyRef,
    mountedRef,
    openMemoryEditor,
    memory,
    memoryLoading,
    memoryPreview,
    completed,
    progress,
    usage,
    reviewUsage,
    subUsage,
    keyUsage,
    fileChanges,
    additions,
    deletions,
    contextData,
    usageHasData,
    memoryHasData,
    wikiEntry,
    wikiHasData,
    hasData,
    visibleGroups,
    visibleKey,
    orderKey,
  } = useRightPanelData()



  useEffect(() => saveCollapsedGroups(collapsedGroups), [collapsedGroups])
  useEffect(() => setPanelAvailability(hasData), [hasData])
  useEffect(() => setGraphExpanded(false), [sessionId])

  const toggleCollapsed = (id: GroupId) =>
    setCollapsedGroups((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id],
    )

  // 收起后的标题行只显示最关键的一行结论（反馈12#07）。
  const cardSummary = (id: GroupId) =>
    renderCardSummary(id, {
      planStatus,
      todos,
      completed,
      agentCount,
      turnCount,
      forkCount,
      usage,
      subUsage,
      contextData,
      fileChanges,
      additions,
      deletions,
      memory,
      wikiEntry,
      summary,
    })

  const capturePositions = () => {
    const map = new Map<GroupId, number>()
    for (const [id, el] of cardRefs.current) map.set(id, el.offsetTop)
    positionsRef.current = map
  }

  useLayoutEffect(() => {
    const before = positionsRef.current
    if (before.size === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) {
      for (const [id, el] of cardRefs.current) {
        const prev = before.get(id)
        if (prev === undefined) continue
        const delta = prev - el.offsetTop
        if (Math.abs(delta) < 1) continue
        el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: 180, easing: 'cubic-bezier(.16,1,.3,1)' },
        )
      }
    }
    positionsRef.current = new Map()
  }, [prefs.order])

  // 反馈9#06：有数据的分组出现时轻量淡入；若用户正滚动在下方，保持滚动锚点，
  // 不因为上方插入卡片把正在看的内容推走。拖动排序交给上面的 FLIP。
  useLayoutEffect(() => {
    const box = asideRef.current?.querySelector<HTMLElement>('[data-panel-body]')
    if (!box) return
    const first = !mountedRef.current
    const sessionChanged = sessionKeyRef.current !== sessionId
    const orderChanged = orderKeyRef.current !== '' && orderKeyRef.current !== orderKey
    const prev = visibilityLayoutRef.current
    const seen = visibleIdsRef.current
    const added: HTMLElement[] = []
    let anchorDelta = 0
    if (!first && !sessionChanged && !orderChanged) {
      let inside: { before: number; el: HTMLElement } | null = null
      for (const id of visibleGroups) {
        const el = cardRefs.current.get(id)
        if (!el) continue
        const before = prev.get(id)
        if (before === undefined) {
          if (!seen.has(id)) added.push(el)
          continue
        }
        if (before >= box.scrollTop - 1) {
          anchorDelta = el.offsetTop - before
          break
        }
        inside = { before, el }
      }
      if (anchorDelta === 0 && inside) anchorDelta = inside.el.offsetTop - inside.before
      if (anchorDelta !== 0 && box.scrollTop > 0) {
        box.scrollTop = Math.max(0, box.scrollTop + anchorDelta)
      }
      if (
        added.length > 0 &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        for (const el of added) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: 'cubic-bezier(.16,1,.3,1)',
          })
        }
      }
    }
    visibilityLayoutRef.current = new Map(
      [...cardRefs.current].map(([id, el]) => [id, el.offsetTop]),
    )
    visibleIdsRef.current = new Set(visibleGroups)
    orderKeyRef.current = orderKey
    sessionKeyRef.current = sessionId
    mountedRef.current = true
  }, [visibleKey, orderKey, sessionId])

  // 卡片内容高度变化（数据增长、展开明细）后刷新基线，下一次插入/删除才只按增量补偿。
  useLayoutEffect(() => {
    visibilityLayoutRef.current = new Map(
      [...cardRefs.current].map(([id, el]) => [id, el.offsetTop]),
    )
  })

  const moveGroup = (from: GroupId, to: GroupId) => {
    if (from === to) return
    capturePositions()
    const order = [...prefs.order]
    const fromIndex = order.indexOf(from)
    const toIndex = order.indexOf(to)
    if (fromIndex < 0 || toIndex < 0) return
    order.splice(fromIndex, 1)
    order.splice(toIndex, 0, from)
    setPanelPrefs({ ...prefs, order })
  }


  const copyCwd = () => {
    if (summary?.cwd) void copy(summary.cwd)
  }


  const planStatus = plan
    ? plan.status === 'approved'
      ? plan.approvalMode === 'acceptEdits'
        ? '已批准 · 自动接受编辑'
        : '已批准 · 逐个询问'
      : plan.status === 'rejected'
        ? '已退回完善'
        : '待批准'
    : ''

  const renderRight = (id: GroupId) => (
    <PanelActions
      id={id}
      planStatus={planStatus}
      agentCount={agentCount}
      todos={todos}
      completed={completed}
      summary={summary}
      setPlanOpen={setPlanOpen}
      setGraphExpanded={setGraphExpanded}
      openMemoryEditor={openMemoryEditor}
      openWiki={openWiki}
      setChangesOpen={setChangesOpen}
    />
  )

  const renderBody = (id: GroupId) => (
    <PanelBodyContent
      id={id}
      memoryLoading={memoryLoading}
      memory={memory}
      memoryPreview={memoryPreview}
      openMemoryEditor={openMemoryEditor}
      plan={plan}
      todos={todos}
      progress={progress}
      usageHasData={usageHasData}
      usage={usage}
      summary={summary}
      subUsage={subUsage}
      reviewUsage={reviewUsage}
      keyUsage={keyUsage}
      fileChanges={fileChanges}
      additions={additions}
      deletions={deletions}
      contextData={contextData}
      profileName={profileName}
      profilesLoaded={profilesLoaded}
      copyCwd={copyCwd}
      copied={copied}
      hostStatus={hostStatus}
      host={host}
      openSettings={openSettings}
    />
  )

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 flex-col border-l border-border bg-sidebar"
      style={{
        width: isMobile ? '100%' : (dragWidth ?? panelWidth),
        transition: dragWidth !== null ? 'none' : undefined,
      }}
    >
      {!isMobile && (
        <ResizeHandle
          value={panelWidth}
          min={PANEL_WIDTH_MIN}
          max={PANEL_WIDTH_MAX}
          edge="left"
          onChange={setDragWidth}
          onCommit={(next) => {
            setPanelWidth(next)
            savePanelWidth(next)
            setDragWidth(null)
          }}
          resetValue={PANEL_WIDTH_DEFAULT}
          label="调整会话信息面板宽度"
        />
      )}

      {graphExpanded ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-7 pt-2" data-graph-full>
          <SessionGraphCard full onBack={() => setGraphExpanded(false)} />
        </div>
      ) : (
      <PanelBody scroll className="space-y-2 p-3"
        style={{ overflowAnchor: 'none', scrollbarGutter: 'stable' }}
        onDragOver={(e) => {
          if (dragging) e.preventDefault()
        }}
      >
        {visibleGroups.map((id) => {
          const meta = GROUP_META[id]
          return (
            <Card
              key={id}
              id={id}
              label={meta.label}
              icon={meta.Icon}
              dragging={dragging === id}
              cardRef={(el) => {
                if (el) cardRefs.current.set(id, el)
                else cardRefs.current.delete(id)
              }}
              onHandleDown={() => {
                handleDownRef.current = true
              }}
              onHandleUp={() => {
                handleDownRef.current = false
              }}
              onDragStart={(e) => {
                if (!handleDownRef.current) {
                  e.preventDefault()
                  return
                }
                setDragging(id)
                lastTargetRef.current = null
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', id)
              }}
              onDragEnd={() => {
                handleDownRef.current = false
                setDragging(null)
                lastTargetRef.current = null
              }}
              onDragOver={(e) => {
                if (!dragging || dragging === id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (lastTargetRef.current === id) return
                lastTargetRef.current = id
                moveGroup(dragging, id)
              }}
              right={renderRight(id)}
              collapsible
              collapsed={collapsedGroups.includes(id)}
              onToggle={() => toggleCollapsed(id)}
              summary={cardSummary(id)}
            >
              {renderBody(id)}
            </Card>
          )
        })}

        {visibleGroups.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] leading-5 text-muted">
            <Info size={15} />
            当前没有可显示的分组；点右上角 ⋯ 勾选要显示的分组（没有数据的分组默认隐藏）。
          </div>
        )}
      </PanelBody>
      )}

      <Modal
        open={planOpen && !!plan}
        onClose={() => setPlanOpen(false)}
        title="当前计划"
        description={plan?.status === 'approved' ? '计划已批准，可随时回看。' : undefined}
        className="max-w-[min(820px,94vw)]"
        bodyClassName="p-5"
        footer={
          <Button size="lg" onClick={() => setPlanOpen(false)}>
            关闭
          </Button>
        }
      >
        {plan && <Markdown text={plan.content} />}
      </Modal>

    </aside>
  )
}

