import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from '@tandem/protocol'
import { nearestEffort } from './effort'
import { loadNewSessionPick, rememberNewSessionPick, resolveNewSessionPick } from './newSessionPick'

const profiles = [
  {
    id: 'p-main',
    name: '主力账号',
    kind: 'openai-compatible',
    models: ['mock-1', 'mock-2'],
    defaultModel: 'mock-1',
    groups: [
      { id: 'g1', name: '生产', models: ['mock-1', 'mock-2'], defaultModel: 'mock-1' },
      { id: 'g2', name: '备用', models: ['o3'], defaultModel: 'o3' },
    ],
  },
  {
    id: 'p-plain',
    name: '自建端点',
    kind: 'openai-compatible',
    models: ['custom-1'],
    defaultModel: 'custom-1',
  },
] as unknown as Profile[]

describe('resolveNewSessionPick', () => {
  it('恢复记住的账号、分组与模型', () => {
    expect(resolveNewSessionPick(profiles, { profileId: 'p-main', groupId: 'g2', model: 'o3' })).toEqual({
      profileId: 'p-main',
      groupId: 'g2',
      model: 'o3',
    })
  })

  it('无分组账号不带分组', () => {
    expect(resolveNewSessionPick(profiles, { profileId: 'p-plain', model: 'custom-1' })).toEqual({
      profileId: 'p-plain',
      model: 'custom-1',
    })
  })

  it('记住的模型已不在该分组时返回 null，由调用方回落默认', () => {
    expect(resolveNewSessionPick(profiles, { profileId: 'p-main', groupId: 'g2', model: 'mock-2' })).toBeNull()
  })

  it('账号或分组已删除时返回 null', () => {
    expect(resolveNewSessionPick(profiles, { profileId: 'gone', groupId: 'g1', model: 'mock-1' })).toBeNull()
    expect(resolveNewSessionPick(profiles, { profileId: 'p-main', groupId: 'gone', model: 'mock-1' })).toBeNull()
  })

  it('自动路由始终可恢复', () => {
    expect(resolveNewSessionPick(profiles, { profileId: 'p-main', groupId: 'g1', model: 'auto' })).toEqual({
      profileId: 'p-main',
      groupId: 'g1',
      model: 'auto',
    })
  })

  it('没有记录时返回 null', () => {
    expect(resolveNewSessionPick(profiles, undefined)).toBeNull()
    expect(resolveNewSessionPick(profiles, { effort: 'high' })).toBeNull()
  })
})

describe('思考强度记忆', () => {
  afterEach(() => vi.unstubAllGlobals())

  const memory = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    return store
  }

  it('只更新给出的字段，记住强度不覆盖账号与模型', () => {
    memory()
    rememberNewSessionPick('h1', { profileId: 'p-main', groupId: 'g1', model: 'mock-2' })
    rememberNewSessionPick('h1', { effort: 'max' })
    expect(loadNewSessionPick('h1')).toEqual({ profileId: 'p-main', groupId: 'g1', model: 'mock-2', effort: 'max' })
  })

  it('非法的强度值读取时丢弃', () => {
    const store = memory()
    store.set('tandem.newSessionPick.v1', JSON.stringify({ h1: { model: 'mock-2', effort: 'turbo' } }))
    expect(loadNewSessionPick('h1')).toEqual({ model: 'mock-2' })
  })

  it('模型降档只影响本次生效档位，换回支持更高档的模型时用户原选择仍可恢复', () => {
    expect(nearestEffort(['low', 'medium', 'high'], 'max')).toBe('high')
    expect(nearestEffort(['low', 'medium', 'high', 'max'], 'max')).toBe('max')
  })
})
