import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import { remarkHardBreaks, remarkMathNodes } from './markdownMath'

type Hast = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Hast[]
}

function toHast(text: string, hardBreaks = false) {
  const processor = unified().use(remarkParse).use(remarkMath).use(remarkMathNodes)
  if (hardBreaks) processor.use(remarkHardBreaks)
  const tree = processor.runSync(processor.parse(text))
  return unified().use(remarkRehype).runSync(tree as never) as Hast
}

function findAll(node: Hast, tagName: string, out: Hast[] = []): Hast[] {
  if (node.tagName === tagName) out.push(node)
  for (const child of node.children ?? []) findAll(child, tagName, out)
  return out
}

describe('markdownMath', () => {
  it('行内与块级公式换成自定义标签并保留 TeX 原文', () => {
    const tree = toHast('行内 $a^2+b^2$ 与块级：\n\n$$\n\\frac{1}{2}\n$$')
    const inline = findAll(tree, 'math-inline')
    const block = findAll(tree, 'math-block')
    expect(inline).toHaveLength(1)
    expect(inline[0]!.properties?.['data-tex']).toBe('a^2+b^2')
    expect(block).toHaveLength(1)
    expect(block[0]!.properties?.['data-tex']).toBe('\\frac{1}{2}')
  })

  it('代码块与行内代码里的 $ 不当作公式', () => {
    const tree = toHast('`价格 $5`\n\n```sh\necho $\n```')
    expect(findAll(tree, 'math-inline')).toHaveLength(0)
    expect(findAll(tree, 'math-block')).toHaveLength(0)
  })

  it('用户消息的单个换行渲染为换行，助手消息保持段落折行', () => {
    const source = '第一行\n第二行\n\n另一段'
    const user = toHast(source, true)
    const firstParagraph = (user.children ?? []).find((node) => node.tagName === 'p')
    expect(findAll(firstParagraph!, 'br').length).toBe(1)
    const assistant = toHast(source)
    expect(findAll(assistant, 'br')).toHaveLength(0)
  })
})
