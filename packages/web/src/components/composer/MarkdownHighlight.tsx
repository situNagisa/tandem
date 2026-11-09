import type { ReactNode } from 'react'
import { FENCE_RE } from './markdownInput'

/**
 * 输入框背后的 Markdown 轻量着色层。
 * 只改颜色、不改字体度量（字号/字重/字距），保证与 textarea 的光标和换行严格对齐。
 */
function inlineNodes(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g)
  return parts.map((part, index) => {
    if (!part) return null
    let className = ''
    if (/^`[^`\n]+`$/.test(part)) className = 'md-hl-inline-code'
    else if (/^\*\*[^*\n]+\*\*$/.test(part)) className = 'md-hl-strong'
    else if (/^\*[^*\n]+\*$/.test(part)) className = 'md-hl-em'
    else if (/^\[[^\]\n]+\]\([^)\n]+\)$/.test(part)) className = 'md-hl-link'
    return (
      <span key={index} className={className || undefined}>
        {part}
      </span>
    )
  })
}

function lineNodes(line: string): ReactNode {
  const heading = /^(\s{0,3})(#{1,6})(\s+)(.*)$/.exec(line)
  if (heading) {
    return (
      <>
        <span className="md-hl-mark">{heading[1] + heading[2] + heading[3]}</span>
        <span className="md-hl-heading">{inlineNodes(heading[4])}</span>
      </>
    )
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return <span className="md-hl-mark">{line}</span>
  }
  const quote = /^(\s{0,3}(?:>\s?)+)(.*)$/.exec(line)
  if (quote) {
    return (
      <>
        <span className="md-hl-mark">{quote[1]}</span>
        <span className="md-hl-quote">{inlineNodes(quote[2])}</span>
      </>
    )
  }
  const list = /^(\s{0,3})([-*+]|\d+[.)])(\s+)(.*)$/.exec(line)
  if (list) {
    const task = /^(\[[ xX]\]\s+)(.*)$/.exec(list[4])
    return (
      <>
        <span className="md-hl-mark">{list[1] + list[2] + list[3]}</span>
        {task ? (
          <>
            <span className="md-hl-mark">{task[1]}</span>
            {inlineNodes(task[2])}
          </>
        ) : (
          inlineNodes(list[4])
        )}
      </>
    )
  }
  return <>{inlineNodes(line)}</>
}

export function MarkdownHighlight({ text }: { text: string }) {
  if (!text) return null
  const lines = text.split('\n')
  const nodes: ReactNode[] = []
  let inCode = false
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      nodes.push(
        <span key={`f${index}`} className="md-hl-fence">
          {line}
        </span>,
      )
      inCode = !inCode
    } else if (inCode) {
      nodes.push(
        <span key={`c${index}`} className="md-hl-code">
          {line}
        </span>,
      )
    } else {
      nodes.push(<span key={`l${index}`}>{lineNodes(line)}</span>)
    }
    if (index < lines.length - 1) nodes.push('\n')
  })
  // 末尾空行也要占一行高度，否则光标会跑到着色层外。
  nodes.push('\u200b')
  return <>{nodes}</>
}
