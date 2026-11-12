import { Fragment, type ReactNode } from 'react'
import { ChevronRight, Folder, GitBranch, Pin, PinOff, Plus, Server, Eye } from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { formatRelative } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Tooltip } from '../ui/Tooltip'
import { IconButton } from '../ui/Button'
import type { ExternalItem, HostGroup, ProjectGroup } from './sessionListUtils'
import { OLDER_SESSION_MS, isOlderSession } from './sessionListUtils'

interface SessionGroupsProps {
  hosts: Array<{ id: string; name: string }>
  groups: HostGroup[]
  pinnedProjects: string[]
  collapsed: Record<string, boolean>
  /** 反馈1603#01：展开了「更早的 N 个会话」的项目（按项目折叠键记）。 */
  expandedOlder: Record<string, boolean>
  setOlderSessionsExpanded: (key: string, expanded: boolean) => void
  expandedExternal: Record<string, boolean>
  setExpandedExternal: (update: (current: Record<string, boolean>) => Record<string, boolean>) => void
  showArchived: boolean
  query: string
  renderRow: (
    hostId: string,
    s: SessionSummary,
    depth?: number,
    section?: 'recent' | 'pinned',
    nested?: boolean,
  ) => ReactNode
  openExternal: (hostId: string, ext: ExternalItem) => void
  setProjectCollapsed: (key: string, collapsed: boolean) => void
  toggleProjectPinned: (key: string) => void
  newSessionIn: (hostId: string, cwd: string) => void
}

export function SessionGroups({
  hosts,
  groups,
  pinnedProjects,
  collapsed,
  expandedOlder,
  setOlderSessionsExpanded,
  expandedExternal,
  setExpandedExternal,
  showArchived,
  query,
  renderRow,
  openExternal,
  setProjectCollapsed,
  toggleProjectPinned,
  newSessionIn,
}: SessionGroupsProps) {
          const multiHost = hosts.length > 1
          const renderExternal = (hostId: string, ext: ExternalItem) => {
            const sourceLabel = ext.source === 'codex' ? 'Codex' : 'Claude Code'
            return (
              <Tooltip
                key={`${hostId}:${ext.source}:${ext.id}`}
                label={`${sourceLabel} 会话 · 只读`}
                side="top"
                className="block w-full"
              >
                <button data-raw-button
                  onClick={() => openExternal(hostId, ext)}
                  className="anim-row-in flex h-11 w-full min-w-0 items-center gap-2 rounded-lg pl-[18px] pr-2 text-left text-[14px] text-text outline-none transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] md:h-[34px]"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-text-tertiary">
                    <Eye size={12} />
                  </span>
                  <span className="min-w-0 flex-1 truncate leading-5" data-tip={ext.title || '未命名会话'}>
                    {ext.title || '未命名会话'}
                  </span>
                  <span className="w-[64px] shrink-0 truncate text-right text-[12px] tabular-nums text-text-tertiary">
                    {formatRelative(ext.updatedAt)}
                  </span>
                </button>
              </Tooltip>
            )
          }

          const renderProject = (hostId: string, project: ProjectGroup, indented: boolean) => {
            // 兼容旧键（按项目名）；新键按主机 + 项目路径记，重开/重建 Host 条目后仍能恢复。
            const projCollapsed = collapsed[project.collapseKey] ?? !!collapsed[project.key]
            const projectPinned = pinnedProjects.includes(project.key)
            const hostName = hosts.find((h) => h.id === hostId)?.name ?? ''
            const projectTip = [hostName, project.cwd].filter(Boolean).join(' · ')
            // 搜索时展示全部；平时外部会话默认只露最近 5 条，避免淹没 Tandem 会话
            const searching = !!query.trim()
            const externalExpanded = !!expandedExternal[project.key]
            const shownExternals =
              searching || externalExpanded ? project.externals : project.externals.slice(0, 5)
            const hiddenExternalCount = project.externals.length - shownExternals.length
            const externalSourceLabel = project.externals.some((e) => e.source === 'claude-code')
              ? 'Claude Code'
              : 'Codex'
            // 反馈1603#01：最近活动超过 7 天的会话默认收起，组末一行点开才渲染；
            // 固定、运行中、待审批、未读的会话始终显示。搜索与已归档视图不收起。
            const cutoff = Date.now() - OLDER_SESSION_MS
            const olderHidden =
              searching || showArchived ? [] : project.items.filter((s) => isOlderSession(s, cutoff))
            const olderExpanded = !!expandedOlder[project.collapseKey]
            const olderHiddenIds = new Set(olderHidden.map((s) => s.id))
            const visibleItems =
              olderExpanded || olderHidden.length === 0
                ? project.items
                : project.items.filter((s) => !olderHiddenIds.has(s.id))
            const entries = [
              ...visibleItems.map((s) => (
                <Fragment key={`${hostId}:${s.id}`}>{renderRow(hostId, s, 0, 'recent', true)}</Fragment>
              )),
              ...(olderHidden.length > 0
                ? [
                    <button
                      key={`${project.key}:older`}
                      data-raw-button
                      type="button"
                      data-older-sessions=""
                      aria-expanded={olderExpanded}
                      onClick={() =>
                        setOlderSessionsExpanded(project.collapseKey, !olderExpanded)
                      }
                      className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 pr-2 text-left text-[12px] text-text-tertiary transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-secondary max-sm:h-11"
                    >
                      <ChevronRight
                        size={11}
                        className={cn('shrink-0 transition-transform duration-150', olderExpanded && 'rotate-90')}
                      />
                      更早的 {olderHidden.length} 个会话
                    </button>,
                  ]
                : []),
              ...shownExternals.map((ext) => renderExternal(hostId, ext)),
            ]
            return (
              <div
                key={project.key}
                className="min-w-0"
                data-project-row
                data-project-key={project.key}
                data-project-pinned={projectPinned || undefined}
                data-host-indented={indented || undefined}
              >
                <div className="group/proj flex h-8 min-w-0 items-center rounded-lg pr-0.5 transition-colors hover:bg-[var(--t-bg-hover)] max-sm:h-11">
                  <button data-raw-button
                    onClick={() => {
                      setProjectCollapsed(project.collapseKey, !projCollapsed)
                      // 旧键（按显示名）留在存储里会在下次重开时复活，切换时一并清掉。
                      if (project.key !== project.collapseKey) setProjectCollapsed(project.key, false)
                    }}
                    className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-1.5 text-left text-[13px] font-medium text-text-secondary transition-colors duration-[120ms] hover:text-text max-sm:h-11"
                    aria-expanded={!projCollapsed}
                    data-tip={projectTip || project.name}
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        'shrink-0 text-text-tertiary opacity-70 transition-transform duration-150',
                        !projCollapsed && 'rotate-90',
                      )}
                    />
                    <Folder size={13} className="shrink-0 text-text-tertiary" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.branch && (
                      <span className="flex min-w-0 max-w-[42%] items-center gap-0.5 text-[12px] font-normal text-text-tertiary">
                        <GitBranch size={9} className="shrink-0" />
                        <span className="truncate">{project.branch}</span>
                      </span>
                    )}
                  </button>
                  <IconButton
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleProjectPinned(project.key)
                    }}
                    label={projectPinned ? `取消固定项目 ${project.name}` : `固定项目 ${project.name}`}
                    tooltip={projectPinned ? '取消固定项目' : '固定项目'}
                    tooltipSide="top"
                    aria-pressed={projectPinned}
                    className="size-7! opacity-100 focus-visible:opacity-100 max-sm:size-11! md:opacity-0 md:group-hover/proj:opacity-100 [&_svg]:size-[13px]"
                  >
                    {projectPinned ? <PinOff size={13} /> : <Pin size={13} />}
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      newSessionIn(hostId, project.cwd || '')
                    }}
                    tooltip={`在 ${project.name} 新建会话`}
                    label={`在 ${project.name} 新建会话`}
                    tooltipSide="top"
                    className="size-7! opacity-100 focus-visible:opacity-100 max-sm:size-11! md:opacity-0 md:group-hover/proj:opacity-100 [&_svg]:size-[13px]"
                  >
                    <Plus size={13} />
                  </IconButton>
                </div>
                <div
                  className="expand-grid mt-0.5"
                  data-open={!projCollapsed}
                  aria-hidden={projCollapsed}
                  inert={projCollapsed}
                >
                  <div className="expand-inner space-y-0.5">
                    {entries}
                    {hiddenExternalCount > 0 && (
                      <button data-raw-button
                        onClick={() =>
                          setExpandedExternal((s) => ({ ...s, [project.key]: true }))
                        }
                        className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 pr-2 text-left text-[12px] text-text-tertiary transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-secondary max-sm:h-11"
                      >
                        <ChevronRight size={11} className="shrink-0 rotate-90" />
                        更多 {externalSourceLabel} 会话（{hiddenExternalCount}）
                      </button>
                    )}
                    {!searching && externalExpanded && project.externals.length > 5 && (
                      <button data-raw-button
                        onClick={() =>
                          setExpandedExternal((s) => {
                            const next = { ...s }
                            delete next[project.key]
                            return next
                          })
                        }
                        className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 pr-2 text-left text-[12px] text-text-tertiary transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-secondary max-sm:h-11"
                      >
                        <ChevronRight size={11} className="shrink-0" />
                        收起 {externalSourceLabel} 会话
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          }

          // 固定项目单独提到列表最上方（跨 Host 也优先），其余项目仍按 Host 分组。
          const pinnedEntries = showArchived
            ? []
            : groups.flatMap((host) =>
                host.projects
                  .filter((project) => pinnedProjects.includes(project.key))
                  .map((project) => ({ host, project })),
              )
          const normalGroups = groups
            .map((host) => ({
              ...host,
              projects: host.projects.filter((project) => !pinnedProjects.includes(project.key)),
            }))
            .filter((host) => host.projects.length > 0)

          const pinnedSection = pinnedEntries.length > 0 && (
            <div className="mb-1" data-pinned-projects>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[12px] font-medium text-text-tertiary">
                <Pin size={11} />
                固定项目
              </div>
              <div className="space-y-1">
                {pinnedEntries.map(({ host, project }) => renderProject(host.id, project, false))}
              </div>
            </div>
          )
          const recentLabel = showArchived ? '已归档' : query.trim() ? '搜索结果' : '最近项目'
          const hasRecent = normalGroups.some((host) => host.projects.length > 0)

          if (!multiHost) {
            return (
              <div className="space-y-1 pt-1">
                {pinnedSection}
                {hasRecent && (
                  <div data-recent-projects>
                    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[12px] font-medium text-text-tertiary">
                      {recentLabel}
                    </div>
                    <div className="space-y-1">
                      {normalGroups.flatMap((host) =>
                        host.projects.map((project) => renderProject(host.id, project, false)),
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          }

          return (
            <>
              {pinnedSection}
              {normalGroups.map((host) => {
                const hostCollapsed =
                  collapsed[host.collapseKey] ?? !!collapsed[`host:${host.id}`]
                return (
                  <div key={host.id} className="mb-1" data-host-group={host.id}>
                    <div className="flex min-w-0 items-center gap-1.5 px-2.5 pb-1 pt-2">
                      <button data-raw-button
                        onClick={() => {
                          setProjectCollapsed(host.collapseKey, !hostCollapsed)
                          const legacyKey = `host:${host.id}`
                          if (legacyKey !== host.collapseKey) setProjectCollapsed(legacyKey, false)
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[12px] font-medium text-text-tertiary transition-colors duration-[120ms] hover:text-text-secondary"
                        aria-expanded={!hostCollapsed}
                        data-tip={host.online ? host.name : `${host.name} · 离线，显示缓存的会话列表`}
                      >
                        <ChevronRight
                          size={11}
                          className={cn(
                            'shrink-0 opacity-70 transition-transform duration-150',
                            !hostCollapsed && 'rotate-90',
                          )}
                        />
                        <Server size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 truncate">{host.name}</span>
                        {!host.online && (
                          <span className="shrink-0 rounded border border-border px-1 text-[11px] font-normal text-muted">
                            离线
                          </span>
                        )}
                      </button>
                      <span className="shrink-0 text-[12px] font-normal tabular-nums text-text-tertiary">
                        {host.count}
                      </span>
                    </div>
                    <div
                      className="expand-grid mt-0.5"
                      data-open={!hostCollapsed}
                      aria-hidden={hostCollapsed}
                      inert={hostCollapsed}
                    >
                      <div className="expand-inner space-y-1 pt-0.5">
                        {host.projects.map((project) => renderProject(host.id, project, true))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </>
          )
}
