import { useState } from 'react'
import type { ToolOutputTruncation } from '@tandem/protocol'
import { formatBytes } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'

export function OutputBlock({
  text,
  isError,
  running,
  maxHeight = 300,
  truncated,
  onLoadFull,
}: {
  text: string
  isError?: boolean
  running?: boolean
  maxHeight?: number
  /** 服务端分页只下发了首尾片段时，提供“显示全部”。 */
  truncated?: ToolOutputTruncation
  onLoadFull?: () => Promise<string | null>
}) {
  const [full, setFull] = useState<string | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!text && !full) {
    return (
      <div className="px-1 py-1 text-[12px] text-muted">
        {running ? <span className="shimmer-text">等待输出…</span> : '无输出'}
      </div>
    )
  }
  const raw = full ?? text
  const shown =
    raw.length > 2_000_000 ? raw.slice(0, 2_000_000) + '\n…（输出超过 2MB，已截断显示）' : raw
  const loadFull = async () => {
    if (!onLoadFull || loadingFull) return
    setLoadingFull(true)
    setFailed(false)
    try {
      const content = await onLoadFull()
      if (content === null) setFailed(true)
      else setFull(content)
    } catch {
      setFailed(true)
    } finally {
      setLoadingFull(false)
    }
  }
  return (
    <>
      <div
        className={cn('tool-output', isError && 'is-error')}
        style={{ maxHeight }}
      >
      {shown.split(/(\[secret:[A-Za-z0-9_-]+\])/g).map((part, index) => {
        const match = /^\[secret:([A-Za-z0-9_-]+)\]$/.exec(part)
        if (!match) return part
        const name = match[1]!
        return (
          <Tooltip key={index} label={`已隐藏 secret：${name}`} className="inline">
            <span
              data-secret-redacted={name}
              className="mx-px inline-flex items-center rounded border border-warning/30 bg-warning-soft/50 px-1 font-mono text-[11px] leading-[16px] text-warning"
            >
              {part}
            </span>
          </Tooltip>
        )
      })}
      </div>
      {truncated && !full && (
        <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-[11.5px] text-muted">
          <span>已省略 {formatBytes(truncated.omittedBytes, { space: false, roundKb: true })}</span>
          {onLoadFull && (
            <Button
              size="inline"
              variant="ghost"
              disabled={loadingFull}
              onClick={() => void loadFull()}
            >
              {loadingFull ? '加载中…' : `显示全部（原 ${formatBytes(truncated.totalBytes, { space: false, roundKb: true })}）`}
            </Button>
          )}
          {failed && <span className="text-danger">加载失败，请重试</span>}
        </div>
      )}
    </>
  )
}

