import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, GitMerge, GitPullRequest, Kanban, MoreHorizontal, Plus, Settings, Sparkles } from 'lucide-react'
import type { Board, BoardCard, BoardCardAction, BoardCardStatus, BoardSummary, PrState } from '@tandem/protocol'
import { api } from '../../lib/api'
import { COLUMNS, MOBILE_GROUPS, boardCost, cardsOf, formatUsd, planDrop } from '../../lib/board'
import { navigateBoard, type BoardRoute } from '../../lib/boardRoute'
import { cn } from '../../lib/cn'
import { nodeContains } from '../../lib/overlay'
import { useIsMobile } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { boardKey, useBoardPolling, useBoardStore } from '../../store/useBoardStore'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Controls'
import { Menu } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { BoardCardItem } from './BoardCardItem'
import { CardActionBar, CardDetail, CardDrawerHeader, type CardActions } from './BoardDrawer'
import { CardChecksDialog } from './CardChecksDialog'
import { CardDiffDialog } from './CardDiffDialog'
import { MergeConfirmDialog } from './MergeConfirmDialog'
import { BoardPrDialog, BoardSettingsDialog, CardEditorDialog, ConfirmDialog, CreateBoardDialog, NoteDialog, PlanDialog } from './BoardDialogs'

const NO_BOARDS: BoardSummary[] = []

const PR_LABEL: Record<PrState, string> = {
  OPEN: '开放',
  DRAFT: '草稿',
  MERGED: '已合并',
  CLOSED: '已关闭',
  UNKNOWN: '未知',
}

function prChecksText(state: Board['pr']): string | undefined {
  if (!state || state.checksState === 'none' || !state.checksState) return undefined
  if (state.checksState === 'success') return 'CI 通过'
  if (state.checksState === 'failure') return 'CI 失败'
  if (state.checksState === 'pending') return 'CI 运行中'
  return 'CI 未知'
}

export function BoardView({ route }: { route: BoardRoute }) {
  const isMobile = useIsMobile()
  const host = useAppStore((s) => s.hosts.find((h) => h.id === route.hostId) ?? null)
  const profiles = useAppStore((s) => s.runtimes[route.hostId]?.profiles)
  const toast = useUiStore((s) => s.toast)
  const summaries = useBoardStore((s) => s.summaries[route.hostId])
  const loaded = useBoardStore((s) => !!s.loaded[route.hostId])
  const board = useBoardStore((s) => (route.boardId ? s.boards[boardKey(route.hostId, route.boardId)] : undefined))
  const applyBoard = useBoardStore((s) => s.applyBoard)
  const refreshBoard = useBoardStore((s) => s.refreshBoard)
  const refreshList = useBoardStore((s) => s.refreshList)
  const forget = useBoardStore((s) => s.forget)

  useBoardPolling(host, route.boardId)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editor, setEditor] = useState<{ card?: BoardCard } | null>(null)
  const [planning, setPlanning] = useState(false)
  const [rejecting, setRejecting] = useState<BoardCard | null>(null)
  const [deleting, setDeleting] = useState<BoardCard | null>(null)
  const [deletingBoard, setDeletingBoard] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 合并确认：cardId 给出时只合并这一张；缺省合并全部已完成卡。 */
  const [mergeTarget, setMergeTarget] = useState<{ cardId?: string } | null>(null)
  const [diffCard, setDiffCard] = useState<BoardCard | null>(null)
  const [checksCard, setChecksCard] = useState<BoardCard | null>(null)
  const openBoardSplit = useUiStore((s) => s.openBoardSplit)

  const list = summaries ?? NO_BOARDS
  const firstId = list[0]?.id
  // 没指定看板（或指定的已被删除）时跳到第一块；列表为空则显示空态
  useEffect(() => {
    if (!loaded) return
    if (!route.boardId && firstId) navigateBoard(route.hostId, firstId)
    else if (route.boardId && !list.some((item) => item.id === route.boardId)) navigateBoard(route.hostId, firstId)
  }, [loaded, route.hostId, route.boardId, firstId, list])

  useEffect(() => setSelectedId(null), [route.boardId])

  const reload = useCallback(async () => {
    if (!host) return
    if (route.boardId) await refreshBoard(host, route.boardId)
    await refreshList(host)
  }, [host, route.boardId, refreshBoard, refreshList])

  const fail = useCallback((err: unknown) => toast(err instanceof Error ? err.message : '操作失败', 'error'), [toast])

  const selected = board?.cards.find((c) => c.id === selectedId) ?? null

  const act = useCallback(
    async (card: BoardCard, action: BoardCardAction, extra: { note?: string } = {}) => {
      if (!host || !board) return
      try {
        await api.boardCardAction(host, board.id, card.id, action, extra)
      } catch (err) {
        fail(err)
      }
      await reload()
    },
    [host, board, reload, fail],
  )

  const actions: CardActions | null = useMemo(() => {
    if (!host || !board) return null
    return {
      start: (c) => void act(c, 'start'),
      unqueue: (c) => void act(c, 'unqueue'),
      stop: (c) => void act(c, 'stop'),
      retry: (c) => void act(c, 'retry'),
      approve: (c) => void act(c, 'approve'),
      reject: (c) => setRejecting(c),
      merge: (c) => setMergeTarget({ cardId: c.id }),
      viewDiff: (c) => setDiffCard(c),
      viewChecks: (c) => setChecksCard(c),
      openSession: (c) => {
        if (c.sessionId) navigate({ kind: 'session', hostId: host.id, sessionId: c.sessionId })
      },
      openSplit: (c) => {
        if (!c.sessionId) return
        if (isMobile) {
          navigate({ kind: 'session', hostId: host.id, sessionId: c.sessionId })
          return
        }
        openBoardSplit(host.id, board.id, c.sessionId)
        navigate({ kind: 'session', hostId: host.id, sessionId: c.sessionId })
      },
      resolveConflicts: (c) => void act(c, 'resolve'),
      fixReview: (c, note) => void act(c, 'reject', { note }),
      edit: (c) => setEditor({ card: c }),
      remove: (c) => setDeleting(c),
    }
  }, [host, board, act, reload, fail, toast, isMobile, openBoardSplit])

  if (!host) return <div className="flex flex-1 items-center justify-center text-[13px] text-muted">主机不存在</div>

  const createDialog = (
    <CreateBoardDialog
      open={creating}
      host={host}
      profiles={profiles ?? []}
      onClose={() => setCreating(false)}
      onCreated={(created) => {
        applyBoard(host.id, created)
        void refreshList(host)
        navigateBoard(host.id, created.id)
      }}
    />
  )

  // ---------- 空态 ----------
  if (loaded && list.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="board-empty">
        <Kanban size={28} aria-hidden className="text-text-tertiary" />
        <h1 className="font-serif text-[22px] text-text">任务看板</h1>
        <p className="max-w-[420px] text-[13px] leading-relaxed text-text-secondary">
          把一个目标拆成多张卡并行做：卡与卡可以有依赖，关键卡完成后要你确认才放行下游，花费与并发都有上限。
        </p>
        <Button size="lg" variant="primary" onClick={() => setCreating(true)}>
          创建看板
        </Button>
        {createDialog}
      </div>
    )
  }
  if (!board || !actions) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-muted">{loaded ? '看板加载中…' : '加载中…'}</div>
  }

  const done = board.cards.filter((c) => c.status === 'done').length
  const progress = `${done}/${board.cards.length} 完成 · ${formatUsd(boardCost(board))}`

  const changeParallel = async (value: string) => {
    try {
      applyBoard(host.id, await api.updateBoard(host, board.id, { maxParallel: Number(value) }))
    } catch (err) {
      fail(err)
    }
  }

  /** 确认后执行合并：单卡走卡片动作，多卡按依赖顺序批量合并。 */
  const runMerge = async (ids: string[]) => {
    try {
      if (ids.length === 1) {
        const done = await api.boardCardAction(host, board.id, ids[0]!, 'merge')
        if (done.result?.mergeError) toast(`合并失败：${done.result.mergeError}`, 'error')
        else toast(`已合并到 ${board.baseBranch ?? '基准分支'}`, 'success')
      } else {
        const res = await api.mergeBoardAll(host, board.id)
        if (res.failed.length > 0) toast(`已合并 ${res.merged.length} 张；失败：${res.failed[0]!.error}`, 'error')
        else toast(`已按依赖顺序合并 ${res.merged.length} 张卡`, 'success')
      }
    } catch (err) {
      fail(err)
    }
    await reload()
  }

  const boardMenu = (
    <Menu
      aria-label="看板菜单"
      align="start"
      trigger={
        <Button variant="ghost" icon={<Kanban />} className="max-w-[240px] text-[14px] font-semibold text-text">
          <span className="truncate">{board.name}</span>
          <ChevronDown size={14} aria-hidden className="text-muted" />
        </Button>
      }
    >
      {list.length > 1 && (
        <>
          <Menu.RadioGroup value={board.id} onValueChange={(id) => navigateBoard(host.id, id)}>
            {list.map((item) => (
              <Menu.RadioItem key={item.id} value={item.id}>
                {item.name}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator />
        </>
      )}
      <Menu.Item onSelect={() => setCreating(true)}>新建看板…</Menu.Item>
      <Menu.Item onSelect={() => setSettingsOpen(true)}>看板设置…</Menu.Item>
      <Menu.Item onSelect={() => setMergeTarget({})}>按依赖顺序合并全部已完成卡</Menu.Item>
      <Menu.Item onSelect={() => setPrOpen(true)}>开 PR…</Menu.Item>
      <Menu.Separator />
      <Menu.Item danger onSelect={() => setDeletingBoard(true)}>
        删除看板…
      </Menu.Item>
    </Menu>
  )

  const parallelSelect = (
    <Select aria-label="并发上限" size="sm" value={String(board.maxParallel)} onChange={(e) => void changeParallel(e.target.value)} wrapperClassName="w-[104px]">
      {[1, 2, 3, 4].map((n) => (
        <option key={n} value={String(n)}>
          {`并发 ${n}`}
        </option>
      ))}
    </Select>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="board-view">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
          {boardMenu}
          {!isMobile && (
            <span className="text-[12px] text-text-tertiary" data-testid="board-progress">
              {progress}
            </span>
          )}
          {!isMobile && board.pr?.url ? (
            <a
              href={board.pr.url}
              target="_blank"
              rel="noreferrer"
              data-testid="board-pr-status"
              className="inline-flex min-w-0 items-center gap-1 text-[12px] text-text-secondary hover:text-text"
            >
              <GitPullRequest size={12} aria-hidden />
              <span className="truncate">
                PR{board.pr.number ? ` #${board.pr.number}` : ''} · {board.pr.state ? PR_LABEL[board.pr.state] : '已创建'}
                {prChecksText(board.pr) ? ` · ${prChecksText(board.pr)}` : ''}
              </span>
            </a>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            {!isMobile && parallelSelect}
            {!isMobile && (
              <Button icon={<GitMerge />} onClick={() => setMergeTarget({})} data-testid="board-merge-all">
                合并
              </Button>
            )}
            {!isMobile && (
              <Button icon={<GitPullRequest />} onClick={() => setPrOpen(true)}>
                开 PR
              </Button>
            )}
            {!isMobile && (
              <Button icon={<Sparkles />} onClick={() => setPlanning(true)}>
                AI 拆分
              </Button>
            )}
            {!isMobile && (
              <Button variant="primary" icon={<Plus />} onClick={() => setEditor({})}>
                新建卡片
              </Button>
            )}
            {isMobile && (
              <>
                <IconButton label="AI 拆分" onClick={() => setPlanning(true)}>
                  <Sparkles />
                </IconButton>
                <IconButton label="新建卡片" onClick={() => setEditor({})}>
                  <Plus />
                </IconButton>
                <Menu
                  aria-label="更多"
                  align="end"
                  trigger={
                    <IconButton label="更多">
                      <MoreHorizontal />
                    </IconButton>
                  }
                >
                  <Menu.Item onSelect={() => void changeParallel(String((board.maxParallel % 4) + 1))}>
                    并发上限：{board.maxParallel}（点击切换）
                  </Menu.Item>
                  <Menu.Item onSelect={() => setSettingsOpen(true)}>看板设置…</Menu.Item>
                  <Menu.Item onSelect={() => setPrOpen(true)}>开 PR…</Menu.Item>
                  <Menu.Item onSelect={() => setMergeTarget({})}>按依赖顺序合并全部已完成卡</Menu.Item>
                </Menu>
              </>
            )}
          </div>
          {isMobile && (
            <span className="w-full text-[12px] text-text-tertiary" data-testid="board-progress">
              {progress}
              {board.pr?.url ? (
                <a
                  href={board.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1.5 text-text-secondary hover:text-text"
                  data-testid="board-pr-status"
                >
                  · PR{board.pr.number ? ` #${board.pr.number}` : ''} · {board.pr.state ? PR_LABEL[board.pr.state] : '已创建'}
                  {prChecksText(board.pr) ? ` · ${prChecksText(board.pr)}` : ''}
                </a>
              ) : null}
            </span>
          )}
        </header>

        {board.cards.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-[380px] text-[13px] leading-relaxed text-text-secondary">看板还是空的。写一句目标让协调者拆成卡片草稿，或手动新建第一张卡。</p>
            <div className="flex gap-2">
              <Button icon={<Sparkles />} onClick={() => setPlanning(true)}>
                AI 拆分
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setEditor({})}>
                新建卡片
              </Button>
            </div>
          </div>
        ) : isMobile ? (
          <BoardList board={board} actions={actions} onOpen={(c) => setSelectedId(c.id)} />
        ) : (
          <BoardColumns
            board={board}
            selectedId={selectedId}
            onOpen={(c) => setSelectedId(c.id)}
            onDrop={async (card, to, beforeId) => {
              const plan = planDrop(card.status, to)
              if (!plan) return
              if (plan.kind === 'action') {
                if (plan.needsNote) {
                  setRejecting(card)
                  return
                }
                await act(card, plan.action)
                if (beforeId !== undefined) await api.moveBoardCard(host, board.id, card.id, beforeId).catch(fail)
              } else {
                try {
                  applyBoard(host.id, await api.moveBoardCard(host, board.id, card.id, beforeId ?? null))
                } catch (err) {
                  fail(err)
                }
              }
              await reload()
            }}
          />
        )}
      </div>

      {!isMobile && selected && (
        <aside aria-label="卡片详情" className="flex min-h-0 w-[420px] shrink-0 flex-col border-l border-border bg-bg" data-testid="board-drawer">
          <CardDrawerHeader card={selected} onClose={() => setSelectedId(null)} />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <CardDetail card={selected} board={board} actions={actions} />
          </div>
        </aside>
      )}
      {isMobile && (
        <Modal
          open={!!selected}
          onClose={() => setSelectedId(null)}
          ariaLabel="卡片详情"
          title={selected?.title}
          className="max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {selected ? <CardDetail card={selected} board={board} actions={actions} /> : null}
        </Modal>
      )}

      {createDialog}
      <CardEditorDialog
        open={!!editor}
        host={host}
        board={board}
        card={editor?.card}
        onClose={() => setEditor(null)}
        onSaved={() => void reload()}
      />
      <PlanDialog
        open={planning}
        host={host}
        board={board}
        onClose={() => setPlanning(false)}
        onCreated={(count) => {
          toast(`已创建 ${count} 张卡到待办`, 'success')
          void reload()
        }}
      />
      <NoteDialog
        open={!!rejecting}
        title="打回并写意见"
        label="告诉 agent 哪里需要改（可留空）"
        confirmLabel="打回重做"
        onClose={() => setRejecting(null)}
        onConfirm={(note) => {
          const card = rejecting
          setRejecting(null)
          if (card) void act(card, 'reject', { note })
        }}
      />
      <BoardSettingsDialog
        open={settingsOpen}
        host={host}
        board={board}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void reload()}
      />
      <BoardPrDialog
        open={prOpen}
        host={host}
        board={board}
        onClose={() => setPrOpen(false)}
        onCreated={(url) => {
          toast(url ? 'PR 已创建，看板顶部会显示状态与 CI' : 'PR 已创建', 'success')
          void reload()
        }}
      />
      <MergeConfirmDialog
        open={!!mergeTarget}
        host={host}
        board={board}
        {...(mergeTarget?.cardId ? { cardId: mergeTarget.cardId } : {})}
        onClose={() => setMergeTarget(null)}
        onConfirm={runMerge}
      />
      <CardDiffDialog
        open={!!diffCard}
        host={host}
        boardId={board.id}
        cardId={diffCard?.id ?? ''}
        title={diffCard?.title}
        onClose={() => setDiffCard(null)}
      />
      <CardChecksDialog
        open={!!checksCard}
        host={host}
        boardId={board.id}
        cardId={checksCard?.id ?? ''}
        title={checksCard?.title}
        onClose={() => setChecksCard(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="删除卡片"
        body={`删除「${deleting?.title ?? ''}」会一并删除它的会话与 worktree（未合并的改动会丢失），其他卡对它的依赖也会移除。`}
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const card = deleting
          setDeleting(null)
          if (!card) return
          try {
            await api.deleteBoardCard(host, board.id, card.id)
            if (selectedId === card.id) setSelectedId(null)
          } catch (err) {
            fail(err)
          }
          await reload()
        }}
      />
      <ConfirmDialog
        open={deletingBoard}
        title="删除看板"
        body={`删除看板「${board.name}」不会删除卡片会话与 worktree，它们会作为普通会话保留；运行中的卡会被停止。`}
        confirmLabel="删除看板"
        onClose={() => setDeletingBoard(false)}
        onConfirm={async () => {
          setDeletingBoard(false)
          try {
            await api.deleteBoard(host, board.id)
            forget(host.id, board.id)
            await refreshList(host)
            navigateBoard(host.id)
          } catch (err) {
            fail(err)
          }
        }}
      />
    </div>
  )
}

// ---------- 桌面：七列 ----------

function BoardColumns({
  board,
  selectedId,
  onOpen,
  onDrop,
}: {
  board: Board
  selectedId: string | null
  onOpen: (card: BoardCard) => void
  onDrop: (card: BoardCard, to: BoardCardStatus, beforeId: string | null | undefined) => Promise<void>
}) {
  const [drag, setDrag] = useState<BoardCard | null>(null)
  const [over, setOver] = useState<{ status: BoardCardStatus; beforeId: string | null } | null>(null)
  const listRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const insertionOf = (status: BoardCardStatus, clientY: number): string | null => {
    const container = listRefs.current[status]
    if (!container) return null
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-card-id]')).filter((n) => n.dataset.cardId !== drag?.id)
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return node.dataset.cardId ?? null
    }
    return null
  }

  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 pb-3" data-testid="board-columns">
      {COLUMNS.map((column) => {
        const cards = cardsOf(board, column.status)
        const valid = !!drag && !!planDrop(drag.status, column.status)
        const active = over?.status === column.status && valid
        return (
          <section
            key={column.status}
            aria-label={`${column.label}列`}
            data-column={column.status}
            onDragOver={(e) => {
              if (!drag || !valid) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const beforeId = insertionOf(column.status, e.clientY)
              setOver((cur) => (cur?.status === column.status && cur.beforeId === beforeId ? cur : { status: column.status, beforeId }))
            }}
            onDragLeave={(e) => {
              if (!nodeContains(e.currentTarget, e.relatedTarget)) setOver((cur) => (cur?.status === column.status ? null : cur))
            }}
            onDrop={(e) => {
              if (!drag || !valid) return
              e.preventDefault()
              const beforeId = insertionOf(column.status, e.clientY)
              const card = drag
              setDrag(null)
              setOver(null)
              void onDrop(card, column.status, beforeId)
            }}
            className={cn(
              'flex min-h-0 w-[236px] min-w-[236px] max-w-[380px] flex-1 flex-col rounded-xl bg-[var(--t-surface-2)]/60 transition-[opacity,box-shadow] duration-[120ms]',
              drag && !valid && 'opacity-50',
              active && 'ring-1 ring-border-strong',
            )}
          >
            <h2 className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[13px] font-medium text-text-secondary" data-tip={column.hint}>
              {column.status === 'approval' && cards.length > 0 ? <span aria-hidden className="size-1.5 rounded-full bg-accent" /> : null}
              {column.label}
              <span className="text-[12px] font-normal tabular-nums text-text-tertiary">{cards.length}</span>
            </h2>
            <div
              ref={(el) => {
                listRefs.current[column.status] = el
              }}
              className="flex min-h-[40px] flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2"
            >
              {cards.map((card) => (
                <div key={card.id}>
                  {active && over?.beforeId === card.id && <div aria-hidden className="mb-1.5 h-0.5 rounded bg-text-tertiary" />}
                  <BoardCardItem
                    card={card}
                    board={board}
                    selected={card.id === selectedId}
                    dragging={drag?.id === card.id}
                    draggable
                    onOpen={() => onOpen(card)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', card.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDrag(card)
                    }}
                    onDragEnd={() => {
                      setDrag(null)
                      setOver(null)
                    }}
                  />
                </div>
              ))}
              {active && over?.beforeId === null && <div aria-hidden className="h-0.5 rounded bg-text-tertiary" />}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// ---------- 手机：分组列表 ----------

function BoardList({ board, actions, onOpen }: { board: Board; actions: CardActions; onOpen: (card: BoardCard) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6" data-testid="board-list">
      {MOBILE_GROUPS.map((group) => {
        const cards = board.cards
          .filter((c) => group.statuses.includes(c.status))
          .sort((a, b) => group.statuses.indexOf(a.status) - group.statuses.indexOf(b.status) || a.order - b.order)
        if (cards.length === 0) return null
        return (
          <section key={group.key} aria-label={group.label} className="mb-3">
            <h2 className="px-1 pb-1 pt-2 text-[13px] font-medium text-text-secondary">
              {group.label} <span className="text-[12px] font-normal tabular-nums text-text-tertiary">{cards.length}</span>
            </h2>
            <div className="space-y-3">
              {cards.map((card) => (
                <div key={card.id} className="space-y-1.5">
                  <BoardCardItem card={card} board={board} onOpen={() => onOpen(card)} />
                  {group.key === 'me' && (
                    <CardActionBar
                      card={card}
                      board={board}
                      actions={actions}
                      className="[&_button]:min-h-[44px] [&_button:nth-child(n+3)]:hidden"
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
