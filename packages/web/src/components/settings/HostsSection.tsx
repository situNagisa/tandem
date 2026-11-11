import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Plus, Server, TriangleAlert } from 'lucide-react'
import type { WorkspaceHostInfo } from '@tandem/protocol'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import { ConnectionDot } from '../StatusDot'
import { HostDetailDrawer } from './HostDetailDrawer'
import { HostGrantDialog } from './HostGrantDialog'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { workstationApi } from '../../lib/api'
import { withWorkstationSession } from '../../lib/workspaceSession'
import { isLocalHostUrl, isSameOrigin } from '../../lib/hostUrl'
import { APP_VERSION } from '../../lib/changelog'

/** 唯一的主机列表：我的 + 获授权，行只留状态，操作全在详情里。 */
export function HostsSection() {
  const account = useAppStore((s) => s.account)
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const syncHosts = useAppStore((s) => s.syncWorkstationHosts)
  const setAddHostOpen = useUiStore((s) => s.setAddHostOpen)

  const [remoteHosts, setRemoteHosts] = useState<WorkspaceHostInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [grantFor, setGrantFor] = useState<WorkspaceHostInfo | null>(null)

  const refresh = useCallback(async () => {
    if (!account) {
      setRemoteHosts([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await withWorkstationSession((base, token) => workstationApi.hosts(base, token))
      setRemoteHosts(list)
      await syncHosts()
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取工作站主机')
    } finally {
      setLoading(false)
    }
  }, [account, syncHosts])

  useEffect(() => {
    void refresh()
    // 主机增删后重新读取归属与授权；令牌刷新由 withWorkstationSession 处理。
  }, [refresh, hosts.length])

  const remoteById = useMemo(
    () => new Map(remoteHosts.map((host) => [host.id, host])),
    [remoteHosts],
  )
  const detailHost = detailId ? hosts.find((host) => host.id === detailId) : undefined
  const detailRemote = detailHost?.hostId ? remoteById.get(detailHost.hostId) : undefined

  return (
    <div data-setting-id="hosts.list">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">主机</h3>
        <span className="text-[13px] text-muted">主机执行任务；会话与模型在工作站</span>
        <span className="flex-1" />
        <Button
          data-setting-id="hosts.add"
          variant="primary"
          onClick={() => setAddHostOpen(true)}
          className="max-sm:min-h-11"
        >
          <Plus size={13} /> 添加主机
        </Button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-1.5 text-[12.5px] leading-5 text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-2">
        {hosts.length === 0 && (
          <EmptyState
            icon={<Server size={17} />}
            title={<>还没有主机</>}
            hint={<>点「添加主机」，复制一行命令到目标机器执行即可。</>}
          />
        )}
        {hosts.map((host) => {
          const rt = runtimes[host.id]
          const remote = host.hostId ? remoteById.get(host.hostId) : undefined
          const mine = !remote?.ownerId || remote.ownerId === account?.account.id
          const versionMismatch =
            rt?.status === 'online' && !!rt.info?.version && rt.info.version !== APP_VERSION
          return (
            <button
              data-raw-button
              key={host.id}
              type="button"
              data-host-row={host.hostId ?? host.id}
              onClick={() => setDetailId(host.id)}
              className="settings-item flex w-full items-center gap-2.5 p-3 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-soft">
                <Server size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold">{host.name}</span>
                  <ConnectionDot state={rt?.status ?? 'connecting'} />
                  <span className="text-[13px] text-muted">
                    {rt?.status === 'online'
                      ? '在线'
                      : rt?.status === 'connecting'
                        ? '连接中'
                        : '离线'}
                  </span>
                  {host.id === activeHostId && <Badge tone="neutral">当前</Badge>}
                  {account && <Badge tone="neutral">{mine ? '我的' : '获授权'}</Badge>}
                  {(remote?.local || (host.mode !== 'relay' && (isLocalHostUrl(host.url) || isSameOrigin(host.url)))) && (
                    <Badge tone="neutral">本机</Badge>
                  )}
                  {versionMismatch && (
                    <Badge tone="warn" icon={<TriangleAlert size={10} />}>
                      版本不一致
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
                  {host.url}
                </span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-muted" />
            </button>
          )
        })}
      </div>

      <p className="settings-note">
        {loading ? '正在同步工作站主机…' : '点主机行查看详情、改名与授权。修改地址或 Token 会自动重连并重新订阅当前会话。'}
      </p>

      {detailHost && (
        <HostDetailDrawer
          host={detailHost}
          remote={detailRemote}
          onClose={() => setDetailId(null)}
          onGrant={(remote) => setGrantFor(remote)}
          onRemoved={() => void refresh()}
        />
      )}

      <HostGrantDialog
        host={grantFor}
        onClose={() => setGrantFor(null)}
        onDone={() => {
          setGrantFor(null)
          void refresh()
        }}
      />

      {loading && hosts.length > 0 && (
        <span className="sr-only" aria-live="polite">
          <Spinner size={12} /> 正在同步主机
        </span>
      )}
    </div>
  )
}
