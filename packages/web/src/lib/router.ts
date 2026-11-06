import { useEffect, useState } from 'react'
import type { AppRoute } from './types'

/** `#/h/:hostId/s/:sessionId`、`#/h/:hostId/x/:source/:id`、`#/h/:hostId`、其余为首页。 */
export function parseHash(hash = window.location.hash): AppRoute {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (!path) return { kind: 'home' }
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'h' && parts[1]) {
    const hostId = decodeURIComponent(parts[1])
    if (parts[2] === 's' && parts[3]) {
      return { kind: 'session', hostId, sessionId: decodeURIComponent(parts[3]) }
    }
    if (parts[2] === 'x' && (parts[3] === 'claude-code' || parts[3] === 'codex') && parts[4]) {
      return {
        kind: 'external',
        hostId,
        source: parts[3],
        id: decodeURIComponent(parts[4]),
      }
    }
    return { kind: 'host', hostId }
  }
  return { kind: 'home' }
}

export function routeToHash(route: AppRoute): string {
  switch (route.kind) {
    case 'session':
      return `#/h/${encodeURIComponent(route.hostId)}/s/${encodeURIComponent(route.sessionId)}`
    case 'external':
      return `#/h/${encodeURIComponent(route.hostId)}/x/${route.source}/${encodeURIComponent(route.id)}`
    case 'host':
      return `#/h/${encodeURIComponent(route.hostId)}`
    default:
      return '#/'
  }
}

export function navigate(route: AppRoute): void {
  const hash = routeToHash(route)
  if (window.location.hash === hash) return
  window.location.hash = hash
}

export function sessionHash(hostId: string, sessionId: string): string {
  return routeToHash({ kind: 'session', hostId, sessionId })
}

export function hostHash(hostId: string): string {
  return routeToHash({ kind: 'host', hostId })
}

export function externalHash(
  hostId: string,
  source: import('@tandem/protocol').ExternalSource,
  id: string,
): string {
  return routeToHash({ kind: 'external', hostId, source, id })
}

export function useRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseHash())
  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

/** 写入 hash（用于 <a href> 场景，不触发整页跳转）。 */
export function hrefFor(route: AppRoute): string {
  return routeToHash(route)
}
