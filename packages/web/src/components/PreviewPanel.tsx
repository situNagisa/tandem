import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  Columns2,
  ImageOff,
  Loader2,
  Monitor,
  MousePointerClick,
  PanelTop,
  RefreshCw,
  ScanSearch,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react'
import type {
  PreviewCandidate,
  PreviewMount,
  PreviewSelection,
  PreviewSnapshot,
  PreviewState,
} from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { usePreviewShot } from '../lib/browserShot'
import { useIsMobile } from '../lib/hooks'
import { selectionLabel, selectionSource } from '../lib/previewElement'
import type { HostConfig } from '../lib/types'
import { Button, IconButton } from './ui/Button'
import { Input, SegmentedControl } from './ui/Controls'
import { PanelBar, PanelBody } from './ui/Panel'
import { ResizeHandle } from './ui/ResizeHandle'

const EMPTY_STATE: PreviewState = { sessionId: '', active: false, updatedAt: 0 }
const EMPTY_SELECTIONS: PreviewSelection[] = []

type DeviceKey = 'desktop' | 'tablet' | 'phone' | 'custom'

const DEVICES: Array<{ value: DeviceKey; label: string; width: number; height: number }> = [
  { value: 'desktop', label: '桌面', width: 1440, height: 900 },
  { value: 'tablet', label: '平板', width: 834, height: 1112 },
  { value: 'phone', label: '手机', width: 390, height: 844 },
  { value: 'custom', label: '自定义', width: 1024, height: 768 },
]

function presetOf(key: DeviceKey) {
  return DEVICES.find((item) => item.value === key) ?? DEVICES[0]!
}

function deviceKeyFor(width?: number, height?: number): DeviceKey {
  const match = DEVICES.find((item) => item.value !== 'custom' && item.width === width && item.height === height)
  return match?.value ?? 'custom'
}

/** 点选元素后把焦点交给输入框，面板本身不抢焦点也不遮挡它。 */
function focusComposer() {
  const focus = () => {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')
    if (!el) return false
    el.focus()
    return document.activeElement === el
  }
  // 手机上收起抽屉会改变布局与可视视口，再补一次聚焦，避免焦点被底部开关抢走。
  window.setTimeout(focus, 80)
  window.setTimeout(focus, 360)
}

/**
 * 应用预览：Host 端 Playwright 渲染本地 Web 应用，截图流下发；支持点选元素。
 * 桌面为可拖宽的右侧面板，手机为可收起的底部抽屉，都不加全屏遮罩。
 */
export function PreviewPanel() {
  const panel = useUiStore((s) => s.previewPanel)
  const close = useUiStore((s) => s.closePreviewPanel)
  const toast = useUiStore((s) => s.toast)
  const previewWidth = useUiStore((s) => s.previewWidth)
  const setPreviewWidth = useUiStore((s) => s.setPreviewWidth)
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === panel?.hostId) ?? null
  const stored = usePreviewStore((s) => (panel ? s.states[panel.sessionId] : undefined))
  const apply = usePreviewStore((s) => s.apply)
  const setPrefs = usePreviewStore((s) => s.setPrefs)
  const selections = usePreviewStore((s) => (panel ? s.selections[panel.sessionId] ?? EMPTY_SELECTIONS : EMPTY_SELECTIONS))
  const addSelection = usePreviewStore((s) => s.addSelection)
  const removeSelection = usePreviewStore((s) => s.removeSelection)
  const state = stored ?? EMPTY_STATE

  const [address, setAddress] = useState('')
  const [candidates, setCandidates] = useState<PreviewCandidate[]>([])
  const [snapshots, setSnapshots] = useState<PreviewSnapshot[]>([])
  const [mountInfo, setMountInfo] = useState<PreviewMount | null>(null)
  const isMobile = useIsMobile()
  const [device, setDevice] = useState<DeviceKey>(() => (isMobile ? 'phone' : 'desktop'))
  const [custom, setCustom] = useState({ width: 1024, height: 768 })
  const [selectMode, setSelectMode] = useState(false)
  const [embed, setEmbed] = useState(false)
  const [baselineId, setBaselineId] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState<'slider' | 'split'>('slider')
  const [splitPct, setSplitPct] = useState(50)
  const [busy, setBusy] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [composerHeight, setComposerHeight] = useState(0)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const autoOpenedRef = useRef<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 切换截图/对比/嵌入时回到顶部，避免保留上一种视图的滚动位置。
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [baselineId, compareMode, embed])

  const baseline = snapshots.find((item) => item.id === baselineId) ?? null
  const baselineShot = usePreviewShot(host, panel?.sessionId, baseline?.shotId)
  const shot = usePreviewShot(host, panel?.sessionId, state.screenshotId)

  useEffect(() => {
    setDevice(deviceKeyFor(state.width, state.height))
    if (state.width && state.height) setCustom({ width: state.width, height: state.height })
  }, [state.width, state.height])

  useEffect(() => {
    if (state.url) setAddress(state.url)
  }, [state.url])

  // 关闭再打开：恢复该会话上次的地址、设备尺寸与图标状态。
  useEffect(() => {
    if (!panel) {
      autoOpenedRef.current = null
      return
    }
    setSelectMode(false)
    setEmbed(false)
    setBaselineId(null)
    setSnapshots([])
    setCandidates([])
    setCollapsed(false)
    autoOpenedRef.current = null
    const saved = usePreviewStore.getState().prefs[panel.sessionId]
    if (saved?.address) setAddress(saved.address)
    if (saved?.device) setDevice(saved.device)
    if (saved?.width && saved?.height) setCustom({ width: saved.width, height: saved.height })
  }, [panel?.sessionId])

  // 手机底部抽屉停在输入框上方：量出输入框区域高度，收起成一条时输入框仍完整可用。
  useEffect(() => {
    if (!isMobile || !panel) return
    const measure = () => {
      const el = document.querySelector<HTMLElement>('[data-composer-anchor]')
      setComposerHeight(el ? Math.round(el.getBoundingClientRect().height) : 0)
    }
    measure()
    const el = document.querySelector<HTMLElement>('[data-composer-anchor]')
    const observer = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (el) observer?.observe(el)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [isMobile, panel?.sessionId])

  // Esc 关闭面板；有菜单/弹层打开时让给最上层。
  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role=dialog], [role=menu], [role=listbox]')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, close])

  const doOpen = async (
    raw: string,
    viewport: { width: number; height: number },
    quiet = false,
  ) => {
    if (!panel || !host) return
    const url = raw.trim()
    if (!url) return
    setBusy('open')
    try {
      const next = await api.previewOpen(host, panel.sessionId, {
        url,
        width: viewport.width,
        height: viewport.height,
      })
      apply(next)
      setAddress(next.url ?? url)
      setPrefs(panel.sessionId, {
        address: next.url ?? url,
        width: viewport.width,
        height: viewport.height,
      })
      setEmbed(false)
      setSelectMode(false)
      if (next.error) toast(next.error, 'error')
      else if (!quiet) toast('预览已打开', 'success')
      setMountInfo(await api.previewMount(host, panel.sessionId).catch(() => null))
    } catch (err) {
      toast(err instanceof Error ? err.message : '打开预览失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!panel || !host) return
    let cancelled = false
    const load = async () => {
      setDetecting(true)
      try {
        const [next, cands, mounts, snaps] = await Promise.all([
          api.previewState(host, panel.sessionId).catch(() => null),
          api.previewDetect(host, panel.sessionId).catch(() => [] as PreviewCandidate[]),
          api.previewMount(host, panel.sessionId).catch(() => null),
          api.previewSnapshots(host, panel.sessionId).catch(() => [] as PreviewSnapshot[]),
        ])
        if (cancelled) return
        if (next) apply(next)
        setCandidates(cands)
        setMountInfo(mounts)
        // 识别地址可能比截图慢：保留面板打开后刚截的快照，避免晚到的列表把它覆盖掉。
        setSnapshots((prev) => {
          const ids = new Set(snaps.map((item) => item.id))
          return [...prev.filter((item) => !ids.has(item.id)), ...snaps].sort(
            (a, b) => b.createdAt - a.createdAt,
          )
        })
        const saved = usePreviewStore.getState().prefs[panel.sessionId]
        const best = cands.find((item) => item.reachable)
        const fallback = saved?.address || best?.url
        if (fallback) setAddress((prev) => prev || fallback)
        if (next && !next.active && fallback && autoOpenedRef.current !== panel.sessionId) {
          autoOpenedRef.current = panel.sessionId
          const viewportTarget =
            saved?.width && saved?.height
              ? { width: saved.width, height: saved.height }
              : { width: DEVICES[0]!.width, height: DEVICES[0]!.height }
          await doOpen(fallback, viewportTarget, true)
        }
      } finally {
        if (!cancelled) setDetecting(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.hostId, panel?.sessionId, host?.id])

  // WS 未连接时兜底轮询；状态带 updatedAt，不会覆盖更新的 WS 消息。
  useEffect(() => {
    if (!panel || !host) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void api
        .previewState(host, panel.sessionId)
        .then((next) => {
          if (!cancelled) apply(next)
        })
        .catch(() => undefined)
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [panel?.hostId, panel?.sessionId, host?.id, apply])

  if (!panel || !host) return null

  const viewport = device === 'custom' ? custom : { width: presetOf(device).width, height: presetOf(device).height }

  const changeDevice = (next: DeviceKey) => {
    setDevice(next)
    const target = next === 'custom' ? custom : presetOf(next)
    if (next !== 'custom') setCustom({ width: target.width, height: target.height })
    setPrefs(panel.sessionId, { device: next, width: target.width, height: target.height })
    if (state.active) void resize(target.width, target.height)
  }

  const resize = async (width: number, height: number) => {
    if (!state.active) return
    setBusy('resize')
    try {
      apply(await api.previewResize(host, panel.sessionId, width, height))
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换尺寸失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const applyCustom = () => {
    if (custom.width < 240 || custom.height < 240) {
      toast('自定义尺寸最小 240×240', 'error')
      return
    }
    setPrefs(panel.sessionId, { device: 'custom', width: custom.width, height: custom.height })
    void resize(custom.width, custom.height)
  }

  const openAddress = (event: FormEvent) => {
    event.preventDefault()
    void doOpen(address, viewport)
  }

  const detect = async () => {
    setDetecting(true)
    try {
      const cands = await api.previewDetect(host, panel.sessionId)
      setCandidates(cands)
      const best = cands.find((item) => item.reachable)
      if (best) setAddress(best.url)
      toast(best ? `自动识别到 ${best.url}` : '没有自动识别到运行中的本地开发地址', best ? 'success' : 'info')
    } catch (err) {
      toast(err instanceof Error ? err.message : '自动识别失败', 'error')
    } finally {
      setDetecting(false)
    }
  }

  const refresh = async () => {
    if (busy || !state.active) return
    setBusy('reload')
    try {
      apply(await api.previewReload(host, panel.sessionId))
    } catch (err) {
      toast(err instanceof Error ? err.message : '刷新失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const travel = async (direction: 'back' | 'forward') => {
    if (busy || !state.active) return
    setBusy(direction)
    try {
      const next =
        direction === 'back'
          ? await api.previewBack(host, panel.sessionId)
          : await api.previewForward(host, panel.sessionId)
      apply(next)
    } catch (err) {
      toast(err instanceof Error ? err.message : '导航失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const captureBefore = async () => {
    if (busy || !state.active) return
    setBusy('snapshot')
    try {
      const snap = await api.previewSnapshot(host, panel.sessionId, '改前')
      setSnapshots((prev) => [snap, ...prev])
      setBaselineId(snap.id)
      toast('已保存改前快照，改完后可对比', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '截取快照失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const deleteSnapshot = async (snapshotId: string) => {
    try {
      await api.previewDeleteSnapshot(host, panel.sessionId, snapshotId)
      setSnapshots((prev) => prev.filter((item) => item.id !== snapshotId))
      if (baselineId === snapshotId) setBaselineId(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除快照失败', 'error')
    }
  }

  const selectAt = async (event: MouseEvent<HTMLDivElement>) => {
    if (!selectMode || busy || !state.active) return
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = ((event.clientX - rect.left) / rect.width) * (state.width ?? 1440)
    const y = ((event.clientY - rect.top) / rect.height) * (state.height ?? 900)
    setBusy('select')
    try {
      const selection = await api.previewSelect(host, panel.sessionId, x, y)
      addSelection(panel.sessionId, selection)
      toast(`已选 <${selection.tag}> ${selection.name}`, 'success')
      // 面板保持打开；手机上收起成一条，把输入区让出来。
      if (isMobile) setCollapsed(true)
      focusComposer()
    } catch (err) {
      toast(err instanceof Error ? err.message : '选取元素失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const canEmbed = mountInfo?.embeddable === true
  const showCompare = baseline && baselineShot.url && shot.url

  const content = (
    <>
      <form
        onSubmit={openAddress}
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
      >
        <IconButton
          onClick={() => void travel('back')}
          label="后退"
          tooltip="后退"
          disabled={!state.active || busy !== null}
        >
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton
          onClick={() => void travel('forward')}
          label="前进"
          tooltip="前进"
          disabled={!state.active || busy !== null}
        >
          <ArrowRight size={14} />
        </IconButton>
        <Input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="应用地址"
          placeholder="http://localhost:5173"
          size="sm"
          className="min-w-[160px] flex-1 font-mono text-[12px]"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={busy !== null || !address.trim()}>
          {busy === 'open' ? <Loader2 size={13} className="animate-spin" /> : null}
          打开
        </Button>
        <IconButton
          onClick={() => void detect()}
          label="自动识别本地地址"
          tooltip="自动识别"
          disabled={detecting}
        >
          <ScanSearch size={14} className={detecting ? 'animate-pulse' : undefined} />
        </IconButton>
      </form>

      {candidates.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-1.5">
          <span className="mr-0.5 text-[12px] text-muted">自动识别：</span>
          {candidates.slice(0, 6).map((candidate) => (
            <button
              key={candidate.url}
              type="button"
              onClick={() => void doOpen(candidate.url, viewport)}
              title={`${candidate.label ?? ''}${candidate.reachable ? ' · 可访问' : ' · 未启动'}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-text-soft transition-colors hover:border-border-strong hover:text-text"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  candidate.reachable ? 'bg-success' : 'bg-muted/50'
                }`}
              />
              <span className="truncate">{candidate.url.replace(/^https?:\/\//, '')}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <SegmentedControl
          aria-label="设备尺寸"
          value={device}
          onChange={(next) => changeDevice(next)}
          size="sm"
          options={[
            { value: 'desktop', label: <Monitor size={12} />, title: '桌面 1440×900' },
            { value: 'tablet', label: <Tablet size={12} />, title: '平板 834×1112' },
            { value: 'phone', label: <Smartphone size={12} />, title: '手机 390×844' },
            { value: 'custom', label: '自定义', title: '自定义尺寸' },
          ]}
        />
        {device === 'custom' ? (
          <span className="flex items-center gap-1">
            <Input
              type="number"
              aria-label="自定义宽度"
              value={custom.width}
              onChange={(event) => setCustom((prev) => ({ ...prev, width: Number(event.target.value) }))}
              size="sm"
              className="w-[72px] text-[12px]"
            />
            <span className="text-[12px] text-muted">×</span>
            <Input
              type="number"
              aria-label="自定义高度"
              value={custom.height}
              onChange={(event) => setCustom((prev) => ({ ...prev, height: Number(event.target.value) }))}
              size="sm"
              className="w-[72px] text-[12px]"
            />
            <Button size="sm" variant="secondary" onClick={applyCustom} disabled={!state.active}>
              应用
            </Button>
          </span>
        ) : (
          <span className="text-[12px] tabular-nums text-muted" data-testid="preview-viewport">
            {viewport.width}×{viewport.height}
          </span>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        <IconButton
          onClick={() => void refresh()}
          label="刷新预览"
          tooltip="刷新"
          disabled={!state.active || busy !== null}
        >
          <RefreshCw size={13} className={busy === 'reload' ? 'animate-spin' : undefined} />
        </IconButton>
        <Button
          size="sm"
          variant={selectMode ? 'primary' : 'secondary'}
          onClick={() => {
            setSelectMode((prev) => !prev)
            setEmbed(false)
            setBaselineId(null)
          }}
          disabled={!state.active || busy !== null}
          aria-pressed={selectMode}
        >
          <MousePointerClick size={13} />
          {selectMode ? '选择中…' : '选择元素'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void captureBefore()} disabled={!state.active || busy !== null}>
          <Camera size={13} />
          截取改前快照
        </Button>
        {canEmbed ? (
          <Button
            size="sm"
            variant={embed ? 'primary' : 'secondary'}
            onClick={() => {
              setEmbed((prev) => !prev)
              setSelectMode(false)
            }}
            aria-pressed={embed}
            title={mountInfo?.reason ?? '客户端与 Host 同机时直接嵌入 localhost 页面'}
          >
            <Columns2 size={13} />
            {embed ? '嵌入中' : '直接嵌入'}
          </Button>
        ) : null}
        {selections.length > 0 ? (
          <span className="ml-auto text-[12px] text-text-soft">已选 {selections.length} 个元素</span>
        ) : null}
      </div>

      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1 overflow-auto bg-[color-mix(in_srgb,var(--t-bg)_60%,transparent)] p-3"
      >
        {!state.active ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface/60 px-6 py-8 text-center">
            <PanelTop size={26} className="text-muted/60" />
            <p className="text-[13px] text-text-soft">
              {detecting ? '正在自动识别本地地址…' : '填写地址，或点工具栏的自动识别'}
            </p>
            <p className="max-w-[440px] text-[12px] leading-5 text-muted">
              在输入框填写本地开发地址（如 http://localhost:5173）后点「打开」；上方自动识别出的候选地址可直接点开。
              Host 会用 Chromium 渲染页面并把截图流式传回这里。
            </p>
            {state.error ? <p className="max-w-[520px] text-[12px] text-danger">{state.error}</p> : null}
          </div>
        ) : embed && canEmbed && mountInfo?.url ? (
          <div className="flex flex-col gap-2">
            <EmbedFrame
              url={mountInfo.url}
              width={state.width ?? viewport.width}
              height={state.height ?? viewport.height}
              refreshKey={`${mountInfo.url}:${state.autoRefresh?.at ?? 0}`}
            />
            <p className="text-center text-[12px] text-muted">
              直接嵌入运行在本机的页面；元素点选请切回截图模式。
            </p>
          </div>
        ) : showCompare ? (
          <div
            className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-surface"
            data-testid="preview-compare"
          >
            {compareMode === 'slider' ? (
              <div className="relative mx-auto w-fit max-w-full">
                <img
                  src={shot.url ?? undefined}
                  alt="当前预览画面"
                  className="block h-auto max-h-[calc(100dvh-320px)] w-auto max-w-full object-contain"
                />
                <img
                  src={baselineShot.url ?? undefined}
                  alt="改前快照"
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                  style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                />
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
                  style={{ left: `${splitPct}%` }}
                />
                <span className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[12px] text-white">
                  改前
                </span>
                <span className="absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[12px] text-white">
                  当前
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={splitPct}
                  onChange={(event) => setSplitPct(Number(event.target.value))}
                  aria-label="对比分割位置"
                  className="absolute inset-x-3 bottom-3 h-1 w-[calc(100%-1.5rem)] cursor-ew-resize accent-[var(--t-accent-strong)]"
                />
              </div>
            ) : (
              <div className="flex gap-2 p-2" style={{ height: 'min(520px, calc(100dvh - 340px))' }}>
                <figure className="flex min-w-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">
                    <img
                      src={baselineShot.url ?? undefined}
                      alt="改前快照"
                      className="block size-full rounded border border-border object-contain"
                    />
                  </div>
                  <figcaption className="mt-1 shrink-0 text-center text-[12px] text-muted">改前</figcaption>
                </figure>
                <figure className="flex min-w-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">
                    <img
                      src={shot.url ?? undefined}
                      alt="当前预览画面"
                      className="block size-full rounded border border-border object-contain"
                    />
                  </div>
                  <figcaption className="mt-1 shrink-0 text-center text-[12px] text-muted">当前</figcaption>
                </figure>
              </div>
            )}
          </div>
        ) : shot.url ? (
          <div
            className={`relative mx-auto w-fit max-w-full ${selectMode ? 'cursor-crosshair' : ''}`}
            onClick={(event) => void selectAt(event)}
            data-testid="preview-shot-wrap"
          >
            <img
              ref={imgRef}
              src={shot.url}
              alt="应用预览画面"
              data-testid="preview-shot"
              className="block h-auto max-h-[calc(100dvh-300px)] w-auto max-w-full rounded-lg border border-border bg-surface object-contain"
            />
            {state.autoRefresh ? (
              <span
                data-testid="preview-auto-refresh"
                className="absolute right-2 top-2 rounded-full border border-border bg-[color-mix(in_srgb,var(--t-surface)_88%,transparent)] px-2 py-0.5 text-[12px] text-text-soft shadow-sm backdrop-blur"
              >
                已根据 {state.autoRefresh.count} 处改动刷新
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface/60 px-6 py-8 text-center">
            {shot.error ? <ImageOff size={26} className="text-muted/60" /> : <Camera size={26} className="text-muted/60" />}
            <p className="text-[13px] text-text-soft">
              {shot.error ? '截图加载失败' : detecting ? '正在打开预览…' : '预览画面准备中…'}
            </p>
            {state.error ? <p className="max-w-[520px] text-[12px] text-danger">{state.error}</p> : null}
            {shot.error ? (
              <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                重新加载
              </Button>
            ) : null}
          </div>
        )}

        {state.autoRefresh && (showCompare || embed || !shot.url) ? (
          <span
            data-testid="preview-auto-refresh"
            className="absolute right-4 top-4 rounded-full border border-border bg-[color-mix(in_srgb,var(--t-surface)_88%,transparent)] px-2 py-0.5 text-[12px] text-text-soft shadow-sm backdrop-blur"
          >
            已根据 {state.autoRefresh.count} 处改动刷新
          </span>
        ) : null}

        {baseline ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px]">
            <span className="text-text-soft">正在对比「{baseline.label}」</span>
            <SegmentedControl
              aria-label="对比方式"
              size="sm"
              value={compareMode}
              onChange={(next) => setCompareMode(next)}
              options={[
                { value: 'slider', label: '滑块' },
                { value: 'split', label: '左右' },
              ]}
            />
            <Button size="sm" variant="ghost" onClick={() => setBaselineId(null)}>
              退出对比
            </Button>
          </div>
        ) : null}
      </div>

      {snapshots.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-border px-3 py-2">
          <span className="shrink-0 text-[12px] text-muted">改前快照</span>
          {snapshots.map((snapshot) => (
            <SnapshotCard
              key={snapshot.id}
              host={host}
              sessionId={panel.sessionId}
              snapshot={snapshot}
              active={snapshot.id === baselineId}
              onCompare={() => {
                setBaselineId(baselineId === snapshot.id ? null : snapshot.id)
                setSelectMode(false)
              }}
              onDelete={() => void deleteSnapshot(snapshot.id)}
            />
          ))}
        </div>
      ) : null}

      {selections.length > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-2"
          data-testid="preview-selections"
        >
          <span className="text-[12px] text-muted">已选元素</span>
          {selections.map((selection) => (
            <span
              key={selection.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-text-soft"
            >
              <MousePointerClick size={12} className="shrink-0 text-muted" />
              <span className="truncate">{selectionLabel(selection)}</span>
              {selectionSource(selection) ? (
                <span className="shrink-0 font-mono text-[12px] text-muted">{selectionSource(selection)}</span>
              ) : null}
              <IconButton
                size="sm"
                onClick={() => removeSelection(panel.sessionId, selection.id)}
                label={`移除已选元素 ${selection.name}`}
                className="size-6! [&_svg]:size-3"
              >
                <X size={12} />
              </IconButton>
            </span>
          ))}
          <span className="text-[12px] text-muted">发送时作为上下文附带给 agent</span>
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted">
        <span>截图由 {host.name} 上的 Chromium 生成；只访问本机地址或设置 → 浏览器里的允许列表。</span>
        {state.title ? <span className="min-w-0 truncate">· {state.title}</span> : null}
        <span className="ml-auto tabular-nums">{state.error && state.active ? <span className="text-danger">{state.error}</span> : null}</span>
      </div>
    </>
  )

  const runningBadge = state.active ? (
    <span className="shrink-0 rounded-full bg-[var(--t-bg-active)] px-1.5 py-px text-[12px] font-normal text-text-soft">
      运行中
    </span>
  ) : null

  const header = (
    <PanelBar
      icon={<PanelTop size={15} />}
      title="应用预览"
      actions={
        <IconButton onClick={close} label="关闭应用预览" tooltip="关闭" className="-mr-1">
          <X size={15} />
        </IconButton>
      }
    >
      {runningBadge}
    </PanelBar>
  )

  if (isMobile) {
    return (
      <div
        role="complementary"
        aria-label="应用预览"
        data-testid="preview-panel"
        className="fixed inset-x-0 z-40 flex flex-col rounded-t-xl border-t border-border bg-bg shadow-[0_-8px_24px_rgba(0,0,0,0.28)]"
        style={{ bottom: composerHeight, maxHeight: collapsed ? undefined : 'min(56dvh, calc(100dvh - 140px))' }}
      >
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
          <PanelTop size={14} className="shrink-0 text-text-soft" />
          <span className="shrink-0 text-[13px] font-medium">应用预览</span>
          {runningBadge}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{address || '未打开地址'}</span>
          <IconButton
            onClick={() => setCollapsed((prev) => !prev)}
            label={collapsed ? '展开应用预览' : '收起应用预览'}
            tooltip={collapsed ? '展开' : '收起'}
            className="max-sm:size-11"
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </IconButton>
          <IconButton onClick={close} label="关闭应用预览" className="-mr-1 max-sm:size-11">
            <X size={15} />
          </IconButton>
        </div>
        {!collapsed ? <div className="flex min-h-0 flex-1 flex-col">{content}</div> : null}
      </div>
    )
  }

  return (
    <aside
      role="complementary"
      aria-label="应用预览"
      data-testid="preview-panel"
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-bg"
      style={{ width: dragWidth ?? previewWidth, transition: dragWidth !== null ? 'none' : undefined }}
    >
      <ResizeHandle
        value={previewWidth}
        min={360}
        max={1200}
        edge="left"
        onChange={setDragWidth}
        onCommit={(next) => {
          setPreviewWidth(next)
          setDragWidth(null)
        }}
        resetValue={560}
        label="调整预览面板宽度"
      />
      {header}
      <PanelBody>{content}</PanelBody>
    </aside>
  )
}

function EmbedFrame({
  url,
  width,
  height,
  refreshKey,
}: {
  url: string
  width: number
  height: number
  refreshKey: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const node = wrapRef.current
    if (!node) return
    const update = () => setScale(Math.min(1, node.clientWidth / Math.max(1, width)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [width])
  return (
    <div
      ref={wrapRef}
      className="mx-auto max-w-full overflow-hidden rounded-lg border border-border bg-surface"
      style={{ height: Math.max(120, height * scale) }}
      data-testid="preview-embed"
    >
      <iframe
        key={refreshKey}
        src={url}
        title="应用预览（直接嵌入）"
        className="border-0 bg-white"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      />
    </div>
  )
}

function SnapshotCard({
  host,
  sessionId,
  snapshot,
  active,
  onCompare,
  onDelete,
}: {
  host: HostConfig
  sessionId: string
  snapshot: PreviewSnapshot
  active: boolean
  onCompare: () => void
  onDelete: () => void
}) {
  const shot = usePreviewShot(host, sessionId, snapshot.shotId)
  return (
    <div
      className={`flex shrink-0 items-center gap-1 rounded-lg border p-1 ${
        active ? 'border-[var(--t-accent-strong)] bg-[var(--t-bg-active)]' : 'border-border bg-surface'
      }`}
    >
      <button
        type="button"
        onClick={onCompare}
        className="flex items-center gap-1.5"
        title="与当前画面对比"
        data-testid="preview-snapshot-compare"
      >
        {shot.url ? (
          <img src={shot.url} alt="" className="h-8 w-12 rounded object-cover" />
        ) : (
          <span className="flex h-8 w-12 items-center justify-center rounded bg-surface-2 text-[12px] text-muted">
            加载中
          </span>
        )}
        <span className="max-w-[88px] truncate text-[12px] text-text-soft">{snapshot.label}</span>
      </button>
      <IconButton size="sm" onClick={onDelete} label={`删除快照 ${snapshot.label}`} className="size-6! [&_svg]:size-3">
        <Trash2 size={11} />
      </IconButton>
    </div>
  )
}
