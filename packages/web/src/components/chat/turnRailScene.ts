// 轮次条的"场景"：一组固定 DOM 池（25 个元素按 turn mod 25 循环绑定），
// 每帧只写 transform / opacity。刻度与大纲行是同一批元素：p=0 是紧凑刻度，p=1 是大纲行，
// 展开/收回就是 p 的弹簧动画（FLIP：每个刻度"长"成对应的行）。
import { Spring, prefersReducedMotion } from './turnRailMotion'
import { heatLabel, turnUsageLabel, type TurnUsage } from '../../lib/turnUsage'

export const ROW = 28
export const PITCH = 7
export const PANEL_W = 280
export const POOL = 25
const POOL_K = (POOL - 1) / 2
const FADE = 14
const REST_W = 46

export interface SceneTurn {
  id: string
  turn: number
  preview: string
  /** 首行全文：悬停时显示，读屏也读这一份。 */
  full?: string
  /** 该轮用量；悬停时显示标准 tooltip（只显示用量，不重复文字）。 */
  usage?: TurnUsage
  /** 真实轮次序号；摘要行没有。 */
  no?: number
  /** 用量档位 1–5（颜色深浅）。 */
  heat?: number
  /** 占本会话比例（tooltip）。 */
  share?: number
  summary?: boolean
  compressed?: boolean
  pinned?: boolean
  /** 该轮消息尚未加载（长会话懒加载）：虚线刻度 + 行尾「未加载」。 */
  unloaded?: boolean
  /** 正在加载这一轮所在的段。 */
  loading?: boolean
  /** 只读预览：不显示固定图钉，也不在 tooltip 里编造「花费未知」。 */
  readOnly?: boolean
  hideUnknownCost?: boolean
}

export interface SceneEls {
  root: HTMLElement
  bg: HTMLElement
  ind: HTMLElement
  cur: HTMLElement
  items: HTMLElement[]
}

interface ItemRef {
  el: HTMLElement
  n: HTMLElement
  t: HTMLElement
  k: HTMLElement
  r: HTMLElement
  p: HTMLElement
  d: HTMLElement
  c: HTMLElement
  bound: number
  shown: boolean
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const f3 = (x: number) => (Math.round(x * 1000) / 1000).toString()

export class RailScene {
  // 列表中心（轮号，可为小数）/ 展开进度 / 当前轮指示 / 悬停指示位置 / 悬停指示显隐
  private L = new Spring(1, 170, 27, 0.002)
  private P = new Spring(0, 300, 25, 0.0008)
  private C = new Spring(1, 260, 30, 0.002)
  private I = new Spring(1, 700, 42, 0.003)
  private H = new Spring(0, 420, 36, 0.003)

  private turns: SceneTurn[] = []
  private N = 0
  private layoutN = 0
  private items: ItemRef[]
  private raf = 0
  private last = 0
  private RH = 10
  private PR = 7
  private PH = 3
  private panelH = 0
  private restH = 0
  private ptrY: number | null = null
  private hoverOn = true
  private dragging = false
  private lastDragRow = 0
  private held = 0
  private edgeDir = 0
  /** 拖动中指针所在行变化（含边缘滚动期间行从指针下滑过）。 */
  onDragRow: ((turn: number) => void) | null = null
  /** 悬停行变化（含面板展开后指针已经停住的情况）。 */
  onHoverTurn: ((turn: number | null) => void) | null = null
  private lastHoverTurn: number | null = null

  constructor(private els: SceneEls) {
    this.items = els.items.map((el) => ({
      el,
      n: el.children[0] as HTMLElement,
      t: el.children[1] as HTMLElement,
      k: el.children[2] as HTMLElement,
      r: el.children[3] as HTMLElement,
      p: el.children[4] as HTMLElement,
      d: el.children[5] as HTMLElement,
      c: el.children[6] as HTMLElement,
      bound: -1,
      shown: true,
    }))
  }

  get open(): boolean {
    return this.P.t > 0.5
  }
  /** 展开动画基本完成（可以响应行级悬停与拖动）。 */
  get expanded(): boolean {
    return this.P.x > 0.6
  }
  get hoverTurn(): number | null {
    return this.ptrY != null && this.expanded ? this.rowAt(this.ptrY) : null
  }

  /**
   * `layoutN` 决定面板高度：一般等于全部轮次数；「只看已固定」时传固定轮次数，
   * 面板缩到内容高度，固定的轮从列表顶部开始排（反馈8 验收补丁）。
   */
  setData(turns: SceneTurn[], layoutN = turns.length): void {
    // 固定/取消固定不改变阅读区顺序；插入压缩行/摘要行时按消息 id 找回原来的当前轮与视口中心，
    // 避免阅读区因为行数变化整体跳动。
    const activeId = this.turns[Math.round(this.C.t) - 1]?.id
    const centerId = this.turns[Math.round(this.L.t) - 1]?.id
    this.turns = turns
    this.N = turns.length
    this.layoutN = layoutN
    for (const it of this.items) it.bound = -1
    const indexOf = (id: string | undefined) => {
      if (!id) return null
      const index = turns.findIndex((turn) => turn.id === id)
      return index >= 0 ? index + 1 : null
    }
    const activePos = indexOf(activeId) ?? Math.min(Math.round(this.C.t) || 1, Math.max(1, this.N))
    const centerPos = indexOf(centerId) ?? Math.min(Math.round(this.L.t) || 1, Math.max(1, this.N))
    this.C.t = activePos
    this.C.snap(activePos)
    this.L.t = centerPos
    this.L.snap(centerPos)
    this.geometry()
    this.kick()
  }

  private turnAtPos(pos: number): number | null {
    return this.turns[pos - 1] ? pos : null
  }

  private posOf(turn: number): number | null {
    return turn >= 1 && turn <= this.N ? turn : null
  }

  setAvail(height: number): void {
    this.avail = height
    this.geometry()
    this.kick()
  }
  private avail = 600

  private geometry(): void {
    const actual = Math.max(1, this.N)
    // 只看已固定时 layoutN 就是固定轮次数，面板随内容收缩；其余情况按全部轮次。
    const n = Math.max(actual, this.layoutN || 0)
    // 面板 + 下方计数胶囊/提示行都要落在可用高度内
    let rows = Math.floor((this.avail - 112) / ROW)
    rows = clamp(rows, 5, 15)
    if (rows % 2 === 0) rows -= 1
    this.PR = Math.min(n, rows)
    this.PH = (this.PR - 1) / 2
    this.RH = clamp(Math.floor((this.avail * 0.5) / PITCH / 2), 3, 10)
    this.panelH = this.PR * ROW + 2 * FADE
    this.restH = Math.min(actual, 2 * this.RH + 1) * PITCH + 10
    const root = this.els.root
    root.style.setProperty('--turn-ph', `${this.panelH}px`)
    root.style.setProperty('--turn-rest-h', `${this.restH}px`)
  }

  setActive(turn: number, snap = false): void {
    const pos = this.posOf(turn) ?? turn
    this.C.t = pos
    if (snap) this.C.snap(pos)
    this.kick()
  }

  setCenter(turn: number, snap = false): void {
    const pos = this.posOf(turn) ?? turn
    this.L.t = pos
    if (snap) this.L.snap(pos)
    this.kick()
  }

  /**
   * 滚轮预览：只上下移动大纲列表本身，不改变当前选中轮（C），
   * 调用方也不滚动对话区。指针停在原处时，悬停行随列表移动。
   */
  scrollBy(rows: number): void {
    if (!this.N || !rows) return
    this.L.t = clamp(this.L.t + rows, 1, this.N)
    this.held = 0
    this.kick()
  }

  setOpen(open: boolean): void {
    this.P.t = open ? 1 : 0
    if (!open) {
      this.held = 0
      this.edgeDir = 0
    }
    this.kick()
  }

  setPointer(y: number | null): void {
    this.ptrY = y
    this.kick()
  }

  setHoverEnabled(on: boolean): void {
    this.hoverOn = on
    this.kick()
  }

  setDragging(on: boolean): void {
    this.dragging = on
    this.lastDragRow = 0
    this.held = 0
    this.kick()
  }

  /** 指针 Y（相对中心线）→ 轮号；展开前按刻度间距、展开后按行高。 */
  rowAt(y: number): number {
    const n = this.N
    const pos =
      this.P.x < 0.5
        ? clamp(Math.round(this.restCenter() + y / PITCH), 1, n)
        : clamp(Math.round(this.panelCenter() + y / ROW), 1, n)
    return this.turnAtPos(pos) ?? clamp(pos, 1, n)
  }

  private restCenter(): number {
    const n = this.N
    return n <= 2 * this.RH + 1 ? (n + 1) / 2 : clamp(this.L.x, 1 + this.RH, n - this.RH)
  }
  private panelCenter(): number {
    const n = this.N
    return n <= this.PR ? (n + 1) / 2 : clamp(this.L.x, 1 + this.PH, n - this.PH)
  }

  kick(): void {
    if (this.raf) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.onDragRow = null
    this.onHoverTurn = null
  }

  private frame = (now: number): void => {
    this.raf = 0
    const dt = Math.min(0.033, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    if (this.tick(dt)) this.raf = requestAnimationFrame(this.frame)
  }

  private tick(dt: number): boolean {
    const n = this.N
    if (!n) return false
    // 边缘加速滚动：只在展开、轮次多于可见行时生效；拖动中立即响应，悬停需停留一下。
    let edge = false
    if (this.expanded && this.ptrY != null && n > this.PR) {
      const half = (this.PR * ROW) / 2
      const zone = ROW * 1.7
      const y = this.ptrY
      let dir = 0
      let depth = 0
      if (y < -half + zone) {
        dir = -1
        depth = clamp((-half + zone - y) / zone, 0, 1.15)
      } else if (y > half - zone) {
        dir = 1
        depth = clamp((y - (half - zone)) / zone, 0, 1.15)
      }
      if (dir !== 0) {
        this.held += dt
        const dwell = this.dragging ? 0.05 : 0.28
        const gate = smooth(dwell, dwell + 0.25, this.held)
        const ramp = 0.7 + 0.7 * Math.min(1, this.held / 1.4)
        const speed = (2 + 30 * depth * depth) * gate * ramp
        if (speed > 0.01) {
          this.L.t = clamp(this.L.t + dir * speed * dt, 1, n)
          edge = true
        }
      } else {
        this.held = 0
      }
    } else {
      this.held = 0
    }

    // 悬停/拖动目标行
    let row: number | null = null
    if (this.ptrY != null && this.expanded && (this.hoverOn || this.dragging)) row = this.rowAt(this.ptrY)
    if (row != null) {
      if (this.H.x < 0.05) this.I.snap(row)
      this.I.t = row
      this.H.t = 1
    } else {
      this.H.t = 0
    }
    if (row !== this.lastHoverTurn) {
      this.lastHoverTurn = row
      this.onHoverTurn?.(row)
    }
    if (this.dragging && row != null && row !== this.lastDragRow) {
      this.lastDragRow = row
      this.onDragRow?.(row)
    }

    if (prefersReducedMotion()) {
      this.L.snap()
      this.P.snap()
      this.C.snap()
      this.I.snap()
      this.H.snap()
    } else {
      this.L.step(dt)
      this.P.step(dt)
      this.C.step(dt)
      this.I.step(dt)
      this.H.step(dt)
    }
    this.render()
    return (
      edge ||
      !(this.L.settled && this.P.settled && this.C.settled && this.I.settled && this.H.settled) ||
      (this.dragging && this.ptrY != null && this.expanded && n > this.PR)
    )
  }

  private bind(it: ItemRef, turn: number): void {
    const mark = this.turns[turn - 1]
    const summary = !!mark?.summary
    const compressed = !!mark?.compressed
    const unloaded = !!mark?.unloaded
    const loading = !!mark?.loading
    const no = mark?.no ?? turn
    const heat = mark?.heat ?? 1
    it.n.textContent = summary ? '摘' : String(no)
    it.r.textContent = summary ? '摘' : String(no)
    it.t.textContent = summary ? '摘要' : (mark?.preview ?? '')
    const full = mark?.full || mark?.preview || ''
    // 反馈6#01：悬停只显示该轮用量，不再重复大纲文字；全文保留在 aria-label 与 sr-only 列表。
    it.el.title = [
      turnUsageLabel(mark?.usage, {
        ...(mark?.share !== undefined ? { share: mark.share } : {}),
        ...(compressed ? { compressed: true } : {}),
        ...(summary ? { summary: true } : {}),
        ...(mark?.hideUnknownCost ? { hideUnknownCost: true } : {}),
      }),
      loading ? '正在加载这一段…' : unloaded ? '未加载 · 点击加载并跳转' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    it.t.removeAttribute('title')
    const aria = summary
      ? `摘要 · ${heatLabel(heat)}`
      : `第 ${no} 轮：${full} · ${heatLabel(heat)}${compressed ? ' · 已压缩' : ''}${unloaded ? ' · 未加载' : ''}`
    it.el.setAttribute('aria-label', aria)
    it.el.dataset.turnLabel = summary ? '摘要' : full
    it.el.dataset.turnPos = String(turn)
    it.el.dataset.turnNo = String(no)
    it.el.dataset.heat = String(heat)
    it.el.dataset.summary = summary ? 'true' : 'false'
    it.el.dataset.compressed = compressed ? 'true' : 'false'
    it.el.dataset.unloaded = unloaded ? 'true' : 'false'
    it.el.dataset.loading = loading ? 'true' : 'false'
    it.c.textContent = loading ? '加载中…' : compressed ? '已压缩' : unloaded ? '未加载' : ''
    const canPin = !mark?.readOnly && !summary && !compressed
    it.p.dataset.turn = canPin ? (mark?.id ?? '') : ''
    it.p.title = canPin ? (mark?.pinned ? '取消固定' : '固定此轮') : ''
    it.bound = turn
  }

  private render(): void {
    const n = this.N
    const { RH, PH } = this
    const Lc = this.restCenter()
    const Lp = this.panelCenter()
    const p = this.P.x
    const pc = clamp(p, 0, 1)
    const base = Math.round(Lc)
    const cx = this.C.x
    const hv = clamp(this.H.x, 0, 1)
    const hi = this.I.x
    const dpr = window.devicePixelRatio || 1
    const px = (v: number) => Math.round(v * dpr) / dpr
    // 收回时文字更早淡出，避免行文字漂在逐渐缩小的面板之外
    const textIn = this.P.t > 0.5 ? smooth(0.5, 0.92, pc) : smooth(0.8, 0.98, pc)

    for (let e = 0; e < POOL; e++) {
      const it = this.items[e]
      if (!it) continue
      let d = (((e - (base - 1)) % POOL) + POOL) % POOL
      if (d > POOL_K) d -= POOL
      const pos = base + d
      const turn = this.turnAtPos(pos)
      const dr = pos - Lc
      const dp = pos - Lp
      const orest = clamp((RH + 1 - Math.abs(dr)) / 1.5, 0, 1)
      const o = orest * (1 - pc) + pc
      if (!turn || pos < 1 || pos > n || o < 0.01) {
        if (it.shown) {
          it.el.style.visibility = 'hidden'
          it.shown = false
        }
        continue
      }
      if (!it.shown) {
        it.el.style.visibility = 'visible'
        it.shown = true
      }
      if (it.bound !== turn) this.bind(it, turn)
      const mark = this.turns[turn - 1]
      const heat = mark?.heat ?? 1
      const y = dr * PITCH + (dp * ROW - dr * PITCH) * p
      it.el.style.transform = `translate3d(0,${px(y)}px,0)`
      it.el.style.opacity = f3(o)
      const act = Math.max(0, 1 - Math.abs(pos - cx))
      const hov = hv * Math.max(0, 1 - Math.abs(pos - hi))
      const lit = Math.max(act, hov)
      // 文字透明度叠加容器淡出后仍需保持可读对比度（axe color-contrast）。
      const readable = (value: number, floor: number) =>
        value <= 0.01 ? 0 : Math.max(value, floor)
      it.t.style.opacity = f3(readable(textIn * (0.66 + 0.34 * lit), 0.72))
      it.n.style.opacity = f3(readable(textIn * (0.5 + 0.5 * lit), 0.72))
      it.r.style.opacity = f3(readable(act * (1 - smooth(0, 0.35, pc)), 0.9))
      // 图钉：悬停行或已固定时显示；静止态用右侧小圆点标出被固定的轮。
      const canPin = !mark?.summary && !mark?.compressed
      const pinned = canPin && !!mark?.pinned
      it.el.dataset.pinned = pinned ? 'true' : 'false'
      it.p.style.opacity = f3(canPin ? textIn * (pinned ? 0.62 + 0.38 * lit : hov > 0.5 ? 1 : 0) : 0)
      it.p.dataset.on = canPin && ((pinned && textIn > 0.4) || hov > 0.5) ? 'true' : 'false'
      it.p.dataset.pinned = pinned ? 'true' : 'false'
      it.d.style.opacity = f3(pinned ? (1 - smooth(0.05, 0.45, pc)) * (0.55 + 0.45 * act) : 0)
      const tag = mark?.compressed || mark?.unloaded || mark?.loading
      it.c.style.opacity = f3(tag ? textIn * (0.5 + 0.5 * lit) : 0)
      const restS = 0.42 + 0.4 * Math.exp(-Math.abs(dr) / 4)
      const sx = lerp(restS + 0.55 * act, 0.5 + 0.4 * lit, pc)
      const sy = 1 + 0.5 * act * (1 - pc)
      it.k.style.transform = `scale(${f3(sx)},${f3(sy)})`
      // 刻度条也按用量档位加深（8%→60% 的中性色透明度）。
      const heatFactor = 0.18 + heat * 0.164
      it.k.style.opacity = f3(
        Math.min(1, lerp(0.4 + 0.6 * act, 0.38 + 0.62 * lit, pc) * (0.55 + 0.45 * heatFactor)),
      )
    }

    const { bg, cur, ind } = this.els
    const sxBg = lerp(REST_W / PANEL_W, 1, p)
    const syBg = lerp(this.restH / this.panelH, 1, p)
    bg.style.transform = `scale(${f3(sxBg)},${f3(syBg)})`
    bg.style.opacity = f3(smooth(0.02, 0.5, pc))

    const curY = lerp((cx - Lc) * PITCH, (cx - Lp) * ROW, p)
    cur.style.transform = `translate3d(0,${px(curY)}px,0)`
    const chrome = this.P.t > 0.5 ? smooth(0.5, 1, pc) : smooth(0.8, 0.98, pc)
    cur.style.opacity = f3(chrome)

    ind.style.transform = `translate3d(0,${px((hi - Lp) * ROW)}px,0)`
    ind.style.opacity = f3(hv * chrome)
  }
}
