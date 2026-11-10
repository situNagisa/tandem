import type { ReactNode } from 'react'
import { ArrowUpRight, Maximize2 } from 'lucide-react'
import type { SessionSummary, Todo } from '@tandem/protocol'
import { Button, IconButton } from '../ui/Button'
import type { GroupId } from './shared'

interface PanelActionsProps {
  id: GroupId
  planStatus: ReactNode
  agentCount: number
  todos: Todo[]
  completed: number
  summary: SessionSummary | null
  setPlanOpen: (open: boolean) => void
  setGraphExpanded: (open: boolean) => void
  openMemoryEditor: (target: { scope: 'project'; project: string }) => void
  openWiki: (target: { project: string }) => void
  setChangesOpen: (open: boolean) => void
}

export function PanelActions({
  id,
  planStatus,
  agentCount,
  todos,
  completed,
  summary,
  setPlanOpen,
  setGraphExpanded,
  openMemoryEditor,
  openWiki,
  setChangesOpen,
}: PanelActionsProps) {
    if (id === 'plan') {
      return (
        <span className="flex items-center gap-1 text-[12px] text-muted">
          {planStatus}
          <IconButton
            size="sm"
            onClick={() => setPlanOpen(true)}
            label="查看计划全文"
            tooltip="查看全文"
            className="-mr-1 size-6! [&_svg]:size-3"
          >
            <Maximize2 size={12} />
          </IconButton>
        </span>
      )
    }
    if (id === 'agents') {
      return <span className="text-[12px] tabular-nums text-muted">{agentCount}</span>
    }
    if (id === 'graph') {
      return (
        <IconButton
          size="sm"
          onClick={() => setGraphExpanded(true)}
          label="全高显示会话图"
          tooltip="展开"
          className="-mr-1 size-6! [&_svg]:size-3"
        >
          <Maximize2 size={12} />
        </IconButton>
      )
    }
    if (id === 'todos' && todos.length > 0) {
      return (
        <span className="text-[12px] tabular-nums text-muted">
          {completed}/{todos.length}
        </span>
      )
    }
    if (id === 'memory') {
      return (
        <Button
          size="inline"
          variant="ghost"
          onClick={() => summary?.cwd && openMemoryEditor({ scope: 'project', project: summary.cwd })}
          disabled={!summary?.cwd}
        >
          编辑
        </Button>
      )
    }
    if (id === 'wiki') {
      return (
        <Button
          size="inline"
          variant="ghost"
          onClick={() => summary?.cwd && openWiki({ project: summary.env?.repoRoot || summary.cwd })}
          disabled={!summary?.cwd}
        >
          浏览
        </Button>
      )
    }
    if (id === 'changes') {
      return (
        <Button size="inline" variant="ghost" onClick={() => setChangesOpen(true)}>
          审阅 <ArrowUpRight size={10} />
        </Button>
      )
    }
    return null
  }
