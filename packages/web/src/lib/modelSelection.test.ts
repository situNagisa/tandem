import { describe, expect, it } from 'vitest'
import { identifyModel, isNewerModel, mergeFetchedSelection, selectLatestModels } from './modelSelection'

describe('identifyModel', () => {
  it('拆出系列、版本与日期快照', () => {
    expect(identifyModel('claude-opus-4-6')).toMatchObject({
      series: 'claude-opus',
      version: [4, 6],
    })
    expect(identifyModel('claude-opus-4-5-20251101')).toMatchObject({
      series: 'claude-opus',
      version: [4, 5],
      snapshot: 20251101,
    })
    expect(identifyModel('claude-sonnet-4-5-2025-09-29')).toMatchObject({
      series: 'claude-sonnet',
      version: [4, 5],
      snapshot: 20250929,
    })
    // 旧命名把版本放在系列词之间：claude-3-5-sonnet 与 claude-sonnet-3-5 视为同系列
    expect(identifyModel('claude-3-5-sonnet-20241022')?.series).toBe(
      identifyModel('claude-sonnet-3-5')?.series,
    )
  })

  it('没有版本号的模型无法判断', () => {
    expect(identifyModel('deepseek-chat')).toBeNull()
    expect(identifyModel('kimi-latest')).toBeNull()
    expect(identifyModel('gpt-4o')?.version).toEqual([4])
  })
})

describe('isNewerModel', () => {
  const id = (value: string) => identifyModel(value)!

  it('同系列版本号更大更新；更长的小版本更新', () => {
    expect(isNewerModel(id('claude-opus-4-6'), id('claude-opus-4-5'))).toBe(true)
    expect(isNewerModel(id('claude-fable-5-1'), id('claude-fable-5'))).toBe(true)
    expect(isNewerModel(id('claude-haiku-5-5'), id('claude-haiku-4-5-20251001'))).toBe(true)
  })

  it('同版本优先别名，其次日期更新的快照', () => {
    expect(isNewerModel(id('claude-opus-4-5'), id('claude-opus-4-5-20251101'))).toBe(true)
    expect(isNewerModel(id('claude-opus-4-5-20251101'), id('claude-opus-4-5'))).toBe(false)
    expect(
      isNewerModel(id('claude-opus-4-5-20251101'), id('claude-opus-4-5-20251001')),
    ).toBe(true)
  })
})

describe('selectLatestModels', () => {
  it('每个系列只选最新一代（反馈截图 04）', () => {
    const ids = [
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
      'claude-haiku-5-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-opus-5-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-5-5',
    ]
    expect(selectLatestModels(ids)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
  })

  it('无法判断的模型不勾选，不同系列各自保留最新', () => {
    expect(selectLatestModels(['deepseek-chat', 'kimi-latest'])).toEqual([])
    expect(selectLatestModels(['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'])).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
    ])
  })

  it('同版本别名与日期快照同时存在时只选别名', () => {
    expect(
      selectLatestModels(['claude-sonnet-5-5-20250929', 'claude-sonnet-5-5']),
    ).toEqual(['claude-sonnet-5-5'])
  })
})

describe('mergeFetchedSelection', () => {
  const first = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5']

  it('没手动勾选过时，再次拉取仍按最新一代重选', () => {
    expect(
      mergeFetchedSelection({
        selected: ['claude-opus-4-5', 'claude-opus-4-6'],
        previousAvailable: first,
        fetched: [...first, 'claude-opus-5-5'],
        touched: false,
      }),
    ).toEqual(['claude-sonnet-4-5', 'claude-opus-5-5'])
  })

  it('手动勾选过时保留用户选择，只对新增模型应用规则', () => {
    expect(
      mergeFetchedSelection({
        selected: ['claude-opus-4-5', 'claude-sonnet-4-5'],
        previousAvailable: first,
        fetched: [...first, 'claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-chat'],
        touched: true,
      }),
    ).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
  })

  it('首次拉取（没有历史候选）按规则选最新', () => {
    expect(
      mergeFetchedSelection({
        selected: [],
        previousAvailable: [],
        fetched: ['claude-opus-4-5', 'claude-opus-4-6'],
        touched: true,
      }),
    ).toEqual(['claude-opus-4-6'])
  })
})
