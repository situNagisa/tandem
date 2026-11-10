import { Archive, ArchiveRestore, Columns2, Copy, FlaskConical, GitMerge, Pencil, Pin, PinOff, Share2, Trash2 } from 'lucide-react'
import { Menu } from '../ui/Menu'
import type { MenuState } from './sessionListUtils'

export function RowMenu({
  state,
  onClose,
  onRename,
  onSplit,
  onTogglePin,
  onTogglePinProject,
  onFork,
  onShare,
  onSaveEval,
  onArchive,
  onDelete,
  onMerge,
}: {
  state: MenuState
  onClose: () => void
  onRename: () => void
  onSplit: () => void
  onTogglePin: () => void
  onTogglePinProject: () => void
  onFork: () => void
  onShare: () => void
  onSaveEval: () => void
  onArchive: () => void
  onDelete: () => void
  onMerge: () => void
}) {
  return (
    <Menu
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      side="bottom"
      align="start"
      sideOffset={2}
      aria-label="会话操作"
      className="w-[196px]"
      trigger={
        <span
          aria-hidden
          style={{ position: 'fixed', left: state.x, top: state.y, width: 1, height: 1 }}
        />
      }
    >
      <Menu.Item icon={<Pencil size={14} />} onSelect={onRename}>
        重命名
      </Menu.Item>
      <Menu.Item icon={<Columns2 size={14} />} onSelect={onSplit}>
        在分屏中打开
      </Menu.Item>
      <Menu.Item
        icon={state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        onSelect={onTogglePin}
      >
        {state.session.pinned ? '取消置顶' : '置顶'}
      </Menu.Item>
      <Menu.Item
        icon={state.session.pinnedInProject ? <PinOff size={14} /> : <Pin size={14} />}
        onSelect={onTogglePinProject}
      >
        {state.session.pinnedInProject ? '取消项目置顶' : '在项目中置顶'}
      </Menu.Item>
      <Menu.Item icon={<Copy size={14} />} onSelect={onFork}>
        复制会话
      </Menu.Item>
      <Menu.Item icon={<Share2 size={14} />} onSelect={onShare}>
        分享…
      </Menu.Item>
      <Menu.Item icon={<FlaskConical size={14} />} onSelect={onSaveEval}>
        存为评测用例…
      </Menu.Item>
      {state.session.worktree && (
        <Menu.Item icon={<GitMerge size={14} />} onSelect={onMerge}>
          合并回 {state.session.worktree.baseBranch}
        </Menu.Item>
      )}
      <Menu.Item
        icon={state.session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        onSelect={onArchive}
      >
        {state.session.archived ? '取消归档' : '归档'}
      </Menu.Item>
      <Menu.Separator />
      <Menu.Item danger icon={<Trash2 size={14} />} onSelect={onDelete}>
        删除
      </Menu.Item>
    </Menu>
  )
}

