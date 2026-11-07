import { describe, expect, test } from 'vitest'
import {
  fileBaseName,
  isAnchorHref,
  isExternalHref,
  isImagePath,
  isMarkdownPath,
  lineLabel,
  normalizeFileRefPath,
  parseFileHref,
  parseInlinePath,
  splitFileRefs,
} from './fileLinks'

describe('normalizeFileRefPath', () => {
  test('Windows 盘符四种写法统一为 D:/', () => {
    expect(normalizeFileRefPath('D:\\repo\\a.ts')).toBe('D:/repo/a.ts')
    expect(normalizeFileRefPath('D:/repo/a.ts')).toBe('D:/repo/a.ts')
    expect(normalizeFileRefPath('/D:/repo/a.ts')).toBe('D:/repo/a.ts')
    expect(normalizeFileRefPath('file:///D:/repo/a.ts')).toBe('D:/repo/a.ts')
  })

  test('file URL 解码中文与空格', () => {
    expect(normalizeFileRefPath('file:///tmp/%E4%B8%AD%E6%96%87%20a.md')).toBe(
      '/tmp/中文 a.md',
    )
  })

  test('posix 反斜杠也统一（前端展示用）', () => {
    expect(normalizeFileRefPath('src\\a.ts')).toBe('src/a.ts')
  })
})

describe('parseFileHref', () => {
  test('Markdown 文件链接与行号后缀', () => {
    expect(parseFileHref('src/a.ts:12-14')).toEqual({
      path: 'src/a.ts',
      lineStart: 12,
      lineEnd: 14,
    })
    expect(parseFileHref('src/a.ts#L3-L5')).toEqual({
      path: 'src/a.ts',
      lineStart: 3,
      lineEnd: 5,
    })
    expect(parseFileHref('src/a.ts#L7')).toEqual({ path: 'src/a.ts', lineStart: 7 })
  })

  test('Windows 路径带盘符和行号', () => {
    expect(parseFileHref('C:\\repo\\a.ts:5')).toEqual({
      path: 'C:/repo/a.ts',
      lineStart: 5,
    })
  })

  test('外链、页内锚点、javascript 与空路径不当作文件', () => {
    expect(parseFileHref('https://example.com/a.ts')).toBeNull()
    expect(parseFileHref('mailto:a@b.c')).toBeNull()
    expect(parseFileHref('#section')).toBeNull()
    expect(parseFileHref('#L12')).toBeNull()
    expect(parseFileHref('javascript:alert(1)')).toBeNull()
    expect(parseFileHref('')).toBeNull()
  })

  test('percent 编码的普通链接会解码', () => {
    expect(parseFileHref('docs/%E4%B8%AD%E6%96%87.md')).toEqual({ path: 'docs/中文.md' })
  })
})

describe('parseInlinePath / splitFileRefs', () => {
  test('行内代码整段是路径时识别', () => {
    expect(parseInlinePath('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parseInlinePath('./docs/readme.md:2-4')).toEqual({
      path: './docs/readme.md',
      lineStart: 2,
      lineEnd: 4,
    })
    expect(parseInlinePath('/tmp/a.ts')).toEqual({ path: '/tmp/a.ts' })
    expect(parseInlinePath('hello/world')).toBeNull()
    expect(parseInlinePath('https://example.com/a.ts')).toBeNull()
    expect(parseInlinePath('a.ts b.ts')).toBeNull()
  })

  test('纯文本中的路径切分，中文标点不进入路径', () => {
    const segments = splitFileRefs('看 src/a.ts:3 和 docs/readme.md。')
    expect(segments).toHaveLength(5)
    expect(segments[0]).toBe('看 ')
    expect(segments[1]).toEqual({
      ref: { path: 'src/a.ts', lineStart: 3 },
      text: 'src/a.ts:3',
    })
    expect(segments[2]).toBe(' 和 ')
    expect(segments[3]).toEqual({
      ref: { path: 'docs/readme.md' },
      text: 'docs/readme.md',
    })
    expect(segments[4]).toBe('。')
  })

  test('普通文本不产生文件引用', () => {
    expect(splitFileRefs('普通文本，没有路径。')).toEqual(['普通文本，没有路径。'])
    expect(parseInlinePath('https://example.com/a.ts')).toBeNull()
  })
})

test('路径分类与展示辅助', () => {
  expect(isExternalHref('HTTPS://x')).toBe(true)
  expect(isExternalHref('src/a.ts')).toBe(false)
  expect(isAnchorHref('#intro')).toBe(true)
  expect(isAnchorHref('#L12')).toBe(false)
  expect(isImagePath('a/b.PNG')).toBe(true)
  expect(isMarkdownPath('a/b.md')).toBe(true)
  expect(fileBaseName('C:\\repo\\a.ts')).toBe('a.ts')
  expect(fileBaseName('/tmp/a.ts')).toBe('a.ts')
  expect(lineLabel({ lineStart: 3, lineEnd: 3 })).toBe('3')
  expect(lineLabel({ lineStart: 3, lineEnd: 5 })).toBe('3-5')
  expect(lineLabel({})).toBe('')
})
