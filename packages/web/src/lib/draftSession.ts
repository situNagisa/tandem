/** 发送后、创建请求返回前的本地占位会话 id 前缀：还没有真实会话，不能请求也不能发往 Host。 */
export const DRAFT_SESSION_PREFIX = 'draft-'

export function isDraftSession(sessionId: string): boolean {
  return sessionId.startsWith(DRAFT_SESSION_PREFIX)
}
