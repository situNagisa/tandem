import { describe, expect, test } from 'vitest'
import {
  basename,
  dayBucket,
  dirname,
  fileExt,
  formatCost,
  formatDurationMs,
  formatElapsed,
  formatFullTime,
  formatMessageTime,
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

  test('消息耗时保留一位小数，满一分钟用分秒', () => {
    expect(formatDurationMs(0)).toBe('0.0s')
    expect(formatDurationMs(12_300)).toBe('12.3s')
    expect(formatDurationMs(40_000)).toBe('40s')
    expect(formatDurationMs(65_000)).toBe('1m 05s')
    expect(formatDurationMs(Number.NaN)).toBe('0.0s')
  })

  test('消息时间：6 小时内相对时间，今天只显示时分，非今天带日期，跨年带年份', () => {
    const now = new Date(2026, 10, 9, 10).getTime()
    expect(formatMessageTime(now - 20_000, now)).toBe('刚刚')
    expect(formatMessageTime(now - 12 * 60_000, now)).toBe('12 分钟前')
    expect(formatMessageTime(now - 5 * 3_600_000, now)).toBe('5 小时前')
    // 超过 6 小时但仍是今天：显示时钟时间。
    expect(formatMessageTime(new Date(2026, 10, 9, 0, 5).getTime(), now)).toBe('00:05')
    expect(formatMessageTime(new Date(2026, 10, 8, 21, 49).getTime(), now)).toBe('11-08 21:49')
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('2025-12-31 23:59')
    expect(formatFullTime(new Date(2026, 10, 9, 8, 5, 7).getTime())).toBe('2026-11-09 08:05:07')
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
