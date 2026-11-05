import {
  ArrowRight,
  FileText,
  GitBranch,
  Laptop,
  Plus,
  Search,
  Server,
  Sparkles,
  Wrench,
} from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, formatRelative, modLabel } from '../lib/format'
import { navigate, sessionHash } from '../lib/router'
import { ConnectionDot, SessionStatusDot } from './StatusDot'
import { BrandMark } from './BrandMark'

const EMPTY_SESSIONS: SessionSummary[] = []

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

function SuggestionGrid({ onPick }: { onPick?: () => void }) {
  const seedPrompt = useUiStore((s) => s.seedPrompt)
  return (
    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map((s) => {
        const Icon = s.icon
        return (
          <button
            key={s.title}
            onClick={() => {
              seedPrompt(s.prompt)
              onPick?.()
            }}
            className="group flex min-h-[76px] items-start gap-3 rounded-xl border border-border bg-surface/80 p-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-border-strong/70 hover:bg-surface hover:shadow-[0_4px_16px_-8px_rgba(40,30,20,0.25)]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Icon size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-[13px] font-medium text-text">
                {s.title}
                <ArrowRight
                  size={12}
                  className="-translate-x-1 text-muted opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
                />
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-5 text-muted">{s.desc}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

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

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-2 py-8 text-center md:py-12">
      <BrandMark size={38} className="mb-4 opacity-90 shadow-sm" />
      <h2 className="font-serif text-[26px] leading-tight tracking-tight text-text md:text-[30px]">
        今天想做点什么？
      </h2>
      <p className="mt-2 max-w-md text-[13px] leading-6 text-muted">
        {hostName}
        {summary ? ` · ${basename(summary.cwd) || summary.cwd}` : ''}
        {profileName ? ` · ${profileName}` : ''}
        {summary?.model ? ` · ${summary.model}` : ''}
      </p>
      <div className="mt-7 w-full max-w-xl">
        <SuggestionGrid />
      </div>
    </div>
  )
}

export function HomeView() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const sessions = useAppStore((s) =>
    activeHostId ? (s.runtimes[activeHostId]?.sessions ?? EMPTY_SESSIONS) : EMPTY_SESSIONS,
  )
  const runtime = useAppStore((s) => (activeHostId ? s.runtimes[activeHostId] : undefined))
  const setNewSessionOpen = useUiStore((s) => s.setNewSessionOpen)
  const openSettings = useUiStore((s) => s.openSettings)
  const host = hosts.find((h) => h.id === activeHostId) ?? hosts[0] ?? null

  if (!host) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 text-center shadow-sm md:p-8">
          <BrandMark size={46} className="mx-auto" />
          <h2 className="mt-5 font-serif text-[26px] tracking-tight">欢迎使用 Tandem</h2>
          <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-muted">
            在要执行任务的机器上启动 Tandem Host，然后用带 token 的链接打开，或手动添加一台 Host。
          </p>
          <div className="mt-6 space-y-2 rounded-xl border border-border bg-bg/50 p-3 text-left">
            {[
              ['1', '在目标机器上启动 Host 守护进程'],
              ['2', '用地址栏里的 ?token= 链接打开，或手动添加 Host'],
              ['3', '选择工作目录，开始和 agent 对话'],
            ].map(([n, text]) => (
              <div key={n} className="flex items-center gap-2.5 text-[12.5px] text-text-soft">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10.5px] font-semibold text-accent">
                  {n}
                </span>
                {text}
              </div>
            ))}
          </div>
          <button
            onClick={() => openSettings('hosts')}
            className="mt-6 inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            <Plus size={15} /> 添加 Host
          </button>
        </div>
      </div>
    )
  }

  const recent = sessions.slice(0, 4)
  const offline = runtime?.status === 'offline'
  const profiles = runtime?.profiles ?? []

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-12">
      <div className="anim-slide-up">
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          <ConnectionDot state={runtime?.status ?? 'connecting'} />
          {host.name}
          <span className="text-border-strong">·</span>
          {runtime?.status === 'online'
            ? '在线'
            : runtime?.status === 'connecting'
              ? '连接中…'
              : '离线'}
          {runtime?.info?.platform && (
            <>
              <span className="text-border-strong">·</span>
              {runtime.info.platform} {runtime.info.version}
            </>
          )}
        </div>
        <h1 className="mt-3 font-serif text-[30px] leading-tight tracking-tight md:text-[36px]">
          在{host.name}上开始
        </h1>
        <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-muted">
          选择一个工作目录，Tandem 会在那台机器上读写文件、运行命令并实时向你汇报。
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setNewSessionOpen(true)}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[13px] font-medium text-on-accent shadow-[0_2px_8px_-2px_rgba(120,60,30,0.4)] transition-colors hover:bg-accent-hover"
          >
            <Plus size={15} /> 新建会话
          </button>
          <button
            onClick={() => openSettings('profiles')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-[13px] text-text-soft transition-colors hover:bg-surface-2"
          >
            <Sparkles size={14} /> 账号与模型
            <span className="text-[11px] text-muted">{profiles.length} 个账号</span>
          </button>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted md:flex">
            {modLabel} N 新会话 · {modLabel} K 搜索
          </span>
        </div>

        {offline && (
          <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning-soft/60 px-3.5 py-2.5 text-[12.5px] text-warning">
            <Server size={15} />
            Host 当前离线，连上后即可发起任务。
            <button
              onClick={() => useAppStore.getState().retryHost(host.id)}
              className="ml-auto rounded-md border border-warning/30 px-2 py-0.5 text-[11.5px] hover:bg-warning/10"
            >
              重试
            </button>
          </div>
        )}

        <div className="mt-8 grid gap-3 md:grid-cols-[1.15fr_1fr]">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-text-soft">
              <Laptop size={14} className="text-muted" /> 最近会话
            </div>
            {recent.length === 0 ? (
              <p className="mt-5 text-[12.5px] text-muted">还没有会话，从右上角的「新会话」开始。</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/70">
                {recent.map((s) => (
                  <li key={s.id}>
                    <a
                      href={sessionHash(host.id, s.id)}
                      onClick={(e) => {
                        e.preventDefault()
                        navigate({ kind: 'session', hostId: host.id, sessionId: s.id })
                      }}
                      className="flex min-h-11 items-center gap-2 py-1.5 text-[12.5px] text-text-soft transition-colors hover:text-text"
                    >
                      <SessionStatusDot status={s.status} />
                      <span className="min-w-0 flex-1 truncate">{s.title || '未命名会话'}</span>
                      <span className="shrink-0 text-[10.5px] text-muted">
                        {formatRelative(s.updatedAt)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-text-soft">
              <Server size={14} className="text-muted" /> Host 信息
            </div>
            <dl className="mt-3 space-y-2 text-[12px]">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted">名称</dt>
                <dd className="min-w-0 flex-1 truncate">{host.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted">版本</dt>
                <dd>{runtime?.info?.version ?? '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted">家目录</dt>
                <dd className="min-w-0 flex-1 truncate font-mono text-[11px]" title={runtime?.info?.homeDir}>
                  {runtime?.info?.homeDir ?? '—'}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted">地址</dt>
                <dd className="min-w-0 flex-1 truncate font-mono text-[11px]" title={host.url}>
                  {host.url.replace(/^https?:\/\//, '')}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="mt-8">
          <SuggestionGrid onPick={() => setNewSessionOpen(true)} />
        </div>
      </div>
    </div>
  )
}
