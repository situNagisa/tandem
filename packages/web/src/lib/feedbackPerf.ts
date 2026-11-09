/**
 * 反馈截图耗时记录（仅调试版）：每次截图记一条，拆分克隆/内联样式、序列化、
 * 绘制、PNG 编码与总耗时，供 `e2e/regression.mjs` 的性能用例断言。
 */
export interface FeedbackShotPerf {
  kind: 'element' | 'region' | 'page'
  /** 总耗时（含裁切与编码）。 */
  ms: number
  /** DOM 遍历 + 计算样式 + 样式内联。 */
  cloneMs: number
  /** 内嵌资源（背景图/字体）耗时。 */
  embedMs: number
  /** 序列化 SVG / 生成图片耗时。 */
  drawMs: number
  /** PNG 编码耗时。 */
  encodeMs: number
  /** 目标子树里的元素个数。 */
  nodes: number
  /** 被跳过（视口外）的元素个数。 */
  pruned: number
  width: number
  height: number
  bytes: number
  /** 是否走桌面原生截图。 */
  native: boolean
  at: number
}

const MAX_RECORDS = 40
const records: FeedbackShotPerf[] = []
let current: FeedbackShotPerf | null = null

export function shotPerfStart(
  kind: FeedbackShotPerf['kind'],
  info: { nodes?: number; pruned?: number; native?: boolean } = {},
): FeedbackShotPerf | null {
  if (!__TANDEM_DEBUG__) return null
  current = {
    kind,
    ms: 0,
    cloneMs: 0,
    embedMs: 0,
    drawMs: 0,
    encodeMs: 0,
    nodes: info.nodes ?? 0,
    pruned: info.pruned ?? 0,
    width: 0,
    height: 0,
    bytes: 0,
    native: info.native ?? false,
    at: Date.now(),
  }
  return current
}

/** 累加某阶段耗时；阶段可分段多次调用。 */
export function shotPerfAdd(phase: 'cloneMs' | 'embedMs' | 'drawMs' | 'encodeMs', ms: number): void {
  if (current) current[phase] += ms
}

export function shotPerfEnd(
  record: FeedbackShotPerf | null,
  ms: number,
  size: { width?: number; height?: number; bytes?: number } = {},
): void {
  if (!record) return
  record.ms = Math.round(ms)
  record.cloneMs = Math.round(record.cloneMs)
  record.embedMs = Math.round(record.embedMs)
  record.drawMs = Math.round(record.drawMs)
  record.encodeMs = Math.round(record.encodeMs)
  record.width = size.width ?? record.width
  record.height = size.height ?? record.height
  record.bytes = size.bytes ?? record.bytes
  records.push(record)
  if (records.length > MAX_RECORDS) records.shift()
  if (current === record) current = null
}

export function feedbackShotPerf(): FeedbackShotPerf[] {
  return records.slice()
}
