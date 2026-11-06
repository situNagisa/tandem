import { useEffect, useRef, useState } from 'react'
import { Loader2, ScanLine, TriangleAlert, X } from 'lucide-react'
import { Modal } from './ui/Modal'

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>
}

/** 浏览器原生 BarcodeDetector；不支持时上层隐藏扫码入口。 */
export function scannerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'BarcodeDetector' in window &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

export function QrScanDialog({
  onClose,
  onResult,
}: {
  onClose: () => void
  onResult: (value: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const Detector = (window as unknown as {
      BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike
    }).BarcodeDetector
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持原生扫码，请粘贴配对链接。')
      return
    }
    const detector = new Detector({ formats: ['qr_code'] })
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        void video.play().catch(() => undefined)
        setReady(true)
        const scan = async () => {
          if (cancelled || doneRef.current || !videoRef.current) return
          if (videoRef.current.readyState >= 2) {
            try {
              const codes = await detector.detect(videoRef.current)
              const value = codes.find((code) => code.rawValue)?.rawValue
              if (value && !doneRef.current) {
                doneRef.current = true
                onResult(value)
                return
              }
            } catch {
              /* 单帧识别失败，继续下一帧 */
            }
          }
          timer = window.setTimeout(scan, 400)
        }
        void scan()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof Error && /denied|NotAllowed/i.test(err.message)
            ? '没有相机权限，请在系统设置中允许后重试。'
            : '无法打开相机，请检查权限或改用粘贴链接。',
        )
      })
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [onResult])

  return (
    <Modal
      open
      onClose={onClose}
      title="扫码连接"
      description="对准电脑上的配对二维码。"
      className="max-w-sm"
    >
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-xl border border-border bg-black/90">
          <video ref={videoRef} playsInline muted className="aspect-square w-full object-cover" />
          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-white/80">
              <Loader2 size={22} className="animate-spin" />
            </div>
          )}
          <div className="pointer-events-none absolute inset-10 rounded-xl border-2 border-white/70" />
          {!error && (
            <div className="absolute inset-x-0 bottom-3 flex justify-center text-[11px] text-white/80">
              <span className="flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5">
                <ScanLine size={11} /> 正在识别…
              </span>
            </div>
          )}
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11.5px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}
        <button
          onClick={onClose}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
        >
          <X size={13} /> 取消
        </button>
      </div>
    </Modal>
  )
}
