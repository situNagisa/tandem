import { describe, expect, test } from 'vitest'
import type { Profile } from '@tandem/protocol'
import { defaultChoiceFor, groupName, profileModelGroups } from './profileModels'

function profile(patch: Partial<Profile>): Profile {
  return {
    id: 'p1',
    name: '测试账号',
    kind: 'openai-compatible',
    apiKeyMasked: 'sk****',
    models: ['m1', 'm2'],
    defaultModel: 'm1',
    createdAt: 1,
    ...patch,
  }
}

describe('profileModelGroups', () => {
  test('无分组账号回退到 models / defaultModel', () => {
    expect(profileModelGroups(profile({}))).toEqual([{ name: '默认', models: ['m1', 'm2'] }])
    expect(profileModelGroups(profile({ models: [] }))).toEqual([
      { name: '默认', models: ['m1'] },
    ])
    expect(profileModelGroups(undefined)).toEqual([])
  })

  test('有分组时按分组展开，空模型回退默认模型', () => {
    const result = profileModelGroups(
      profile({
        groups: [
          {
            id: 'g1',
            name: '官方',
            apiKeyMasked: '',
            keys: [],
            models: ['a', 'b'],
            defaultModel: 'a',
          },
          {
            id: 'g2',
            name: '备用',
            apiKeyMasked: '',
            keys: [],
            models: [],
            defaultModel: 'c',
          },
          {
            id: 'g3',
            name: '空组',
            apiKeyMasked: '',
            keys: [],
            models: [],
            defaultModel: '',
          },
        ],
      }),
    )
    expect(result).toEqual([
      { groupId: 'g1', name: '官方', models: ['a', 'b'] },
      { groupId: 'g2', name: '备用', models: ['c'] },
    ])
  })
})

test('defaultChoiceFor 优先第一个分组的默认模型', () => {
  expect(
    defaultChoiceFor(
      profile({
        groups: [
          {
            id: 'g1',
            name: '官方',
            apiKeyMasked: '',
            keys: [],
            models: ['a', 'b'],
            defaultModel: 'b',
          },
        ],
      }),
    ),
  ).toEqual({ groupId: 'g1', model: 'b' })
  expect(defaultChoiceFor(profile({}))).toEqual({ model: 'm1' })
  expect(defaultChoiceFor(undefined)).toBeNull()
})

test('groupName 只返回存在的分组名', () => {
  const p = profile({
    groups: [
      {
        id: 'g1',
        name: '官方',
        apiKeyMasked: '',
        keys: [],
        models: ['a'],
        defaultModel: 'a',
      },
    ],
  })
  expect(groupName(p, 'g1')).toBe('官方')
  expect(groupName(p, 'missing')).toBe('')
  expect(groupName(p, undefined)).toBe('')
})
