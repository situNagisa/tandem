import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Loader2, Send, TriangleAlert } from 'lucide-react'
import type { ContentBlock, PermissionMode, SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { loadRecentDirs, rememberDir } from '../lib/storage'
import { defaultChoiceFor, profileModelGroups } from '../lib/profileModels'
import { cn } from '../lib/cn'
import { Button } from './ui/Button'
import { Input, Select } from './ui/Controls'
import { Modal } from './ui/Modal'
import { Popover } from './ui/Popover'
import { FolderBrowser } from './EnvBar'

const MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: '默认（按规则审批）' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: '计划模式' },
  { value: 'bypassPermissions', label: '跳过审批' },
]

function lastSessionOf(sessions: SessionSummary[]): SessionSummary | undefined {
  return sessions
    .filter((item) => !item.parentId && !item.archived)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function DispatchDialog({
  open,
  onClose,
  initialHostId,
}: {
  open: boolean
  onClose: () => void
  initialHostId?: string
}) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const dispatchSession = useAppStore((s) => s.dispatchSession)
  const toast = useUiStore((s) => s.toast)

  const [hostId, setHostId] = useState('')
  const [cwd, setCwd] = useState('')
  const [profileId, setProfileId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [task, setTask] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultsHost = useRef('')

  const host = hosts.find((item) => item.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const online = runtime?.status === 'online'
  const recents = useMemo(() => (hostId ? loadRecentDirs(hostId) : []), [hostId, open])

  const profile = profiles.find((item) => item.id === profileId)
  const modelGroups = profile ? profileModelGroups(profile) : []
  const modelOptions = [
    ...new Set(
      groupId
        ? (modelGroups.find((item) => (item.groupId ?? '') === groupId)?.models ?? [])
        : modelGroups.flatMap((item) => item.models),
    ),
  ]

  const applyDefaults = (id: string) => {
    if (!id) return
    const rt = useAppStore.getState().runtimes[id]
    const sessions = rt?.sessions ?? []
    const last = lastSessionOf(sessions)
    const recent = loadRecentDirs(id)
    setCwd(recent[0] ?? last?.cwd ?? rt?.info?.homeDir ?? '')
    const nextProfiles = rt?.profiles ?? []
    const chosen = last ? nextProfiles.find((item) => item.id === last.profileId) : undefined
    const target = chosen ?? nextProfiles[0]
    const choice = defaultChoiceFor(target)
    setProfileId(target?.id ?? '')
    setGroupId(last && chosen ? last.groupId ?? choice?.groupId ?? '' : choice?.groupId ?? '')
    setModel(last && chosen ? last.model : choice?.model ?? '')
    setPermissionMode(last?.permissionMode ?? 'default')
  }

  useEffect(() => {
    if (!open) return
    const id = initialHostId ?? activeHostId ?? hosts[0]?.id ?? ''
    setHostId(id)
    setError(null)
    defaultsHost.current = ''
    applyDefaults(id)
    if (id) void refreshProfiles(id)
    // 只在打开时初始化一次，避免用户编辑被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialHostId, activeHostId])

  // 首次打开时 profiles 可能还没加载：到达后补一次默认账号（仅当尚未选择）。
  useEffect(() => {
    if (!open || !hostId || profiles.length === 0) return
    if (defaultsHost.current === hostId && profileId) return
    defaultsHost.current = hostId
    if (!profiles.some((item) => item.id === profileId)) applyDefaults(hostId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostId, profiles.length])

  const chooseHost = (id: string) => {
    setHostId(id)
    setError(null)
    defaultsHost.current = ''
    applyDefaults(id)
    void refreshProfiles(id)
  }

  const chooseProfile = (id: string) => {
    const next = profiles.find((item) => item.id === id)
    const choice = defaultChoiceFor(next)
    setProfileId(id)
    setGroupId(choice?.groupId ?? '')
    setModel(choice?.model ?? '')
  }

  const submit = async () => {
    if (!host || sending) return
    if (!online) {
      setError('Host 离线，连上后才能派单')
      return
    }
    if (!cwd.trim()) {
      setError('请选择目标项目目录')
      return
    }
    if (!profileId || !model) {
      setError('请选择账号与模型')
      return
    }
    if (!task.trim()) {
      setError('写一句任务描述')
      return
    }
    setSending(true)
    setError(null)
    const content: ContentBlock[] = [{ type: 'text', text: task.trim() }]
    try {
      const { summary, sent } = await dispatchSession(
        host.id,
        {
          cwd: cwd.trim(),
          profileId,
          ...(groupId ? { groupId } : {}),
          model,
          permissionMode,
          title: task.trim().split('\n')[0].slice(0, 60) || '派单任务',
        },
        content,
      )
      rememberDir(host.id, cwd.trim())
      if (!sent) {
        toast('会话已创建，但消息未发送（连接中断）', 'error')
        setError('会话已创建，但连接中断导致消息未发送。可到会话里重新发送。')
        return
      }
      toast(`已派单到 ${host.name}`, 'success', {
        actionLabel: '查看',
        onClick: () => navigate({ kind: 'session', hostId: host.id, sessionId: summary.id }),
      })
      setTask('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '派单失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="派单"
      title={
        <span className="flex items-center gap-2">
          <Send size={14} className="text-muted" /> 派单到其他 Host
        </span>
      }
      className="max-h-[min(620px,88dvh)] w-[min(560px,94vw)] max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="space-y-3">
        <label className="block space-y-1 text-[12px] text-muted">
          目标 Host
          <Select aria-label="目标 Host" value={hostId} onChange={(e) => chooseHost(e.target.value)}>
            {hosts.map((item) => {
              const status = runtimes[item.id]?.status
              return (
                <option key={item.id} value={item.id}>
                  {item.name} {status === 'online' ? '· 在线' : status === 'connecting' ? '· 连接中' : '· 离线'}
                </option>
              )
            })}
          </Select>
        </label>

        <div className="space-y-1">
          <div className="text-[12px] text-muted">项目目录</div>
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/you/project"
              className="min-w-0 flex-1"
            />
            <Popover
              panelClassName="w-[320px] max-w-[92vw] p-0"
              trigger={({ toggle }) => (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={13} />}
                  onClick={toggle}
                  disabled={!host}
                >
                  浏览
                </Button>
              )}
            >
              {(close) =>
                host ? (
                  <div className="max-h-[360px] overflow-y-auto">
                    <FolderBrowser
                      hostId={host.id}
                      initial={cwd}
                      onUse={(path) => {
                        setCwd(path)
                        close()
                      }}
                    />
                  </div>
                ) : null
              }
            </Popover>
          </div>
          {recents.length > 0 && (
            <div className="no-scrollbar flex items-center gap-1 overflow-x-auto pb-0.5">
              {recents.slice(0, 5).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setCwd(dir)}
                  className={cn(
                    'h-7 shrink-0 rounded-md bg-[var(--t-bg-subtle)] px-2 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text',
                    cwd === dir && 'bg-[var(--t-bg-active)] text-text',
                  )}
                  title={dir}
                >
                  {dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block space-y-1 text-[12px] text-muted">
            账号
            <Select aria-label="账号" value={profileId} onChange={(e) => chooseProfile(e.target.value)}>
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block space-y-1 text-[12px] text-muted">
            分组 / 模型
            <div className="flex gap-1.5">
              <Select
                aria-label="分组"
                value={groupId}
                onChange={(e) => {
                  const next = e.target.value
                  const group = modelGroups.find((item) => (item.groupId ?? '') === next)
                  setGroupId(next)
                  setModel(group?.models[0] ?? model)
                }}
                disabled={!profile?.groups?.length}
                wrapperClassName="w-[42%]"
              >
                <option value="">默认</option>
                {modelGroups
                  .filter((item) => item.groupId)
                  .map((group) => (
                    <option key={group.groupId} value={group.groupId}>
                      {group.name}
                    </option>
                  ))}
              </Select>
              <Select aria-label="模型" value={model} onChange={(e) => setModel(e.target.value)} wrapperClassName="min-w-0 flex-1">
                {modelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </div>
          </label>
        </div>

        <label className="block space-y-1 text-[12px] text-muted">
          权限模式
          <Select
            aria-label="权限模式"
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
          >
            {MODE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="block space-y-1 text-[12px] text-muted">
          任务
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            autoFocus
            placeholder="一句话说明要做什么，比如：跑一遍测试并修复失败的用例"
            className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-border-strong"
          />
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/60 px-3 py-2 text-[12px] text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {!online && host && (
          <div className="text-[12px] text-warning">
            该 Host 当前离线。派单需要目标 Host 在线（两台机器都要开着 Host）。
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[12px] text-muted">发送后本页不跳转，可在收件箱跟进审批与完成。</span>
          <Button
            variant="primary"
            onClick={submit}
            disabled={sending || !online || !host}
            icon={sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            className="max-sm:h-10"
          >
            派单
          </Button>
        </div>
      </div>
    </Modal>
  )
}
