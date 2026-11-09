import { useEffect, useRef, useState } from 'react'
import type { FsReadResult } from '@tandem/protocol'
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { useIsMobile } from '../lib/hooks'
import { Button, IconButton } from './ui/Button'
import { SegmentedControl } from './ui/Controls'
import { PanelBar, PanelBody } from './ui/Panel'
import { ResizeHandle } from './ui/ResizeHandle'
import { isLocalHostUrl } from '../lib/hostUrl'
import { isRelayHost } from '../lib/relay'
import {
  fileBaseName,
  isImagePath,
  isMarkdownPath,
  lineLabel,
  normalizeFileRefPath,
} from '../lib/fileLinks'
import { CodeBlock } from './CodeBlock'
import { Markdown } from './Markdown'
import { FileBrowser } from './FileBrowser'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 服务端 404 时拿不到解析结果，客户端按 主机平台规则拼出绝对路径供用户判断。 */
function resolveAbsolute(path: string, cwd: string, platform?: string): string {
  const raw = normalizeFileRefPath(path)
  if (!raw) return ''
  const win = platform === 'win32'
  if (win ? /^[A-Za-z]:\//.test(raw) : raw.startsWith('/')) return raw
  if (!cwd) return raw
  const base = normalizeFileRefPath(cwd).replace(/\/+$/, '')
  return `${base}/${raw.replace(/^\/+/, '')}`
}

export function FilePreviewPanel({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile()
  const preview = useUiStore((s) => s.filePreview)
  const widthPref = useUiStore((s) => s.filePreviewWidth)
  const setWidth = useUiStore((s) => s.setFilePreviewWidth)
  const browserVisible = useUiStore((s) => s.fileBrowserVisible)
  const setBrowserVisible = useUiStore((s) => s.setFileBrowserVisible)
  const browserWidthPref = useUiStore((s) => s.fileBrowserWidth)
  const setBrowserWidth = useUiStore((s) => s.setFileBrowserWidth)
  const toast = useUiStore((s) => s.toast)
  const hostId = useAppStore((s) => s.active?.hostId ?? s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const hostPlatform = useAppStore((s) => (hostId ? s.runtimes[hostId]?.info?.platform : undefined))

  const [data, setData] = useState<FsReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [dragTreeWidth, setDragTreeWidth] = useState<number | null>(null)
  const copyTimer = useRef<number | null>(null)

  const path = preview?.path ?? ''
  const cwd = preview?.cwd ?? ''
  const absPath = data?.path ?? (path ? resolveAbsolute(path, cwd, hostPlatform) : '')
  const image = isImagePath(absPath)
  const markdown = isMarkdownPath(absPath)
  const label = lineLabel(preview ?? {})

  // 中继主机的 token 在密文里，不能直接把 URL 交给 <img>，先取回内容再转 blob URL。
  useEffect(() => {
    if (!host || !image || !absPath) {
      setImageUrl('')
      return
    }
    if (!isRelayHost(host)) {
      setImageUrl(api.fsRawUrl(host, absPath, cwd || undefined))
      return
    }
    let cancelled = false
    let objectUrl = ''
    setImageUrl('')
    api
      .fsRawBlob(host, absPath, cwd || undefined)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setImageUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setImageUrl('')
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [host, image, absPath, cwd, retryNonce])

  useEffect(() => {
    if (!host || !path) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    api
      .fsRead(host, path, cwd || undefined)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取文件失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, path, cwd, retryNonce])

  useEffect(() => {
    setMode('preview')
  }, [path])

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!preview) return null

  const width = dragWidth ?? widthPref

  const copyPath = async () => {
    if (!absPath) return
    if (!(await copyText(absPath))) {
      toast('复制失败', 'error')
      return
    }
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const reveal = async () => {
    if (!host || !absPath || revealing) return
    setRevealing(true)
    try {
      const result = await api.fsReveal(host, absPath)
      if (result.ok) toast('已在主机上打开文件位置', 'success')
      else toast(result.error || '主机无法打开文件位置', 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : '打开失败', 'error')
    } finally {
      setRevealing(false)
    }
  }

  const highlightRange = preview.lineStart
    ? { start: preview.lineStart, end: preview.lineEnd ?? preview.lineStart }
    : undefined

  return (
    <aside
      className="relative flex h-full min-h-0 w-full flex-col border-l border-border bg-sidebar"
      style={{ width: isMobile ? '100%' : width, transition: dragWidth !== null ? 'none' : undefined }}
    >
      {!isMobile && (
        <ResizeHandle
          value={widthPref}
          min={380}
          max={900}
          edge="left"
          onChange={setDragWidth}
          onCommit={(next) => {
            setWidth(next)
            setDragWidth(null)
          }}
          resetValue={560}
          label="调整文件预览宽度"
        />
      )}

      <PanelBar
        icon={<FileText size={15} />}
        actions={
          <>
            {cwd && !isMobile && (
              <SegmentedControl
                aria-label="文件浏览器"
                size="sm"
                value={browserVisible ? 'tree' : 'preview'}
                onChange={(value) => setBrowserVisible(value === 'tree')}
                options={[
                  { value: 'preview', label: '仅预览' },
                  { value: 'tree', label: '树+预览' },
                ]}
              />
            )}
            {markdown && data && !data.isBinary && (
              <SegmentedControl
                aria-label="文件视图"
                size="sm"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'preview', label: <><Eye size={11} /> 预览</> },
                  { value: 'source', label: <><Code2 size={11} /> 源码</> },
                ]}
              />
            )}
            {host && isLocalHostUrl(host.url) && (
              <IconButton
                size="sm"
                onClick={() => void reveal()}
                disabled={revealing || !data}
                label="在本机打开"
                tooltip="在主机的文件管理器中显示"
                className="max-md:size-11"
              >
                {revealing ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
              </IconButton>
            )}
            <IconButton
              size="sm"
              onClick={() => void copyPath()}
              label="复制文件路径"
              tooltip={copied ? '已复制' : `复制路径：${absPath || path}`}
              className="max-md:size-11"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </IconButton>
            <IconButton onClick={onClose} label="关闭文件预览" className="-mr-1 max-md:size-11">
              <X size={15} />
            </IconButton>
          </>
        }
      >
        <span
          className="min-w-0 truncate font-mono text-[13px] text-text"
          data-tip={absPath || path || '文件预览'}
        >
          {fileBaseName(path || absPath) || '文件'}
        </span>
        {label && (
          <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1.5 py-px font-mono text-[12px] text-text-secondary">
            :{label}
          </span>
        )}
      </PanelBar>

      <PanelBody row>
        {browserVisible && !isMobile && cwd && host && (
          <>
            <div
              className="min-h-0 shrink-0 border-r border-border"
              style={{ width: dragTreeWidth ?? browserWidthPref }}
            >
              <FileBrowser
                host={host}
                cwd={cwd}
                selectedPath={normalizeFileRefPath(absPath)}
                onPick={(picked) => useUiStore.getState().openFilePreview({ path: picked, cwd })}
              />
            </div>
            <ResizeHandle
              inline
              value={browserWidthPref}
              min={160}
              max={360}
              edge="right"
              onChange={setDragTreeWidth}
              onCommit={(next) => {
                setBrowserWidth(next)
                setDragTreeWidth(null)
              }}
              resetValue={220}
              label="调整文件树宽度"
            />
          </>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {!path && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <FileText size={26} className="text-muted/50" />
              <p className="text-[13px] font-medium text-text-soft">从左侧文件树选择文件</p>
              <p className="text-[12px] text-muted">点击文件即可在右侧预览</p>
            </div>
          )}
          {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileText size={26} className="text-muted/50" />
          <p className="text-[13px] font-medium text-text-soft">无法打开这个文件</p>
          <p className="max-w-[420px] text-[12px] leading-5 text-danger">{error}</p>
          <p className="max-w-full break-all rounded-md bg-[var(--t-bg-subtle)] px-2 py-1 font-mono text-[12px] text-text-secondary">
            {absPath}
          </p>
          <Button size="sm" onClick={() => setRetryNonce((n) => n + 1)} className="mt-1">
            <RotateCcw size={11} /> 重试
          </Button>
        </div>
      ) : data ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {data.truncated && (
            <div className="shrink-0 border-b border-border/70 bg-[var(--t-bg-subtle)] px-3 py-1.5 text-[12px] text-text-secondary">
              文件较大（{formatSize(data.size)}），仅显示前 1 MB。
            </div>
          )}
          {image ? (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
              <img
                src={imageUrl}
                alt={fileBaseName(absPath)}
                className="max-h-full max-w-full rounded-lg border border-border object-contain"
              />
            </div>
          ) : data.isBinary ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <ImageIcon size={26} className="text-muted/50" />
              <p className="text-[13px] font-medium text-text-soft">二进制文件</p>
              <p className="text-[13px] text-muted">
                无法以文本预览（{formatSize(data.size)}）
              </p>
            </div>
          ) : markdown && mode === 'preview' ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6">
              <Markdown text={data.content} cwd={cwd} className="file-preview-md" />
            </div>
          ) : (
            <div className="min-h-0 flex-1 p-3">
              <CodeBlock
                code={data.content}
                language={data.language}
                showHeader={false}
                maxHeight={null}
                lineNumbers
                highlightRange={highlightRange}
                scrollToLine={preview.lineStart}
                fill
                className="h-full"
              />
            </div>
          )}
        </div>
      ) : null}
        </div>
      </PanelBody>
    </aside>
  )
}
