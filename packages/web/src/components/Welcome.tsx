import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FileText, GitBranch, Inbox, Search, Send, Sparkles, Wrench } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename } from '../lib/format'
import { useIsMobile } from '../lib/hooks'
import { SegmentedControl } from './ui/Controls'
import { ConnectView, NewSessionView } from './NewSessionDialog'
import { InboxView, useInboxCount, useInboxPendingCount } from './inbox/InboxView'

const SUGGESTIONS = [
  {
    icon: Search,
    title: '介绍一下这个项目',
    desc: '快速浏览仓库结构，梳理关键模块与启动方式',
    prompt: '介绍一下这个项目的结构和主要模块，并告诉我如何运行它。',
  },
  {
    icon: Wrench,
    title: '修复失败的测试',
    desc: '运行测试、定位失败原因并完成修复',
    prompt: '帮我运行测试，定位失败的用例并修复它们。',
  },
  {
    icon: GitBranch,
    title: '总结最近的改动',
    desc: '查看 git 改动，提炼变更与潜在风险',
    prompt: '查看最近的 git 改动，总结变更内容并指出可能的风险。',
  },
  {
    icon: FileText,
    title: '补一份说明文档',
    desc: '根据代码补全 README 或模块说明',
    prompt: '阅读这个仓库并为它补一份清晰的中文 README。',
  },
]

export function SessionWelcome() {
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const hostName = useAppStore(
    (s) => s.hosts.find((h) => h.id === s.active?.hostId)?.name ?? 'Host',
  )
  const profileName = useAppStore((s) => {
    const profileId = s.active?.summary?.profileId
    const hostId = s.active?.hostId
    if (!profileId || !hostId) return null
    return s.runtimes[hostId]?.profiles.find((p) => p.id === profileId)?.name ?? null
  })
  const seedPrompt = useUiStore((s) => s.seedPrompt)

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-2 py-10 text-center md:py-14">
      <h2 className="font-serif text-[26px] leading-tight tracking-[-0.01em] text-text md:text-[30px]">
        想先做点什么？
      </h2>
      <p className="mt-2 max-w-md text-[13px] leading-6 text-muted">
        {hostName}
        {summary ? ` · ${basename(summary.cwd) || summary.cwd}` : ''}
        {profileName ? ` · ${profileName}` : ''}
      </p>
      <div className="mt-7 grid w-full max-w-[560px] grid-cols-2 gap-2 text-left">
        {SUGGESTIONS.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.title}
              onClick={() => seedPrompt(s.prompt)}
              className="group flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-surface px-2.5 py-2.5 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-[var(--t-bg-hover)] sm:gap-2.5 sm:px-3"
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--t-bg-active)] text-text-soft">
                <Icon size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[12px] font-medium text-text sm:text-[13px]">
                  {s.title}
                  <ArrowUpRight
                    size={11}
                    className="text-muted opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </span>
                <span className="mt-0.5 hidden text-[12px] leading-5 text-muted sm:block">{s.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-muted">
        <Sparkles size={11} />
        输入框支持 @ 文件、/ 命令与图片粘贴
      </p>
    </div>
  )
}

export function HomeView() {
  const hosts = useAppStore((s) => s.hosts)
  const isMobile = useIsMobile()
  const pendingCount = useInboxPendingCount()
  const unreadCount = useInboxCount()
  const setDispatchOpen = useUiStore((s) => s.setDispatchOpen)
  const teamRole = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  // 手机打开 App 时若有待审批，直接落在收件箱；用户手动切换后不再自动跳。
  const [tab, setTab] = useState<'new' | 'inbox'>(() =>
    pendingCount > 0 ? 'inbox' : 'new',
  )
  const touched = useRef(false)
  useEffect(() => {
    if (!isMobile || touched.current) return
    if (pendingCount > 0) setTab('inbox')
  }, [pendingCount, isMobile])

  if (hosts.length === 0) return <ConnectView />
  if (teamRole === 'observer' || teamRole === 'approver') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-[14px] font-medium">只读成员</p>
          <p className="mt-1.5 text-[12.5px] leading-5 text-muted">
            你在这个 Host 上是{teamRole === 'observer' ? '观察者' : '审批者'}，可以查看被授权项目的会话
            {teamRole === 'approver' ? '并处理审批请求' : ''}，不能新建会话或发消息。
          </p>
        </div>
      </div>
    )
  }
  if (!isMobile) return <NewSessionView />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <SegmentedControl<'new' | 'inbox'>
          aria-label="首页页签"
          value={tab}
          onChange={(value) => {
            touched.current = true
            setTab(value)
          }}
          className="max-sm:h-11"
          itemClassName="max-sm:h-11 max-sm:px-3"
          options={[
            { value: 'new', label: '新会话' },
            {
              value: 'inbox',
              label: (
                <span className="flex items-center gap-1.5">
                  <Inbox size={14} />
                  收件箱
                  {unreadCount > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-strong px-1 text-[12px] font-semibold leading-none text-on-accent">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </span>
              ),
            },
          ]}
        />
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setDispatchOpen(true)}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] max-sm:min-h-11 font-medium text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <Send size={14} />
          派单
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'inbox' ? <InboxView embedded /> : <NewSessionView />}
      </div>
    </div>
  )
}
