// 语音输入按钮：按住说话 / 点击持续录音，松开后转写并回填到调用方光标位置。
// 录音只在本机与用户自己的 主机之间传输；主机转写失败时按设置降级到设备内置识别。
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Mic, X } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import type { ControlSize } from '../ui/Button'
import { IconButton } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import {
  browserSpeechSupported,
  blobToBase64,
  getVoiceCapabilities,
  isNativeApp,
  loadVoicePrefs,
  nativeSpeechSupported,
  startBrowserSpeech,
  startNativeSpeech,
  VoiceRecorder,
  type SpeechSession,
} from '../../lib/voice'
import { api } from '../../lib/api'

type Phase = 'idle' | 'preparing' | 'recording' | 'transcribing'
type Backend = 'host' | 'native' | 'browser'

export interface VoiceButtonHandle {
  /** 快捷键按下：开始说话 */
  startHold: () => void
  /** 快捷键松开：停止并转写 */
  stopHold: () => void
  cancel: () => void
}

export interface VoiceButtonProps {
  onText: (text: string) => void
  disabled?: boolean
  size?: ControlSize
  className?: string
  tooltipSide?: 'top' | 'bottom'
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export const VoiceButton = forwardRef<VoiceButtonHandle, VoiceButtonProps>(function VoiceButton(
  { onText, disabled, size = 'md', className, tooltipSide = 'top' },
  ref,
) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const openSettings = useUiStore((s) => s.openSettings)
  const toast = useUiStore((s) => s.toast)

  const [phase, setPhase] = useState<Phase>('idle')
  const [locked, setLocked] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>([])
  const [liveText, setLiveText] = useState('')
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null)

  const phaseRef = useRef<Phase>('idle')
  const lockedRef = useRef(false)
  const backendRef = useRef<Backend | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const speechRef = useRef<SpeechSession | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tickerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const pressedAtRef = useRef(0)
  const pendingReleaseRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (tickerRef.current) window.clearInterval(tickerRef.current)
      recorderRef.current?.cancel()
      speechRef.current?.cancel()
    }
  }, [])

  const setPhaseSafe = (next: Phase) => {
    phaseRef.current = next
    if (mountedRef.current) setPhase(next)
  }

  const stopTicker = () => {
    if (tickerRef.current) {
      window.clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }

  const updatePanel = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 264
    const left = Math.min(Math.max(8, rect.left - 8), window.innerWidth - width - 8)
    const top = Math.max(8, rect.top - 116)
    setPanelPos({ left, top })
  }, [])

  const cleanup = () => {
    stopTicker()
    recorderRef.current?.cancel()
    recorderRef.current = null
    speechRef.current?.cancel()
    speechRef.current = null
    backendRef.current = null
    pendingReleaseRef.current = null
    if (mountedRef.current) {
      setLevels([])
      setElapsed(0)
      setLiveText('')
      setLocked(false)
      setPanelPos(null)
    }
    lockedRef.current = false
  }

  const showError = (err: unknown) => {
    const message = err instanceof Error ? err.message : '语音输入失败'
    toast(message, 'error')
  }

  const chooseBackend = async (): Promise<Backend> => {
    const prefs = loadVoicePrefs()
    const hostAvailable = async () => {
      if (!host) return false
      try {
        const caps = await getVoiceCapabilities(host)
        return caps.available
      } catch {
        return false
      }
    }
    if (isNativeApp()) {
      if (prefs.engine === 'system') {
        if (await nativeSpeechSupported()) return 'native'
        throw new Error('系统内置语音识别不可用，请检查系统语音服务')
      }
      if (prefs.engine === 'host') {
        if (await hostAvailable()) return 'host'
        throw new Error('主机本地转写不可用，请在设置 → 语音 中配置 Whisper')
      }
      if (await hostAvailable()) return 'host'
      if (await nativeSpeechSupported()) return 'native'
      throw new Error('没有可用的语音识别方式：请配置 主机 Whisper，或启用系统语音服务')
    }
    if (prefs.engine === 'host') {
      if (await hostAvailable()) return 'host'
      throw new Error('主机本地转写不可用，请在设置 → 语音 中配置 Whisper')
    }
    if (prefs.engine === 'system') {
      if (!prefs.browserSpeechAllowed) {
        throw new Error('浏览器内置识别可能联网，需先在设置 → 语音 中明确允许')
      }
      if (!browserSpeechSupported()) throw new Error('当前浏览器不支持内置语音识别')
      return 'browser'
    }
    if (await hostAvailable()) return 'host'
    if (prefs.browserSpeechAllowed && browserSpeechSupported()) return 'browser'
    throw new Error(
      host
        ? '还没配置语音识别：可在设置 → 语音 配置 主机 Whisper，或允许浏览器内置识别（可能联网）'
        : '主机未连接，无法使用本机转写',
    )
  }

  const finish = useCallback(async () => {
    if (phaseRef.current !== 'recording') return
    setPhaseSafe('transcribing')
    stopTicker()
    setLocked(false)
    lockedRef.current = false
    const backend = backendRef.current
    try {
      let text = ''
      if (backend === 'host') {
        const recorder = recorderRef.current
        if (!recorder) throw new Error('录音未开始')
        const clip = await recorder.stop()
        recorderRef.current = null
        if (!host) throw new Error('主机未连接')
        const audioBase64 = await blobToBase64(clip.blob)
        const result = await api.transcribe(host, {
          audioBase64,
          mimeType: clip.mimeType,
          language: 'zh',
        })
        text = result.text.trim()
      } else {
        const session = speechRef.current
        if (!session) throw new Error('语音识别未开始')
        text = (await session.stop()).trim()
        speechRef.current = null
      }
      if (!mountedRef.current) return
      if (!text) {
        toast('没有识别到文字，请再说一次', 'info')
      } else {
        onText(text)
      }
      cleanup()
      setPhaseSafe('idle')
    } catch (err) {
      cleanup()
      setPhaseSafe('idle')
      showError(err)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, onText, toast])

  const cancel = useCallback(() => {
    if (phaseRef.current === 'idle') return
    cleanup()
    setPhaseSafe('idle')
  }, [])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || disabled) return
    setPhaseSafe('preparing')
    setLocked(false)
    lockedRef.current = false
    setLiveText('')
    try {
      const backend = await chooseBackend()
      if (!mountedRef.current) return
      backendRef.current = backend
      if (backend === 'host') {
        const recorder = new VoiceRecorder()
        await recorder.start()
        recorderRef.current = recorder
      } else if (backend === 'native') {
        speechRef.current = await startNativeSpeech()
      } else {
        speechRef.current = startBrowserSpeech((text) => {
          if (mountedRef.current) setLiveText(text)
        })
      }
      if ((phaseRef.current as Phase) !== 'preparing') {
        // 准备期间被取消
        cleanup()
        return
      }
      startedAtRef.current = Date.now()
      setPhaseSafe('recording')
      updatePanel()
      tickerRef.current = window.setInterval(() => {
        if (phaseRef.current !== 'recording') return
        const ms = Date.now() - startedAtRef.current
        setElapsed(ms)
        const recorder = recorderRef.current
        const level = recorder
          ? recorder.level()
          : 0.25 + Math.abs(Math.sin(ms / 260)) * 0.45
        setLevels((prev) => [...prev.slice(-23), level])
        if (ms >= 120_000) void finish()
      }, 100)
      const pending = pendingReleaseRef.current
      if (pending !== null) {
        pendingReleaseRef.current = null
        if (pending < 250) {
          lockedRef.current = true
          setLocked(true)
        } else {
          void finish()
        }
      }
    } catch (err) {
      cleanup()
      setPhaseSafe('idle')
      showError(err)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, host, updatePanel, finish, toast])

  useImperativeHandle(
    ref,
    () => ({
      startHold: () => void start(),
      stopHold: () => {
        if (phaseRef.current === 'recording' && !lockedRef.current) void finish()
      },
      cancel,
    }),
    [start, finish, cancel],
  )

  useEffect(() => {
    if (phase === 'idle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phaseRef.current === 'recording') {
        e.preventDefault()
        cancel()
      }
    }
    const onViewport = () => updatePanel()
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [phase, cancel, updatePanel])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    if (phaseRef.current === 'recording') {
      if (lockedRef.current) void finish()
      return
    }
    if (phaseRef.current !== 'idle') return
    pressedAtRef.current = Date.now()
    pendingReleaseRef.current = null
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 某些 WebView 不支持指针捕获
    }
    void start()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    const duration = pressedAtRef.current ? Date.now() - pressedAtRef.current : 0
    if (phaseRef.current === 'preparing') {
      pendingReleaseRef.current = duration
      return
    }
    if (phaseRef.current !== 'recording') return
    if (lockedRef.current) return
    if (duration < 250) {
      // 短按进入持续录音模式
      lockedRef.current = true
      setLocked(true)
      updatePanel()
    } else {
      void finish()
    }
  }

  const recording = phase === 'recording'
  const busy = phase === 'preparing' || phase === 'transcribing'
  const tip = recording
    ? locked
      ? '点击麦克风停止并转写'
      : '松开转写'
    : '按住说话，松开转写；点击持续录音'

  return (
    <>
      <IconButton
        ref={buttonRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => e.preventDefault()}
        disabled={disabled}
        label={recording ? '停止语音输入' : '语音输入'}
        tooltip={busy ? '正在处理语音…' : tip}
        tooltipSide={tooltipSide}
        aria-pressed={recording}
        data-recording={recording || undefined}
        className={cn(
          'max-sm:size-11',
          recording && 'bg-[var(--t-danger-soft)] text-danger hover:bg-[var(--t-danger-soft)] hover:text-danger',
          className,
        )}
      >
        {busy ? (
          <Spinner size={16} />
        ) : (
          <Mic size={16} className={recording ? 'animate-pulse' : undefined} />
        )}
      </IconButton>
      {phase !== 'idle' &&
        panelPos &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="fixed z-[70] w-[264px] rounded-xl border border-border bg-surface p-2.5 shadow-lg"
            style={{ left: panelPos.left, top: panelPos.top }}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  recording ? 'animate-pulse bg-danger' : 'bg-[var(--t-accent)]',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                {phase === 'preparing'
                  ? '正在准备麦克风…'
                  : phase === 'transcribing'
                    ? '正在转写…'
                    : `录音中 ${formatTime(elapsed)}`}
              </span>
              <IconButton
                label="取消语音输入"
                size="sm"
                onClick={cancel}
                disabled={phase === 'transcribing'}
                className="size-6! [&_svg]:size-3"
              >
                <X size={12} />
              </IconButton>
            </div>
            {recording ? (
              <div className="mt-2 flex h-8 items-center gap-[3px]" aria-hidden>
                {levels.map((level, i) => (
                  <span
                    key={i}
                    className="w-[6px] flex-1 rounded-full bg-[color-mix(in_srgb,var(--t-accent)_70%,transparent)] transition-[height] duration-100"
                    style={{ height: `${4 + Math.round(level * 24)}px` }}
                  />
                ))}
                {Array.from({ length: Math.max(0, 24 - levels.length) }).map((_, i) => (
                  <span key={`empty-${i}`} className="h-1 w-[6px] flex-1 rounded-full bg-border" />
                ))}
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] text-muted">
                <Spinner size={13} />
                {phase === 'transcribing' ? '正在把语音变成文字…' : '等待麦克风权限…'}
              </div>
            )}
            {liveText ? (
              <div className="mt-1.5 line-clamp-2 text-[12px] text-text-soft">{liveText}</div>
            ) : null}
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-muted">
              <span className="truncate">
                {backendRef.current === 'host'
                  ? '识别：主机本机 Whisper'
                  : backendRef.current === 'native'
                    ? '识别：系统语音服务'
                    : backendRef.current === 'browser'
                      ? '识别：浏览器内置（可能联网）'
                      : '识别：准备中'}
              </span>
              <span className="shrink-0">
                {recording ? (locked ? '点击停止 · Esc 取消' : '松开转写 · Esc 取消') : ''}
              </span>
            </div>
            {!recording && phase === 'preparing' ? (
              <Button
                size="inline"
                variant="ghost"
                className="mt-1 text-accent-text"
                onClick={() => {
                  cancel()
                  openSettings('voice')
                }}
              >
                打开语音设置
              </Button>
            ) : null}
          </div>,
          document.body,
        )}
    </>
  )
})
