/** 消息耗时口径：只记录请求/工具本身，不用客户端时钟。 */

export interface RequestTiming {
  durationMs: number;
  ttftMs?: number;
}

/** 从发起请求到流式完成；firstTokenAt 为首次收到任意内容块的时间。 */
export function requestTiming(
  startedAt: number,
  firstTokenAt: number | undefined,
  endedAt = Date.now(),
): RequestTiming {
  const durationMs = Math.max(0, endedAt - startedAt);
  if (firstTokenAt === undefined) return { durationMs };
  return {
    durationMs,
    ttftMs: Math.max(0, Math.min(durationMs, firstTokenAt - startedAt)),
  };
}

/** 一批工具的执行耗时（含审批等待）。 */
export function toolTiming(startedAt: number, endedAt = Date.now()): number {
  return Math.max(0, endedAt - startedAt);
}
