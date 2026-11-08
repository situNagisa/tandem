import type { MessagePage } from '@tandem/protocol'
import type { MessageGap, UiMessage } from './types'

/** 会话首屏快照的尾部条数。 */
export const SESSION_TAIL_MESSAGES = 200
/** 每次向前翻页的条数。 */
export const MESSAGE_PAGE_SIZE = 200

export interface MergedPage {
  messages: UiMessage[]
  firstMessageId?: string
  hasEarlier: boolean
  totalMessages: number
}

export function gapMessage(gap: MessageGap): UiMessage {
  return {
    id: `gap:${gap.afterId ?? 'top'}:${gap.beforeId}`,
    role: 'user',
    createdAt: 0,
    content: [],
    gap,
  }
}

function realIds(messages: UiMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) if (!message.gap) ids.add(message.id)
  return ids
}

/** 顶部“加载更早”：page 紧接在当前第一条之前。 */
export function mergeOlderPage(current: UiMessage[], page: MessagePage): MergedPage {
  const ids = realIds(current)
  const older = page.messages.filter((message) => !ids.has(message.id))
  return {
    messages: older.length ? [...older, ...current] : current.slice(),
    firstMessageId: page.firstMessageId ?? older[0]?.id ?? current[0]?.id,
    hasEarlier: page.hasEarlier,
    totalMessages: page.totalMessages,
  }
}

/**
 * 按需加载的一段（大纲/搜索跳转的 around 页）：
 * - 与已加载区间有重叠：在重叠处前后拼接；
 * - 完全在更早处：插到最前面，中间若不相邻则放一个缺口占位。
 */
export function mergeSegmentPage(
  current: UiMessage[],
  page: MessagePage,
  currentHasEarlier: boolean,
): MergedPage {
  const currentReal = current.filter((message) => !message.gap)
  const currentIds = realIds(current)
  const pageIds = new Set(page.messages.map((message) => message.id))
  const base = {
    firstMessageId: page.firstMessageId ?? current[0]?.id,
    hasEarlier: page.hasEarlier,
    totalMessages: page.totalMessages,
  }
  if (!page.messages.length) {
    return { ...base, messages: current.slice() }
  }
  if (!currentReal.length) {
    return { ...base, messages: [...page.messages] }
  }
  const firstOverlap = current.findIndex((message) => !message.gap && pageIds.has(message.id))
  if (firstOverlap >= 0) {
    let lastOverlap = firstOverlap
    for (let i = current.length - 1; i > firstOverlap; i--) {
      const message = current[i]!
      if (!message.gap && pageIds.has(message.id)) {
        lastOverlap = i
        break
      }
    }
    const startInPage = page.messages.findIndex((message) => message.id === current[firstOverlap]!.id)
    const endInPage = page.messages.findIndex((message) => message.id === current[lastOverlap]!.id)
    const before = page.messages
      .slice(0, Math.max(0, startInPage))
      .filter((message) => !currentIds.has(message.id))
    const after = page.messages
      .slice(endInPage >= 0 ? endInPage + 1 : page.messages.length)
      .filter((message) => !currentIds.has(message.id))
    // 新段在更早处时，firstMessageId 取自 page；否则保留当前窗口的锚点。
    return {
      ...base,
      firstMessageId: before.length ? base.firstMessageId : (current[0]?.id ?? base.firstMessageId),
      hasEarlier: before.length ? page.hasEarlier : currentHasEarlier,
      messages: [...before, ...current, ...after],
    }
  }
  // 与当前窗口不相交：跳转目标是更早的历史，插到顶部。
  const lastId = page.messages[page.messages.length - 1]!.id
  const adjacent = page.nextMessageId !== undefined && page.nextMessageId === current[0]?.id
  return {
    ...base,
    messages: adjacent
      ? [...page.messages, ...current]
      : [
          ...page.messages,
          gapMessage({ afterId: lastId, beforeId: current[0]!.id }),
          ...current,
        ],
  }
}

/** 加载缺口下方一页（page 紧接在缺口 beforeId 之前），并收紧/关闭缺口。 */
export function fillGapPage(
  current: UiMessage[],
  gapIndex: number,
  page: MessagePage,
  currentHasEarlier: boolean,
): MergedPage {
  const gap = current[gapIndex]?.gap
  if (!gap) {
    return mergeOlderPage(current, page)
  }
  const ids = realIds(current)
  const fresh = page.messages.filter((message) => !ids.has(message.id))
  const next = [...current]
  next.splice(gapIndex, 0, ...fresh)
  const markerIndex = gapIndex + fresh.length
  const closed =
    (gap.afterId !== undefined &&
      (page.firstMessageId === gap.afterId || fresh[0]?.id === gap.afterId)) ||
    page.hasEarlier === false
  if (closed) next.splice(markerIndex, 1)
  else if (fresh.length > 0) {
    next[markerIndex] = gapMessage({
      afterId: gap.afterId,
      beforeId: page.firstMessageId ?? fresh[0]!.id,
    })
  }
  return {
    messages: next,
    firstMessageId: current[0]?.id,
    hasEarlier: currentHasEarlier,
    totalMessages: page.totalMessages,
  }
}
