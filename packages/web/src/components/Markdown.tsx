import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeftRight, FileText } from 'lucide-react'
import { cn } from '../lib/cn'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useHorizontalOverflow } from '../lib/hooks'
import {
  isAnchorHref,
  isExternalHref,
  parseFileHref,
  parseInlinePath,
  splitFileRefs,
  type FileRef,
} from '../lib/fileLinks'
import { CodeBlock } from './CodeBlock'

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

function codeInfo(children: ReactNode): { code: string; language?: string } | null {
  // 自定义 code 组件接走后，pre 的子元素类型不再是 'code'，按 props 判断即可。
  if (!isValidElement(children)) return null
  const props = children.props as { className?: string; children?: ReactNode }
  const code = nodeText(props.children).replace(/\n$/, '')
  if (!code) return null
  const match = /language-([\w-]+)/.exec(props.className ?? '')
  return { code, language: match?.[1] }
}

export function openFileRef(ref: FileRef, cwd?: string): void {
  const fallback = useAppStore.getState().active?.summary?.cwd ?? ''
  useUiStore.getState().openFilePreview({
    path: ref.path,
    cwd: cwd || fallback,
    ...(ref.lineStart ? { lineStart: ref.lineStart } : {}),
    ...(ref.lineEnd ? { lineEnd: ref.lineEnd } : {}),
  })
}

/** 把消息里的纯文本路径也变成文件链接，不改动代码、既有链接与行内代码。 */
function remarkFileLinks() {
  return (tree: unknown) => {
    const walk = (node: { type?: string; children?: unknown[] }) => {
      if (!node || !Array.isArray(node.children)) return
      if (
        node.type === 'link' ||
        node.type === 'linkReference' ||
        node.type === 'code' ||
        node.type === 'inlineCode' ||
        node.type === 'html'
      ) {
        return
      }
      const next: unknown[] = []
      for (const child of node.children as Array<{ type?: string; value?: string }>) {
        if (child?.type === 'text' && typeof child.value === 'string') {
          for (const segment of splitFileRefs(child.value)) {
            if (typeof segment === 'string') {
              if (segment) next.push({ type: 'text', value: segment })
            } else {
              next.push({
                type: 'link',
                url: segment.text,
                children: [{ type: 'text', value: segment.text }],
              })
            }
          }
        } else {
          walk(child as { type?: string; children?: unknown[] })
          next.push(child)
        }
      }
      node.children = next
    }
    walk(tree as { type?: string; children?: unknown[] })
  }
}

/** 表格：可横向滚动、带渐隐与滚动提示；宽度铺满对话列（反馈 #7-02）。 */
function MarkdownTable({ children }: { children?: ReactNode }) {
  const { ref, canLeft, canRight, update } = useHorizontalOverflow<HTMLDivElement>()
  return (
    <div className="md-table-wrap x-scroll-wrap">
      <div ref={ref} onScroll={update} className="md-table-scroll">
        <table>{children}</table>
      </div>
      <div className="x-scroll-fade" data-visible={canRight} aria-hidden />
      {canLeft || canRight ? (
        <div className="x-scroll-more" data-visible={canRight} aria-hidden>
          <ArrowLeftRight size={10} /> 横向滚动
        </div>
      ) : null}
    </div>
  )
}

function makeComponents(streaming: boolean, cwd?: string): Components {
  return {
    pre({ children }) {
      const info = codeInfo(children)
      if (!info) return <pre>{children}</pre>
      return (
        <CodeBlock
          code={info.code}
          language={info.language}
          className="my-4"
          streaming={streaming}
        />
      )
    },
    table({ children }) {
      return <MarkdownTable>{children}</MarkdownTable>
    },
    a({ href, children }) {
      const url = href ?? ''
      if (isExternalHref(url)) {
        return (
          <a href={url} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }
      if (isAnchorHref(url)) return <a href={url}>{children}</a>
      const ref = parseFileHref(url)
      if (!ref) return <span>{children}</span>
      const label = ref.lineStart
        ? `${ref.path}:${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `${ref.lineStart}-${ref.lineEnd}` : ref.lineStart}`
        : ref.path
      return (
        <a
          href={url}
          data-tip={`打开 ${label}`}
          onClick={(e) => {
            e.preventDefault()
            openFileRef(ref, cwd)
          }}
          className="file-ref"
        >
          <FileText size={12} className="file-ref-icon" aria-hidden />
          {children}
        </a>
      )
    },
    code({ className, children }) {
      if ((className ?? '').includes('language-')) {
        return <code className={className}>{children}</code>
      }
      const text = nodeText(children)
      const ref = parseInlinePath(text)
      if (!ref) return <code className={className}>{children}</code>
      const open = () => openFileRef(ref, cwd)
      return (
        <code
          className={cn(className, 'file-ref-inline')}
          role="link"
          tabIndex={0}
          data-tip={`打开 ${text}`}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              open()
            }
          }}
        >
          {children}
        </code>
      )
    },
  }
}

const REMARK_PLUGINS = [remarkGfm, remarkFileLinks]

/**
 * 流式时按动画帧合并 delta；文本越长渲染间隔越大，避免整段 Markdown
 * 被每个 token 重解析（短文本约 20fps，长文本约 8–12fps）。
 */
function useStreamingText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text)
  const shownRef = useRef(text)
  shownRef.current = shown
  const lastCommit = useRef(0)

  useEffect(() => {
    if (!streaming) {
      if (shownRef.current !== text) setShown(text)
      return
    }
    if (shownRef.current === text) return
    let raf = 0
    const interval = text.length > 8000 ? 120 : text.length > 3000 ? 80 : 48
    const tick = () => {
      const now = performance.now()
      if (now - lastCommit.current >= interval) {
        lastCommit.current = now
        setShown(text)
      } else {
        raf = window.requestAnimationFrame(tick)
      }
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [text, streaming])

  return streaming ? shown : text
}

interface Chunk {
  start: number
  text: string
}

/**
 * 把流式 Markdown 按空行切成块，已完成块用 memo 缓存，只重解析最后一块。
 * 只在语义安全的空行处切：不切代码围栏、引用、列表（列表后的新段落可以切）。
 */
function splitChunks(text: string): Chunk[] {
  const lines = text.split('\n')
  const chunks: Chunk[] = []
  let startOffset = 0
  let offset = 0
  let fence: string | null = null
  let prevNonBlank = ''

  const push = () => {
    const end = offset
    if (end > startOffset) chunks.push({ start: startOffset, text: text.slice(startOffset, end) })
    startOffset = end
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    offset += line.length + 1
    const trimmed = line.trimStart()
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      prevNonBlank = line
      continue
    }
    if (!line.trim() && !fence) {
      // 下一个非空行决定这里是不是安全边界
      let next = ''
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          next = lines[j]
          break
        }
      }
      if (!next) continue
      const nextTrim = next.trimStart()
      const nextIndented = /^\s{2,}/.test(next)
      const nextList = /^(?:[-*+]|\d+[.)])\s/.test(nextTrim)
      const prevList = /^(?:[-*+]|\d+[.)])\s/.test(prevNonBlank.trimStart())
      const prevQuote = prevNonBlank.trimStart().startsWith('>')
      const safe =
        !!prevNonBlank &&
        !nextIndented &&
        !prevQuote &&
        !(prevList && nextList)
      if (safe) push()
      continue
    }
    if (line.trim()) prevNonBlank = line
  }
  if (startOffset < text.length) chunks.push({ start: startOffset, text: text.slice(startOffset) })
  return chunks.length ? chunks : [{ start: 0, text }]
}

const MarkdownChunk = memo(function MarkdownChunk({
  text,
  streaming,
  cwd,
}: {
  text: string
  streaming: boolean
  cwd?: string
}) {
  const components = useMemo(() => makeComponents(streaming, cwd), [streaming, cwd])
  return (
    <div className={cn('md-chunk', streaming && 'is-streaming')}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        urlTransform={(url) => url}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
  cwd,
}: {
  text: string
  /** 流式输出时在最后一段尾部显示闪烁光标。 */
  streaming?: boolean
  className?: string
  /** 文件链接的解析基准（外部会话传入该会话 cwd，默认活动会话 cwd）。 */
  cwd?: string
}) {
  const shown = useStreamingText(text, streaming)
  const chunks = useMemo(
    () => (streaming ? splitChunks(shown) : [{ start: 0, text: shown }]),
    [shown, streaming],
  )
  return (
    <div className={cn('md chat-md', streaming && 'is-streaming', className)}>
      {chunks.map((chunk, i) =>
        chunk.text ? (
          <MarkdownChunk
            key={chunk.start}
            text={chunk.text}
            streaming={streaming && i === chunks.length - 1}
            cwd={cwd}
          />
        ) : null,
      )}
    </div>
  )
})
