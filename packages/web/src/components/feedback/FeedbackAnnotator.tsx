import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight,
  Check,
  Grid3x3,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../ui/Button'

type Tool = 'rect' | 'arrow' | 'pen' | 'text' | 'mosaic'

const COLORS = [
  { value: '#F97316', label: '橙色' },
  { value: '#FFFFFF', label: '白色' },
  { value: '#EF4444', label: '红色' },
] as const

const TOOLS: ReadonlyArray<{ value: Tool; label: string; icon: ReactNode }> = [
  { value: 'rect', label: '矩形', icon: <Square size={15} /> },
  { value: 'arrow', label: '箭头', icon: <ArrowUpRight size={15} /> },
  { value: 'pen', label: '画笔', icon: <Pencil size={15} /> },
  { value: 'text', label: '文字', icon: <Type size={15} /> },
  { value: 'mosaic', label: '马赛克', icon: <Grid3x3 size={15} /> },
]

const MAX_HISTORY = 30

/** Canvas 标注编辑器：矩形、箭头、画笔、文字、马赛克，橙/白/红三色，撤销重做。 */
export function FeedbackAnnotator({
  image,
  onCancel,
  onSave,
}: {
  image: string
  onCancel: () => void
  onSave: (dataURL: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState<string>('#F97316')
  const [display, setDisplay] = useState({ width: 0, height: 0 })
  const [history, setHistory] = useState<{ list: string[]; index: number }>({ list: [], index: -1 })
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null)
  const [textValue, setTextValue] = useState('')
  const [ready, setReady] = useState(false)
  const textCommitRef = useRef<string | null>(null)
  const drawingRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    base: ImageData | null
  } | null>(null)
  const toolRef = useRef(tool)
  toolRef.current = tool
  const colorRef = useRef(color)
  colorRef.current = color

  const drawImageUrl = useCallback((url: string, canvas: HTMLCanvasElement) => {
    return new Promise<void>((resolve) => {
      const img = new Image()
      img.onload = () => {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0)
        }
        resolve()
      }
      img.onerror = () => resolve()
      img.src = url
    })
  }, [])

  // 载入原图并计算适合视口的显示尺寸。
  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return
    void drawImageUrl(image, canvas).then(() => {
      if (cancelled) return
      const fit = () => {
        if (!canvas.width || !canvas.height) return
        const maxW = Math.max(320, window.innerWidth - 64)
        const maxH = Math.max(240, window.innerHeight - 150)
        const scale = Math.min(maxW / canvas.width, maxH / canvas.height, 3)
        setDisplay({
          width: Math.round(canvas.width * scale),
          height: Math.round(canvas.height * scale),
        })
      }
      fit()
      window.addEventListener('resize', fit)
      setHistory({ list: [image], index: 0 })
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [image, drawImageUrl])

  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const url = canvas.toDataURL('image/png')
    setHistory((prev) => {
      const next = prev.list.slice(0, prev.index + 1)
      next.push(url)
      const overflow = Math.max(0, next.length - MAX_HISTORY)
      const list = overflow ? next.slice(overflow) : next
      return { list, index: list.length - 1 }
    })
  }, [])

  const restore = useCallback(
    async (index: number) => {
      const canvas = canvasRef.current
      const url = history.list[index]
      if (!canvas || !url) return
      await drawImageUrl(url, canvas)
      setHistory((prev) => ({ ...prev, index }))
    },
    [history, drawImageUrl],
  )

  const undo = () => {
    if (history.index > 0) void restore(history.index - 1)
  }
  const redo = () => {
    if (history.index < history.list.length - 1) void restore(history.index + 1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (textAt) {
          setTextAt(null)
          setTextValue('')
        } else {
          onCancel()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const box = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - box.left) / Math.max(1, box.width)) * canvas.width,
      y: ((e.clientY - box.top) / Math.max(1, box.height)) * canvas.height,
    }
  }

  const drawArrow = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const head = Math.max(10, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.02)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7))
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7))
    ctx.stroke()
  }

  const pixelate = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const size = Math.max(14, Math.min(40, ctx.canvas.width * 0.018))
    const sx = Math.max(0, Math.min(ctx.canvas.width - size, x - size / 2))
    const sy = Math.max(0, Math.min(ctx.canvas.height - size, y - size / 2))
    const tmp = document.createElement('canvas')
    tmp.width = 4
    tmp.height = 4
    const tmpCtx = tmp.getContext('2d')
    if (!tmpCtx) return
    tmpCtx.imageSmoothingEnabled = false
    tmpCtx.drawImage(ctx.canvas, sx, sy, size, size, 0, 0, 4, 4)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(tmp, 0, 0, 4, 4, sx, sy, size, size)
    ctx.restore()
  }

  const strokeStyle = (ctx: CanvasRenderingContext2D) => {
    ctx.strokeStyle = colorRef.current
    ctx.fillStyle = colorRef.current
    ctx.lineWidth = Math.max(2, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.004)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    const point = canvasPoint(e)
    if (tool === 'text') {
      textCommitRef.current = null
      setTextAt(point)
      setTextValue('')
      return
    }
    if (tool === 'mosaic') {
      pixelate(ctx, point.x, point.y)
      drawingRef.current = { pointerId: e.pointerId, startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, base: null }
      return
    }
    const base = tool === 'pen' ? null : ctx.getImageData(0, 0, canvas.width, canvas.height)
    drawingRef.current = {
      pointerId: e.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      base,
    }
    if (tool === 'pen') {
      strokeStyle(ctx)
      ctx.beginPath()
      ctx.moveTo(point.x, point.y)
      ctx.lineTo(point.x + 0.1, point.y + 0.1)
      ctx.stroke()
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const draw = drawingRef.current
    if (!draw || draw.pointerId !== e.pointerId) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const point = canvasPoint(e)
    if (toolRef.current === 'pen') {
      strokeStyle(ctx)
      ctx.beginPath()
      ctx.moveTo(draw.lastX, draw.lastY)
      ctx.lineTo(point.x, point.y)
      ctx.stroke()
      draw.lastX = point.x
      draw.lastY = point.y
      return
    }
    if (toolRef.current === 'mosaic') {
      pixelate(ctx, point.x, point.y)
      draw.lastX = point.x
      draw.lastY = point.y
      return
    }
    if (draw.base) ctx.putImageData(draw.base, 0, 0)
    strokeStyle(ctx)
    if (toolRef.current === 'rect') {
      ctx.strokeRect(
        Math.min(draw.startX, point.x),
        Math.min(draw.startY, point.y),
        Math.abs(point.x - draw.startX),
        Math.abs(point.y - draw.startY),
      )
    } else if (toolRef.current === 'arrow') {
      drawArrow(ctx, draw.startX, draw.startY, point.x, point.y)
    }
    draw.lastX = point.x
    draw.lastY = point.y
  }

  const onPointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = null
    pushHistory()
  }

  const commitText = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !textAt) return
    const value = textValue.trim()
    // Enter 提交后输入框卸载还会触发一次 blur，避免重复落字。
    const key = `${textAt.x}:${textAt.y}:${value}`
    if (textCommitRef.current === key) return
    textCommitRef.current = key
    setTextAt(null)
    setTextValue('')
    if (!value) return
    const size = Math.max(14, Math.min(48, canvas.width * 0.022))
    strokeStyle(ctx)
    ctx.font = `600 ${size}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = 3
    ctx.fillText(value, textAt.x, textAt.y)
    ctx.shadowBlur = 0
    pushHistory()
  }

  const save = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    onSave(canvas.toDataURL('image/png'))
  }

  const ratio = display.width > 0 ? display.width / Math.max(1, canvasRef.current?.width ?? 1) : 0

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      data-feedback-ui=""
      className="fixed inset-0 z-[160] flex flex-col bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-label="标注截图"
    >
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <span className="mr-1 text-[12.5px] font-medium text-white/90">标注截图</span>
        <div className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5">
          {TOOLS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setTool(entry.value)}
              aria-label={entry.label}
              aria-pressed={tool === entry.value}
              title={entry.label}
              className={cn(
                'flex size-7 items-center justify-center rounded-md text-white/70 transition-colors',
                tool === entry.value ? 'bg-white text-black' : 'hover:bg-white/15 hover:text-white',
              )}
            >
              {entry.icon}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-white/10 p-1">
          {COLORS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setColor(entry.value)}
              aria-label={entry.label}
              aria-pressed={color === entry.value}
              className={cn(
                'size-5 rounded-full border transition-transform',
                color === entry.value
                  ? 'scale-110 border-white ring-2 ring-white/40'
                  : 'border-white/40 hover:scale-105',
              )}
              style={{ backgroundColor: entry.value }}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            size="sm"
            label="撤销（Ctrl+Z）"
            onClick={undo}
            disabled={history.index <= 0}
            className="text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-30"
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            size="sm"
            label="重做（Ctrl+Shift+Z）"
            onClick={redo}
            disabled={history.index >= history.list.length - 1}
            className="text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-30"
          >
            <Redo2 size={15} />
          </IconButton>
          <Button size="sm" variant="ghost" onClick={onCancel} className="text-white/80 hover:bg-white/15 hover:text-white">
            取消
          </Button>
          <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={save}>
            完成
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
        <div ref={wrapRef} className="relative" style={{ width: display.width, height: display.height }}>
          <canvas
            ref={canvasRef}
            className="block touch-none rounded-md bg-white shadow-2xl"
            style={{
              width: display.width || undefined,
              height: display.height || undefined,
              cursor: tool === 'text' ? 'text' : 'crosshair',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {textAt && (
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitText()
                } else if (e.key === 'Escape') {
                  setTextAt(null)
                  setTextValue('')
                }
              }}
              onBlur={commitText}
              placeholder="输入文字，Enter 确认"
              className="absolute min-w-32 rounded border border-white/60 bg-black/70 px-1.5 py-0.5 text-[13px] text-white outline-none"
              style={{
                left: textAt.x * ratio,
                top: textAt.y * ratio,
                maxWidth: Math.max(120, display.width - textAt.x * ratio),
              }}
            />
          )}
        </div>
      </div>
      <p className="pb-3 text-center text-[12px] text-white/60">
        矩形 / 箭头拖拽绘制 · 画笔与马赛克按住涂抹 · 文字点击放置 · Ctrl+Z 撤销 · Esc 取消
      </p>
    </div>,
    document.body,
  )
}
