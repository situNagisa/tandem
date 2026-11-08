/**
 * 浮层与命中测试的统一处理。
 *
 * Radix 的模态弹层打开时会给 `body` 设 `pointer-events: none`，此时
 * `elementsFromPoint` 只剩 `<html>`，反馈圈选拿不到真实目标（R09 复发）。
 * 所有 Portal 浮层都带上 `data-portal-layer`，交互时统一用这里的类型守卫
 * 与 `elementsAtPoint`，不再在各自组件里裸调 `contains(relatedTarget)`。
 */

/** Portal 浮层统一标记；`data-portal-layer` 的值是浮层种类，便于排查。 */
export const PORTAL_ATTR = 'data-portal-layer'

/** 给 Portal 面板打标记：`<Menu.Content {...portalLayer('menu')} />`。 */
export function portalLayer(kind: string): Record<string, string> {
  return { [PORTAL_ATTR]: kind }
}

/** 事件目标转 Node；`relatedTarget` 可能是 Window，`contains` 会直接抛 TypeError。 */
export function asNode(target: EventTarget | null | undefined): Node | null {
  return target instanceof Node ? target : null
}

/** 安全版 contains：接收任意事件目标，非 Node 视为不在节点内。 */
export function nodeContains(host: Element | null | undefined, target: EventTarget | null | undefined): boolean {
  const node = asNode(target)
  if (!host || !node) return false
  try {
    return host.contains(node)
  } catch {
    return false
  }
}

/** 指针位置的命中元素，从最上层开始；必要时绕过模态浮层的 pointer-events 锁。 */
export function elementsAtPoint(x: number, y: number): Element[] {
  const hit = (): Element[] => Array.from(document.elementsFromPoint(x, y))
  const list = hit()
  // 只有 html/body 命中说明有模态浮层把 body 锁成了 pointer-events: none。
  const bodyLocked =
    typeof document !== 'undefined' &&
    document.body !== null &&
    getComputedStyle(document.body).pointerEvents === 'none'
  if (!bodyLocked) return list
  const body = document.body
  const previous = body.style.pointerEvents
  try {
    body.style.pointerEvents = 'auto'
    return hit()
  } catch {
    return list
  } finally {
    body.style.pointerEvents = previous
  }
}
