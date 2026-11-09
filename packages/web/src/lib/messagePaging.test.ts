import { describe, expect, it } from 'vitest'
import type { MessagePage } from '@tandem/protocol'
import { fillGapPage, mergeOlderPage, mergeSegmentPage } from './messagePaging'
import type { UiMessage } from './types'

function msg(id: string): UiMessage {
  return { id, role: 'user', createdAt: 1, content: [{ type: 'text', text: id }] }
}

function page(ids: string[], extra: Partial<MessagePage> = {}): MessagePage {
  const messages = ids.map(msg)
  return {
    messages,
    totalMessages: 100,
    firstMessageId: ids[0],
    lastMessageId: ids[ids.length - 1],
    hasEarlier: true,
    ...extra,
  }
}

describe('messagePaging', () => {
  it('顶部加载更早：前置且不重复', () => {
    const current = [msg('m5'), msg('m6')]
    const merged = mergeOlderPage(current, page(['m3', 'm4', 'm5'], { hasEarlier: false }))
    expect(merged.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6'])
    expect(merged.firstMessageId).toBe('m3')
    expect(merged.hasEarlier).toBe(false)
  })

  it('跳转到更早的段：插入缺口占位', () => {
    const current = [msg('m90'), msg('m91')]
    const merged = mergeSegmentPage(current, page(['m10', 'm11'], { nextMessageId: 'm12' }), true)
    expect(merged.messages.map((m) => m.id)).toEqual(['m10', 'm11', 'gap:m11:m90', 'm90', 'm91'])
    expect(merged.messages[2]?.gap).toEqual({ afterId: 'm11', beforeId: 'm90' })
    expect(merged.firstMessageId).toBe('m10')
    expect(merged.hasEarlier).toBe(true)
  })

  it('跳转段与已加载窗口相邻：不加缺口', () => {
    const current = [msg('m90'), msg('m91')]
    const merged = mergeSegmentPage(current, page(['m10', 'm11'], { nextMessageId: 'm90' }), true)
    expect(merged.messages.map((m) => m.id)).toEqual(['m10', 'm11', 'm90', 'm91'])
    expect(merged.messages.some((m) => m.gap)).toBe(false)
  })

  it('跳转段与窗口重叠：在重叠处拼接', () => {
    const current = [msg('m90'), msg('m91')]
    const merged = mergeSegmentPage(current, page(['m10', 'm90', 'm91'], { nextMessageId: 'm92' }), false)
    expect(merged.messages.map((m) => m.id)).toEqual(['m10', 'm90', 'm91'])
    expect(merged.firstMessageId).toBe('m10')
  })

  it('窗口里有缺口时，新页接在重叠处而不是窗口末尾', () => {
    const current = [
      msg('m1'),
      msg('m2'),
      { id: 'gap:m2:m5', role: 'user', createdAt: 0, content: [], gap: { afterId: 'm2', beforeId: 'm5' } },
      msg('m5'),
      msg('m6'),
    ] as UiMessage[]
    const merged = mergeSegmentPage(current, page(['m2', 'm3', 'm4']), true)
    expect(merged.messages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'gap:m4:m5',
      'm5',
      'm6',
    ])
    expect(merged.messages[4]?.gap).toEqual({ afterId: 'm4', beforeId: 'm5' })
  })

  it('新页覆盖缺口两侧：关闭缺口', () => {
    const current = [
      msg('m1'),
      msg('m2'),
      { id: 'gap:m2:m5', role: 'user', createdAt: 0, content: [], gap: { afterId: 'm2', beforeId: 'm5' } },
      msg('m5'),
      msg('m6'),
    ] as UiMessage[]
    const merged = mergeSegmentPage(current, page(['m2', 'm3', 'm4', 'm5']), true)
    expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  it('补齐缺口：逐页推进，到顶后关闭', () => {
    const current = [
      msg('m10'),
      msg('m11'),
      { id: 'gap:m11:m50', role: 'user', createdAt: 0, content: [], gap: { afterId: 'm11', beforeId: 'm50' } },
      msg('m50'),
      msg('m51'),
    ] as UiMessage[]
    const merged = fillGapPage(current, 2, page(['m30', 'm31'], { nextMessageId: 'm50' }), true)
    expect(merged.messages.map((m) => m.id)).toEqual([
      'm10',
      'm11',
      'm30',
      'm31',
      'gap:m11:m30',
      'm50',
      'm51',
    ])
    const closed = fillGapPage(merged.messages, 4, page(['m11'], { nextMessageId: 'm30' }), true)
    expect(closed.messages.map((m) => m.id)).toEqual(['m10', 'm11', 'm30', 'm31', 'm50', 'm51'])
  })
})
