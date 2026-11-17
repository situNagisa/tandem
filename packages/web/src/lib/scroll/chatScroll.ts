/**
 * 消息区滚动控制器的纯函数部分（方案见 docs/archive/plan/scroll-controller-2026-11-14.md）。
 *
 * 这里只做数字与状态：滚动来源分类、贴底判定、锚点、跳转落点、弹簧积分、状态迁移。
 * 不碰 DOM、不用定时器，控制器（chatScrollController.ts）负责绑定事件并为每个效果写 scrollTop。
 *
 * 「程序滚动」用写入记账（write ledger）表示：控制器每次写 scrollTop 后把真实值记进 mark，
 * 下一个 scroll 事件与 mark 对照分类。不再用 600ms 时间窗，原生 `behavior:'smooth'` 的中间帧
 * 因为不记账会被判成用户滚动——这正是平滑滚动必须由控制器自绘弹簧完成的原因。
 */

export type ScrollAlign = 'start' | 'center'

export interface ScrollTarget {
  messageId?: string
  toolUseId?: string
}

/** 一次滚动位置采样（scroll 事件或写入后立即读取的值）。 */
export interface ScrollSample {
  top: number
  height: number
  client: number
}

/** 控制器最后一次写入后的真实位置（被浏览器夹紧后也记真实值）。 */
export interface WriteMark {
  top: number
  height: number
  writtenAt: number
}

export type ScrollCause = 'programmatic' | 'clamp' | 'user'

/** 贴底判定的严格阈值：距底部 ≤2px 才算贴底。 */
export const BOTTOM_EPSILON = 2

/** 80px 只用于「回到底部」按钮的显示，不参与跟随判定。 */
export const BUTTON_SHOW_DISTANCE = 80

/** 距顶部 240px 内请求加载更早消息。 */
export const REACH_TOP_DISTANCE = 240

export function maxTop(view: { height: number; client: number }): number {
  return Math.max(0, view.height - view.client)
}

/** 距底部像素数（内容不足一屏时为负）。 */
export function bottomDistance(view: ScrollSample): number {
  return view.height - view.top - view.client
}

export function atBottom(view: ScrollSample): boolean {
  return bottomDistance(view) <= BOTTOM_EPSILON
}

export function showFollowButton(view: ScrollSample): boolean {
  return bottomDistance(view) > BUTTON_SHOW_DISTANCE
}

/**
 * 这次 scroll 事件是谁引起的。
 *
 * - `programmatic`：与我们最后一次写入一致（±1px），或写入超出了可滚范围被浏览器夹到底；
 * - `clamp`：内容收缩后浏览器把视口夹到底/到顶，我们没写、用户也没滚（66550b8 的事故类）；
 * - `user`：其余情况，唯一能改写跟随状态的来源。
 */
export function classifyScroll(prev: ScrollSample, next: ScrollSample, mark: WriteMark): ScrollCause {
  const max = maxTop(next)
  if (next.height < prev.height) {
    // 内容收缩被夹到底：与「用户滚到底」区分开，后者高度不变。
    if (next.top === max) return 'clamp'
    // 整体收缩后仍停在顶部：只有从底部开始写的写入才可能落到这里。
    if (next.top === 0 && mark.top === Math.max(0, mark.height - prev.client)) return 'clamp'
  }
  // 写入比可滚范围大，浏览器夹到了新的 bottom。
  if (mark.top > max && next.top === max) return 'programmatic'
  if (Math.abs(next.top - mark.top) <= 1) return 'programmatic'
  return 'user'
}

/* ------------------------------------------------------------------ 弹簧 */

export const FOLLOW_K = 240
export const FOLLOW_C = 31
/** 与 jump.ts 一致：单帧 dt 上限 33ms、下限 1ms，子步 4ms。 */
export const SPRING_MAX_DT = 0.033
export const SPRING_MIN_DT = 0.001
export const SPRING_SUBSTEP = 0.004
/** 跳转最多动画 900ms（jump.ts 的 elapsed 上限）。 */
export const SPRING_MAX_MS = 900
export const SPRING_POS_EPSILON = 0.5
export const SPRING_VEL_EPSILON = 6

/** rAF 间隔（ms）换算成积分步长，夹在 [1ms, 33ms]。 */
export function springDt(ms: number): number {
  return Math.min(SPRING_MAX_DT, Math.max(SPRING_MIN_DT, ms / 1000))
}

export function isSpringSettled(pos: number, vel: number, goal: number): boolean {
  return Math.abs(goal - pos) < SPRING_POS_EPSILON && Math.abs(vel) < SPRING_VEL_EPSILON
}

export interface SpringStep {
  pos: number
  vel: number
  done: boolean
}

/**
 * 临界阻尼弹簧追目标的一帧。与 jump.ts 的积分完全一致：按 4ms 子步推进，
 * 到达（|差|<0.5 且 |速度|<6）时把位置对齐到 goal。
 */
export function stepSpring(pos: number, vel: number, goal: number, dtSeconds: number): SpringStep {
  const n = Math.max(1, Math.ceil(dtSeconds / SPRING_SUBSTEP))
  const h = dtSeconds / n
  let p = pos
  let v = vel
  for (let i = 0; i < n; i++) {
    v += (FOLLOW_K * (goal - p) - FOLLOW_C * v) * h
    p += v * h
  }
  if (isSpringSettled(p, v, goal)) return { pos: goal, vel: v, done: true }
  return { pos: p, vel: v, done: false }
}

export interface TeleportPlan {
  pos: number
  teleported: boolean
}

/** 长距离跳转先瞬移到目标前约 1.1 屏（阈值 2.2 屏，与 jump.ts 一致）。 */
export function planTeleport(pos: number, goal: number, clientHeight: number): TeleportPlan {
  if (Math.abs(goal - pos) <= clientHeight * 2.2) return { pos, teleported: false }
  return { pos: goal - Math.sign(goal - pos) * clientHeight * 1.1, teleported: true }
}

/* ------------------------------------------------------------------ 落点 */

/** 行相对内容顶部的位置（不受 scrollTop 影响）。 */
export interface RowRect {
  id: string
  top: number
  height: number
}

export interface RowGeometry {
  top: number
  height: number
}

/** 目标行该落的 scrollTop：`start` 贴顶 gap 16；比视口还高的行也贴顶；否则居中。 */
export function targetTop(
  row: RowGeometry,
  view: { clientHeight: number; scrollHeight: number },
  align: ScrollAlign = 'center',
): number {
  const gap =
    align === 'start' || row.height >= view.clientHeight - 32 ? 16 : (view.clientHeight - row.height) / 2
  const max = Math.max(0, view.scrollHeight - view.clientHeight)
  return Math.min(max, Math.max(0, row.top - gap))
}

/* ------------------------------------------------------------------ 锚点 */

/** 视口内第一个完整可见行的 id + 偏移，附带捕获时的 scrollTop/scrollHeight 供退化补偿。 */
export interface Anchor {
  messageId?: string
  offset: number
  height: number
  top: number
}

export function captureAnchor(
  rows: readonly RowRect[],
  view: { scrollTop: number; clientHeight: number; scrollHeight: number },
): Anchor | null {
  const bottom = view.scrollTop + view.clientHeight
  for (const row of rows) {
    if (row.top >= view.scrollTop && row.top + row.height <= bottom) {
      return {
        messageId: row.id,
        offset: row.top - view.scrollTop,
        height: view.scrollHeight,
        top: view.scrollTop,
      }
    }
  }
  return null
}

/**
 * 按锚点算新的 scrollTop。
 *
 * - 锚点行还在：保持它在视口里的偏移，行本身高度变化不影响落点；
 * - 锚点行被卸载：退化为 scrollHeight 差补偿（`fallback` 为 true，调用方只补一次就释放锚点）。
 */
export function restoreAnchorTop(
  anchor: Anchor,
  row: RowRect | undefined,
  view: { scrollTop: number; scrollHeight: number; clientHeight: number },
): { top: number; fallback: boolean } {
  const max = Math.max(0, view.scrollHeight - view.clientHeight)
  const raw = row ? row.top - anchor.offset : view.scrollTop + (view.scrollHeight - anchor.height)
  return { top: Math.min(max, Math.max(0, raw)), fallback: !row }
}

/* ------------------------------------------------------------- 状态与迁移 */

export type ScrollState =
  | { kind: 'idle' }
  | { kind: 'following' }
  | { kind: 'detached' }
  | { kind: 'jumping'; token: number; target: ScrollTarget; align: ScrollAlign; verifies: number }
  | { kind: 'anchoring'; anchor: Anchor; resume: 'following' | 'detached'; frames: number }
  | { kind: 'settling'; untilStable: boolean; frames: number }

export type JumpEndReason = 'arrived' | 'timeout' | 'cancelled' | 'replaced'

/** 控制器需要执行的动作；`hold` 表示明确不写位置。 */
export type ScrollEffect =
  | { type: 'write-bottom' }
  | { type: 'spring-bottom' }
  | { type: 'hold' }
  | { type: 'temp-anchor' }
  | { type: 'anchor'; anchor: Anchor }
  | { type: 'anchor-fallback'; anchor: Anchor }
  | { type: 'drop-anchor' }
  | { type: 'jump'; token: number; target: ScrollTarget; align: ScrollAlign; retarget: boolean }
  | { type: 'need-mount'; target: ScrollTarget }
  | { type: 'jump-verify'; token: number }
  | { type: 'jump-end'; token: number; reason: JumpEndReason }
  | { type: 'follow-exit' }
  | { type: 'destroy' }

export type ScrollEvent =
  /** A/H：打开或切换会话，重置并进入 settling。 */
  | { type: 'open'; key?: string }
  /** D：回到底部（smooth 时自绘弹簧逐帧贴底）。 */
  | { type: 'follow'; smooth?: boolean }
  /** E：跳转；`mounted` 为 false 时要求先挂载目标。 */
  | { type: 'jump'; token: number; target: ScrollTarget; align?: ScrollAlign; mounted: boolean }
  | { type: 'cancel-jump' }
  /** 弹簧走完一帧到达落点（之后进入复核）。 */
  | { type: 'jump-arrived' }
  /** 复核落点：`residual` 为与目标落点的像素差。 */
  | { type: 'jump-verify'; residual: number }
  | { type: 'jump-failed' }
  /** F/G：插入内容前捕获锚点。 */
  | { type: 'begin-anchor'; anchor: Anchor }
  | { type: 'end-anchor' }
  /** I/G：内容高度变化；`anchorFound` 为 false 表示锚点行被卸载。 */
  | { type: 'content-grow'; anchorFound?: boolean }
  /** J：滚动区尺寸变化。 */
  | { type: 'resize' }
  /** C：真实用户滚动（分类结论）。 */
  | { type: 'user-scroll'; atBottom: boolean }
  /** 控制器每帧的稳定性报告：高度这一帧是否变化、现在是否贴底。 */
  | { type: 'frame'; heightChanged: boolean; atBottom: boolean }
  | { type: 'destroy' }

export interface ScrollTransition {
  state: ScrollState
  effects: ScrollEffect[]
}

function resumeState(resume: 'following' | 'detached'): ScrollState {
  return resume === 'following' ? { kind: 'following' } : { kind: 'detached' }
}

function settled(): ScrollState {
  return { kind: 'settling', untilStable: true, frames: 0 }
}

function unchanged(state: ScrollState): ScrollTransition {
  return { state, effects: [] }
}

function toBottom(state: ScrollState, smooth: boolean): ScrollTransition {
  const effects: ScrollEffect[] = []
  if (state.kind === 'jumping') effects.push({ type: 'jump-end', token: state.token, reason: 'replaced' })
  if (state.kind === 'anchoring') effects.push({ type: 'drop-anchor' })
  effects.push(smooth ? { type: 'spring-bottom' } : { type: 'write-bottom' })
  return { state: settled(), effects }
}

function startJump(state: ScrollState, event: Extract<ScrollEvent, { type: 'jump' }>): ScrollTransition {
  const align = event.align ?? 'center'
  const effects: ScrollEffect[] = []
  if (state.kind === 'anchoring') effects.push({ type: 'drop-anchor' })
  if (!event.mounted) effects.push({ type: 'need-mount', target: event.target })
  effects.push({
    type: 'jump',
    token: event.token,
    target: event.target,
    align,
    retarget: state.kind === 'jumping',
  })
  return {
    state: { kind: 'jumping', token: event.token, target: event.target, align, verifies: 0 },
    effects,
  }
}

/**
 * 状态迁移：`next(state, event)` 只算新状态与该做的动作，由控制器执行。
 * 转移表见方案 4.5 节；表里没写的组合取「不移动视口、不打断用户」的一侧。
 */
export function next(state: ScrollState, event: ScrollEvent): ScrollTransition {
  switch (event.type) {
    case 'open':
      return toBottom(state, false)

    case 'follow':
      return toBottom(state, event.smooth === true)

    case 'jump':
      return startJump(state, event)

    case 'cancel-jump':
      if (state.kind !== 'jumping') return unchanged(state)
      return {
        state: { kind: 'detached' },
        effects: [{ type: 'jump-end', token: state.token, reason: 'cancelled' }],
      }

    case 'destroy': {
      const effects: ScrollEffect[] = []
      if (state.kind === 'jumping') effects.push({ type: 'jump-end', token: state.token, reason: 'cancelled' })
      if (state.kind === 'anchoring') effects.push({ type: 'drop-anchor' })
      effects.push({ type: 'destroy' })
      return { state: { kind: 'idle' }, effects }
    }

    case 'jump-arrived': {
      if (state.kind !== 'jumping') return unchanged(state)
      // 复核期间仍是 jumping，最多复核 2 次。
      if (state.verifies < 2) {
        return {
          state: { ...state, verifies: state.verifies + 1 },
          effects: [{ type: 'jump-verify', token: state.token }],
        }
      }
      return {
        state: { kind: 'detached' },
        effects: [{ type: 'jump-end', token: state.token, reason: 'arrived' }],
      }
    }

    case 'jump-verify': {
      if (state.kind !== 'jumping') return unchanged(state)
      if (event.residual <= 3) {
        return {
          state: { kind: 'detached' },
          effects: [{ type: 'jump-end', token: state.token, reason: 'arrived' }],
        }
      }
      // 渲染后行高变真实值：以当前位置再滑一次，之后不再写。
      return {
        state,
        effects: [
          { type: 'jump', token: state.token, target: state.target, align: state.align, retarget: true },
        ],
      }
    }

    case 'jump-failed': {
      if (state.kind !== 'jumping') return unchanged(state)
      return {
        state: { kind: 'detached' },
        effects: [{ type: 'jump-end', token: state.token, reason: 'timeout' }],
      }
    }

    case 'begin-anchor': {
      // following/settling 想贴底，锚点没有意义；jumping 期间禁止锚点写，跳完再恢复。
      if (state.kind === 'following' || state.kind === 'settling' || state.kind === 'jumping') {
        return unchanged(state)
      }
      // anchoring 期间再来一次：保留先到的锚点（更早的用户参考位置）。
      if (state.kind === 'anchoring') return unchanged(state)
      return {
        state: {
          kind: 'anchoring',
          anchor: event.anchor,
          resume: 'detached',
          frames: 0,
        },
        effects: [],
      }
    }

    case 'end-anchor': {
      if (state.kind !== 'anchoring') return unchanged(state)
      return { state: resumeState(state.resume), effects: [] }
    }

    case 'content-grow': {
      switch (state.kind) {
        case 'following':
        case 'settling':
          return { state, effects: [{ type: 'write-bottom' }] }
        case 'detached':
          return { state, effects: [{ type: 'hold' }] }
        case 'anchoring':
          if (event.anchorFound === false) {
            // 锚点行被卸载：按 scrollHeight 差补一次就释放，不再反复补偿。
            return {
              state: resumeState(state.resume),
              effects: [{ type: 'anchor-fallback', anchor: state.anchor }],
            }
          }
          return { state: { ...state, frames: 0 }, effects: [{ type: 'anchor', anchor: state.anchor }] }
        case 'jumping':
          return {
            state,
            effects: [
              { type: 'jump', token: state.token, target: state.target, align: state.align, retarget: true },
            ],
          }
        default:
          return unchanged(state)
      }
    }

    case 'resize': {
      switch (state.kind) {
        case 'following':
        case 'settling':
          return { state, effects: [{ type: 'write-bottom' }] }
        case 'detached':
          // 等价于一次临时 anchor：捕获视口首行 + 偏移，重排后补回来。
          return { state, effects: [{ type: 'temp-anchor' }] }
        case 'anchoring':
          return { state: { ...state, frames: 0 }, effects: [{ type: 'anchor', anchor: state.anchor }] }
        case 'jumping':
          return {
            state,
            effects: [
              { type: 'jump', token: state.token, target: state.target, align: state.align, retarget: true },
            ],
          }
        default:
          return unchanged(state)
      }
    }

    case 'user-scroll': {
      switch (state.kind) {
        case 'following':
          return event.atBottom ? unchanged(state) : { state: { kind: 'detached' }, effects: [{ type: 'follow-exit' }] }
        case 'detached':
          return event.atBottom ? { state: { kind: 'following' }, effects: [] } : unchanged(state)
        case 'settling':
          // 用户优先：打开会话后立即上滚也必须停住。
          return { state: { kind: 'detached' }, effects: [] }
        case 'anchoring':
          return event.atBottom
            ? { state: { kind: 'following' }, effects: [{ type: 'drop-anchor' }] }
            : { state: { kind: 'detached' }, effects: [{ type: 'drop-anchor' }] }
        case 'jumping':
          // 1724#03：用户一滚动就结束这次跳转（进入 detached），之后不再写视口。
          // 不能把用户位置并入后继续追目标——那会在每次滚轮后把视图写回目标，形成持续锁定。
          return {
            state: { kind: 'detached' },
            effects: [{ type: 'jump-end', token: state.token, reason: 'cancelled' }],
          }
        default:
          return unchanged(state)
      }
    }

    case 'frame': {
      if (state.kind === 'settling') {
        if (event.heightChanged) return { state: { ...state, frames: 0 }, effects: [] }
        const frames = state.frames + 1
        // 没有墙钟期限：到达底部且内容连续 2 帧不变才结束。
        if (frames >= 2 && event.atBottom) return { state: { kind: 'following' }, effects: [] }
        return { state: { ...state, frames }, effects: [] }
      }
      if (state.kind === 'anchoring') {
        if (event.heightChanged) return { state: { ...state, frames: 0 }, effects: [] }
        const frames = state.frames + 1
        if (frames >= 2) return { state: resumeState(state.resume), effects: [] }
        return { state: { ...state, frames }, effects: [] }
      }
      return unchanged(state)
    }
  }
}

/* ------------------------------------------------------------- 顶部请求 */

/**
 * 是否该发一次 `onReachTop`（顶部 240px 内加载更早消息）。
 * 只在 detached/following 生效；同一次停留只触发一次，离开顶部后重新武装。
 */
export function shouldEmitReachTop(
  state: ScrollState,
  top: number,
  armed: boolean,
): { fire: boolean; armed: boolean } {
  if (top > REACH_TOP_DISTANCE) return { fire: false, armed: true }
  if (!armed) return { fire: false, armed }
  if (state.kind !== 'detached' && state.kind !== 'following') return { fire: false, armed }
  return { fire: true, armed: false }
}
