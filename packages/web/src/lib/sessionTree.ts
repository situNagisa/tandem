import type { SessionSummary } from '@tandem/protocol'

/**
 * 会话树：分叉跟 forkedFrom、子代理跟 parentId 一路向上找根。
 * 侧栏（分叉与原会话共用一行）与悬停拓扑图共用同一口径，
 * 不依赖树是否完整——父会话不在列表里时，当前会话就是自己的根。
 */
export function sessionTreeRootId(
  session: SessionSummary,
  byId: Map<string, SessionSummary>,
): string {
  let current = session
  const seen = new Set<string>([session.id])
  for (let depth = 0; depth < 64; depth += 1) {
    const parentId = current.parentId ?? current.forkedFrom?.sessionId
    if (!parentId) break
    const parent = byId.get(parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current.id
}

/** 树内所有会话（根、分叉、子代理、孙代理），按树根 id 归并。 */
export function sessionTreeMembers(
  rootId: string,
  sessions: SessionSummary[],
): SessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return sessions.filter((session) => sessionTreeRootId(session, byId) === rootId)
}
