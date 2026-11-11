import { useMemo, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import type { ExternalSource, Session } from '@tandem/protocol'
import { countTurns } from '@tandem/protocol'
import { cn } from '../lib/cn'
import { formatCost, formatRelative, formatTime, formatTokens } from '../lib/format'
import { useCopy } from '../lib/useCopy'
import { estimateMessageTokens } from '../lib/turnUsage'
import { useUiStore } from '../store/useUiStore'
import { IconButton } from './ui/Button'
import { ReadOnlySessionGraph } from './sessionGraph/SessionGraphCard'
import { PanelBar, PanelBody } from './ui/Panel'
import { ResizeHandle } from './ui/ResizeHandle'
import {
  Card,
  DetailRow,
  GROUP_META,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  loadPanelWidth,
  savePanelWidth,
} from './right-panel/shared'

const SOURCE_LABEL: Record<ExternalSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** 外部会话只读预览的信息面板：只显示原日志里能拿到的数据，缺的项不渲染。 */
export function ExternalSessionPanel({
  session,
  source,
  onClose,
}: {
  session: Session
  source: ExternalSource
  onClose: () => void
}) {
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const toast = useUiStore((s) => s.toast)
  const { copied, copy } = useCopy({ onError: () => toast('复制失败', 'error') })
  const messages = session.messages
  const turnCount = useMemo(() => countTurns(messages), [messages])

  const model = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!
      if (message.role === 'assistant' && message.model) return message.model
    }
    return session.model
  }, [messages, session.model])

  const usage = useMemo(() => {
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      hasCost: false,
      hasUsage: false,
    }
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.usage) continue
      const item = message.usage
      const tokens =
        (item.inputTokens || 0) +
        (item.outputTokens || 0) +
        (item.cacheReadTokens || 0) +
        (item.cacheWriteTokens || 0)
      if (tokens > 0) total.hasUsage = true
      total.inputTokens += item.inputTokens || 0
      total.outputTokens += item.outputTokens || 0
      total.cacheReadTokens += item.cacheReadTokens || 0
      total.cacheWriteTokens += item.cacheWriteTokens || 0
      if (typeof item.costUsd === 'number' && Number.isFinite(item.costUsd)) {
        total.costUsd += item.costUsd
        total.hasCost = true
      }
    }
    const inputTotal = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens
    return {
      ...total,
      hitRate: inputTotal > 0 ? total.cacheReadTokens / inputTotal : undefined,
    }
  }, [messages])

  const contextTokens = useMemo(
    () => messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    [messages],
  )

  const editedFiles = useMemo(() => {
    const files = new Map<string, number>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        if (!/^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch|str_replace_editor|create_file)$/i.test(block.name)) {
          continue
        }
        const input = block.input as Record<string, unknown> | undefined
        const file =
          (typeof input?.file_path === 'string' && input.file_path) ||
          (typeof input?.path === 'string' && input.path) ||
          (typeof input?.notebook_path === 'string' && input.notebook_path) ||
          ''
        if (file) files.set(file, (files.get(file) ?? 0) + 1)
      }
    }
    return [...files.entries()].sort((a, b) => b[1] - a[1])
  }, [messages])

  const copyCwd = () => {
    if (session.cwd) void copy(session.cwd)
  }

  const groups = [
    usage.hasUsage || usage.hasCost ? 'usage' : null,
    contextTokens > 0 && turnCount > 0 ? 'context' : null,
    turnCount > 0 ? 'graph' : null,
    editedFiles.length > 0 ? 'changes' : null,
    'details',
  ].filter((id): id is 'usage' | 'context' | 'graph' | 'changes' | 'details' => id !== null)

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 flex-col border-l border-border bg-sidebar"
      style={{ width: dragWidth ?? panelWidth }}
    >
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
      <PanelBar title="会话信息">
        <span className="flex items-center gap-1.5 text-[12px] text-muted">
          <span className="size-1.5 rounded-full bg-[var(--t-text-tertiary)]" />
          只读 · {SOURCE_LABEL[source]}
        </span>
        <span className="flex-1" />
        <IconButton onClick={onClose} label="关闭信息面板" className="-mr-1 max-md:size-11">
          <X size={15} />
        </IconButton>
      </PanelBar>

      <PanelBody scroll className="space-y-2 p-3" style={{ scrollbarGutter: 'stable' }}>
        {groups.map((id) => {
          const meta = GROUP_META[id]
          return (
            <Card
              key={id}
              id={id}
              label={id === 'changes' ? '文件改动' : meta.label}
              icon={meta.Icon}
            >
              {id === 'details' ? (
                <div>
                  {model && (
                    <DetailRow label="模型">
                      <span className="break-all font-mono text-[12px]">{model}</span>
                    </DetailRow>
                  )}
                  <DetailRow label="来源">
                    {SOURCE_LABEL[source]} 原始会话
                  </DetailRow>
                  <DetailRow label="工作目录">
                    <span className="flex items-start gap-1">
                      <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[17px] text-text-soft">
                        {session.cwd || '—'}
                      </span>
                      {session.cwd && (
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
                  <DetailRow label="轮数">
                    <span className="tabular-nums">{turnCount}</span>
                  </DetailRow>
                  <DetailRow label="消息">
                    <span className="tabular-nums">{messages.length}</span>
                  </DetailRow>
                  <DetailRow label="更新">
                    <span className="tabular-nums" data-tip={formatTime(session.updatedAt)}>
                      {formatRelative(session.updatedAt)}
                    </span>
                  </DetailRow>
                  <DetailRow label="创建">
                    <span className="tabular-nums" data-tip={formatTime(session.createdAt)}>
                      {formatRelative(session.createdAt)}
                    </span>
                  </DetailRow>
                </div>
              ) : id === 'graph' ? (
                <ReadOnlySessionGraph messages={messages} title={session.title} />
              ) : id === 'usage' ? (
                <div>
                  {usage.hasCost && (
                    <>
                      <div className="text-[12px] text-muted">总花费</div>
                      <div className="mt-0.5 font-mono text-[19px] leading-6 tabular-nums text-text">
                        {formatCost(usage.costUsd)}
                      </div>
                    </>
                  )}
                  <div className={cn('grid grid-cols-2 gap-x-4 gap-y-1.5', usage.hasCost && 'mt-2')}>
                    {[
                      { label: '输入', value: usage.inputTokens },
                      { label: '输出', value: usage.outputTokens },
                      { label: '缓存读', value: usage.cacheReadTokens },
                      { label: '缓存写', value: usage.cacheWriteTokens },
                    ].map((item) => (
                      <div key={item.label} className="flex min-w-0 items-baseline justify-between gap-2">
                        <span className="text-[12px] text-muted">{item.label}</span>
                        <span className="truncate font-mono text-[13px] tabular-nums text-text-soft">
                          {formatTokens(item.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
                    <span className="text-[12px] text-muted">缓存命中率</span>
                    <span className="font-mono text-[13px] tabular-nums text-text-soft">
                      {usage.hitRate !== undefined ? `${Math.round(usage.hitRate * 100)}%` : '—'}
                    </span>
                  </div>
                </div>
              ) : id === 'context' ? (
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[12px] tabular-nums text-text-soft">
                      ~{formatTokens(contextTokens)}
                    </span>
                    <span className="text-[12px] text-muted">{turnCount} 轮对话</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-4 text-muted">
                    按原会话消息估算，不含系统提示与工具定义。
                  </p>
                </div>
              ) : (
                <div>
                  <div className="mb-1.5 flex items-baseline gap-2 text-[12px] text-text-soft">
                    <span className="tabular-nums">{editedFiles.length} 个文件</span>
                  </div>
                  <div className="space-y-px">
                    {editedFiles.slice(0, 5).map(([file, count]) => (
                      <div key={file} className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px]">
                        <span className="w-2.5 shrink-0 font-mono text-[12px] text-muted">M</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-text-soft" data-tip={file}>
                          {file}
                        </span>
                        <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
                          ×{count}
                        </span>
                      </div>
                    ))}
                    {editedFiles.length > 5 && (
                      <div className="pt-0.5 text-[12px] text-muted">
                        还有 {editedFiles.length - 5} 个文件
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>
          )
        })}
      </PanelBody>

      <div className="shrink-0 border-t border-border px-4 py-2.5 text-[12px] leading-4 text-muted">
        原文件只读；导入为 Tandem 会话后可继续对话。
      </div>
    </aside>
  )
}
