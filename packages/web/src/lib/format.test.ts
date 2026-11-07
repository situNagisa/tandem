import { describe, expect, test } from 'vitest'
import {
  basename,
  dayBucket,
  dirname,
  fileExt,
  formatCost,
  formatElapsed,
  formatTokens,
  joinPath,
  truncate,
} from './format'

describe('格式化', () => {
  test('token 数量：千 / 百万', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-1)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(15000)).toBe('15k')
    expect(formatTokens(2_500_000)).toBe('2.50m')
  })

  test('花费按量级保留精度', () => {
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(Number.NaN)).toBe('—')
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatCost(0.1234)).toBe('$0.123')
    expect(formatCost(0.0012)).toBe('$0.0012')
  })

  test('运行时长', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(32_999)).toBe('32s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_725_000)).toBe('1h 02m')
  })

  test('dayBucket 以本地午夜为界', () => {
    const now = new Date(2026, 10, 7, 10).getTime()
    const today = new Date(2026, 10, 7, 0, 1).getTime()
    const yesterday = new Date(2026, 10, 6, 23, 59).getTime()
    const older = new Date(2026, 10, 5, 12).getTime()
    expect(dayBucket(today, now)).toBe('今天')
    expect(dayBucket(yesterday, now)).toBe('昨天')
    expect(dayBucket(older, now)).toBe('更早')
  })

  test('Windows / POSIX 路径辅助', () => {
    expect(basename('C:\\repo\\a.ts')).toBe('a.ts')
    expect(basename('/tmp/a.ts/')).toBe('a.ts')
    expect(dirname('C:\\repo\\a.ts')).toBe('C:\\repo')
    expect(dirname('/tmp/a.ts')).toBe('/tmp')
    expect(joinPath('C:\\repo', 'a.ts')).toBe('C:\\repo\\a.ts')
    expect(joinPath('/tmp', 'a.ts')).toBe('/tmp/a.ts')
    expect(fileExt('A.TSX')).toBe('tsx')
  })

  test('截断压缩空白', () => {
    expect(truncate(' a \n b ', 20)).toBe('a b')
    expect(truncate('abcdef', 5)).toBe('abcd…')
  })
})
