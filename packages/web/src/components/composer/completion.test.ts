import { expect, test } from 'vitest'
import { detectCompletion } from './completion'

test('行首 / 触发斜杠命令补全', () => {
  expect(detectCompletion('/mod', 4)).toEqual({ kind: 'slash', start: 0, end: 4, query: 'mod' })
  expect(detectCompletion('第一行\n/help', 9)).toEqual({
    kind: 'slash',
    start: 4,
    end: 9,
    query: 'help',
  })
})

test('@ 触发文件补全并带查询', () => {
  expect(detectCompletion('看看 @src/a', 9)).toEqual({
    kind: 'file',
    start: 3,
    end: 9,
    query: 'src/a',
  })
  expect(detectCompletion('@', 1)).toEqual({ kind: 'file', start: 0, end: 1, query: '' })
})

test('空白、@ 已被空格截断或斜杠命令含空格时不补全', () => {
  expect(detectCompletion('普通文本', 4)).toBeNull()
  expect(detectCompletion('看看 @src/a b', 12)).toBeNull()
  expect(detectCompletion('/model sonnet', 13)).toBeNull()
})
