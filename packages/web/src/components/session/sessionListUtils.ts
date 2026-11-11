import type { ExternalSession, SessionSummary } from '@tandem/protocol'
import type { AppState } from '../../store/appStore/types'
import type { SessionFilter } from '../../lib/types'
import { basename } from '../../lib/format'
import { sessionTreeRootId } from '../../lib/sessionTree'

const EMPTY: SessionSummary[] = []

export interface ExternalItem extends ExternalSession {
  hostId: string
}

/**
 * 侧栏一行 = 一棵会话树（主会话 + 分叉 + 分叉的分叉）。
 * 行本身是根会话，`openedId` / `branchTitle` / `treeIds` 记录树内其他会话。
 */
export interface SessionTreeRow extends SessionSummary {
  /** 树内最近活动的会话：点这一行打开它。 */
  openedId?: string
  /** 当前打开的是分叉时，行内小字显示的所在分叉名。 */
  branchTitle?: string
  /** 树内全部会话 id（用于置顶按整棵树生效）。 */
  treeIds?: string[]
}

export interface ProjectGroup {
  key: string
  /** 折叠状态用的标识：主机 + 项目路径（见 projectCollapseKey）。 */
  collapseKey: string
  name: string
  cwd?: string
  branch?: string
  items: SessionTreeRow[]
  externals: ExternalItem[]
  children: Record<string, SessionTreeRow[]>
}

export interface HostGroup {
  id: string
  name: string
  /** 折叠状态用的标识：见 hostCollapseKey。 */
  collapseKey: string
  online: boolean
  projects: ProjectGroup[]
  count: number
}

export interface MenuState {
  hostId: string
  session: SessionSummary
  x: number
  y: number
}

/** 服务端把 worktree 放在 ~/.tandem/worktrees/<repo>/<branch>，从中还原项目名以便与主仓库归组。 */
export function worktreeRepoName(s: SessionSummary): string | undefined {
  const p = s.worktree?.path
  if (!p) return undefined
  const m = p.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)\//)
  return m?.[1]
}

export function projectName(s: SessionSummary): string {
  return worktreeRepoName(s) || s.env?.repoName || basename(s.cwd) || '未命名项目'
}

type CollapseHost = { id: string; hostId?: string }

/** 折叠状态的主机标识：优先 Host 自己的 hostId（客户端重建 Host 条目后仍稳定）。 */
export function hostCollapseKey(host: CollapseHost): string {
  return `host:${host.hostId || host.id}`
}

/**
 * 折叠状态的项目标识：主机 + 项目路径。按名字记时，同名项目（不同目录）会互相影响，
 * 项目名或 env 口径变化后也会丢掉已折叠状态（反馈1601#05）。
 */
export function projectCollapseKey(host: CollapseHost, project: { cwd?: string; name: string }): string {
  const path = (project.cwd || project.name).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows 盘符路径大小写不敏感；Linux 路径保持原样。
  const stable = /^[a-z]:/i.test(path) ? path.toLowerCase() : path
  return `${host.hostId || host.id}:${stable}`
}

/** 侧栏项目归组名；Sidebar 的筛选菜单复用同一口径。 */
export function sessionProjectName(s: SessionSummary): string {
  return projectName(s)
}

export function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'waiting_permission' || status === 'retrying'
}

export function matchesStatus(s: SessionSummary, filter: SessionFilter['status']): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return s.status === 'running' || s.status === 'retrying';
  if (filter === 'waiting_permission') return s.status === 'waiting_permission';
  if (filter === 'error') return s.status === 'error';
  return s.unread === true;
}

/** 状态汇总优先级：待审批最需要看见，其次运行中、等待网络、错误。 */
const STATUS_RANK: Record<SessionSummary['status'], number> = {
  idle: 0,
  error: 1,
  retrying: 2,
  running: 3,
  waiting_permission: 4,
}

/** 一棵会话树汇总成一行：标题用根会话，打开最近活动的会话，状态按树内任一会话汇总。 */
function treeRow(
  root: SessionSummary,
  tree: SessionSummary[],
  activeSessionId?: string | null,
): SessionTreeRow {
  let opened = root
  let updatedAt = root.updatedAt
  let status = root.status
  let unread = !!root.unread
  let pinned = !!root.pinned
  let pinnedInProject = !!root.pinnedInProject
  let branchTitle: string | undefined
  const ids: string[] = []
  for (const session of tree) {
    ids.push(session.id)
    if (session.updatedAt > updatedAt) updatedAt = session.updatedAt
    if (session.updatedAt > opened.updatedAt) opened = session
    if (STATUS_RANK[session.status] > STATUS_RANK[status]) status = session.status
    if (session.unread) unread = true
    if (session.pinned) pinned = true
    if (session.pinnedInProject) pinnedInProject = true
    if (activeSessionId && session.id === activeSessionId && session.id !== root.id) {
      branchTitle = session.title || '未命名会话'
    }
  }
  return {
    ...root,
    updatedAt,
    status,
    unread,
    pinned,
    pinnedInProject,
    ...(opened.id !== root.id ? { openedId: opened.id } : {}),
    ...(branchTitle ? { branchTitle } : {}),
    ...(ids.length > 1 ? { treeIds: ids } : {}),
  }
}

export function buildGroups(
  hosts: Array<{ id: string; name: string; hostId?: string }>,
  runtimes: AppState['runtimes'],
  externalSessions: ExternalItem[],
  query: string,
  showArchived: boolean,
  filter: SessionFilter,
  pinnedProjects: string[],
  activeSessionId?: string | null,
): { pinned: Array<{ hostId: string; session: SessionTreeRow }>; hosts: HostGroup[] } {
  const q = query.trim().toLowerCase()
  const pinned: Array<{ hostId: string; session: SessionTreeRow }> = []
  const groups: HostGroup[] = []
  const allowTandem = filter.source === 'all' || filter.source === 'tandem'
  const allowExternal =
    filter.source === 'all' || filter.source === 'claude-code' || filter.source === 'codex'

  for (const h of hosts) {
    if (filter.hostId !== 'all' && h.id !== filter.hostId) continue
    const rt = runtimes[h.id]
    const all = allowTandem ? (rt?.sessions ?? EMPTY) : EMPTY
    const matchesQuery = (s: SessionSummary) =>
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q) ||
      (s.env?.repoName ?? '').toLowerCase().includes(q) ||
      (s.env?.branch ?? '').toLowerCase().includes(q) ||
      h.name.toLowerCase().includes(q)

    // 子代理/孙代理会话只出现在对应主会话的消息流里，侧栏与搜索结果一律隐藏；看板卡片会话从「任务看板」进入。
    // 分叉不单独占一行：与根会话归并成一棵树（用户 2026-11-11 22:09 原话）。
    const inView = all.filter(
      (s) =>
        !s.parentId &&
        !s.board &&
        (showArchived ? !!s.archived : !s.archived),
    )
    const inViewById = new Map(inView.map((s) => [s.id, s]))
    const trees = new Map<string, SessionSummary[]>()
    for (const s of inView) {
      const rootId = sessionTreeRootId(s, inViewById)
      const tree = trees.get(rootId)
      if (tree) tree.push(s)
      else trees.set(rootId, [s])
    }

    const regular: SessionTreeRow[] = []
    for (const [rootId, tree] of trees) {
      const root = inViewById.get(rootId)
      if (!root) continue
      if (filter.project !== 'all' && projectName(root) !== filter.project) continue
      if (!tree.some((s) => matchesStatus(s, filter.status) && (!q || matchesQuery(s)))) continue
      const row = treeRow(root, tree, activeSessionId)
      if (row.pinned && !showArchived) pinned.push({ hostId: h.id, session: row })
      else regular.push(row)
    }
    const map = new Map<string, ProjectGroup>()
    for (const s of regular) {
      const name = projectName(s)
      const key = `${h.id}:${name}`
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          // 折叠按仓库根（没有则 cwd）记，不跟着显示名/排序变化。
          collapseKey: projectCollapseKey(h, { cwd: s.env?.repoRoot || s.cwd, name }),
          name,
          cwd: s.cwd,
          branch: s.worktree ? undefined : s.env?.branch,
          items: [],
          externals: [],
          children: {},
        }
        map.set(key, group)
      }
      if (!group.branch && s.env?.branch && !s.worktree) group.branch = s.env.branch
      group.items.push(s)
    }

    // 外部会话（Claude Code / Codex）按 cwd 并入对应项目；字段缺失时自然为空。
    if (!showArchived && allowExternal && filter.status === 'all') {
      for (const ext of externalSessions) {
        if (ext.hostId !== h.id) continue
        if (filter.source !== 'all' && ext.source !== filter.source) continue
        const base = basename(ext.cwd) || '未命名项目'
        if (filter.project !== 'all' && base !== filter.project) continue
        if (q) {
          const hay = `${ext.title} ${ext.cwd} ${ext.source}`.toLowerCase()
          if (!hay.includes(q)) continue
        }
        let group: ProjectGroup | null =
          [...map.values()].find((g) => (g.cwd && g.cwd === ext.cwd) || g.name === base) ?? null
        if (!group) {
          group = {
            key: `${h.id}:${base}`,
            collapseKey: projectCollapseKey(h, { cwd: ext.cwd, name: base }),
            name: base,
            cwd: ext.cwd,
            items: [],
            externals: [],
            children: {},
          }
          map.set(group.key, group)
        }
        group.externals.push(ext)
      }
    }
    if (regular.length === 0 && ![...map.values()].some((g) => g.externals.length > 0)) continue
    const projects = [...map.values()]
      .map((g) => ({
        ...g,
        items: g.items
          .slice()
          .sort(
            (a, b) =>
              Number(!!b.pinnedInProject) - Number(!!a.pinnedInProject) ||
              b.updatedAt - a.updatedAt,
          ),
        externals: g.externals.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => {
        // 项目级固定优先于普通项目；同类按最近活动排序
        const ap = pinnedProjects.includes(a.key)
        const bp = pinnedProjects.includes(b.key)
        if (ap !== bp) return ap ? -1 : 1
        const at = Math.max(a.items[0]?.updatedAt ?? 0, a.externals[0]?.updatedAt ?? 0)
        const bt = Math.max(b.items[0]?.updatedAt ?? 0, b.externals[0]?.updatedAt ?? 0)
        return bt - at
      })
    groups.push({
      id: h.id,
      name: h.name,
      collapseKey: hostCollapseKey(h),
      online: rt?.status === 'online',
      projects,
      count:
        regular.length +
        projects.reduce((n, p) => n + p.externals.length, 0) +
        Object.values(projects).reduce(
          (n, p) => n + Object.values(p.children).reduce((m, l) => m + l.length, 0),
          0,
        ),
    })
  }

  pinned.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
  return { pinned, hosts: groups }
}
