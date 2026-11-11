import { describe, expect, it } from 'vitest'
import { pathTokens, registerToken, tokenDeleteRange } from './richEditor'

describe('输入框 @ 路径标记', () => {
  it('只显示名字，模型范围保留完整路径（文件与文件夹）', () => {
    registerToken('src/hello.ts')
    registerToken('src/')
    const source = '看 src/hello.ts 和 src/ '
    const tokens = pathTokens(source)
    const file = tokens.find((token) => token.src === 'src/hello.ts')!
    expect(file.name).toBe('hello.ts')
    expect(file.dir).toBe(false)
    expect(source.slice(file.from, file.to)).toBe('src/hello.ts')
    const folder = tokens.find((token) => token.src === 'src/')!
    expect(folder.name).toBe('src/')
    expect(folder.dir).toBe(true)
  })

  it('未选中过的路径不当成标记', () => {
    expect(pathTokens('@src/h')).toEqual([])
  })

  it('补全插入过的路径删掉尾随空格后仍是标记', () => {
    registerToken('src/hello.ts')
    const tokens = pathTokens('src/hello.ts')
    expect(tokens[0]).toMatchObject({ name: 'hello.ts', src: 'src/hello.ts' })
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

  it('同一段文本重复读取时返回缓存结果', () => {
    registerToken('src/hello.ts')
    const first = pathTokens('看 src/hello.ts')
    const second = pathTokens('看 src/hello.ts')
    expect(second).toBe(first)
  })
})
