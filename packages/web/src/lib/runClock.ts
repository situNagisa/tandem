const starts = new Map<string, number>()

/** 顶栏与侧栏共享同一次回合的开始时间，避免各自按 updatedAt 估算出现偏差。 */
export function runningSince(key: string, fallback: number): number {
  const existing = starts.get(key)
  if (existing !== undefined) return existing
  const start = Math.min(Date.now(), fallback || Date.now())
  starts.set(key, start)
  return start
}

export function clearRunning(key: string): void {
  starts.delete(key)
}
