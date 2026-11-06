import { ArrowUpRight, FileText, GitBranch, Search, Sparkles, Wrench } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename } from '../lib/format'
import { ConnectView, NewSessionView } from './NewSessionDialog'

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
        这个会话还没有消息
      </h2>
      <p className="mt-2 max-w-md text-[12.5px] leading-6 text-muted">
        {hostName}
        {summary ? ` · ${basename(summary.cwd) || summary.cwd}` : ''}
        {profileName ? ` · ${profileName}` : ''}
      </p>
      <div className="mt-7 grid w-full max-w-[560px] grid-cols-1 gap-2 text-left sm:grid-cols-2">
        {SUGGESTIONS.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.title}
              onClick={() => seedPrompt(s.prompt)}
              className="group flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors duration-100 hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                <Icon size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[12.5px] font-medium text-text">
                  {s.title}
                  <ArrowUpRight
                    size={11}
                    className="text-muted opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </span>
                <span className="mt-0.5 block text-[11px] leading-5 text-muted">{s.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-[10.5px] text-muted">
        <Sparkles size={11} />
        输入框支持 @ 文件、/ 命令与图片粘贴
      </p>
    </div>
  )
}

export function HomeView() {
  const hosts = useAppStore((s) => s.hosts)
  if (hosts.length === 0) return <ConnectView />
  return <NewSessionView />
}
