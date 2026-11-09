// 语音输入：录音 → 16kHz 单声道 WAV（上传给用户自己的 Host），以及设备内置识别。
// 浏览器 Web Speech API 在 Chrome 中会联网，因此默认禁用，必须用户在设置里显式允许。
import { Capacitor } from '@capacitor/core'
import type { SttCapabilities } from '@tandem/protocol'
import { api } from './api'
import { readJson, writeJson } from './storage'
import type { HostConfig } from './types'

const PREFS_KEY = 'tandem.voice.prefs'
const PREFS_EVENT = 'tandem-voice-prefs'

export interface VoicePrefs {
  /** auto：Host 转写可用就优先用它；host：只用 Host；system：只用设备内置识别。 */
  engine: 'auto' | 'host' | 'system'
  /** 浏览器 Web Speech API 可能联网，默认 false。 */
  browserSpeechAllowed: boolean
}

export function loadVoicePrefs(): VoicePrefs {
  const parsed = readJson<Partial<VoicePrefs> | null>(PREFS_KEY, null)
  if (parsed) {
    return {
      engine:
        parsed.engine === 'host' || parsed.engine === 'system' ? parsed.engine : 'auto',
      browserSpeechAllowed: parsed.browserSpeechAllowed === true,
    }
  }
  return { engine: 'auto', browserSpeechAllowed: false }
}

export function saveVoicePrefs(next: VoicePrefs): void {
  writeJson(PREFS_KEY, next)
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next }))
}

export function subscribeVoicePrefs(cb: (prefs: VoicePrefs) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<VoicePrefs>).detail)
  window.addEventListener(PREFS_EVENT, handler)
  return () => window.removeEventListener(PREFS_EVENT, handler)
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

// ---------- 录音与 WAV ----------

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private data: Uint8Array<ArrayBuffer> | null = null
  private startedAt = 0
  private rawMime = ''

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风采集')
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('当前浏览器不支持录音（MediaRecorder）')
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.ctx = new AudioContext()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    source.connect(this.analyser)
    this.data = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>
    this.rawMime = pickMimeType()
    this.recorder = new MediaRecorder(this.stream, this.rawMime ? { mimeType: this.rawMime } : undefined)
    this.chunks = []
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start(120)
    this.startedAt = Date.now()
  }

  /** 当前音量 0..1，用于波形条。 */
  level(): number {
    if (!this.analyser || !this.data) return 0
    this.analyser.getByteTimeDomainData(this.data)
    let sum = 0
    for (const v of this.data) {
      const x = (v - 128) / 128
      sum += x * x
    }
    return Math.min(1, Math.sqrt(sum / this.data.length) * 4)
  }

  elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.analyser = null
  }

  async stop(): Promise<{ blob: Blob; mimeType: string; durationMs: number }> {
    const durationMs = this.elapsedMs()
    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        recorder.stop()
      })
    }
    this.recorder = null
    this.stopTracks()
    const raw = new Blob(this.chunks, { type: recorder?.mimeType || this.rawMime || 'audio/webm' })
    this.chunks = []
    if (!raw.size) throw new Error('没有录到声音')
    try {
      const wav = await blobToWav16k(raw)
      return { blob: wav, mimeType: 'audio/wav', durationMs }
    } catch {
      // 浏览器解不了自家格式时交给 Host 的 ffmpeg 兜底
      return { blob: raw, mimeType: raw.type || 'audio/webm', durationMs }
    }
  }

  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      // 已停止
    }
    this.recorder = null
    this.chunks = []
    this.stopTracks()
  }
}

/** 解码任意浏览器可解的音频，混成单声道并线性重采样到 16kHz PCM16 WAV。 */
export async function blobToWav16k(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void ctx.close().catch(() => {})
  }
  const channels = buffer.numberOfChannels
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels
  }
  const targetRate = 16000
  const ratio = buffer.sampleRate / targetRate
  const length = Math.max(1, Math.round(mono.length / ratio))
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(mono.length - 1, i0 + 1)
    const frac = pos - i0
    const sample = mono[i0] * (1 - frac) + mono[i1] * frac
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  return new Blob([header, pcm.buffer], { type: 'audio/wav' })
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取录音失败'))
    reader.readAsDataURL(blob)
  })
}

// ---------- 浏览器内置识别（Web Speech API，可能联网） ----------

interface BrowserRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export function browserSpeechSupported(): boolean {
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserRecognition
    webkitSpeechRecognition?: new () => BrowserRecognition
  }
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

export interface SpeechSession {
  stop(): Promise<string>
  cancel(): void
}

export function startBrowserSpeech(onInterim?: (text: string) => void): SpeechSession {
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserRecognition
    webkitSpeechRecognition?: new () => BrowserRecognition
  }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) throw new Error('当前浏览器不支持内置语音识别')
  const rec = new Ctor()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  let finalText = ''
  let ended = false
  let endResolve: (() => void) | null = null
  let failure: Error | null = null
  rec.onresult = (event: any) => {
    let interim = ''
    for (let i = event.resultIndex ?? 0; i < (event.results?.length ?? 0); i++) {
      const result = event.results[i]
      const text = result?.[0]?.transcript ?? ''
      if (result?.isFinal) finalText += text
      else interim += text
    }
    onInterim?.((finalText + interim).trim())
  }
  rec.onerror = (event: any) => {
    const code = event?.error ?? 'unknown'
    if (code !== 'no-speech' && code !== 'aborted') {
      failure = new Error(
        code === 'not-allowed'
          ? '麦克风或语音识别权限被拒绝'
          : code === 'network'
            ? '浏览器内置识别需要联网，已失败'
            : `内置语音识别失败：${code}`,
      )
    }
  }
  rec.onend = () => {
    ended = true
    endResolve?.()
  }
  rec.start()
  return {
    stop: () =>
      new Promise<string>((resolve, reject) => {
        if (ended) {
          if (failure) reject(failure)
          else resolve(finalText.trim())
          return
        }
        endResolve = () => (failure ? reject(failure) : resolve(finalText.trim()))
        rec.stop()
      }),
    cancel: () => {
      try {
        rec.abort()
      } catch {
        // 已经结束
      }
    },
  }
}

// ---------- 安卓系统内置识别（Capacitor） ----------

export async function nativeSpeechSupported(): Promise<boolean> {
  if (!isNativeApp()) return false
  try {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
    const res = await SpeechRecognition.available()
    return res.available
  } catch {
    return false
  }
}

export async function startNativeSpeech(): Promise<SpeechSession> {
  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
  const perm = await SpeechRecognition.checkPermissions()
  if (perm.speechRecognition !== 'granted') {
    const next = await SpeechRecognition.requestPermissions()
    if (next.speechRecognition !== 'granted') throw new Error('麦克风权限被拒绝')
  }
  const resultPromise = SpeechRecognition.start({
    language: 'zh-CN',
    maxResults: 1,
    partialResults: false,
    popup: false,
    prompt: '请说话',
  })
  let stopped = false
  return {
    stop: async () => {
      if (!stopped) {
        stopped = true
        await SpeechRecognition.stop().catch(() => {})
      }
      const result = await Promise.race([
        resultPromise,
        new Promise<{ matches?: string[] }>((resolve) => setTimeout(() => resolve({}), 6000)),
      ])
      return result.matches?.[0]?.trim() ?? ''
    },
    cancel: () => {
      stopped = true
      void SpeechRecognition.stop().catch(() => {})
    },
  }
}


// ---------- Host 转写能力探测（短缓存，设置改动后由设置页主动失效） ----------

let capCache: { hostId: string; at: number; value: SttCapabilities } | null = null

export function invalidateVoiceCapabilities(): void {
  capCache = null
}

export async function getVoiceCapabilities(
  host: HostConfig,
  force = false,
): Promise<SttCapabilities> {
  if (!force && capCache && capCache.hostId === host.id && Date.now() - capCache.at < 15_000) {
    return capCache.value
  }
  const value = await api.sttCapabilities(host)
  capCache = { hostId: host.id, at: Date.now(), value }
  return value
}
