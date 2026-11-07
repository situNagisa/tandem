/** 轮次大纲虚拟列表的可见区间：按行高取视口范围，上下各多渲染 overscan 行。 */
export function visibleTurnRange(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  rowHeight = 52,
  overscan = 6,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)
  return { start, end }
}
