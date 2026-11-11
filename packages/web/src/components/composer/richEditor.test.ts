import { describe, expect, it } from 'vitest'
import { parseEditor, registerToken, tokenDeleteRange } from './richEditor'

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

  it('已选路径只显示名字，模型长度保留完整路径', () => {
    registerToken('src/hello.ts')
    registerToken('src/')
    const source = '看 src/hello.ts 和 src/ '
    const runs = parseEditor(source)[0]!.runs
    const file = runs.find((run) => run.src === 'src/hello.ts')!
    expect(file.text).toBe('hello.ts')
    expect(file.len).toBe(12)
    expect(file.title).toBe('src/hello.ts')
    const folder = runs.find((run) => run.src === 'src/')!
    expect(folder.text).toBe('src/')
    expect(folder.len).toBe(4)
  })

  it('未选中过的路径不当成标记', () => {
    const runs = parseEditor('@src/h')[0]!.runs
    expect(runs.some((run) => run.src)).toBe(false)
  })

  it('补全插入过的路径删掉尾随空格后仍是标记', () => {
    registerToken('src/hello.ts')
    const runs = parseEditor('src/hello.ts')[0]!.runs
    expect(runs[0]).toMatchObject({ text: 'hello.ts', src: 'src/hello.ts' })
    expect(tokenDeleteRange('src/hello.ts', 12, 'Backspace')).toEqual({ start: 0, end: 12 })
  })

  it('退格/删除整块移除光标旁的路径标记', () => {
    registerToken('src/hello.ts')
    const text = 'a src/hello.ts b'
    const start = text.indexOf('src/hello.ts')
    const end = start + 'src/hello.ts'.length
    expect(tokenDeleteRange(text, end, 'Backspace')).toEqual({ start, end })
    expect(tokenDeleteRange(text, start, 'Delete')).toEqual({ start, end })
    expect(tokenDeleteRange(text, end + 1, 'Backspace')).toBeNull()
  })
})
