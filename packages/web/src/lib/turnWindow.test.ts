import { expect, test } from 'vitest'
import { visibleTurnRange } from './turnWindow'

test('轮次大纲顶部：从 0 开始并多渲染 6 行', () => {
  expect(visibleTurnRange(0, 520, 120)).toEqual({ start: 0, end: 16 })
})

test('滚动到中部：按行高 52 计算上下 overscan', () => {
  // 10 行 * 52 = 520；视口 520 高（10 行）
  expect(visibleTurnRange(520, 520, 120)).toEqual({ start: 4, end: 26 })
})

test('接近底部：end 不超过总轮数', () => {
  expect(visibleTurnRange(120 * 52 - 520, 520, 120)).toEqual({ start: 104, end: 120 })
})

test('空列表、单行与负 scrollTop 的边界', () => {
  expect(visibleTurnRange(0, 520, 0)).toEqual({ start: 0, end: 0 })
  expect(visibleTurnRange(0, 52, 1)).toEqual({ start: 0, end: 1 })
  expect(visibleTurnRange(-10, 520, 30)).toEqual({ start: 0, end: 16 })
})

test('自定义行高与 overscan', () => {
  expect(visibleTurnRange(100, 200, 50, 50, 0)).toEqual({ start: 2, end: 6 })
})
