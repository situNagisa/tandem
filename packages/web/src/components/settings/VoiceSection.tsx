// 语音设置：主机本机 Whisper（首选）与设备内置识别（次选），以及数据流向说明。
import { useEffect, useState } from 'react'
import { CheckCircle2, Info, Mic, ShieldCheck, XCircle } from 'lucide-react'
import type { HostSettings, SttCapabilities, SttTestResult, VoiceSettings } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Input, SegmentedControl, Switch } from '../ui/Controls'
import { Card } from '../ui/Card'
import { SettingNote, SettingRow } from '../ui/SettingRow'
import {
  browserSpeechSupported,
  invalidateVoiceCapabilities,
  isNativeApp,
  loadVoicePrefs,
  saveVoicePrefs,
  type VoicePrefs,
} from '../../lib/voice'

const ENGINE_OPTIONS = [
  { value: 'auto' as const, label: '自动判断' },
  { value: 'whisper-cpp' as const, label: 'whisper.cpp' },
  { value: 'faster-whisper' as const, label: 'faster-whisper' },
]

const PREF_OPTIONS = [
  { value: 'auto' as const, label: '自动', title: '优先 Host 本地 Whisper，不可用时降级到设备内置识别' },
  { value: 'host' as const, label: 'Host 转写', title: '只把录音发到用户自己的 Host' },
  { value: 'system' as const, label: '设备识别', title: '只使用系统/浏览器内置语音识别' },
]

export function VoiceSection() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [draft, setDraft] = useState<VoiceSettings>({ engine: 'auto', language: 'zh' })
  const [caps, setCaps] = useState<SttCapabilities | null>(null)
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<SttTestResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setCaps(null)
    setError(null)
    setTest(null)
    if (!host) return
    Promise.all([
      api.settings(host),
      api.sttCapabilities(host).catch((err: Error) => {
        if (!cancelled) setError(err.message)
        return null
      }),
    ])
      .then(([next, capabilities]) => {
        if (cancelled) return
        setSettings(next)
        setDraft({
          engine: next.voice?.engine ?? 'auto',
          binaryPath: next.voice?.binaryPath ?? '',
          modelPath: next.voice?.modelPath ?? '',
          language: next.voice?.language ?? 'zh',
        })
        setCaps(capabilities)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [host])

  const patch = (next: Partial<VoiceSettings>) => {
    setDraft((prev) => ({ ...prev, ...next }))
    setTest(null)
  }

  const save = async (): Promise<boolean> => {
    if (!host || !settings || saving) return false
    setSaving(true)
    setError(null)
    try {
      const next = await api.updateSettings(host, { ...settings, voice: draft })
      setSettings(next)
      invalidateVoiceCapabilities()
      const capabilities = await api.sttCapabilities(host).catch(() => null)
      setCaps(capabilities)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    if (!host || testing) return
    setTesting(true)
    setTest(null)
    try {
      if (!(await save())) return
      const result = await api.testStt(host)
      setTest(result)
    } catch (err) {
      setTest({
        ok: false,
        elapsedMs: 0,
        error: err instanceof Error ? err.message : '测试失败',
      })
    } finally {
      setTesting(false)
    }
  }

  const updatePrefs = (next: Partial<VoicePrefs>) => {
    const value = { ...prefs, ...next }
    setPrefs(value)
    saveVoicePrefs(value)
  }

  const useDetected = (binaryPath: string, engine: 'whisper-cpp' | 'faster-whisper') => {
    patch({ engine, binaryPath })
  }

  return (
    <div className="space-y-3">
      <Card data-setting-id="voice.engine">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <Mic size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">识别方式</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              默认优先使用你自己主机上的 Whisper；不可用时才降级到设备内置识别。
              Tandem 不会下载模型，也不会调用任何云端语音服务。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SegmentedControl
                options={PREF_OPTIONS}
                value={prefs.engine}
                onChange={(engine) => updatePrefs({ engine })}
                aria-label="语音识别方式偏好"
              />
              <span className="text-[12px] text-muted">
                {isNativeApp() ? '当前设备：安卓 App' : '当前设备：浏览器 / 桌面端'}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Card data-setting-id="voice.whisper">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <ShieldCheck size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[13px] font-medium">Host 本地 Whisper</h3>
              {caps ? (
                caps.available ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--t-success-soft)] px-2 py-0.5 text-[12px] text-success">
                    <CheckCircle2 size={11} /> 可用
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--t-warning-soft)] px-2 py-0.5 text-[12px] text-[var(--t-warning)]">
                    <XCircle size={11} /> 未配置
                  </span>
                )
              ) : null}
            </div>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              录音会通过局域网发到该 Host，转写后临时文件立即删除。可执行文件和模型都由你自行准备。
            </p>
            <div className="mt-3 grid gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted">识别后端</span>
                <SegmentedControl
                  options={ENGINE_OPTIONS}
                  value={draft.engine ?? 'auto'}
                  onChange={(engine) => patch({ engine })}
                  size="sm"
                  aria-label="本机 Whisper 后端"
                />
              </div>
              <label className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted">可执行文件</span>
                <Input
                  value={draft.binaryPath ?? ''}
                  onChange={(e) => patch({ binaryPath: e.target.value })}
                  placeholder="whisper-cli 的绝对路径；faster-whisper 模式填 python3"
                  className="font-mono text-[12px]"
                />
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted">模型</span>
                <Input
                  value={draft.modelPath ?? ''}
                  onChange={(e) => patch({ modelPath: e.target.value })}
                  placeholder="ggml-small.bin 的绝对路径；faster-whisper 填 small 或本地目录"
                  className="font-mono text-[12px]"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted">语言</span>
                <Input
                  value={draft.language ?? 'zh'}
                  onChange={(e) => patch({ language: e.target.value })}
                  className="w-24 font-mono text-[12px]"
                  aria-label="识别语言"
                />
                <Button variant="secondary" size="sm" disabled={!host || saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!host || saving || testing}
                  onClick={() => void runTest()}
                  tooltip="先保存，再让 Whisper 转写一段 1 秒静音"
                  tooltipSide="top"
                >
                  {testing ? '测试中…' : '测试'}
                </Button>
              </div>
            </div>
            {test ? (
              <div
                className={`mt-2 rounded-lg px-2.5 py-2 text-[12px] ${
                  test.ok
                    ? 'bg-[var(--t-success-soft)] text-success'
                    : 'bg-[var(--t-danger-soft)] text-danger'
                }`}
              >
                {test.ok
                  ? `测试通过（${test.engine}，${test.elapsedMs}ms）${test.text ? `：${test.text}` : '；静音返回空文本，属正常现象'}`
                  : `测试失败：${test.error ?? '未知错误'}`}
              </div>
            ) : null}
            {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
            {caps && caps.detected.length > 0 ? (
              <div className="mt-3">
                <p className="text-[12px] text-muted">在这台主机上自动探测到：</p>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {caps.detected.map((item) => (
                    <div
                      key={`${item.engine}:${item.binaryPath}`}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5"
                    >
                      <span className="font-mono text-[12px] text-text-soft">{item.binaryPath}</span>
                      <span className="text-[12px] text-muted">{item.engine}</span>
                      <span className="min-w-0 flex-1" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => useDetected(item.binaryPath, item.engine)}
                      >
                        填入
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <details className="mt-3 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] text-muted">
              <summary className="cursor-pointer select-none text-text-soft">如何准备本地 Whisper（不在 Tandem 内下载）</summary>
              <div className="mt-2 space-y-2 leading-5">
                <p>
                  <span className="text-text-soft">whisper.cpp：</span>自行获取源码并编译，得到
                  <code className="mx-1 rounded bg-[var(--t-code-bg)] px-1 font-mono">whisper-cli</code>
                  （旧版本叫 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">main</code>）。
                  在仓库目录执行 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">cmake -B build</code>、
                  <code className="mx-1 rounded bg-[var(--t-code-bg)] px-1 font-mono">cmake --build build -j</code>，
                  常见产物是 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">build/bin/whisper-cli</code>。
                  再把 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">ggml-*.bin</code> 模型文件放到本机
                  （例如 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">ggml-small.bin</code>），
                  两个路径填到上面。
                </p>
                <p>
                  <span className="text-text-soft">faster-whisper：</span>在主机上
                  <code className="mx-1 rounded bg-[var(--t-code-bg)] px-1 font-mono">pip install faster-whisper</code>
                  ，可执行文件填对应的 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">python3</code>，
                  模型填 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">small</code> 或本地模型目录。
                  首次使用某模型时，faster-whisper 自己可能需要联网拉取权重；Tandem 不代下载。
                </p>
                <p>Windows 上路径建议用完整盘符路径，例如 <code className="rounded bg-[var(--t-code-bg)] px-1 font-mono">C:\tools\whisper-cli.exe</code>。</p>
              </div>
            </details>
          </div>
        </div>
      </Card>

      <Card data-setting-id="voice.device">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-muted">
            <Info size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium">设备内置识别</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              安卓 App 使用系统语音服务；请在系统设置中下载中文离线语音包，避免识别时联网。
              浏览器 Web Speech API 在 Chrome 中通常会把音频发到浏览器厂商的服务器，因此默认关闭。
            </p>
            <div className="mt-3 flex items-center gap-2.5">
              <Switch
                checked={prefs.browserSpeechAllowed}
                onChange={(browserSpeechAllowed) => updatePrefs({ browserSpeechAllowed })}
                label="允许使用浏览器内置识别（可能联网）"
                disabled={isNativeApp()}
              />
              <span className="text-[12px] text-text-soft">
                允许使用浏览器内置识别（可能联网）
              </span>
              {!browserSpeechSupported() && !isNativeApp() ? (
                <span className="text-[12px] text-muted">当前浏览器不支持</span>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      <Card data-setting-id="voice.privacy">
        <h3 className="text-[13px] font-medium">数据流向</h3>
        <ul className="mt-2 space-y-1.5 text-[12px] leading-5 text-muted">
          <li>• Host 转写：麦克风 → 当前设备 → 你配置的 Host（局域网/本机）→ 本机 Whisper → 文本。临时音频在转写结束后立即删除。</li>
          <li>• 安卓系统识别：音频由系统语音服务处理；启用离线语音包时不离开设备。仅在 Host 转写不可用且你在上面选择设备识别时使用。</li>
          <li>• 浏览器内置识别：可能把音频发往浏览器厂商，默认禁用；只有你在这里明确打开才会使用。</li>
          <li>• Tandem 不会保存录音、不会上传到第三方，也不会自动下载模型。</li>
        </ul>
      </Card>

      <p className="px-1 text-[12px] text-muted">
        {host ? `主机设置保存在 ${host.name} 的 config.json；设备识别开关只保存在当前设备。` : '请先选择一台主机。'}
      </p>
    </div>
  )
}
