import { useCallback, useEffect, useState } from 'react'
import { Link2, RefreshCw, Share2, Trash2, TriangleAlert } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import type { ShareInfo } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatDateTime } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'

export function SharesSection() {
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!host) {
      setShares([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setShares(await api.shares(host))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取分享列表失败')
    } finally {
      setLoading(false)
    }
  }, [host])

  useEffect(() => {
    void load()
  }, [load, activeHostId])

  const revoke = async (share: ShareInfo) => {
    if (!host) return
    setRevoking(share.id)
    try {
      await api.deleteShare(host, share.id)
      setShares((list) => list.filter((item) => item.id !== share.id))
      setConfirmId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div data-setting-id="shares.list" className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-medium">
            <Share2 size={15} className="text-muted" />
            分享
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            {host ? `当前主机：${host.name}` : '未连接主机'}。只读链接仅用于可信内网，
            链接含访问 token，请勿转发到公网。
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || !host}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
          刷新
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {!loading && host && shares.length === 0 && (
        <div className="flex flex-col items-center rounded-xl border border-border bg-bg/40 px-4 py-12 text-center">
          <Link2 size={22} className="text-text-tertiary" />
          <EmptyState variant="plain" title={<>还没有分享</>} />
          <p className="mt-1 text-[12px] leading-5 text-muted">
            在会话列表的 ⋯ 菜单里点「分享…」生成只读链接。
          </p>
        </div>
      )}

      {shares.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          {shares.map((share) => (
            <div
              key={share.id}
              className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">
                    {share.sessionTitle || '未命名会话'}
                  </span>
                  {share.expired ? (
                    <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-muted">
                      已过期
                    </span>
                  ) : (
                    !share.expiresAt && (
                      <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-muted">
                        不过期
                      </span>
                    )
                  )}
                  <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-muted">
                    {share.snapshot ? '快照' : '实时'}
                  </span>
                  {!share.hidePaths && (
                    <span className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-[12px] text-warning">
                      含路径
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                  <span>创建 {formatDateTime(share.createdAt, { year: true })}</span>
                  <span>
                    {share.expiresAt ? `${formatDateTime(share.expiresAt, { year: true })} 到期` : '永久有效'}
                  </span>
                  <span>访问 {share.accessCount} 次</span>
                  {share.lastAccessAt && (
                    <span>最近 {formatDateTime(share.lastAccessAt, { year: true })}</span>
                  )}
                </div>
              </div>
              <div className={cn('flex shrink-0 items-center gap-1.5')}>
                {confirmId === share.id ? (
                  <>
                    <span className="text-[12px] text-muted">撤销后立即失效</span>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => void revoke(share)}
                      disabled={revoking === share.id}
                    >
                      {revoking === share.id && <Spinner size={12} />}
                      确认撤销
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <IconButton
                    size="sm"
                    label="撤销分享"
                    tooltip="撤销分享"
                    onClick={() => setConfirmId(share.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
