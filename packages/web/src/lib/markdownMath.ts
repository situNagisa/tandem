// Markdown 渲染前的两个 remark 变换：数学公式换成自定义标签、用户消息换行即换行。
// 只处理 mdast 文本层，代码块与行内代码里的 `$`、换行不受影响。

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

/**
 * remark-math 产出 `inlineMath` / `math` 节点；换成 `<math-inline>` / `<math-block>`
 * 两个自定义标签，由 Markdown 的 components 渲染成 KaTeX（按需加载，见 MathTex）。
 */
export function remarkMathNodes() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children) return
      node.children = node.children.map((child) => {
        if (child.type === 'inlineMath' || child.type === 'math') {
          const block = child.type === 'math'
          const tex = child.value ?? ''
          return {
            type: block ? 'mathBlock' : 'mathInline',
            data: {
              hName: block ? 'math-block' : 'math-inline',
              hProperties: { 'data-tex': tex },
            },
            children: [{ type: 'text', value: tex }],
          }
        }
        walk(child)
        return child
      })
    }
    walk(tree)
  }
}

/**
 * 用户消息的「换行即换行」：段落里的单个换行按换行显示（remark-breaks 的等价实现）。
 * 助手消息不启用；发送给模型的原文不变，只是渲染层。
 */
export function remarkHardBreaks() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children) return
      const next: MdNode[] = []
      for (const child of node.children) {
        if (child.type === 'text' && child.value?.includes('\n')) {
          child.value.split('\n').forEach((part, index) => {
            if (index > 0) next.push({ type: 'break' })
            if (part) next.push({ ...child, value: part })
          })
          continue
        }
        walk(child)
        next.push(child)
      }
      node.children = next
    }
    walk(tree)
  }
}
