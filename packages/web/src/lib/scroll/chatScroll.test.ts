import { describe, expect, it } from 'vitest'
import {
  atBottom,
  bottomDistance,
  captureAnchor,
  classifyScroll,
  isSpringSettled,
  maxTop,
  next,
  planTeleport,
  restoreAnchorTop,
  showFollowButton,
  shouldEmitReachTop,
  springDt,
  stepSpring,
  targetTop,
} from './chatScroll'
import type {
  Anchor,
  ScrollEffect,
  ScrollEvent,
  ScrollState,
  ScrollTarget,
  ScrollTransition,
} from './chatScroll'

const anchorA: Anchor = { messageId: 'm1', offset: 24, height: 4000, top: 1000 }
const anchorB: Anchor = { messageId: 'm2', offset: 8, height: 4200, top: 960 }
const target: ScrollTarget = { messageId: 'm10' }

const idle: ScrollState = { kind: 'idle' }
const following: ScrollState = { kind: 'following' }
const detached: ScrollState = { kind: 'detached' }
const settling: ScrollState = { kind: 'settling', untilStable: true, frames: 0 }
const anchoring: ScrollState = { kind: 'anchoring', anchor: anchorA, resume: 'detached', frames: 0 }
const jumping: ScrollState = { kind: 'jumping', token: 7, target, align: 'start', verifies: 0 }

/** 依次喂事件，返回每一步的迁移结果。 */
function play(state: ScrollState, events: ScrollEvent[]): ScrollTransition[] {
  const out: ScrollTransition[] = []
  let current = state
  for (const event of events) {
    const step = next(current, event)
    out.push(step)
    current = step.state
  }
  return out
}

/** 只跑最后一步，返回最终状态与这一步的 effects。 */
function last(state: ScrollState, events: ScrollEvent[]): ScrollTransition {
  const steps = play(state, events)
  return steps[steps.length - 1] ?? { state, effects: [] }
}

function kinds(effects: ScrollEffect[]): string[] {
  return effects.map((e) => e.type)
}

describe('滚动来源分类（替代 600ms 时间窗）', () => {
  it('1. 写入后的滚动事件与 mark 一致（±1px）→ programmatic', () => {
    const mark = { top: 420, height: 1000, writtenAt: 0 }
    const prev = { top: 420, height: 1000, client: 500 }
    expect(classifyScroll(prev, { ...prev }, mark)).toBe('programmatic')
    expect(classifyScroll(prev, { ...prev, top: 421 }, mark)).toBe('programmatic')
  })

  it('2. 写入被浏览器夹紧（mark.top > maxTop，落在新的 bottom）→ programmatic', () => {
    const prev = { top: 500, height: 1000, client: 500 }
    const mark = { top: 600, height: 1000, writtenAt: 0 }
    expect(classifyScroll(prev, { ...prev }, mark)).toBe('programmatic')
  })

  it('3. 内容收缩导致的 top 下降 → clamp（66550b8 回归）', () => {
    const prev = { top: 500, height: 1000, client: 500 }
    const mark = { top: 500, height: 1000, writtenAt: 0 }
    const next1 = { top: 300, height: 800, client: 500 }
    expect(classifyScroll(prev, next1, mark)).toBe('clamp')

    // 整体收缩后回到顶部，且收缩前 mark 在底部：同样是 clamp，不是用户滚动。
    const prev2 = { top: 100, height: 1000, client: 500 }
    const mark2 = { top: 500, height: 1000, writtenAt: 0 }
    expect(classifyScroll(prev2, { top: 0, height: 900, client: 500 }, mark2)).toBe('clamp')
  })

  it('4. 用户上滚（top 小于 mark，高度不变）→ user', () => {
    const prev = { top: 500, height: 1000, client: 500 }
    const mark = { top: 500, height: 1000, writtenAt: 0 }
    expect(classifyScroll(prev, { top: 400, height: 1000, client: 500 }, mark)).toBe('user')
  })

  it('5. 原生平滑滚动的中间帧不记账 → 会被判成 user（所以平滑只能自绘）', () => {
    const start = { top: 500, height: 3000, client: 600 }
    const mark = { top: 500, height: 3000, writtenAt: 0 }
    const mid = { top: 300, height: 3000, client: 600 }
    expect(classifyScroll(start, mid, mark)).toBe('user')
    // 控制器自绘时每帧都写、每帧都有 mark，同一帧永远判为 programmatic。
    expect(classifyScroll(mid, mid, { top: 300, height: 3000, writtenAt: 16 })).toBe('programmatic')
  })

  it('6. 同一帧内先 clamp 再 user（连续两次 scroll 事件）', () => {
    const mark = { top: 500, height: 1000, writtenAt: 0 }
    const before = { top: 500, height: 1000, client: 500 }
    const clamped = { top: 300, height: 800, client: 500 }
    expect(classifyScroll(before, clamped, mark)).toBe('clamp')
    expect(classifyScroll(clamped, { top: 200, height: 800, client: 500 }, mark)).toBe('user')
  })
})

describe('贴底与离开', () => {
  it('7. atBottom 边界：距离 2 → true；3 → false；内容不足一屏 → true', () => {
    expect(atBottom({ top: 498, height: 1000, client: 500 })).toBe(true)
    expect(atBottom({ top: 497, height: 1000, client: 500 })).toBe(false)
    expect(atBottom({ top: 0, height: 400, client: 500 })).toBe(true)
  })

  it('8. 距离 80 与 81 只切按钮显示，不切跟随（跟随只认 2px）', () => {
    const at80 = { top: 420, height: 1000, client: 500 }
    const at81 = { top: 419, height: 1000, client: 500 }
    expect(bottomDistance(at80)).toBe(80)
    expect(bottomDistance(at81)).toBe(81)
    expect(showFollowButton(at80)).toBe(false)
    expect(showFollowButton(at81)).toBe(true)
    // 80px 处已经不是贴底：状态机按 2px 判，用户滚动立即离开跟随。
    expect(atBottom(at80)).toBe(false)
    expect(last(following, [{ type: 'content-grow' }]).state).toEqual(following)
    expect(last(following, [{ type: 'user-scroll', atBottom: atBottom(at80) }]).state.kind).toBe('detached')
  })

  it('9. settling 下单帧贴底不结束，需连续 2 帧稳定且贴底', () => {
    const one = last(settling, [{ type: 'frame', heightChanged: false, atBottom: true }])
    expect(one.state.kind).toBe('settling')
    const two = last(one.state, [{ type: 'frame', heightChanged: false, atBottom: true }])
    expect(two.state.kind).toBe('following')
    // 两帧稳定但还没到底：继续 settling。
    const notYet = play(settling, [
      { type: 'frame', heightChanged: false, atBottom: false },
      { type: 'frame', heightChanged: false, atBottom: false },
    ])
    expect(notYet[1]?.state.kind).toBe('settling')
    // 高度一直在变：帧计数归零。
    const changing = play(settling, [
      { type: 'frame', heightChanged: false, atBottom: true },
      { type: 'frame', heightChanged: true, atBottom: true },
      { type: 'frame', heightChanged: false, atBottom: true },
    ])
    expect(changing[2]?.state.kind).toBe('settling')
  })
})

describe('落点', () => {
  const view = { clientHeight: 800, scrollHeight: 5000 }

  it('10. targetTop(start)：贴顶 gap 16；比视口高的行也贴顶', () => {
    expect(targetTop({ top: 1200, height: 600 }, view, 'start')).toBe(1184)
    expect(targetTop({ top: 3000, height: 900 }, view, 'start')).toBe(2984)
    // 居中时超过阈值（client - 32）同样贴顶。
    expect(targetTop({ top: 3000, height: 800 }, view, 'center')).toBe(2984)
  })

  it('11. targetTop(center)：居中，且被夹在 0..max', () => {
    expect(targetTop({ top: 2000, height: 400 }, view, 'center')).toBe(1800)
    expect(targetTop({ top: 100, height: 400 }, view, 'center')).toBe(0)
    expect(targetTop({ top: 1200, height: 400 }, { clientHeight: 800, scrollHeight: 1300 }, 'center')).toBe(500)
    expect(maxTop({ height: 1300, client: 800 })).toBe(500)
  })

  it('12. planTeleport：2.2 屏外先瞬移到目标前 1.1 屏，之内不瞬移', () => {
    expect(planTeleport(0, 1250, 500)).toEqual({ pos: 700, teleported: true })
    expect(planTeleport(0, 1000, 500)).toEqual({ pos: 0, teleported: false })
    expect(planTeleport(1250, 0, 500)).toEqual({ pos: 550, teleported: true })
  })

  it('13. 弹簧一帧大 dt 与多帧小 dt 的总位移接近（子步积分稳定）', () => {
    let big = { pos: 0, vel: 0 }
    for (let i = 0; i < 6; i++) big = stepSpring(big.pos, big.vel, 1000, 0.033)
    let small = { pos: 0, vel: 0 }
    for (let i = 0; i < 198; i++) small = stepSpring(small.pos, small.vel, 1000, 0.001)
    expect(Math.abs(big.pos - small.pos)).toBeLessThan(3)
    expect(springDt(0.5)).toBe(0.001)
    expect(springDt(100)).toBe(0.033)
  })

  it('14. 到点判定：|goal-pos| < 0.5 且 |vel| < 6；否则继续', () => {
    expect(isSpringSettled(99.7, 0, 100)).toBe(true)
    expect(isSpringSettled(99.5, 0, 100)).toBe(false)
    expect(isSpringSettled(100, 5.9, 100)).toBe(true)
    expect(isSpringSettled(100, 6, 100)).toBe(false)
    const near = stepSpring(99.9, 0, 100, 0.016)
    expect(near).toMatchObject({ pos: 100, done: true })
    const far = stepSpring(0, 0, 1000, 0.016)
    expect(far.done).toBe(false)
    expect(far.pos).toBeGreaterThan(0)
  })

  it('15. 跳转期间内容增高目标下移 → 下一帧仍朝新目标前进（单调，不回弹）', () => {
    const first = stepSpring(100, 0, 200, 0.016)
    const second = stepSpring(first.pos, first.vel, 400, 0.016)
    expect(first.pos).toBeGreaterThan(100)
    expect(second.pos).toBeGreaterThan(first.pos)
    expect(second.vel).toBeGreaterThan(0)
  })
})

describe('锚点', () => {
  const rows = [
    { id: 'a', top: 0, height: 1000 },
    { id: 'b', top: 1000, height: 200 },
  ]
  const view = { scrollTop: 1000, clientHeight: 800, scrollHeight: 3000 }
  const anchor = captureAnchor(rows, view)

  it('捕获视口内第一个完整可见行（半截行跳过）', () => {
    expect(anchor).toEqual({ messageId: 'b', offset: 0, height: 3000, top: 1000 })
    expect(captureAnchor([{ id: 'half', top: 900, height: 300 }], view)).toBeNull()
  })

  it('16. 锚点行上方增高 120px → scrollTop + 120', () => {
    expect(anchor).not.toBeNull()
    const moved = [{ id: 'a', top: 0, height: 1120 }, { id: 'b', top: 1120, height: 200 }]
    const restored = restoreAnchorTop(anchor!, moved[1], { scrollTop: 1000, scrollHeight: 3120, clientHeight: 800 })
    expect(restored).toEqual({ top: 1120, fallback: false })
  })

  it('17. 锚点行本身高度变化 → 保持行的 top 偏移，不按 scrollHeight 差补偿', () => {
    const restored = restoreAnchorTop(anchor!, { id: 'b', top: 1000, height: 400 }, {
      scrollTop: 1000,
      scrollHeight: 3200,
      clientHeight: 800,
    })
    expect(restored).toEqual({ top: 1000, fallback: false })
    // 按 scrollHeight 差会得到 1200，正是这里要避免的。
    expect(restored.top).not.toBe(1200)
  })

  it('18. 锚点行被卸载 → 退化为 height 差补偿，只补一次', () => {
    const restored = restoreAnchorTop(anchor!, undefined, { scrollTop: 1000, scrollHeight: 3120, clientHeight: 800 })
    expect(restored).toEqual({ top: 1120, fallback: true })
    const once = last(anchoring, [{ type: 'content-grow', anchorFound: false }])
    expect(once.state.kind).toBe('detached')
    expect(once.effects).toEqual([{ type: 'anchor-fallback', anchor: anchorA }])
    // 释放后再增高不再补偿，也不再写位置。
    const after = last(once.state, [{ type: 'content-grow' }])
    expect(after.state.kind).toBe('detached')
    expect(kinds(after.effects)).toEqual(['hold'])
  })

  it('19. 两帧内高度不变 → 自动释放；高度继续变 → 保持 anchoring', () => {
    const kept = play(anchoring, [
      { type: 'frame', heightChanged: false, atBottom: false },
      { type: 'content-grow' },
      { type: 'frame', heightChanged: false, atBottom: false },
    ])
    expect(kept[2]?.state.kind).toBe('anchoring')

    const released = play(anchoring, [
      { type: 'frame', heightChanged: false, atBottom: false },
      { type: 'frame', heightChanged: false, atBottom: false },
    ])
    expect(released[1]?.state.kind).toBe('detached')
  })

  it('20. anchoring 期间 jump() → 锚点丢弃，不产生锚点写点', () => {
    const step = last(anchoring, [{ type: 'jump', token: 9, target, mounted: true }])
    expect(step.state.kind).toBe('jumping')
    expect(kinds(step.effects)).toEqual(['drop-anchor', 'jump'])
    expect(step.effects.some((e) => e.type === 'anchor')).toBe(false)
  })
})

describe('状态迁移', () => {
  it('21. open 时处于 jumping → settling，旧 token 失效', () => {
    const step = last(jumping, [{ type: 'open', key: 's2' }])
    expect(step.state).toEqual({ kind: 'settling', untilStable: true, frames: 0 })
    expect(step.effects).toEqual([
      { type: 'jump-end', token: 7, reason: 'replaced' },
      { type: 'write-bottom' },
    ])
  })

  it('22. following + 用户上滚 → detached；滚回底部 → following', () => {
    const left = last(following, [{ type: 'user-scroll', atBottom: false }])
    expect(left.state.kind).toBe('detached')
    expect(left.effects).toEqual([{ type: 'follow-exit' }])
    const back = last(left.state, [{ type: 'user-scroll', atBottom: true }])
    expect(back.state.kind).toBe('following')
    expect(back.effects).toEqual([])
  })

  it('23. jumping + 用户上滚 → 仍 jumping（R68）；结束后 detached，不再回底', () => {
    const scrolled = last(jumping, [{ type: 'user-scroll', atBottom: false }])
    expect(scrolled.state.kind).toBe('jumping')
    expect(scrolled.effects).toEqual([])
    const arrived = play(scrolled.state, [{ type: 'jump-arrived' }, { type: 'jump-verify', residual: 0 }])
    expect(arrived[1]?.state.kind).toBe('detached')
    const after = last(arrived[1]!.state, [{ type: 'user-scroll', atBottom: false }])
    expect(after.state.kind).toBe('detached')
    expect(after.effects).toEqual([])
  })

  it('24. settling + 用户上滚 → detached（不被吸回底部）', () => {
    const step = last(settling, [{ type: 'user-scroll', atBottom: false }])
    expect(step.state.kind).toBe('detached')
    expect(step.effects).toEqual([])
  })

  it('25. detached + 内容增高 → 位置不变（无 anchor）', () => {
    const step = last(detached, [{ type: 'content-grow' }])
    expect(step.state.kind).toBe('detached')
    expect(step.effects).toEqual([{ type: 'hold' }])
  })

  it('26. 尺寸变化：following 补底；detached 首行偏移不变；jumping 目标重算', () => {
    expect(kinds(last(following, [{ type: 'resize' }]).effects)).toEqual(['write-bottom'])
    expect(kinds(last(detached, [{ type: 'resize' }]).effects)).toEqual(['temp-anchor'])
    expect(kinds(last(jumping, [{ type: 'resize' }]).effects)).toEqual(['jump'])
  })

  it('27. onReachTop 只在 detached/following 且 top <= 240 时发一次', () => {
    expect(shouldEmitReachTop(detached, 100, true)).toEqual({ fire: true, armed: false })
    // 同一次停留不重复触发。
    expect(shouldEmitReachTop(detached, 120, false)).toEqual({ fire: false, armed: false })
    // 离开顶部后重新武装。
    expect(shouldEmitReachTop(detached, 300, false)).toEqual({ fire: false, armed: true })
    expect(shouldEmitReachTop(following, 0, true)).toEqual({ fire: true, armed: false })
    expect(shouldEmitReachTop(settling, 0, true)).toEqual({ fire: false, armed: true })
    expect(shouldEmitReachTop(jumping, 0, true)).toEqual({ fire: false, armed: true })
    expect(shouldEmitReachTop(anchoring, 0, true)).toEqual({ fire: false, armed: true })
  })
})

/**
 * 方案第 3 节「两两组合：应该谁赢」，每行一条状态机用例。
 * 用模拟的 height/client/top 与事件序列驱动，断言最终状态与 effects。
 */
describe('第 3 节两两组合：应该谁赢', () => {
  it('A×B：打开后流式增高由 B 补底，A 只是 B 的初始态', () => {
    const steps = play(idle, [
      { type: 'open' },
      { type: 'content-grow' },
      { type: 'frame', heightChanged: false, atBottom: true },
      { type: 'frame', heightChanged: false, atBottom: true },
    ])
    expect(steps[0]?.effects).toEqual([{ type: 'write-bottom' }])
    expect(steps[1]?.effects).toEqual([{ type: 'write-bottom' }])
    expect(steps[3]?.state.kind).toBe('following')
  })

  it('A×C：打开后立即上滚停住，不被任何补偿拉回', () => {
    const steps = play(idle, [
      { type: 'open' },
      { type: 'user-scroll', atBottom: false },
      { type: 'content-grow' },
    ])
    expect(steps[1]?.state.kind).toBe('detached')
    expect(kinds(steps[2]?.effects ?? [])).toEqual(['hold'])
  })

  it('A×D：D 覆盖 A 的同步写底', () => {
    const step = last(settling, [{ type: 'follow', smooth: true }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([{ type: 'spring-bottom' }])
  })

  it('A×E：有跳转时 A 不启动校准，增高只重取目标', () => {
    const steps = play(settling, [{ type: 'jump', token: 1, target, mounted: true }, { type: 'content-grow' }])
    expect(steps[0]?.state.kind).toBe('jumping')
    expect(steps[1]?.state.kind).toBe('jumping')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['jump'])
  })

  it('A×F：打开即底部，不存在阅读意图，锚点不生效', () => {
    const steps = play(settling, [{ type: 'begin-anchor', anchor: anchorA }, { type: 'content-grow' }])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(steps[0]?.effects).toEqual([])
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('A×G：固定轮只保证挂载，插入上方时仍回到底部', () => {
    const steps = play(settling, [{ type: 'begin-anchor', anchor: anchorA }, { type: 'content-grow' }])
    expect(steps[1]?.state.kind).toBe('settling')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('A×H：H 先保旧画面，提交后 A 接管（settling → following）', () => {
    const steps = play(idle, [
      { type: 'open', key: 's2' },
      { type: 'frame', heightChanged: false, atBottom: true },
      { type: 'frame', heightChanged: false, atBottom: true },
    ])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(steps[2]?.state.kind).toBe('following')
  })

  it('A×I：打开期间 content-visibility 撑高一律绘制前补底', () => {
    const steps = play(settling, [{ type: 'content-grow' }, { type: 'content-grow' }])
    expect(kinds(steps[0]?.effects ?? [])).toEqual(['write-bottom'])
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('A×J：窗口尺寸变化时 A 仍贴底', () => {
    const step = last(settling, [{ type: 'resize' }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('B×C：用户滚动在事件当帧生效，不延迟、不被时间窗吞掉', () => {
    const step = last(following, [{ type: 'user-scroll', atBottom: false }])
    expect(step.state.kind).toBe('detached')
    expect(step.effects).toEqual([{ type: 'follow-exit' }])
  })

  it('B×D：D 让跟随变成平滑回底', () => {
    const step = last(following, [{ type: 'follow', smooth: true }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([{ type: 'spring-bottom' }])
  })

  it('B×E：E 打断跟随；跳转中用户发消息（D）可打断 E', () => {
    const steps = play(following, [
      { type: 'jump', token: 2, target, mounted: true },
      { type: 'follow', smooth: true },
    ])
    expect(steps[0]?.state.kind).toBe('jumping')
    expect(steps[1]?.state.kind).toBe('settling')
    expect(steps[1]?.effects).toEqual([
      { type: 'jump-end', token: 2, reason: 'replaced' },
      { type: 'spring-bottom' },
    ])
  })

  it('B×F：贴底时增高补底；离开后同一路径改按锚点补偿', () => {
    const steps = play(following, [
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
      { type: 'user-scroll', atBottom: false },
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
    ])
    expect(steps[0]?.state.kind).toBe('following')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
    expect(steps[2]?.state.kind).toBe('detached')
    expect(steps[3]?.state.kind).toBe('anchoring')
    expect(kinds(steps[4]?.effects ?? [])).toEqual(['anchor'])
  })

  it('B×G：固定轮插入上方后 B 补底', () => {
    const step = last(following, [{ type: 'content-grow' }])
    expect(step.state.kind).toBe('following')
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('B×H：旧会话流式增长写的是旧画面；切换后由新会话接管', () => {
    const steps = play(following, [{ type: 'open', key: 's2' }, { type: 'content-grow' }])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(kinds(steps[0]?.effects ?? [])).toEqual(['write-bottom'])
    expect(steps[1]?.state.kind).toBe('settling')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('B×I：增高事件同步补底（绘制前语义，不排 rAF）', () => {
    const step = last(following, [{ type: 'content-grow' }])
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('B×J：宽度变化行重排后仍补底', () => {
    const step = last(following, [{ type: 'resize' }])
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('C×D：D 显式覆盖 C，settling 中再次用户滚动仍停住', () => {
    const steps = play(detached, [{ type: 'follow', smooth: true }, { type: 'user-scroll', atBottom: false }])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(kinds(steps[0]?.effects ?? [])).toEqual(['spring-bottom'])
    expect(steps[1]?.state.kind).toBe('detached')
  })

  it('C×E：跳转期间 C 不打断；跳完只停目标，不再被拉走', () => {
    const steps = play(detached, [
      { type: 'jump', token: 3, target, mounted: true },
      { type: 'user-scroll', atBottom: false },
      { type: 'jump-arrived' },
      { type: 'jump-verify', residual: 0 },
      { type: 'user-scroll', atBottom: false },
    ])
    expect(steps[1]?.state.kind).toBe('jumping')
    expect(steps[1]?.effects).toEqual([])
    expect(steps[3]?.state.kind).toBe('detached')
    expect(steps[4]?.state.kind).toBe('detached')
    expect(steps[4]?.effects).toEqual([])
  })

  it('C×F：离开底部且保持锚点，两者同时成立', () => {
    const steps = play(detached, [
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
      { type: 'end-anchor' },
    ])
    expect(steps[0]?.state.kind).toBe('anchoring')
    expect(steps[1]?.state.kind).toBe('anchoring')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['anchor'])
    expect(steps[2]?.state.kind).toBe('detached')
  })

  it('C×G：固定轮按需加载插入上方时视口不动（锚点补偿，不写底）', () => {
    const steps = play(detached, [
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
      { type: 'content-grow' },
      { type: 'end-anchor' },
    ])
    expect(steps.map((s) => s.state.kind)).toEqual(['anchoring', 'anchoring', 'anchoring', 'detached'])
    for (const step of steps) {
      expect(kinds(step.effects)).not.toContain('write-bottom')
      expect(kinds(step.effects)).not.toContain('spring-bottom')
    }
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['anchor'])
    expect(kinds(steps[2]?.effects ?? [])).toEqual(['anchor'])
  })

  it('C×H：切换会话后 C 重置为 A（新会话从底部开始）', () => {
    const step = last(detached, [{ type: 'open', key: 's2' }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('C×I：阅读时被动撑高保持锚点/不动，不误判为用户滚动', () => {
    const step = last(detached, [{ type: 'content-grow' }])
    expect(step.state.kind).toBe('detached')
    expect(step.effects).toEqual([{ type: 'hold' }])
  })

  it('C×J：阅读时窗口尺寸变化保持视口首行', () => {
    const step = last(detached, [{ type: 'resize' }])
    expect(step.state.kind).toBe('detached')
    expect(step.effects).toEqual([{ type: 'temp-anchor' }])
  })

  it('D×E：后派发者 D 覆盖 E', () => {
    const step = last(jumping, [{ type: 'follow' }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([
      { type: 'jump-end', token: 7, reason: 'replaced' },
      { type: 'write-bottom' },
    ])
  })

  it('D×F：位移互斥，D 后派发时锚点不参与', () => {
    const steps = play(settling, [{ type: 'begin-anchor', anchor: anchorA }, { type: 'content-grow' }])
    expect(steps[0]?.effects).toEqual([])
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('D×G：固定轮插入上方时 D 仍贴底', () => {
    const steps = play(settling, [{ type: 'begin-anchor', anchor: anchorA }, { type: 'content-grow' }])
    expect(steps[1]?.state.kind).toBe('settling')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('D×H：切换瞬间取消平滑并同步贴底', () => {
    const step = last(settling, [{ type: 'open', key: 's2' }])
    expect(step.state.kind).toBe('settling')
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('D×I：回底动画期间增高继续补底', () => {
    const step = last(settling, [{ type: 'content-grow' }])
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('D×J：回底动画期间尺寸变化仍贴底', () => {
    const step = last(settling, [{ type: 'resize' }])
    expect(step.effects).toEqual([{ type: 'write-bottom' }])
  })

  it('E×F：跳转期间禁止锚点写，跳完才恢复锚点（最危险）', () => {
    const steps = play(detached, [
      { type: 'jump', token: 11, target, align: 'start', mounted: true },
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
      { type: 'jump-arrived' },
      { type: 'jump-verify', residual: 0 },
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
    ])
    expect(steps[0]?.state.kind).toBe('jumping')
    expect(steps[1]?.state.kind).toBe('jumping')
    expect(steps[1]?.effects).toEqual([])
    expect(steps[2]?.state.kind).toBe('jumping')
    expect(kinds(steps[2]?.effects ?? [])).toEqual(['jump'])
    expect(steps[3]?.effects).toEqual([{ type: 'jump-verify', token: 11 }])
    expect(steps[4]?.state.kind).toBe('detached')
    expect(steps[4]?.effects).toEqual([{ type: 'jump-end', token: 11, reason: 'arrived' }])
    // 跳转期间（含复核）没有任何锚点写点。
    for (const step of steps.slice(0, 5)) {
      expect(step.effects.some((e) => e.type === 'anchor' || e.type === 'anchor-fallback')).toBe(false)
    }
    // 跳完之后的加载才恢复锚点补偿。
    expect(steps[5]?.state.kind).toBe('anchoring')
    expect(kinds(steps[6]?.effects ?? [])).toEqual(['anchor'])
  })

  it('E×G：跳转中固定轮挂载只重取目标，不写底', () => {
    const step = last(jumping, [{ type: 'content-grow' }])
    expect(step.state.kind).toBe('jumping')
    expect(kinds(step.effects)).toEqual(['jump'])
    expect(step.effects).toContainEqual({ type: 'jump', token: 7, target, align: 'start', retarget: true })
  })

  it('E×H：H 提交后 E 才生效，旧 token 随切换失效', () => {
    const steps = play(jumping, [{ type: 'open', key: 's2' }, { type: 'jump', token: 12, target, mounted: true }])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(steps[0]?.effects).toEqual([
      { type: 'jump-end', token: 7, reason: 'replaced' },
      { type: 'write-bottom' },
    ])
    expect(steps[1]?.state.kind).toBe('jumping')
    expect(steps[1]?.state).toMatchObject({ token: 12 })
  })

  it('E×I：逐帧重取目标、最多复核 2 次', () => {
    const steps = play(jumping, [
      { type: 'content-grow' },
      { type: 'content-grow' },
      { type: 'jump-arrived' },
      { type: 'jump-verify', residual: 12 },
      { type: 'jump-arrived' },
      { type: 'jump-verify', residual: 0 },
    ])
    expect(steps[0]?.state.kind).toBe('jumping')
    expect(steps[1]?.state.kind).toBe('jumping')
    expect(steps[2]?.state).toMatchObject({ kind: 'jumping', verifies: 1 })
    expect(steps[3]?.state.kind).toBe('jumping')
    expect(steps[4]?.state).toMatchObject({ kind: 'jumping', verifies: 2 })
    expect(steps[5]?.state.kind).toBe('detached')
  })

  it('E×J：跳转中尺寸变化重算目标；跳完后按锚点保持', () => {
    const steps = play(jumping, [
      { type: 'resize' },
      { type: 'jump-arrived' },
      { type: 'jump-verify', residual: 0 },
      { type: 'resize' },
    ])
    expect(kinds(steps[0]?.effects ?? [])).toEqual(['jump'])
    expect(steps[2]?.state.kind).toBe('detached')
    expect(kinds(steps[3]?.effects ?? [])).toEqual(['temp-anchor'])
  })

  it('F×G：两次加载都按锚点补偿（保留先到的锚点）', () => {
    const steps = play(detached, [
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'begin-anchor', anchor: anchorB },
      { type: 'content-grow' },
    ])
    expect(steps[1]?.state).toEqual({ kind: 'anchoring', anchor: anchorA, resume: 'detached', frames: 0 })
    expect(steps[2]?.effects).toEqual([{ type: 'anchor', anchor: anchorA }])
  })

  it('F×H：H 重置，F 不跨会话', () => {
    const step = last(anchoring, [{ type: 'open', key: 's2' }])
    expect(step.state.kind).toBe('settling')
    expect(kinds(step.effects)).toEqual(['drop-anchor', 'write-bottom'])
  })

  it('F×I：稳定 2 帧后释放锚点，不用墙钟', () => {
    const steps = play(anchoring, [
      { type: 'content-grow' },
      { type: 'frame', heightChanged: false, atBottom: false },
      { type: 'frame', heightChanged: false, atBottom: false },
    ])
    expect(steps[1]?.state.kind).toBe('anchoring')
    expect(steps[2]?.state.kind).toBe('detached')
  })

  it('F×J：阅读时尺寸变化按首行锚点补偿', () => {
    const step = last(anchoring, [{ type: 'resize' }])
    expect(step.state.kind).toBe('anchoring')
    expect(kinds(step.effects)).toEqual(['anchor'])
  })

  it('G×H：切换会话重置，固定轮按会话存', () => {
    const steps = play(settling, [{ type: 'begin-anchor', anchor: anchorA }, { type: 'open', key: 's2' }])
    expect(steps[0]?.state.kind).toBe('settling')
    expect(steps[1]?.state.kind).toBe('settling')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('G×I：固定轮插入上方 + 多次 reflow，视口不动', () => {
    const steps = play(detached, [
      { type: 'begin-anchor', anchor: anchorA },
      { type: 'content-grow' },
      { type: 'content-grow' },
      { type: 'end-anchor' },
    ])
    for (const step of steps) expect(kinds(step.effects)).not.toContain('write-bottom')
    expect(steps[3]?.state.kind).toBe('detached')
  })

  it('G×J：固定轮无重排，尺寸变化按锚点补偿', () => {
    const step = last(anchoring, [{ type: 'resize' }])
    expect(kinds(step.effects)).toEqual(['anchor'])
  })

  it('H×I：提交后由 A/I 顺序接管：先补底再稳定', () => {
    const steps = play(idle, [
      { type: 'open' },
      { type: 'content-grow' },
      { type: 'frame', heightChanged: false, atBottom: true },
      { type: 'frame', heightChanged: false, atBottom: true },
    ])
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
    expect(steps[3]?.state.kind).toBe('following')
  })

  it('H×J：切换时尺寸变化仍贴底（旧画面不留比例）', () => {
    const steps = play(idle, [{ type: 'open' }, { type: 'resize' }])
    expect(steps[1]?.state.kind).toBe('settling')
    expect(kinds(steps[1]?.effects ?? [])).toEqual(['write-bottom'])
  })

  it('I×J：内容增高按状态分派，尺寸变化也按状态分派', () => {
    const pinned = last(following, [{ type: 'content-grow' }])
    expect(pinned.effects).toEqual([{ type: 'write-bottom' }])
    const reading = last(detached, [{ type: 'content-grow' }])
    expect(reading.effects).toEqual([{ type: 'hold' }])
    const resized = last(detached, [{ type: 'resize' }])
    expect(resized.effects).toEqual([{ type: 'temp-anchor' }])
    const still = last(anchoring, [{ type: 'frame', heightChanged: false, atBottom: false }])
    expect(still.state.kind).toBe('anchoring')
  })
})
