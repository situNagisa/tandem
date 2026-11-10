import { ArrowUpRight, Check, Copy, FolderGit2, GitBranch, GitFork, KeyRound } from 'lucide-react'
import type { ConnectionState } from '../../lib/types'
import type { SessionSummary } from '@tandem/protocol'
import { PERMISSION_MODE_LABELS } from '../../lib/types'
import { formatRelative, formatTime } from '../../lib/format'
import { ConnectionDot } from '../StatusDot'
import { Button, IconButton } from '../ui/Button'
import { DetailRow } from './shared'

interface PanelDetailsProps {
  summary: SessionSummary | null
  profileName: string | null
  profilesLoaded: boolean
  copyCwd: () => void
  copied: boolean
  hostStatus: ConnectionState
  host: { name: string } | null
  openSettings: (tab: 'secrets') => void
}

export function PanelDetails({
  summary,
  profileName,
  profilesLoaded,
  copyCwd,
  copied,
  hostStatus,
  host,
  openSettings,
}: PanelDetailsProps) {
return (
      <div className="space-y-0">
        <DetailRow label="模型">
          <span className="font-mono text-[12px]">
            {summary?.autoRoute
              ? `自动 · ${summary.route?.model ?? summary.model ?? '—'}`
              : (summary?.model ?? '—')}
          </span>
        </DetailRow>
        <DetailRow label="账号">
          {profileName ??
            (summary?.profileId ? (profilesLoaded ? '未知账号' : '加载中…') : '—')}
        </DetailRow>
        <DetailRow label="权限">
          {summary ? PERMISSION_MODE_LABELS[summary.permissionMode] : '—'}
        </DetailRow>
        <DetailRow label="工作目录">
          <span className="flex items-start gap-1">
            <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[17px] text-text-soft">
              {summary?.cwd ?? '—'}
            </span>
            {summary?.cwd && (
              <IconButton
                size="sm"
                onClick={copyCwd}
                label="复制工作目录"
                tooltip="复制"
                className="mt-px size-5! shrink-0 opacity-40 hover:opacity-100 [&_svg]:size-3"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </IconButton>
            )}
          </span>
        </DetailRow>
        {summary?.env?.repoName && (
          <DetailRow label="仓库">
            <span className="flex items-center gap-1">
              <FolderGit2 size={10} className="text-muted" />
              {summary.env.repoName}
            </span>
          </DetailRow>
        )}
        {summary?.env?.branch && (
          <DetailRow label="分支">
            <span className="flex items-center gap-1">
              <GitBranch size={10} className="text-muted" />
              {summary.env.branch}
            </span>
          </DetailRow>
        )}
        {summary?.worktree && (
          <DetailRow label="worktree">
            <span className="block space-y-0.5">
              <span className="flex items-center gap-1 text-text">
                <GitFork size={10} className="text-muted" />
                <span className="font-mono text-[12px]">{summary.worktree.branch}</span>
              </span>
              <span className="block text-[12px] text-muted">
                基于 {summary.worktree.baseBranch}
              </span>
              <span className="block break-all font-mono text-[12px] leading-4 text-muted">
                {summary.worktree.path}
              </span>
            </span>
          </DetailRow>
        )}
        <DetailRow label="Secrets">
          <Button
            size="inline"
            variant="ghost"
            onClick={() => openSettings('secrets')}
            tooltip="打开设置 → Secrets"
          >
            <KeyRound size={10} className="text-muted" />
            {summary?.secretsCount ? `${summary.secretsCount} 个可用` : '未配置'}
            <ArrowUpRight size={10} className="text-muted" />
          </Button>
        </DetailRow>
        <DetailRow label="主机">
          <span className="flex items-center gap-1.5">
            <ConnectionDot state={hostStatus} />
            <span className="truncate">{host?.name ?? '—'}</span>
          </span>
        </DetailRow>
        <DetailRow label="更新">
          {summary ? (
            <span className="tabular-nums" data-tip={formatTime(summary.updatedAt)}>
              {formatRelative(summary.updatedAt)}
            </span>
          ) : (
            '—'
          )}
        </DetailRow>
        <DetailRow label="创建">
          {summary ? (
            <span className="tabular-nums" data-tip={formatTime(summary.createdAt)}>
              {formatRelative(summary.createdAt)}
            </span>
          ) : (
            '—'
          )}
        </DetailRow>
      </div>
    )
}
