import { describe, expect, test } from 'vitest'
import {
  handleMarkdownEnter,
  handleMarkdownTab,
  isInsideFence,
} from './markdownInput'
import { estimateInputTokens } from '../../lib/tokens'

describe('Markdown 输入：代码围栏', () => {
  test('开围栏行回车自动补一对闭合围栏，光标停在中间空行', () => {
    const text = '```ts'
    const caret = text.length
    const edit = handleMarkdownEnter(text, caret)
    expect(edit).not.toBeNull()
    expect(edit!.text).toBe('```ts\n\n```\n')
    expect(edit!.caret).toBe(6)
  })

  test('代码块内回车只换行，不触发发送', () => {
    const text = '```\nconst a = 1'
    const edit = handleMarkdownEnter(text, text.length)
    expect(edit).toEqual({ text: `${text}\n`, caret: text.length + 1 })
  })

  test('闭合围栏行回车在围栏后新起一行', () => {
    const text = '```\ncode\n```'
    const edit = handleMarkdownEnter(text, text.length)
    expect(edit!.text).toBe('```\ncode\n```\n')
    expect(edit!.caret).toBe(text.length + 1)
  })

  test('代码块内 Tab 插入两个空格，块外不拦截', () => {
    const inside = '```\nline'
    expect(handleMarkdownTab(inside, inside.length)).toEqual({
      text: '```\nline  ',
      caret: inside.length + 2,
    })
    expect(handleMarkdownTab('普通文本', 2)).toBeNull()
  })

  test('围栏状态按光标所在行之前的围栏数量判断', () => {
    expect(isInsideFence('```\nabc', 6)).toBe(true)
    expect(isInsideFence('```\nabc\n```\nnext', 15)).toBe(false)
    expect(isInsideFence('```', 3)).toBe(false)
  })
})

describe('Markdown 输入：列表续项', () => {
  test('有序列表自动续号并保留缩进与标点', () => {
    const text = '1. 第一步'
    expect(handleMarkdownEnter(text, text.length)).toEqual({
      text: '1. 第一步\n2. ',
      caret: text.length + 4,
    })
    const paren = '  3) 第三步'
    expect(handleMarkdownEnter(paren, paren.length)).toEqual({
      text: '  3) 第三步\n  4) ',
      caret: paren.length + 6,
    })
  })

  test('无序列表自动续项，任务列表保留未勾选框', () => {
    const dash = '- 一项'
    expect(handleMarkdownEnter(dash, dash.length)).toEqual({
      text: '- 一项\n- ',
      caret: dash.length + 3,
    })
    const task = '- [x] 已完成'
    expect(handleMarkdownEnter(task, task.length)).toEqual({
      text: '- [x] 已完成\n- [ ] ',
      caret: task.length + 7,
    })
  })

  test('空列表项回车退出列表；普通文本回车仍交给发送逻辑', () => {
    const empty = '- '
    expect(handleMarkdownEnter(empty, empty.length)).toEqual({ text: '', caret: 0 })
    expect(handleMarkdownEnter('普通消息', 2)).toBeNull()
    expect(handleMarkdownEnter('普通消息', 4)).toBeNull()
  })

  test('标题、分割线不拦截 Enter', () => {
    expect(handleMarkdownEnter('# 标题', 4)).toBeNull()
    expect(handleMarkdownEnter('---', 3)).toBeNull()
  })
})

describe('输入 token 估算', () => {
  test('文本按字符数 / 3.5 向上取整，附件按 1200/张', () => {
    expect(estimateInputTokens({ text: '1234567' })).toBe(2)
    expect(estimateInputTokens({ text: '1234567', attachments: 2 })).toBe(2402)
    expect(estimateInputTokens({ text: '' })).toBe(0)
  })
})
