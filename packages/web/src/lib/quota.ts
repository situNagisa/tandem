import type { QuotaEstimate } from '@tandem/protocol'

/** 用量卡/上下文面板共用的一行预估；没有数据时返回 undefined。 */
export function quotaLine(quota?: QuotaEstimate): string | undefined {
  if (!quota || quota.turnsLeft === undefined) return undefined
  const turns = Math.max(0, quota.turnsLeft)
  const limitedBy =
    quota.limitedBy === 'budget' ? '预算' : quota.limitedBy === 'ratelimit' ? 'Key 限流' : undefined
  const head =
    turns === 0 ? '按当前速度预计下一轮即耗尽' : `按当前速度约可再跑 ${turns} 轮`
  return limitedBy ? `${head}（受限于：${limitedBy}）` : head
}

/** 交接卡「等待重置」按钮里的相对时间。 */
export function handoffWaitLabel(resumeAt?: number, now = Date.now()): string {
  if (!resumeAt) return '等待额度重置（自动继续）'
  const seconds = Math.max(0, Math.round((resumeAt - now) / 1000))
  if (seconds < 90) return `等待额度重置（约 ${seconds} 秒后自动继续）`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `等待额度重置（约 ${minutes} 分钟后自动继续）`
}
