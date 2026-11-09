import { describe, expect, it } from 'vitest'
import { splitHtmlLines } from '../components/CodeBlock'

describe('splitHtmlLines（反馈12#02 换行模式行号对齐）', () => {
  it('每个源码行一段，跨行的高亮标签在行尾闭合、下一行重开', () => {
    const html = '<span class="a">line1</span>\n<span class="b">line2\nline3</span>'
    expect(splitHtmlLines(html)).toEqual([
      '<span class="a">line1</span>',
      '<span class="b">line2</span>',
      '<span class="b">line3</span>',
    ])
  })

  it('纯文本按行拆分且保留空行', () => {
    expect(splitHtmlLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})
