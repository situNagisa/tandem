import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/cn'
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
  if (!isValidElement(children)) return null
  const props = children.props as { className?: string; children?: ReactNode }
  const code = nodeText(props.children).replace(/\n$/, '')
  if (!code) return null
  const match = /language-([\w-]+)/.exec(props.className ?? '')
  return { code, language: match?.[1] }
}

const components: Components = {
  pre({ children }) {
    const info = codeInfo(children)
    if (!info) return <pre>{children}</pre>
    return <CodeBlock code={info.code} language={info.language} className="my-4" />
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string
  /** 流式输出时在最后一段尾部显示闪烁光标。 */
  streaming?: boolean
  className?: string
}) {
  return (
    <div className={cn('md chat-md', streaming && 'is-streaming', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
