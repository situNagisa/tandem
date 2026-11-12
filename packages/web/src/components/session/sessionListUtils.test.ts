import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@tandem/protocol'
import type { AppState } from '../../store/appStore/types'
import { OLDER_SESSION_MS, buildGroups, isOlderSession, staysVisibleWhenOlder } from './sessionListUtils'

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    cwd: '/repo/app',
    profileId: 'p',
    model: 'm',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...extra,
  }
}

const filter = {
  status: 'all',
  hostId: 'all',
  project: 'all',
  source: 'all',
} as const

function groupsOf(sessions: SessionSummary[], activeSessionId?: string | null) {
  return buildGroups(
    [{ id: 'h1', name: '本机' }],
    { h1: { status: 'online', sessions } } as unknown as AppState['runtimes'],
    [],
    '',
    false,
    filter,
    [],
    activeSessionId,
  )
}

describe('buildGroups（侧栏会话树）', () => {
  it('分叉不再单独占一行，与根会话共用一行；点击打开树内最近活动的会话', () => {
    const root = session('root', { updatedAt: 100 })
    const fork = session('fork', {
      updatedAt: 300,
      forkedFrom: { sessionId: 'root', title: 'root' },
    })
    const sub = session('sub', { parentId: 'root', depth: 1, updatedAt: 400 })
    const { pinned, hosts } = groupsOf([root, fork, sub])
    expect(pinned).toHaveLength(0)
    expect(hosts).toHaveLength(1)
    const items = hosts[0]!.projects[0]!.items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'root',
      title: 'root',
      openedId: 'fork',
      updatedAt: 300,
      treeIds: ['root', 'fork'],
    })
    // 子代理不进侧栏，也不进树行。
    expect(hosts[0]!.count).toBe(1)
    expect(items[0]!.treeIds).not.toContain('sub')
  })

  it('当前打开的是分叉时，行内记录所在分叉名；状态与未读按树汇总', () => {
    const root = session('root', { updatedAt: 100 })
    const fork = session('fork', {
      updatedAt: 300,
      status: 'waiting_permission',
      unread: true,
      forkedFrom: { sessionId: 'root', title: 'root' },
    })
    const { hosts } = groupsOf([root, fork], 'fork')
    const row = hosts[0]!.projects[0]!.items[0]!
    expect(row.id).toBe('root')
    expect(row.branchTitle).toBe('fork')
    expect(row.status).toBe('waiting_permission')
    expect(row.unread).toBe(true)
  })

  it('分叉命中搜索时仍显示根会话那一行', () => {
    const root = session('root', { title: '主会话' })
    const fork = session('fork', {
      title: '先补参数校验',
      forkedFrom: { sessionId: 'root', title: '主会话' },
    })
    const { hosts } = buildGroups(
      [{ id: 'h1', name: '本机' }],
      { h1: { status: 'online', sessions: [root, fork] } } as unknown as AppState['runtimes'],
      [],
      '参数校验',
      false,
      filter,
      [],
    )
    expect(hosts[0]!.projects[0]!.items.map((row) => row.id)).toEqual(['root'])
  })

  it('根会话已归档时，未归档分叉退回独立一行，不会消失', () => {
    const root = session('root', { archived: true })
    const fork = session('fork', {
      forkedFrom: { sessionId: 'root', title: 'root' },
    })
    const { hosts } = groupsOf([root, fork])
    expect(hosts[0]!.projects[0]!.items.map((row) => row.id)).toEqual(['fork'])
  })

  it('反馈1603：7 天前的会话默认收起，固定/运行中/待审批/未读始终显示', () => {
    const now = Date.now()
    const cutoff = now - OLDER_SESSION_MS
    const old = (extra: Partial<SessionSummary> = {}) =>
      session('old', { updatedAt: now - OLDER_SESSION_MS - 1000, ...extra })

    expect(isOlderSession(old(), cutoff)).toBe(true)
    // 6 天 23 小时仍在阈值内；恰好 7 天按「超过」处理，不收起。
    expect(isOlderSession(session('recent', { updatedAt: now - OLDER_SESSION_MS + 1000 }), cutoff)).toBe(false)
    expect(isOlderSession(session('edge', { updatedAt: cutoff }), cutoff)).toBe(false)

    for (const keep of [
      old({ pinnedInProject: true }),
      old({ status: 'running' }),
      old({ status: 'waiting_permission' }),
      old({ status: 'retrying' }),
      old({ unread: true }),
    ]) {
      expect(staysVisibleWhenOlder(keep)).toBe(true)
      expect(isOlderSession(keep, cutoff)).toBe(false)
    }
  })
})
