// 右栏 Wiki 卡片：项目 Wiki 摘要、生成/更新入口。
import { useEffect } from 'react'
import { BookOpen} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { rememberWikiHost, useWikiStore } from '../../store/useWikiStore'
import { formatAgo } from '../../lib/format'
import { Button } from '../ui/Button'

export function WikiCard() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const openWiki = useUiStore((s) => s.openWiki)
  const project = summary?.env?.repoRoot || summary?.cwd || ''
  const key = host && project ? `${host.id}\u0000${project}` : ''
  const entry = useWikiStore((s) => (key ? s.entries[key] : undefined))
  const refresh = useWikiStore((s) => s.refresh)

  useEffect(() => {
    if (!host || !project) return
    rememberWikiHost(host)
    void refresh(host, project)
  }, [host, project, refresh])

  // 工具/后台任务生成后 messages 会变；WikiCard 挂载期间轻量轮询任务进度。
  const runningJob = entry?.jobs.find((job) => job.status === 'running')
  useEffect(() => {
    if (!host || !project || !runningJob) return
    const timer = window.setInterval(() => void refresh(host, project), 2500)
    return () => window.clearInterval(timer)
  }, [host, project, runningJob?.id, refresh])

  if (!project) {
    return <p className="text-[12px] text-muted">当前会话没有项目目录。</p>
  }
  const meta = entry?.meta
  const pages = meta?.pages.length ?? 0

  return (
    <div className="space-y-2 text-[12px] leading-[18px]">
      {runningJob ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-text-soft">
            <Spinner size={11} />
            {runningJob.current ? `正在生成：${runningJob.current}` : '准备生成…'}
            <span className="tabular-nums text-muted">
              {runningJob.done}/{runningJob.total}
            </span>
          </p>
          <div className="h-0.5 overflow-hidden rounded-full bg-[var(--t-bg-active)]/60">
            <div
              className="h-full rounded-full bg-[var(--t-text-tertiary)]/70 transition-[width] duration-300"
              style={{ width: `${runningJob.total ? (runningJob.done / runningJob.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : meta?.exists ? (
        <p className="text-muted">
          共 {pages} 页 · 基于 {meta.commit ? `commit ${meta.commit}` : '生成时的代码'}
          {meta.updatedAt ? ` · ${formatAgo(meta.updatedAt)}` : ''}
        </p>
      ) : (
        <p className="text-muted">还没有 Wiki。生成后可供人和 agent 检索项目架构。</p>
      )}

      {meta && meta.exists && meta.changedFiles > 0 && !runningJob ? (
        <p className="text-muted">之后有 {meta.changedFiles} 个文件改动（其中 {meta.changedInWiki} 个在 Wiki 覆盖范围）</p>
      ) : null}

      <div className="flex items-center gap-1.5 pt-0.5">
        {meta?.exists ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => openWiki({ project })}>
              <BookOpen size={12} /> 浏览
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!runningJob}
              onClick={() => openWiki({ project, generate: 'update' })}
            >
              更新
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!!runningJob}
            onClick={() => openWiki({ project, generate: 'generate' })}
          >
            <BookOpen size={12} /> 生成 Wiki
          </Button>
        )}
        <span className="flex-1" />
        {meta?.model ? <span className="truncate text-[11px] text-muted">{meta.model}</span> : null}
      </div>
    </div>
  )
}
