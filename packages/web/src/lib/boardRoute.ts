// 任务看板路由：#/h/:hostId/b[/:boardId]。AppRoute 把它当作 host 路由处理（激活 Host、关闭会话），
// 看板视图再单独读取这里的结果，避免改动共用的路由类型。
import { useEffect, useState } from 'react'

export interface BoardRoute {
  hostId: string
  boardId?: string
}

export function parseBoardHash(hash = window.location.hash): BoardRoute | null {
  const parts = hash.replace(/^#\/?/, '').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts[0] !== 'h' || !parts[1] || parts[2] !== 'b') return null
  return {
    hostId: decodeURIComponent(parts[1]),
    ...(parts[3] ? { boardId: decodeURIComponent(parts[3]) } : {}),
  }
}

export function boardHash(hostId: string, boardId?: string): string {
  const base = `#/h/${encodeURIComponent(hostId)}/b`
  return boardId ? `${base}/${encodeURIComponent(boardId)}` : base
}

export function navigateBoard(hostId: string, boardId?: string): void {
  const hash = boardHash(hostId, boardId)
  if (window.location.hash !== hash) window.location.hash = hash
}

export function useBoardRoute(): BoardRoute | null {
  const [route, setRoute] = useState<BoardRoute | null>(() => parseBoardHash())
  useEffect(() => {
    const onChange = () => setRoute(parseBoardHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
