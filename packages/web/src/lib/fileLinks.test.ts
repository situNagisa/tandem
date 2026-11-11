import { describe, expect, test } from 'vitest'
import {
  extractInlineRefs,
  fileBaseName,
  isAnchorHref,
  isExternalHref,
  isImagePath,
  isMarkdownPath,
  lineLabel,
  normalizeFileRefPath,
  parseFileHref,
  parseInlinePath,
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

describe('parseInlinePath / extractInlineRefs', () => {
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

  test('只收行内代码里的路径，纯文本里的文件名不识别（反馈0220#04）', () => {
    expect(
      extractInlineRefs(
        'menu.cpp中 去掉.cpp中的unique_ptr；`src/a.ts:3` 和 `D:\\repo\\b.txt` 与 `菜单.cpp`。',
      ),
    ).toEqual([
      { path: 'src/a.ts', lineStart: 3 },
      { path: 'D:/repo/b.txt' },
    ])
    expect(extractInlineRefs('menu.cpp、.cpp、.cppm、unique_ptr 都不是链接')).toEqual([])
    expect(extractInlineRefs('见 `src/a.ts` 与 `src/a.ts`，只出现一次')).toEqual([
      { path: 'src/a.ts' },
    ])
  })

  test('句中斜杠（通/断、和/或、A/B、1/2、km/h）不是文件路径', () => {
    for (const text of [
      '3. 状态不只是通 /断：设阈值并平滑',
      '通/断时怎么判断可达',
      '延迟和/或丢包都要看',
      'A/B 测试',
      '速度 80km/h',
      '比例 1/2',
      '中文/英文',
    ]) {
      // 纯文本一律不扫描（反馈0220#04）；行内代码里的形状候选还要过「文件确实存在」这一关
      expect(extractInlineRefs(`这些不是路径：${text}`)).toEqual([])
    }
    expect(parseInlinePath('/断时怎么判断可达')).toBeNull()
    expect(parseInlinePath('/或')).toBeNull()
  })

  test('真实路径形状仍然识别（扩展名、多段、显式根、盘符）', () => {
    expect(parseInlinePath('/home/x/y.md')).toEqual({ path: '/home/x/y.md' })
    expect(parseInlinePath('/etc/hosts')).toEqual({ path: '/etc/hosts' })
    expect(parseInlinePath('~/.tandem/config')).toEqual({ path: '~/.tandem/config' })
    expect(parseInlinePath('./build')).toEqual({ path: './build' })
    expect(parseInlinePath('C:\\a\\b.txt')).toEqual({ path: 'C:/a/b.txt' })
    expect(parseInlinePath('C:\\a\\b.txt:12')).toEqual({ path: 'C:/a/b.txt', lineStart: 12 })
    expect(extractInlineRefs('见 `/home/x/y.md` 与 `C:\\a\\b.txt`。')).toEqual([
      { path: '/home/x/y.md' },
      { path: 'C:/a/b.txt' },
    ])
  })

  test('普通文本不产生文件引用', () => {
    expect(extractInlineRefs('普通文本，没有路径。')).toEqual([])
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
