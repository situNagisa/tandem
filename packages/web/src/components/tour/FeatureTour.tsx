import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  KeyRound,
  MessageSquare,
  Server,
  Sparkles,
  X,
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { navigate } from '../../lib/router'
import { navigateBoard } from '../../lib/boardRoute'
import { openDemoById } from '../../lib/demoOpen'
import {
  APP_VERSION,
  CHANGELOG_VERSION,
  LATEST_CHANGELOG_ITEMS,
  changelogSeenVersion,
  markChangelogSeen,
  markOnboardingDone,
  onboardingDone,
  pulseTourTarget,
  type ChangelogEntry,
  type ChangelogTarget,
} from '../../lib/changelog'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

const CARD_POSITION =
  'fixed bottom-[calc(88px+env(safe-area-inset-bottom))] right-3 z-[75] w-[min(340px,calc(100vw-1.5rem))] sm:right-4'

function runTarget(target: ChangelogTarget): void {
  const ui = useUiStore.getState()
  const app = useAppStore.getState()
  if (target.kind === 'settings') {
    ui.focusSetting(target.tab, target.settingId ?? '')
    return
  }
  if (target.kind === 'search') {
    ui.setSearchOpen(true)
    return
  }
  if (target.kind === 'split') {
    ui.setSplitPickerOpen(true)
    return
  }
  if (target.kind === 'inbox') {
    ui.setInboxOpen(true)
    return
  }
  if (target.kind === 'home') {
    navigate({ kind: 'home' })
    return
  }
  if (target.kind === 'demo') {
    if (!target.scenario) {
      ui.setDemoOpen(true)
      return
    }
    void openDemoById(target.scenario).then((opened) => {
      if (!opened) useUiStore.getState().setDemoOpen(true)
    })
    return
  }
  if (target.kind === 'checklist') {
    ui.setChecklistOpen(true)
    return
  }
  if (target.kind === 'about') {
    ui.setAboutOpen(true)
    return
  }
  if (target.kind === 'feedback') {
    useFeedbackStore.getState().enter()
    return
  }
  if (target.kind === 'board') {
    const hostId = app.activeHostId ?? app.hosts[0]?.id
    if (!hostId) {
      ui.toast('请先连接一台主机', 'info')
      return
    }
    navigateBoard(hostId)
    pulseTourTarget('[data-tour-target="board"]', 320)
  }
}

function TourPill({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className={`${CARD_POSITION} flex items-stretch overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-lg)]`}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--t-bg-active)] text-accent-text">
          <Sparkles size={13} />
        </span>
        <span className="min-w-0 flex-1 text-[13px] font-medium">新功能 · {LATEST_CHANGELOG_ITEMS.length} 项</span>
        <ArrowRight size={13} className="shrink-0 text-muted" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="暂时关闭新功能提示"
        className="grid w-8 shrink-0 place-items-center border-l border-border text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
      >
        <X size={13} />
      </button>
    </div>
  )
}

function TourPanel({ onClose, onJump }: { onClose: () => void; onJump: (entry: ChangelogEntry) => void }) {
  const markAll = () => {
    markChangelogSeen()
    onClose()
  }
  return (
    <section
      aria-label="新功能导览"
      className={`${CARD_POSITION} flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-lg)]`}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <span className="mt-0.5 text-accent-text">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">新功能 · {LATEST_CHANGELOG_ITEMS.length} 项</h2>
          <p className="mt-0.5 text-[12px] text-muted">版本 {CHANGELOG_VERSION} · 最近两天</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭新功能导览"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {LATEST_CHANGELOG_ITEMS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onJump(entry)}
            className="group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
          >
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5">{entry.title}</span>
              <span className="mt-0.5 block text-[12px] leading-5 text-muted">{entry.summary}</span>
            </span>
            <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[12px] text-text-tertiary transition-colors group-hover:text-text">
              去看看
              <ArrowRight size={11} />
            </span>
          </button>
        ))}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="text-[12px] text-muted">设置 → 关于 可再次打开</span>
        <Button size="sm" variant="ghost" onClick={markAll}>
          全部标为已读
        </Button>
      </footer>
    </section>
  )
}

const STEPS = [
  {
    title: '连接一台主机',
    body: '桌面端会自动连接本机；浏览器端输入主机地址，或让已连接的设备扫码。',
    action: '打开主机设置',
    tab: 'hosts' as const,
    icon: Server,
  },
  {
    title: '添加模型账号',
    body: '在账号与模型里填写服务商 Key，或一个 OpenAI / Anthropic 兼容接口。',
    action: '打开账号设置',
    tab: 'profiles' as const,
    icon: KeyRound,
  },
  {
    title: '开始第一个会话',
    body: '选好账号与模型，在输入框里说出第一个任务；审批与改动都在会话里完成。',
    action: '开始第一个会话',
    tab: null,
    icon: MessageSquare,
  },
]

function OnboardingCard({
  onFinish,
  onSkip,
  onOpenSettings,
}: {
  onFinish: () => void
  onSkip: () => void
  onOpenSettings: (tab: 'hosts' | 'profiles') => void
}) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const Icon = current.icon
  const last = step === STEPS.length - 1
  return (
    <section
      aria-label="上手引导"
      className={`${CARD_POSITION} rounded-xl border border-border bg-surface shadow-[var(--shadow-lg)]`}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-full bg-[var(--t-bg-active)] text-text-secondary">
          <Icon size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted">欢迎使用 Tandem · {step + 1}/3</p>
          <h2 className="text-[13px] font-semibold">{current.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1" aria-hidden>
          {STEPS.map((item, index) => (
            <span
              key={item.title}
              className={
                index === step
                  ? 'h-1.5 w-4 rounded-full bg-text-secondary'
                  : index < step
                    ? 'size-1.5 rounded-full bg-text-tertiary'
                    : 'size-1.5 rounded-full bg-border-strong'
              }
            />
          ))}
        </div>
      </header>
      <p className="px-3 py-2.5 text-[12.5px] leading-5 text-text-soft">{current.body}</p>
      <footer className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={onSkip}
          className="text-[12px] text-muted underline-offset-2 transition-colors hover:text-text hover:underline"
        >
          跳过
        </button>
        <span className="flex-1" />
        {current.tab && (
          <Button size="sm" variant="secondary" onClick={() => onOpenSettings(current.tab!)}>
            {current.action}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            if (last) onFinish()
            else setStep(step + 1)
          }}
        >
          {last ? '开始第一个会话' : '下一步'}
          {last ? <Check size={13} /> : <ArrowRight size={13} />}
        </Button>
      </footer>
    </section>
  )
}

function AboutDialog() {
  const open = useUiStore((s) => s.aboutOpen)
  const setAboutOpen = useUiStore((s) => s.setAboutOpen)
  const setTourOpen = useUiStore((s) => s.setTourOpen)
  const setOnboardingOpen = useUiStore((s) => s.setOnboardingOpen)
  const setDemoOpen = useUiStore((s) => s.setDemoOpen)
  const setChecklistOpen = useUiStore((s) => s.setChecklistOpen)
  return (
    <Modal
      open={open}
      onClose={() => setAboutOpen(false)}
      ariaLabel="关于 Tandem"
      title="关于 Tandem"
      className="w-[min(92vw,440px)]"
    >
      <div className="space-y-4 text-[13px] leading-5 text-text-soft">
        <div className="rounded-xl border border-border bg-surface p-3.5">
          <p className="text-[15px] font-medium text-text">Tandem {APP_VERSION}</p>
          <p className="mt-1 text-[12px] text-muted">多端 agent 工作台 · Web / 桌面 / 安卓</p>
        </div>
        <p className="text-[12.5px] text-muted">
          导览只在应用版本更新后自动出现一次；也可以从这里随时重新打开，或重看三步上手引导。
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setAboutOpen(false)
              setDemoOpen(true)
            }}
          >
            演示工作区
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAboutOpen(false)
              setChecklistOpen(true)
            }}
          >
            体验清单
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAboutOpen(false)
              setOnboardingOpen(true)
            }}
          >
            重看上手引导
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setAboutOpen(false)
              setTourOpen(true)
            }}
          >
            查看新功能
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function FeatureTour() {
  const initialized = useAppStore((s) => s.initialized)
  const hosts = useAppStore((s) => s.hosts)
  const tourOpen = useUiStore((s) => s.tourOpen)
  const onboardingOpen = useUiStore((s) => s.onboardingOpen)
  const aboutOpen = useUiStore((s) => s.aboutOpen)
  const setTourOpen = useUiStore((s) => s.setTourOpen)
  const setOnboardingOpen = useUiStore((s) => s.setOnboardingOpen)
  const [autoMode, setAutoMode] = useState<'none' | 'tour' | 'onboarding'>('none')
  const decided = useRef(false)

  useEffect(() => {
    if (!initialized || decided.current) return
    decided.current = true
    if (!onboardingDone() && hosts.length === 0) {
      setAutoMode('onboarding')
      return
    }
    if (changelogSeenVersion() !== CHANGELOG_VERSION) setAutoMode('tour')
  }, [initialized, hosts.length])

  useEffect(() => {
    if (onboardingOpen) setAutoMode('none')
  }, [onboardingOpen])

  useEffect(() => {
    if (tourOpen) setAutoMode('none')
  }, [tourOpen])

  const finishOnboarding = () => {
    markOnboardingDone()
    markChangelogSeen()
    setOnboardingOpen(false)
    setAutoMode('none')
    navigate({ kind: 'home' })
  }

  const skipOnboarding = () => {
    markOnboardingDone()
    markChangelogSeen()
    setOnboardingOpen(false)
    setAutoMode('none')
  }

  const jump = (entry: ChangelogEntry) => {
    setTourOpen(false)
    runTarget(entry.target)
  }

  return (
    <>
      {aboutOpen && <AboutDialog />}
      {!aboutOpen && (onboardingOpen || autoMode === 'onboarding') && (
        <OnboardingCard
          onFinish={finishOnboarding}
          onSkip={skipOnboarding}
          onOpenSettings={(tab) => useUiStore.getState().openSettings(tab)}
        />
      )}
      {!aboutOpen && !onboardingOpen && autoMode !== 'onboarding' && (
        tourOpen ? (
          <TourPanel onClose={() => setTourOpen(false)} onJump={jump} />
        ) : (
          autoMode === 'tour' && (
            <TourPill
              onOpen={() => setTourOpen(true)}
              onDismiss={() => {
                markChangelogSeen()
                setAutoMode('none')
              }}
            />
          )
        )
      )}
    </>
  )
}
