import { describe, expect, it } from 'vitest'
import { parseEditor } from './richEditor'

describe('输入框 Markdown 渲染模型', () => {
  it('代码围栏与代码行使用等宽样式层，原文不变', () => {
    const lines = parseEditor('```ts\nconst a = 1\n```')
    expect(lines.map((line) => line.cls)).toEqual([
      'ce-line-code ce-line-fence',
      'ce-line-code',
      'ce-line-code ce-line-fence',
    ])
    expect(lines.map((line) => line.runs.map((run) => run.text).join('')).join('\n')).toBe(
      '```ts\nconst a = 1\n```',
    )
  })

  it('列表项带序号样式与缩进层级', () => {
    const [first, nested] = parseEditor('1. 第一项\n  - 子项')
    expect(first?.cls).toBe('ce-line-list')
    expect(first?.runs[0]).toMatchObject({ text: '1. ', cls: 'ce-list-mark' })
    expect(nested?.indent).toBe(2)
    expect(nested?.runs[0]).toMatchObject({ text: '  - ', cls: 'ce-list-mark' })
  })

  it('行内代码、粗体、斜体各自成段，源码长度保持', () => {
    const source = '**粗体** *斜体* `code`'
    const line = parseEditor(source)[0]!
    expect(line.runs.filter((run) => run.cls === 'ce-strong').map((run) => run.text)).toEqual(['粗体'])
    expect(line.runs.filter((run) => run.cls === 'ce-em').map((run) => run.text)).toEqual(['斜体'])
    expect(line.runs.filter((run) => run.cls === 'ce-inline-code').map((run) => run.text)).toEqual([
      '`code`',
    ])
    expect(line.runs.map((run) => run.text).join('')).toBe(source)
  })
})
