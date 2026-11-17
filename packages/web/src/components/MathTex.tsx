import { useEffect, useMemo, useState } from 'react'
import type { KatexOptions } from 'katex'

type KatexModule = { renderToString: (tex: string, options?: KatexOptions) => string }

// KaTeX 只在页面里第一次出现公式时加载（JS 与字体样式各一个独立 chunk），
// 普通会话不下载；多个公式共用同一个 Promise。
let katexModule: Promise<KatexModule> | null = null
function loadKatex(): Promise<KatexModule> {
  katexModule ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([mod]) => {
    const resolved = (mod as { default?: KatexModule }).default ?? (mod as KatexModule)
    return resolved
  })
  return katexModule
}

/**
 * 一处公式。块级公式过宽时在公式内部横向滚动，不撑开正文；
 * 加载中或 TeX 无法解析时显示源码文本。
 */
export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [katex, setKatex] = useState<KatexModule | null>(null)
  useEffect(() => {
    let alive = true
    loadKatex()
      .then((mod) => {
        if (alive) setKatex(mod)
      })
      .catch(() => {
        // 加载失败保持源码
      })
    return () => {
      alive = false
    }
  }, [])
  const html = useMemo(() => {
    if (!katex) return ''
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      })
    } catch {
      return ''
    }
  }, [katex, tex, display])
  const className = display ? 'md-math md-math-block' : 'md-math md-math-inline'
  if (!html) {
    return (
      <span className={className} data-math-pending="true">
        {tex}
      </span>
    )
  }
  return (
    <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
