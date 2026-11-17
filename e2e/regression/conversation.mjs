#!/usr/bin/env node
/**
 * 会话与消息（滚动、轮次大纲、上下文卡、用量、Markdown、文件引用、改动审阅、回退）。
 *
 * 用例由 e2e/regression.mjs 统一调度（同一临时 Host、同一组浏览器上下文）；
 * 夹具与页面助手见 ./lib/。用例顺序按拆分前的全局顺序排列。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import WebSocket from 'ws'
import { DESKTOP, HOST_ENTRY, MOBILE, ROOT, SMALL, listen, sleep } from './lib/common.mjs'
import { createMockProvider } from './lib/mock-provider.mjs'
import {
  api,
  auditA11y,
  assertNoOverflow,
  freeTcpPort,
  importSeededProfiles,
  seedData,
  seedEvals,
  seedPreviewApp,
  seedRepo,
  seedWiki,
  startHost,
  startWorkstation,
  waitAnimations,
  waitForValue,
  withinViewport,
  writeJson,
  wsInboxSnapshot,
  wsSessionSnapshot,
} from './lib/seeds.mjs'
import { runWorkstationCheck } from '../workstation-check.mjs'
import { killExecutorsUnder, runExecutorCheck } from '../executor-check.mjs'

export const feature = 'conversation'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 26, 51, 52, 53, 56, 57, 60, 61, 62, 63, 64, 65, 66, 67, 74, 75, 84, 85, 86, 87, 88, 89, 90, 93, 94, 95, 96, 97, 98, 100, 112, 113, 113.1, 113.2, 113.3, 113.4, 113.5, 113.6, 113.7, 113.8]

/**
 * 从下一帧起逐帧记录消息区状态（每帧一项，含还没挂上任何行的帧），
 * 用于「每一帧都在底部 / 画面不跳动」类断言。返回停止并取结果的函数。
 */
async function startScrollSampler(page, key) {
  await page.evaluate((name) => {
    const state = (window[name] = { on: true, frames: [] })
    const sample = (el) => {
      const box = el.getBoundingClientRect()
      const rows = [...el.querySelectorAll('.msg-row[data-message-id]')]
      const first = rows.find((row) => row.getBoundingClientRect().bottom > box.top + 1)
      return {
        rows: rows.length,
        skeleton: el.querySelectorAll('.skeleton').length,
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight,
        distance: el.scrollHeight - el.scrollTop - el.clientHeight,
        firstId: first?.getAttribute('data-message-id') ?? null,
        firstTop: first ? Math.round(first.getBoundingClientRect().top - box.top) : null,
      }
    }
    const loop = () => {
      if (!state.on) return
      const el = document.querySelector('.chat-scroll')
      if (el) state.frames.push(sample(el))
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, key)
  return async () => {
    const frames = await page.evaluate((name) => {
      const state = window[name]
      state.on = false
      return state.frames
    }, key)
    return frames
  }
}

export function register(checks, ctx) {
  const {
    desktop,
    mobile,
    small,
    fb2102,
    fbAdjust,
    fbAdjustMobile,
    newPage,
    openSession,
    gotoSession,
    withNonGitSession,
    openExternal,
    waitOnline,
    waitModelReady,
    openSettings,
    closeSettings,
    openWorkstationPanel,
    withViewport,
    setTheme,
    clientHostIdOf,
    fix1323Shots,
    shot1323,
    useLightTheme,
    shotDir,
    boardCall,
    waitUntil,
    openBoardPage,
    boardColumn,
    boardCardIn,
    home,
    wsHome,
    configDir,
    repo,
    shots,
    hostId,
    token,
    wsBase,
    provider,
    mockPort,
    previewApp,
    today,
    dayString,
    browser,
    base,
    appUrl,
    seeded,
    host,
  } = ctx

desktop('长会话打开贴在最新消息', async (page) => {
      await openSession(page, 'long')
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const root = document.querySelector('.chat-scroll')
        const last = document.querySelector('[data-turn-id="u40"]')
        const r = root.getBoundingClientRect()
        const lr = last.getBoundingClientRect()
        return {
          top: root.scrollTop,
          client: root.clientHeight,
          scroll: root.scrollHeight,
          lastTop: lr.top - r.top,
          lastBottom: lr.bottom - r.top,
        }
      })
      assert.ok(info.top + info.client >= info.scroll - 40, `距底部 ${Math.round(info.scroll - info.top - info.client)}px`)
      assert.ok(info.lastTop < info.client && info.lastBottom > 0, '最后一条用户消息不在视口内')
    })

desktop('大会话首屏只下发尾部消息', async (page) => {
      const tail = await wsSessionSnapshot(base, token, 'huge', 200)
      assert.equal(tail.msg.session.messages.length, 200, '尾部快照条数不是 200')
      assert.equal(tail.msg.session.totalMessages, 640, '尾部快照 totalMessages 不对')
      assert.equal(tail.msg.session.firstMessageId, 'hu221', '尾部快照首条 id 不对')
      assert.equal(tail.msg.truncated, true, '尾部快照未标记 truncated')
      assert.equal(tail.msg.session.hasEarlier, true, '尾部快照未标记还有更早消息')
      assert.ok(tail.bytes < 200 * 1024, `首屏下发 ${(tail.bytes / 1024).toFixed(0)}KB，超过 200KB`)

      // 旧客户端不带 tail：保持全量兼容。
      const full = await wsSessionSnapshot(base, token, 'huge')
      assert.equal(full.msg.session.messages.length, 640, '旧客户端未拿到全量快照')

      await openSession(page, 'huge')
      const band = page.locator('.msg-gap-band').first()
      await band.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await band.innerText(), /第 1–\d+ 轮未加载/, '首屏顶部没有未加载轮次的占位条')
      const loaded = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      assert.ok(loaded >= 150 && loaded <= 220, `首屏挂载了 ${loaded} 行，不是尾部 200 条消息`)
    })

desktop('大会话滚到顶加载更早消息且位置不跳', async (page) => {
      await openSession(page, 'huge')
      await page.locator('.msg-gap-band').first().waitFor({ state: 'visible', timeout: 10_000 })
      const before = await page.evaluate(() => {
        const box = document.querySelector('.chat-scroll')
        const boxTop = box.getBoundingClientRect().top
        box.scrollTop = 0
        const row = [...document.querySelectorAll('.msg-row[data-message-id]')].find(
          (el) => el.getBoundingClientRect().top >= boxTop - 2,
        )
        return {
          height: box.scrollHeight,
          top: box.scrollTop,
          id: row?.dataset.messageId,
          offset: row ? row.getBoundingClientRect().top - boxTop : null,
        }
      })
      assert.equal(before.id, 'hu221', `滚动到顶后首条不是 hu221（${before.id}）`)
      await page.waitForFunction(
        (height) => (document.querySelector('.chat-scroll')?.scrollHeight ?? 0) > height + 500,
        before.height,
        { timeout: 20_000 },
      )
      // content-visibility 会在后续帧继续修正行高；等锚点回到原位（最多 5s）再断言。
      await page
        .waitForFunction(
          ({ id, offset }) => {
            const box = document.querySelector('.chat-scroll')
            const row = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.closest('.msg-row')
            if (!box || !row) return false
            return Math.abs(row.getBoundingClientRect().top - box.getBoundingClientRect().top - offset) < 4
          },
          { id: before.id, offset: before.offset },
          { timeout: 5_000 },
        )
        .catch(() => {})
      await page.waitForTimeout(150)
      const after = await page.evaluate((id) => {
        const box = document.querySelector('.chat-scroll')
        const boxTop = box.getBoundingClientRect().top
        const row = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.closest('.msg-row')
        return {
          height: box.scrollHeight,
          top: box.scrollTop,
          offset: row ? row.getBoundingClientRect().top - boxTop : null,
        }
      }, before.id)
      assert.ok(after.top > 500, `加载更早消息后滚动位置跳回顶部：${after.top}`)
      assert.ok(
        after.offset !== null && Math.abs(after.offset - before.offset) < 4,
        `锚点消息位移 ${after.offset - before.offset}px`,
      )
      await page.waitForFunction(
        () => document.querySelectorAll('.msg-row[data-message-id]').length >= 300,
        null,
        { timeout: 20_000 },
      )
    })

desktop('轮次大纲跳到未加载的轮', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.msg-gap-band').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const box = document.querySelector('.chat-scroll')
        const row = document.querySelector('[data-turn-id="hu1"]')
        const gap = document.querySelector('[data-message-gap]')
        return {
          offset: row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top : null,
          client: box.clientHeight,
          gap: !!gap,
          count: document.querySelector('.turn-count')?.textContent ?? '',
          rows: document.querySelectorAll('.msg-row').length,
        }
      })
      assert.ok(info.offset !== null && info.offset >= -4 && info.offset < info.client, `第 1 轮位置 ${info.offset}`)
      assert.ok(info.gap, '跳转到更早的轮后没有缺口占位')
      assert.match(info.count, /第 1 \/ 320 轮/, '轮次大纲没有定位到第 1 轮')
      assert.ok(info.rows > 300, `按需加载后只渲染了 ${info.rows} 行`)
    })

desktop('轮次大纲滚轮只预览、点击未加载轮能定位（反馈10#01 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const read = () =>
        page.evaluate(() => ({
          top: document.querySelector('.chat-scroll')?.scrollTop ?? -1,
          value: document.querySelector('.turn-hit')?.getAttribute('aria-valuenow') ?? '',
          count: document.querySelector('.turn-count')?.textContent ?? '',
        }))
      const before = await read()
      const box = await page.locator('.turn-hit').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -100)
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(600)
      const afterWheel = await read()
      assert.equal(afterWheel.top, before.top, '滚轮滚动大纲时对话区被滚动了')
      assert.equal(afterWheel.value, before.value, '滚轮滚动大纲时当前轮被改变了')
      assert.equal(afterWheel.count, before.count, '滚轮滚动大纲时轮次胶囊被改变了')

      // 预览滚动到最早几轮后点其中一行：应先加载该段消息，再滚动定位（不加高亮）。
      for (let i = 0; i < 420; i++) await page.mouse.wheel(0, -100)
      await page.waitForTimeout(800)
      const row = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.turn-item')]
          .filter((el) => Number(el.dataset.turnPos) > 0 && Number(el.dataset.turnPos) <= 8)
          .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
        const el = items[0]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, pos: Number(el.dataset.turnPos) }
      })
      assert.ok(row, '滚轮后大纲里看不到最早几轮')
      await page.mouse.click(row.x, row.y)
      await page.locator(`[data-turn-id="hu${row.pos}"]`).waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        `hu${row.pos}`,
        { timeout: 5_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后消息仍被高亮')
      const jumped = await read()
      assert.match(jumped.count, new RegExp(`第 ${row.pos} / 320 轮`), '点击大纲后没有定位到目标轮')
      await page.screenshot({ path: '/tmp/fb10-after/01.png' })
    })

desktop('占位条标注未加载轮次并可分段加载（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      const band = page.locator('.msg-gap-band').first()
      await band.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await band.innerText(), /第 1–\d+ 轮未加载（\d+ 轮）/, '占位条没有轮次范围')
      const height = await band.evaluate((el) => el.getBoundingClientRect().height)
      assert.equal(Math.round(height), 40, `占位条高度 ${height}px，不是固定 40px`)
      assert.equal(await band.getAttribute('data-unmounted'), null, '未加载占位条被标成未显示')
      await band.getByRole('button', { name: '加载前 10 轮' }).click()
      await page.waitForFunction(
        () => !document.querySelector('[data-turn-id="hu1"]') === false,
        null,
        { timeout: 20_000 },
      )
      await page.waitForFunction(
        () => (document.querySelector('.msg-gap-band')?.textContent ?? '').includes('第 1–') === false,
        null,
        { timeout: 20_000 },
      )
      const firstId = await page.evaluate(
        () => document.querySelector('.msg-row[data-message-id]')?.dataset.messageId ?? '',
      )
      assert.equal(firstId, 'hu1', `加载前 10 轮后首条不是 hu1（${firstId}）`)
      await page.screenshot({ path: '/tmp/fb11-after/05-band.png' })
    })

desktop('固定轮次滚到底部仍挂载、中间占位条可加载（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page
        .locator('[data-turn-id="hu1"]')
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => page.keyboard.press('Home'))
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(600)
      const gap = page.locator('.msg-gap-band').first()
      await gap.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await gap.innerText(), /轮未加载/, '跳到早期轮后中间没有未加载占位条')
      const before = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      await gap.getByRole('button', { name: '全部' }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.msg-gap-band').length === 0,
        null,
        { timeout: 40_000 },
      )
      const after = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      assert.ok(after >= before, `加载全部后挂载行数反而减少：${before} → ${after}`)

      // 固定第 5 轮，再滚到底部：固定的轮必须仍在 DOM 里。
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 10_000 })
      await page
        .locator('[data-turn-id="hu5"]')
        .getByRole('button', { name: '固定此轮' })
        .click()
      await page.waitForFunction(
        () => !!document.querySelector('[data-turn-id="hu5"] [aria-label="取消固定此轮"]'),
        null,
        { timeout: 10_000 },
      )
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => {
          const box = document.querySelector('.chat-scroll')
          if (box) box.scrollTop = box.scrollHeight
        })
        await page.waitForTimeout(180)
      }
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '滚到底部后固定的第 5 轮被卸载了',
      )
      const mountedGap = page.locator('.msg-gap-band').first()
      await mountedGap.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await mountedGap.innerText(), /轮未显示/, '固定轮与当前窗口之间没有占位条')
      const height = await mountedGap.evaluate((el) => el.getBoundingClientRect().height)
      assert.equal(Math.round(height), 40, `占位条高度 ${height}px，不是固定 40px`)
      await mountedGap.getByRole('button', { name: '显示' }).click()
      await page.locator('[data-turn-id="hu6"]').waitFor({ state: 'attached', timeout: 10_000 })
      await page.screenshot({ path: '/tmp/fb11-after/05.png' })
    })

desktop('大纲标识未加载轮次并可点击跳转（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(600)
      const readUnloaded = () =>
        page.evaluate(() => {
          const hitRect = document.querySelector('.turn-hit')?.getBoundingClientRect()
          const items = [...document.querySelectorAll('.turn-item[data-unloaded="true"]')]
            .filter((el) => {
              if (Number(el.dataset.turnPos) <= 0 || !el.checkVisibility()) return false
              const style = getComputedStyle(el)
              if (Number(style.opacity) < 0.2 || style.visibility === 'hidden') return false
              const r = el.getBoundingClientRect()
              const y = r.y + r.height / 2
              if (!hitRect || y < hitRect.top + 18 || y > hitRect.bottom - 18) return false
              return r.width > 40
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
          const el = items[0]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            pos: Number(el.dataset.turnPos),
            tag: el.querySelector('.turn-item-c')?.textContent ?? '',
            title: el.getAttribute('title') ?? '',
            dashed: getComputedStyle(el.querySelector('.turn-item-k')).backgroundImage,
          }
        })
      let row = null
      for (let attempt = 0; attempt < 6 && !row; attempt++) {
        for (let i = 0; i < 140; i++) await page.mouse.wheel(0, -100)
        await page.waitForTimeout(600)
        row = await readUnloaded()
      }
      assert.ok(row, '大纲里看不到未加载轮次')
      assert.equal(row.tag.trim(), '未加载', `未加载轮的行尾标记是「${row.tag}」`)
      assert.match(row.title, /未加载/, '未加载轮的 tooltip 没有说明')
      assert.match(row.dashed, /repeating|gradient/, '未加载轮的刻度不是虚线')
      await page.mouse.click(row.x, row.y)
      await page.waitForTimeout(400)
      const target = Number(
        (await page.locator('.turn-count').innerText()).match(/第 (\d+) \/ 320 轮/)?.[1] ?? 0,
      )
      assert.ok(target > 0, '点击未加载轮后大纲没有更新当前轮')
      await page
        .locator(`[data-turn-id="hu${target}"]`)
        .waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        `hu${target}`,
        { timeout: 5_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转到未加载轮后消息仍被高亮')
      assert.ok(row, '点击未加载轮没有跳转到位')
      await page.screenshot({ path: '/tmp/fb11-after/05-rail.png' })
    })

desktop('跳转统一：会话图与轮次大纲调用同一个实现（反馈0220#03）', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      assert.ok(count >= 3, `会话图节点太少：${count}`)
      // 记下所有跳转派发：统一实现在每次跳转只派发一次并带递增 token，
      // 旧实现会在 12 秒内每 300ms 反复派发（会话图点击后滚轮抽搐的根因）。
      await page.evaluate(() => {
        window.__jumpLog = []
        window.addEventListener('tandem-jump-message', (event) => {
          window.__jumpLog.push(event.detail ?? {})
        })
      })
      const node = nodes.nth(Math.floor(count * 0.5))
      const turnId = await node.getAttribute('data-graph-turn-id')
      await node.click()
      await page.waitForTimeout(400)
      let log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 1, `会话图点击派发了 ${log.length} 次跳转事件`)
      assert.equal(log[0].messageId, turnId, '会话图跳转目标不对')
      assert.equal(typeof log[0].token, 'number', '会话图跳转没有走统一的跳转服务（缺少 token）')
      await page.waitForTimeout(900)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 1, `跳转后仍在反复派发事件（${log.length} 次），会不断把视口拉回去`)

      // 从轮次大纲点同一轮：也必须只派发一次，且 token 递增（同一个服务、后一次替换前一次）。
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      let row = null
      for (let step = 0; step < 60 && !row; step++) {
        if (step > 0) {
          await page.mouse.wheel(0, -100)
          await page.waitForTimeout(140)
        }
        row = await page.evaluate((id) => {
          const pin = document.querySelector(`.turn-item-p[data-turn="${CSS.escape(id)}"]`)
          const el = pin?.closest('.turn-item')
          if (!el || !el.checkVisibility() || Number(getComputedStyle(el).opacity) < 0.5) return null
          const r = el.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, pos: el.dataset.turnPos }
        }, turnId)
      }
      assert.ok(row, '大纲里找不到会话图点击的同一轮')
      await page.mouse.click(row.x, row.y)
      await page.waitForTimeout(500)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 2, `大纲点击派发了 ${log.length - 1} 次跳转事件`)
      assert.equal(log[1].messageId, turnId, '大纲与会话图点的不是同一条消息')
      assert.ok(log[1].token > log[0].token, '大纲跳转没有复用同一个跳转服务')
      await page.waitForTimeout(900)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 2, '大纲跳转后仍在反复派发事件')
      await page.screenshot({ path: '/tmp/jump-0220/reg-unified.png' })
    })

desktop('跳转有动画：点击后 scrollTop 在 ≥3 帧内逐步变化（反馈1110）', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      await page.evaluate(() => {
        window.__scroll = { on: true, samples: [] }
        const tick = () => {
          const box = document.querySelector('.chat-scroll')
          if (!window.__scroll.on) return
          window.__scroll.samples.push(box.scrollTop)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await nodes.nth(Math.max(0, Math.floor(count * 0.25))).click()
      await page.waitForTimeout(1400)
      const samples = await page.evaluate(() => {
        window.__scroll.on = false
        return window.__scroll.samples
      })
      const start = samples[0]
      const final = samples[samples.length - 1]
      assert.ok(Math.abs(final - start) > 200, `跳转没有产生位移：${start} → ${final}`)
      const steps = []
      for (let i = 1; i < samples.length; i++) {
        const delta = samples[i] - samples[i - 1]
        if (Math.abs(delta) >= 1) steps.push(delta)
      }
      assert.ok(steps.length >= 3, `跳转只有 ${steps.length} 帧在滚动，像是一次跳到位（没有动画）`)
      const total = Math.abs(final - start)
      const biggest = Math.max(...steps.map(Math.abs))
      assert.ok(biggest < total, `跳转在一帧内完成了全部 ${total}px 位移，没有动画`)
      // 动画中间帧截图（深/浅）：再点一次，在弹簧滑入途中取帧。
      const dir = '/tmp/fix-1110'
      mkdirSync(dir, { recursive: true })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await nodes.nth(Math.max(0, Math.floor(count * 0.7))).click()
      await page.waitForTimeout(90)
      await page.screenshot({ path: `${dir}/jump-anim-mid-dark.png` })
      await page.waitForTimeout(1400)
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await nodes.nth(Math.max(0, Math.floor(count * 0.15))).click()
      await page.waitForTimeout(90)
      await page.screenshot({ path: `${dir}/jump-anim-mid-light.png` })
      await page.screenshot({ path: '/tmp/jump-0220/reg-anim.png' })
    })

desktop('跳转动画结束后不再写 scrollTop、之后滚轮不被拉回（反馈0220#03 R68）', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      await page.evaluate(() => {
        window.__scroll = { on: true, samples: [] }
        const tick = () => {
          const box = document.querySelector('.chat-scroll')
          if (!window.__scroll.on) return
          window.__scroll.samples.push(box.scrollTop)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await nodes.nth(Math.floor(count * 0.6)).click()
      // 弹簧动画 + 落点复核应在 1.5s 内结束：之后 scrollTop 必须完全静止（不再轮询锁视图）。
      await page.waitForTimeout(1500)
      const settledAt = await page.evaluate(() => window.__scroll.samples.length)
      await page.waitForTimeout(700)
      const idle = await page.evaluate((from) => window.__scroll.samples.slice(from), settledAt)
      assert.ok(idle.length > 20, `静止期采样帧太少：${idle.length}`)
      const drift = Math.max(...idle) - Math.min(...idle)
      assert.ok(drift <= 1, `跳转动画结束后仍在写 scrollTop（${drift}px）`)
      // 之后用户滚轮不再被任何补正拉回。
      const box = await page.locator('.chat-scroll').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.evaluate(() => (window.__scroll.wheelAt = window.__scroll.samples.length))
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -160)
        await page.waitForTimeout(180)
      }
      await page.waitForTimeout(1200)
      const data = await page.evaluate(() => {
        window.__scroll.on = false
        return window.__scroll
      })
      const after = data.samples.slice(data.wheelAt ?? 0)
      assert.ok(after.length > 30, `滚轮期间采样帧太少：${after.length}`)
      assert.ok(Math.min(...after) < after[0] - 100, '滚轮上滚没有生效')
      let pulledBack = 0
      for (let i = 1; i < after.length; i++) if (after[i] > after[i - 1] + 3) pulledBack += 1
      assert.equal(pulledBack, 0, `用户滚轮后视口被拉回 ${pulledBack} 次（跳转的定时补正仍在执行）`)
      await page.screenshot({ path: '/tmp/jump-0220/reg-wheel.png' })
    })

desktop('大纲未加载轮标注、点击只取该片段（反馈0220#03 R40）', async (page) => {
      const asked = []
      page.on('request', (request) => {
        const url = request.url()
        if (url.includes('/api/sessions/huge/messages')) asked.push(url)
      })
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      let row = null
      for (let attempt = 0; attempt < 6 && !row; attempt++) {
        for (let i = 0; i < 140; i++) await page.mouse.wheel(0, -100)
        await page.waitForTimeout(500)
        row = await page.evaluate(() => {
          const hit = document.querySelector('.turn-hit')?.getBoundingClientRect()
          const el = [...document.querySelectorAll('.turn-item[data-unloaded="true"]')]
            .filter((item) => {
              if (Number(item.dataset.turnPos) < 2 || !item.checkVisibility()) return false
              const style = getComputedStyle(item)
              if (Number(style.opacity) < 0.2 || style.visibility === 'hidden') return false
              const r = item.getBoundingClientRect()
              const y = r.y + r.height / 2
              return !!hit && y > hit.top + 18 && y < hit.bottom - 18 && r.width > 40
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            pos: Number(el.dataset.turnPos),
            no: Number(el.dataset.turnNo),
            tag: el.querySelector('.turn-item-c')?.textContent?.trim() ?? '',
            dashed: getComputedStyle(el.querySelector('.turn-item-k')).backgroundImage,
          }
        })
      }
      assert.ok(row, '大纲里看不到未加载轮次')
      assert.equal(row.tag, '未加载', `未加载轮的标记是「${row.tag}」`)
      assert.match(row.dashed, /repeating|gradient/, '未加载轮的刻度不是虚线')
      const before = asked.length
      await page.mouse.click(row.x, row.y)
      await page.locator(`[data-turn-id="hu${row.no}"]`).waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.top >= -4 && rect.top < window.innerHeight - 120
        },
        `hu${row.no}`,
        { timeout: 5_000 },
      )
      const fetched = asked.slice(before)
      assert.equal(fetched.length, 1, `点击未加载轮请求了 ${fetched.length} 次片段（应只取该轮所在的一段）`)
      const url = fetched[0]
      assert.match(url, new RegExp(`around=hu${row.no}(&|$)`), `不是按该轮取片段：${url}`)
      assert.doesNotMatch(url, /before=/, '点击未加载轮却按翻页取了一整段历史')
      assert.match(
        await page.locator('.turn-count').innerText(),
        new RegExp(`第 ${row.no} / 320 轮`),
        '点击未加载轮后大纲没有定位到该轮',
      )
      await page.screenshot({ path: '/tmp/jump-0220/reg-unloaded-rail.png' })
    })

desktop('固定轮次初次打开、滚动、跳转后始终挂载（反馈0220#03 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 10_000 })
      // 行上的操作条是悬停才显示的浮层，用 DOM 点击避免被同一行的时间/用量浮层挡住。
      await page.evaluate(() => {
        const row = document.querySelector('[data-turn-id="hu5"]')
        row?.querySelector('button[aria-label="固定此轮"]')?.click()
      })
      await page.waitForFunction(
        () => !!document.querySelector('[data-turn-id="hu5"] [aria-label="取消固定此轮"]'),
        null,
        { timeout: 10_000 },
      )
      // 重新打开会话：首屏只有尾部消息，固定的第 5 轮不在其中，仍必须取回并挂载。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 20_000 },
      )
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 20_000 })
      // 滚到底部：固定轮不参与卸载。
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const box = document.querySelector('.chat-scroll')
          if (box) box.scrollTop = box.scrollHeight
        })
        await page.waitForTimeout(180)
      }
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '滚到底部后固定的第 5 轮被卸载了',
      )
      // 再跳到最后一轮：固定轮仍挂在 DOM 里。
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('End')
      await page.locator('[data-turn-id="hu320"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(400)
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '跳转后固定的第 5 轮不在了',
      )
      await page.screenshot({ path: '/tmp/jump-0220/reg-pinned.png' })
    })

desktop('轮次大纲悬停显示该轮用量、全文可读（#01 R15）', async (page) => {
      await openSession(page, 'long')
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const info = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.turn-item-t')]
        const visible = items.find((el) => (el.textContent ?? '').trim().length > 0)
        const row = visible?.parentElement
        return {
          text: (visible?.textContent ?? '').trim(),
          textTitle: visible?.getAttribute('title') ?? '',
          rowTitle: row?.getAttribute('title') ?? '',
          rowLabel: row?.getAttribute('aria-label') ?? '',
          readout: document.querySelector('[data-testid="turn-readout"]')?.textContent ?? '',
        }
      })
      assert.ok(info.text.length > 0, '大纲行没有真实文本节点')
      // 反馈6#01：悬停只显示该轮用量，不再重复大纲文字；全文保留在 aria-label 与 sr-only 列表。
      assert.equal(info.textTitle, '', '大纲文字仍在重复弹出全文提示')
      assert.match(info.rowTitle, /^输入 .+ · 输出 .+ · 缓存命中 \d+% · \$/, `大纲行没有用量 tooltip：${info.rowTitle}`)
      assert.match(info.rowTitle, /占本会话 \d+%/, `用量 tooltip 缺少占本会话比例：${info.rowTitle}`)
      assert.match(info.rowLabel, /^第 \d+ 轮：/, '大纲行缺少读屏 aria-label')
      assert.match(info.readout, /第 1 轮：/, '读屏列表没有轮次全文')
      // 反馈8#07：着色固定为上下文占用。
      // 标准 tooltip（ui/Tooltip 的 .ui-tip）在悬停行后显示用量。
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /输入 .+ · 输出 .+ · 缓存命中 \d+% · \$/, '悬停大纲行没有显示用量')
      assert.match(await tip.innerText(), /占本会话 \d+%/, '悬停用量没有占本会话比例')
      assert.doesNotMatch(await tip.innerText(), /第 \d+ 轮：/, '用量 tooltip 重复了大纲文字')
    })

desktop('外部会话预览：轮次大纲、用量 tooltip 与信息面板（反馈9#01 R37）', async (page) => {
      await openExternal(page, 'claude-code', 'reg-external')
      await page.locator('.turn-rail').waitFor({ state: 'attached', timeout: 10_000 })
      assert.equal(
        await page.locator('[data-testid="turn-readout"] li').count(),
        2,
        '外部会话大纲没有列出两轮',
      )
      const panel = page
        .locator('aside')
        .filter({ has: page.getByRole('heading', { name: '会话信息' }) })
        .last()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      // 复用正常会话的卡片：详情、用量、上下文、文件改动都来自原日志。
      const text = await panel.innerText()
      assert.match(text, /claude-sonnet-4-5-20250929/, '信息面板缺少模型')
      assert.match(text, /\/tmp\/reg-external-demo/, '信息面板缺少工作目录')
      assert.match(text, /轮数[\s\S]*2/, '信息面板缺少轮数')
      assert.equal(await panel.locator('[data-group="usage"]').count(), 1, '信息面板缺少用量卡')
      assert.match(text, /输入[\s\S]*缓存命中率/, '用量卡没有 token 明细')
      assert.equal(await panel.locator('[data-group="context"]').count(), 1, '信息面板缺少上下文卡')
      assert.equal(await panel.locator('[data-group="changes"]').count(), 1, '信息面板缺少文件改动卡')
      assert.match(text, /scripts\/test\.sh/, '文件改动没有列出原会话编辑过的文件')
      // 只读：没有输入框，保留「在 Tandem 中继续」。
      assert.equal(await page.locator('[aria-label="消息输入框"]').count(), 0, '外部会话不应可发送')
      assert.ok(await page.getByRole('button', { name: /在 Tandem 中继续/ }).count(), '缺少导入继续入口')

      // 大纲悬停：有 usage 就显示用量，没有价格时不编造「花费未知」。
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.turn-item')].filter(
          (el) => (el.querySelector('.turn-item-t')?.textContent ?? '').trim().length > 0,
        )
        const first = rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
        return {
          title: first?.getAttribute('title') ?? '',
          label: first?.getAttribute('aria-label') ?? '',
          pin: first?.querySelector('.turn-item-p')?.getAttribute('data-turn') ?? '',
        }
      })
      assert.match(info.title, /^输入 .+ · 输出 .+ · 缓存命中 \d+% · 占本会话 \d+%/, `外部大纲用量异常：${info.title}`)
      assert.doesNotMatch(info.title, /花费未知|\$/, '外部会话没有价格时不应显示花费')
      assert.match(info.label, /^第 \d+ 轮：/, '外部大纲缺少读屏全文')
      assert.equal(info.pin, '', '只读外部会话不应出现固定图钉')

      // 信息面板可关闭并从顶栏重新打开（与正常会话共用 panelOpen）。
      await panel.getByRole('button', { name: '关闭信息面板' }).click()
      await panel.waitFor({ state: 'hidden', timeout: 5_000 })
      await page.getByRole('button', { name: '切换信息面板' }).first().click()
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      // 拖宽手柄也复用同一实现。
      assert.ok(
        await page.getByRole('separator', { name: '调整会话信息面板宽度' }).count(),
        '外部会话信息面板缺少拖宽手柄',
      )
    })

desktop('反馈16#05：Codex 注入内容不作为用户轮（大纲/会话图）', async (page) => {
      const codexId = globalThis.__regCodexId
      assert.ok(codexId, '缺少 Codex 外部会话夹具')
      await openExternal(page, 'codex', codexId)

      // 大纲只列两轮真实用户发言；注入内容不算轮。
      assert.equal(
        await page.locator('[data-testid="turn-readout"] li').count(),
        2,
        'Codex 注入内容被当成用户轮次',
      )

      const panel = page
        .locator('aside')
        .filter({ has: page.getByRole('heading', { name: '会话信息' }) })
        .last()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })

      // 会话图也只画两轮主线。
      const graph = panel.locator('[data-group="graph"] [data-session-graph]')
      await graph.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await graph.locator('[data-graph-turn-id]').count(),
        2,
        '会话图把注入内容画成了用户轮',
      )
    })

desktop('轮次大纲固定按上下文占用着色，压缩轮最浅并标已压缩（#01 追加 / 反馈8#07）', async (page) => {
      await openSession(page, 'compact')
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(800)
      const readRows = () =>
        page.evaluate(() => {
          const rows = [...document.querySelectorAll('.turn-item')].filter(
            (el) => (el.querySelector('.turn-item-t')?.textContent ?? '').trim().length > 0,
          )
          return rows.map((el) => ({
            heat: el.dataset.heat ?? '',
            summary: el.dataset.summary === 'true',
            compressed: el.dataset.compressed === 'true',
            label: el.getAttribute('aria-label') ?? '',
            title: el.getAttribute('title') ?? '',
            badge: el.querySelector('.turn-item-c')?.textContent ?? '',
            number: el.querySelector('.turn-item-n')?.textContent ?? '',
            text: el.querySelector('.turn-item-t')?.textContent ?? '',
          }))
        })
      const rows = await readRows()
      const compressed = rows.filter((row) => row.compressed)
      const summary = rows.find((row) => row.summary)
      assert.equal(compressed.length, 2, `没有显示被压缩的轮次：${JSON.stringify(rows)}`)
      assert.ok(summary, '没有显示摘要行')
      assert.ok(
        new Set(rows.map((row) => row.heat)).size >= 2,
        `用量着色没有分档：${JSON.stringify(rows.map((row) => row.heat))}`,
      )
      // 反馈8#07：被压缩的轮占用为 0，固定显示为最浅档。
      assert.ok(
        compressed.every((row) => row.heat === '1'),
        `压缩轮不是最浅档：${JSON.stringify(compressed.map((row) => row.heat))}`,
      )
      assert.ok(compressed.every((row) => row.badge === '已压缩'), '压缩轮没有标记')
      assert.ok(compressed.every((row) => /已压缩到摘要/.test(row.title)), '压缩轮 tooltip 没有说明已压缩')
      assert.ok(rows.every((row) => /用量(低|较低|中|较高|高)/.test(row.label)), 'aria-label 缺少用量档位')
      assert.equal(summary?.number, '摘', '摘要行没有标记')
      assert.equal(summary?.text, '摘要', '摘要行文案不对')

      // 撤销压缩后：摘要与压缩行消失，恢复为真实轮次（走 WS 快照，不刷新页面）。
      await api(base, token, '/api/sessions/compact/compaction/cmp-notice/undo', {
        method: 'POST',
        body: '{}',
      })
      await page.waitForFunction(
        () => document.querySelectorAll('.turn-item[data-summary="true"]').length === 0,
        null,
        { timeout: 8_000 },
      )
      await page.waitForTimeout(400)
      const restored = await page.evaluate(() => ({
        summary: document.querySelectorAll('.turn-item[data-summary="true"]').length,
        compressed: document.querySelectorAll('.turn-item[data-compressed="true"]').length,
      }))
      assert.equal(restored.summary, 0, '撤销压缩后仍显示摘要行')
      assert.equal(restored.compressed, 0, '撤销压缩后仍显示已压缩轮次')
    })

desktop('压缩确认与上下文面板按真实用户轮次统计（R16）', async (page) => {
      await openSession(page, 'turns4')
      const meter = page
        .locator('button[aria-label^="上下文"], button[aria-label="暂无上下文数据"]')
        .first()
      await meter.waitFor({ timeout: 15_000 })
      await meter.click()
      await page.getByText('4 轮对话', { exact: true }).first().waitFor({ timeout: 5_000 })
      await page.getByRole('button', { name: '压缩上下文（/compact）' }).click()
      const dialog = page.getByRole('dialog', { name: '压缩上下文' })
      await dialog.waitFor()
      const text = await dialog.innerText()
      assert.match(text, /当前会话的 4 轮对话/, `压缩确认轮次不对：${text}`)
      assert.equal(/当前会话的 [5-9] 轮对话|当前会话的 \d{2,} 轮对话/.test(text), false, '工具结果被算成了用户轮次')
      await dialog.getByRole('button', { name: '取消' }).click()
    })

desktop('上下文卡：鲜明分类色、自定义 agents、缓存条与阈值刻度（反馈13#05）', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const group = page.locator('[data-group="context"]').first()
      await group.waitFor({ state: 'visible', timeout: 15_000 })
      const card = group.locator('[data-context-card]').first()
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      const legend = card.locator('[data-context-legend="true"]')
      const legendText = await legend.innerText()
      const cardText = await card.innerText()
      const order = ['系统提示', '工具定义', 'MCP 工具', '自定义 agents', '记忆文件', '对话', '工具结果', '剩余']
      const positions = order.map((label) => legendText.indexOf(label))
      assert.ok(
        positions.every((position) => position >= 0),
        `上下文卡缺少分类：${order.filter((_, index) => positions[index] < 0).join('、')}`,
      )
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions,
        `上下文分类顺序不对：${order.map((label, index) => `${label}@${positions[index]}`).join(' ')}`,
      )
      assert.doesNotMatch(cardText, /缓存命中率/, '上下文卡重复显示了缓存命中率（反馈16#04）')
      assert.match(cardText, /自动压缩：达到 \d+% 时触发|自动压缩已关闭/, '上下文卡缺少自动压缩说明')

      // 分类色必须鲜明且彼此区分（不能退回一组灰调）。
      const colors = await card.evaluate((el) =>
        [...el.querySelectorAll('.grid span[aria-hidden="true"]')].map(
          (dot) => getComputedStyle(dot).backgroundColor,
        ),
      )
      assert.ok(new Set(colors).size >= 7, `上下文分类色区分不足：${colors.join(' / ')}`)
      assert.equal(
        colors.some((color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent'),
        false,
        `上下文分类色存在透明项：${colors.join(' / ')}`,
      )

      // 85% 阈值刻度画在分段条上。
      const threshold = card.locator('[data-context-threshold="true"]')
      assert.equal(await threshold.count(), 1, '分段条缺少自动压缩阈值刻度')
      assert.match(await threshold.evaluate((el) => el.style.left), /\d+(\.\d+)?%/, '阈值刻度位置没有按百分比设置')

      // 反馈2156#04：上下文卡片不再有「最占空间」轮次列表。
      assert.doesNotMatch(cardText, /最占空间/, '上下文卡仍在显示最占空间')
      assert.equal(await card.locator('[data-context-turn="true"]').count(), 0, '上下文卡仍有最占空间轮次行')
    })

desktop('警告与状态色饱和、对比度达标（反馈13#03）', async (page) => {
      await openSession(page, 'long')
      const result = await page.evaluate(() => {
        const parse = (value) => {
          const raw = value.trim()
          const rgb = raw.match(/rgba?\(([^)]+)\)/)
          if (rgb) return rgb[1].split(',').slice(0, 3).map((n) => Number(n.trim()) / 255)
          const hex = raw.match(/^#([0-9a-f]{6})$/i)
          if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255)
          return null
        }
        const lum = (rgb) => {
          const c = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        }
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
          return (x + 0.05) / (y + 0.05)
        }
        const root = document.documentElement
        const read = (theme) => {
          const dark = theme === 'dark'
          root.classList.toggle('dark', dark)
          const style = getComputedStyle(root)
          const bg = parse(style.getPropertyValue('--t-surface'))
          const data = ['--t-status-warn', '--t-status-online', '--t-status-error'].map((name) => {
            const value = style.getPropertyValue(name)
            return { name, value: value.trim(), contrast: Number(ratio(parse(value), bg).toFixed(2)) }
          })
          data.push({
            name: '--t-warning-soft',
            value: style.getPropertyValue('--t-warning-soft').trim(),
            contrast: 0,
          })
          return data
        }
        const previous = root.classList.contains('dark') ? 'dark' : 'light'
        const themes = { light: read('light'), dark: read('dark') }
        root.classList.toggle('dark', previous === 'dark')
        return themes
      })
      for (const [theme, tokens] of Object.entries(result)) {
        for (const token of tokens) {
          if (token.name === '--t-warning-soft') {
            assert.match(
              token.value,
              /^(?:rgba?\(|#[0-9a-f]{8}$)/i,
              `${theme} 主题的 --t-warning-soft 不是可见色底：${token.value}`,
            )
            continue
          }
          assert.ok(token.contrast >= 4.5, `${theme} 主题 ${token.name}=${token.value} 对比度只有 ${token.contrast}`)
        }
      }
    })

desktop('反馈0220#05：一轮内只有最后一条回复保留操作行', async (page) => {
      const outDir = '/tmp/fix-0220c/regression'
      mkdirSync(outDir, { recursive: true })
      await openSession(page, 'trail')
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.locator('[data-message-id="tr6"]').waitFor({ timeout: 15_000 })
      const info = await page.evaluate(() => {
        const read = (id) => {
          const row = document.querySelector(`[data-message-id="${id}"]`)
          const group = row?.querySelector('.msg-group')
          const content = group ? [...group.children].filter((el) => !el.matches('[data-msg-meta], .msg-more')) : []
          const last = content.at(-1)
          return {
            meta: !!row?.querySelector('[data-msg-meta]'),
            more: !!row?.querySelector('.msg-more'),
            gap: group && last ? Math.round(group.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : -1,
          }
        }
        return { tr2: read('tr2'), tr4: read('tr4'), tr6: read('tr6') }
      })
      assert.equal(info.tr2.meta, false, '第一段不应有操作行')
      assert.equal(info.tr2.more, false, '第一段不应有操作行')
      assert.ok(info.tr2.gap < 12, `第一段下方仍留了操作行空白：${JSON.stringify(info.tr2)}`)
      assert.equal(info.tr4.meta, false, '第二段不应有操作行')
      assert.equal(info.tr4.more, false, '第二段不应有操作行')
      assert.ok(info.tr4.gap < 12, `第二段下方仍留了操作行空白：${JSON.stringify(info.tr4)}`)
      assert.equal(info.tr6.meta, true, '最后一段缺少时间/用量行')
      assert.ok(info.tr6.gap >= 24, `最后一段下方没有保留操作行空间：${info.tr6.gap}px`)
      await page.locator('[data-message-id="tr6"] .msg-group').hover()
      await page.waitForTimeout(300)
      const actions = await page
        .locator('[data-message-id="tr6"] [data-msg-meta]')
        .evaluate((el) => getComputedStyle(el).opacity)
      assert.equal(actions, '1', '最后一段悬停后没有显示操作行')
      await page.screenshot({ path: path.join(outDir, 'turn-meta-only-last.png') })
    })

desktop('轮次条点击第 30 轮精准定位（不跳到相邻轮）', async (page) => {
      await openSession(page, 'long')
      const nav = page.locator('nav[aria-label="轮次导航"]')
      await nav.waitFor({ state: 'attached' })
      const hit = page.locator('.turn-hit')
      const hb = await hit.boundingBox()
      assert.ok(hb, '轮次条命中区不存在')
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.waitForTimeout(500)
      assert.equal(await nav.getAttribute('data-open'), 'true', '悬停后大纲未展开')
      const target = await page.evaluate(() => {
        const clip = document.querySelector('.turn-clip').getBoundingClientRect()
        for (const item of document.querySelectorAll('.turn-item')) {
          if ((item.querySelector('.turn-item-n')?.textContent ?? '') !== '30') continue
          const r = item.getBoundingClientRect()
          if (r.top < clip.top - 1 || r.bottom > clip.bottom + 1) continue
          if (Number(getComputedStyle(item).opacity) < 0.5) continue
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        return null
      })
      assert.ok(target, '展开后的面板中找不到第 30 轮行')
      await page.mouse.move(target.x, target.y)
      await page.waitForTimeout(80)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(900)
      assert.equal(await hit.getAttribute('aria-valuenow'), '30', '点击后落点不是第 30 轮')
      const position = await page.evaluate(() => {
        const root = document.querySelector('.chat-scroll')
        const el = root.querySelector('[data-turn-id="u30"]')
        if (!el) return null
        return el.getBoundingClientRect().top - root.getBoundingClientRect().top
      })
      assert.ok(position !== null, '找不到第 30 轮消息')
      assert.ok(position >= -4 && position <= 120, `第 30 轮未定位到视口顶部（${Math.round(position)}px）`)
      assert.match(await nav.innerText(), /第\s*30\s*\/\s*40\s*轮/, '计数胶囊与落点不一致')
    })

desktop('反馈16#02：宽表格与长代码行限制在正文宽度内、块内部横向滚动', async (page) => {
      await openSession(page, 'wide')
      const paraWidth = await page.evaluate(
        () => document.querySelector('[data-message-id="w2"] .chat-md p')?.getBoundingClientRect().width ?? 0,
      )
      assert.ok(paraWidth > 200, `找不到正文段落宽度：${paraWidth}`)
      const table = page.locator('[data-message-id="w2"] .md-table-wrap').first()
      await table.waitFor({ timeout: 10_000 })
      const tableBox = await table.boundingBox()
      assert.ok(tableBox, '找不到宽表格')
      assert.ok(
        tableBox.width <= paraWidth + 2,
        `表格超出正文阅读宽度：${Math.round(tableBox.width)}px > ${Math.round(paraWidth)}px`,
      )
      const scroll = table.locator('.md-table-scroll')
      const metrics = await scroll.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      assert.ok(metrics.scrollWidth > metrics.clientWidth, '宽表格没有在块内部横向滚动')
      await table.locator('.x-scroll-more[data-visible="true"]').waitFor({ timeout: 5_000 })

      const code = page.locator('[data-message-id="w2"] .chat-code').first()
      await code.waitFor({ timeout: 10_000 })
      const codeBox = await code.boundingBox()
      assert.ok(codeBox, '找不到代码块')
      assert.ok(
        codeBox.width <= paraWidth + 2,
        `代码块超出正文阅读宽度：${Math.round(codeBox.width)}px > ${Math.round(paraWidth)}px`,
      )
      const pre = code.locator('pre')
      const before = await pre.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: getComputedStyle(el).whiteSpace,
      }))
      assert.notEqual(before.whiteSpace, 'pre-wrap', '代码块默认不应自动换行')
      assert.ok(before.scrollWidth > before.clientWidth, '长代码行没有在块内部横向滚动')

      await code.hover()
      await code.getByTestId('code-wrap-toggle').click()
      const after = await pre.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: getComputedStyle(el).whiteSpace,
      }))
      assert.equal(after.whiteSpace, 'pre-wrap', '打开自动换行后仍不换行')
      assert.ok(after.scrollWidth <= after.clientWidth + 1, '自动换行后仍横向溢出')
      // 还原全局换行偏好，避免影响后续用例（代码块换行是跨会话记忆的）。
      await code.getByTestId('code-wrap-toggle').click()
    })

desktop('反馈16#02：代码块有文字且落在可见区域、表格不缺列（真实会话夹具）', async (page) => {
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))
      await openSession(page, 'codeblock')
      const row = page.locator('[data-message-id="r16a2"]')
      await row.waitFor({ timeout: 15_000 })
      const paraWidth = await row
        .locator('.chat-md p')
        .first()
        .evaluate((el) => el.getBoundingClientRect().width)
      assert.ok(paraWidth > 300, `正文段落宽度异常：${paraWidth}`)

      const codes = row.locator('.chat-code')
      const codeCount = await codes.count()
      assert.ok(codeCount >= 3, `真实会话夹具里的代码块太少：${codeCount}`)
      for (let i = 0; i < codeCount; i += 1) {
        const info = await codes.nth(i).evaluate((el) => {
          const box = el.getBoundingClientRect()
          const pre = el.querySelector('pre')
          const preBox = pre.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(pre)
          const rects = [...range.getClientRects()].filter((r) => r.width > 0)
          return {
            width: box.width,
            left: box.left,
            textLength: (pre.textContent ?? '').trim().length,
            scrollHeight: pre.scrollHeight,
            color: getComputedStyle(pre).color,
            bg: getComputedStyle(el).backgroundColor,
            firstTextLeft: rects.length ? Math.min(...rects.map((r) => r.left)) : null,
            hasRectInBox: rects.some(
              (r) => r.right > preBox.left + 2 && r.left < preBox.right - 2 && r.height > 0,
            ),
          }
        })
        assert.ok(info.textLength > 0, `代码块 ${i} 没有任何文字（空白块）`)
        assert.ok(info.scrollHeight > 0, `代码块 ${i} 高度为 0`)
        assert.ok(info.hasRectInBox, `代码块 ${i} 的文字不在可见区域里`)
        assert.ok(
          info.firstTextLeft !== null && info.firstTextLeft >= info.left + 4,
          `代码块 ${i} 的文字从块外开始：${info.firstTextLeft} < ${info.left}`,
        )
        assert.ok(
          info.width <= paraWidth + 2,
          `代码块 ${i} 超出正文宽度：${Math.round(info.width)} > ${Math.round(paraWidth)}`,
        )
        assert.notEqual(info.color, info.bg, `代码块 ${i} 文字颜色与背景相同`)
      }
      // 长 PowerShell 行（真实会话里被裁成半截的那种）：在块内部横向滚动。
      const longCode = page.locator('.chat-code').filter({ hasText: 'sdkmanager.bat' }).first()
      const longMetrics = await longCode.locator('pre').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      assert.ok(longMetrics.scrollWidth > longMetrics.clientWidth, '长 PowerShell 行没有块内横向滚动')

      const tables = row.locator('.md-table-wrap')
      const tableCount = await tables.count()
      assert.ok(tableCount >= 1, '真实会话夹具缺少表格')
      for (let i = 0; i < tableCount; i += 1) {
        const info = await tables.nth(i).evaluate((el) => {
          const box = el.getBoundingClientRect()
          const cells = [...el.querySelectorAll('th,td')].map((cell) => {
            const rect = cell.getBoundingClientRect()
            return {
              text: (cell.textContent ?? '').trim(),
              left: rect.left,
              width: rect.width,
            }
          })
          return { width: box.width, left: box.left, cells }
        })
        assert.ok(info.width <= paraWidth + 2, `表格 ${i} 超出正文宽度：${Math.round(info.width)}`)
        assert.ok(info.cells.length > 0, `表格 ${i} 没有单元格`)
        for (const cell of info.cells) {
          assert.ok(cell.text.length > 0, `表格 ${i} 有空单元格（缺列）`)
          assert.ok(cell.width > 0, `表格 ${i} 有宽度为 0 的单元格`)
          assert.ok(
            cell.left >= Math.max(info.left, 0) - 1,
            `表格 ${i} 的单元格被推到表格左侧之外：${cell.left} < ${info.left}`,
          )
        }
      }

      // 存档整页与消息列截图，便于对照反馈里的元素截图。
      mkdirSync('/tmp/fb16-after', { recursive: true })
      await page.screenshot({ path: '/tmp/fb16-after/regression-codeblock.png' })
      await row.screenshot({ path: '/tmp/fb16-after/regression-codeblock-row.png' })
    })

desktop('反馈1919#07：流式输出时在底部自动跟随，上滚后停止，回到底部后恢复', async (page) => {
      await openSession(page, 'scroll')
      const scroller = page.locator('.chat-scroll').filter({ has: page.locator('.msg-row') }).first()
      const distance = () =>
        scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
      const streaming = () => page.locator('.md.chat-md.is-streaming').count()
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 10_000 },
      )
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SCROLL_E2E 请长篇回答')
      await input.press('Enter')
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      // 在底部时：流式增长过程中始终贴底（距底部小于 PIN_THRESHOLD=80，即仍算贴底）。
      const following = []
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(400)
        following.push(await distance())
      }
      assert.ok(
        following.every((d) => d < 80),
        `在底部时流式输出没有跟随，距底部像素：${following.join(', ')}`,
      )
      // 用户滚轮上滚：停止跟随，内容继续增长也不能把视口拉回底部。
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(300)
      assert.ok((await streaming()) > 0, '上滚时流式输出已经结束，无法验证不跟随')
      const scrolledUp = await distance()
      assert.ok(scrolledUp > 120, `滚轮上滚后距底部只有 ${scrolledUp}px，视口被拉回底部`)
      await page.waitForTimeout(800)
      assert.ok(
        (await distance()) > 120,
        `上滚后流式输出仍在把视口拉回底部：${scrolledUp}px → ${await distance()}px`,
      )
      // 点「回到底部」：恢复跟随，之后的增长继续贴底。
      await page.locator('.chat-jump').click()
      await page.waitForTimeout(700)
      assert.ok((await streaming()) > 0, '回到底部时流式输出已经结束，无法验证恢复跟随')
      const resumed = []
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(400)
        resumed.push(await distance())
      }
      assert.ok(
        resumed.every((d) => d < 80),
        `回到底部后没有恢复跟随，距底部像素：${resumed.join(', ')}`,
      )
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ state: 'detached', timeout: 20_000 })
      assert.ok((await distance()) < 80, '流式结束后没有停在底部')
    })

fb2102('反馈2102#01：切换会话时主区不闪：旧会话画面保留到新会话就绪，不出现空白或骨架屏', async (page) => {
      await openSession(page, 'scroll')
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 10_000 })
      await page.evaluate(() => {
        const state = (window.__fb01 = { on: true, gaps: 0, samples: 0, skeleton: 0, empty: 0 })
        const scroller = () => document.querySelector('.chat-scroll')
        const inspect = () => {
          const el = scroller()
          if (!el) return
          state.samples += 1
          const rows = el.querySelectorAll('.msg-row').length
          const skeleton = !!el.querySelector('.skeleton')
          if (skeleton) state.skeleton += 1
          if (rows === 0 || skeleton) state.gaps += 1
        }
        state.observer = new MutationObserver(inspect)
        state.observer.observe(document.querySelector('main'), { childList: true, subtree: true })
        const sample = () => {
          if (!state.on) return
          inspect()
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const slow = page.locator('[data-session-row]').filter({ hasText: '慢速运行会话' }).first()
      await slow.waitFor({ timeout: 10_000 })
      await slow.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/slow'), null, { timeout: 10_000 })
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      const state = await page.evaluate(() => {
        window.__fb01.on = false
        window.__fb01.observer.disconnect()
        return { gaps: window.__fb01.gaps, samples: window.__fb01.samples, skeleton: window.__fb01.skeleton }
      })
      assert.ok(state.samples > 0, '切换期间没有采样到主区')
      await page.screenshot({ path: '/tmp/fix-2102a/after-01.png' })
      assert.equal(
        state.gaps,
        0,
        `切换会话时主区出现 ${state.gaps} 次空白或骨架屏（骨架屏 ${state.skeleton} 次）`,
      )
    })

desktop('反馈1601#02：来回切换会话，消息区与右栏从新会话首帧起保持同一画面（R10 复发）', async (page) => {
      // 先各打开一次，让右栏的上下文/用量分组数据在测量前就绪。
      await openSession(page, 'huge')
      await page.waitForTimeout(600)
      await openSession(page, 'codeblock')
      await page.waitForTimeout(600)
      await page.evaluate(() => {
        const state = (window.__fb1601 = { on: true, frames: [] })
        const record = () => {
          const s = window.__fb1601
          if (!s.on) return
          const scroll = document.querySelector('.chat-scroll')
          const panelBody = document.querySelector('[data-panel-body]')
          const box = scroll.getBoundingClientRect()
          const rows = [...scroll.querySelectorAll('.msg-row')]
          const first = rows.find(
            (row) =>
              row.getAttribute('data-message-id') &&
              row.getBoundingClientRect().bottom > box.top + 1,
          )
          // 其他用例可能给会话追加过消息，按整个列表里任一已知夹具 id 归属会话。
          const ids = rows.map((row) => row.getAttribute('data-message-id') ?? '')
          const knows = (re) => ids.some((id) => re.test(id))
          s.frames.push({
            session: knows(/^h[ua]\d+/)
              ? 'huge'
              : knows(/^r16/)
                ? 'codeblock'
                : knows(/^sc\d/)
                  ? 'scroll'
                  : '',
            top: scroll.scrollTop,
            height: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
            rows: rows.length,
            skeleton: scroll.querySelectorAll('.skeleton').length,
            rowTop: first ? Math.round(first.getBoundingClientRect().top - box.top) : null,
            groups: panelBody
              ? [...panelBody.querySelectorAll('[data-group]')]
                  .map((g) => g.getAttribute('data-group'))
                  .join(',')
              : '',
            panelSkeleton: panelBody ? panelBody.querySelectorAll('.skeleton').length : 0,
            graphNodes: panelBody ? panelBody.querySelectorAll('[data-graph-turn-id]').length : 0,
            hasGraph: panelBody ? panelBody.textContent.includes('会话图') : false,
          })
          requestAnimationFrame(loop)
        }
        // 在绘制之后采样（rAF → 宏任务），看到的是这一帧真正画出来的画面。
        const loop = () => requestAnimationFrame(() => setTimeout(record, 0))
        loop()
      })
      const clickSession = async (title, sessionId, messagePrefix) => {
        const row = page.locator('[data-session-row]').filter({ hasText: title }).first()
        await row.waitFor({ timeout: 15_000 })
        await row.locator('[data-session-open], button').first().click()
        await page.waitForFunction(
          (id) => window.location.hash.includes(`/s/${id}`),
          sessionId,
          { timeout: 10_000 },
        )
        // 等目标会话的内容真正挂载（首屏快照异步到达），再看它之后的帧。
        await page
          .locator(`.msg-row[data-message-id^="${messagePrefix}"]`)
          .first()
          .waitFor({ timeout: 15_000 })
        await page.waitForTimeout(500)
      }
      await clickSession('超大会话 · 320 轮', 'huge', 'hu')
      await clickSession('代码块与表格会话', 'codeblock', 'r16u')
      // 首次打开的会话：目标视图还没有任何缓存，同样不能闪。
      await clickSession('流式跟随会话', 'scroll', 'sc0')
      const frames = await page.evaluate(() => {
        window.__fb1601.on = false
        return window.__fb1601.frames
      })
      if (process.env.FB1601_DEBUG) writeFileSync('/tmp/fix-1601a/frames-1601.json', JSON.stringify(frames, null, 1))
      assert.ok(frames.length > 30, `切换期间采样帧太少：${frames.length}`)
      // 任何一帧都不能把主区清空、显示骨架，或让右栏出现骨架。
      const blank = frames.filter((f) => f.rows === 0 || f.skeleton > 0 || f.panelSkeleton > 0)
      assert.equal(blank.length, 0, `切换会话时有 ${blank.length} 帧主区/右栏空白或骨架屏`)
      // 贴底：每一帧都应停在底部（切换后重新校准也不能先停在别处）。
      const notBottom = frames.filter(
        (f) => f.rows > 0 && f.height - f.top - f.clientHeight > 2,
      )
      assert.equal(notBottom.length, 0, `切换会话时有 ${notBottom.length} 帧不在底部（画面会跳动）`)
      // 同一会话显示期间，可见首行相对视口的位置必须保持不变：注入说明、代码块等
      // 后到的内容不能让画面先下移再回弹。
      const perSession = new Map()
      for (const f of frames) {
        if (!f.session || f.rowTop === null) continue
        const entry =
          perSession.get(f.session) ??
          { tops: new Set(), groups: new Set(), graphs: new Set(), groupSequence: [] }
        entry.tops.add(f.rowTop)
        entry.groups.add(f.groups)
        entry.graphs.add(f.graphNodes)
        if (entry.groupSequence.at(-1) !== f.groups) entry.groupSequence.push(f.groups)
        perSession.set(f.session, entry)
      }
      for (const session of ['huge', 'codeblock', 'scroll']) {
        assert.ok(perSession.has(session), `没有采样到会话 ${session} 的画面（采样到 ${[...perSession.keys()].join('/') || '无'}，共 ${frames.length} 帧）`)
        const entry = perSession.get(session)
        const tops = [...entry.tops]
        const spread = Math.max(...tops) - Math.min(...tops)
        assert.ok(
          spread <= 2,
          `会话 ${session} 切换后画面上下跳动 ${spread}px（可见首行位置 ${tops.join('/')}）`,
        )
        // 会话树拓扑是一次轻量请求（/api/sessions/:id/graph）：首帧可能还没到，
        // 但到达后节点数必须稳定（不能一次显示一部分、再来一部分）。
        const counts = [...entry.graphs].filter((count) => count > 0)
        assert.ok(counts.length > 0, `会话 ${session} 的会话图卡片没有节点`)
        assert.equal(
          new Set(counts).size,
          1,
          `会话 ${session} 显示期间会话图节点数在变化：${[...entry.graphs].join('/')}`,
        )
        if (session === 'scroll') {
          // 首次打开的会话，上下文数据要多拉一次：只允许卡片晚出现一次，不能再消失。
          const sequence = [...entry.groupSequence]
          const last = new Set(sequence.at(-1)?.split(',') ?? [])
          for (const groups of sequence) {
            for (const id of groups.split(',')) {
              assert.ok(last.has(id), `会话 ${session} 显示期间右栏卡片 ${id} 出现后又消失了`)
            }
          }
        } else {
          assert.equal(
            entry.groups.size,
            1,
            `会话 ${session} 显示期间右栏卡片在跳动：${[...entry.groups].join(' | ')}`,
          )
        }
      }
      assert.ok(frames.every((f) => !f.session || f.hasGraph), '切换期间右栏缺少会话图卡片')
    })

desktop('反馈16#10：等首个 token / 工具运行时显示 spinner 与已运行时长', async (page) => {
      await openSession(page, 'slow')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 跑一个慢步骤')
      await input.press('Enter')
      // 首个 token 前：消息流末尾有「正在思考…」+ spinner。
      const activity = page.locator('[data-turn-activity]')
      await activity.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForFunction(
        () => (document.querySelector('[data-turn-activity]')?.textContent ?? '').includes('正在思考…'),
        null,
        { timeout: 5_000 },
      )
      // 首个 token 到达后：正文出现流式光标，活动行让位给流式输出。
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      await activity.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
      // 工具执行中：工具行转圈 + 已运行时长，消息流末尾显示「正在运行 Bash…」。
      const elapsed = page.locator('[data-tool-elapsed]').first()
      await elapsed.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await elapsed.innerText(), /已运行 \d+s/, '工具运行中没有显示已运行时长')
      const toolRow = page.locator('.tool-row').filter({ hasText: '运行' }).first()
      assert.ok(
        await toolRow.locator('svg.lucide-loader-circle, svg.lucide-loader-2').count(),
        '工具运行中没有转圈动画',
      )
      await activity.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await activity.innerText(), /正在运行 Bash…/, '工具运行时没有「正在运行 Bash…」提示')
      // 回合结束后：活动行消失，工具行变成完成态（没有已运行时长）。
      await activity.waitFor({ state: 'detached', timeout: 20_000 })
      await page.locator('[data-tool-elapsed]').first().waitFor({ state: 'detached', timeout: 10_000 })
      assert.equal(await page.locator('[data-turn-activity]').count(), 0, '回合结束后活动行仍在')
      await page.screenshot({ path: '/tmp/fb16-after/regression-activity.png' }).catch(() => {})
    })

desktop('反馈16#11：排队消息被读取后按原位置出现在对话流里', async (page) => {
      await openSession(page, 'slow2')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 先跑一轮')
      await input.press('Enter')
      // 等工具开始运行（这时再排队，旧实现会被随后的 tool_result 消息误删）。
      await page.locator('[data-tool-elapsed]').first().waitFor({ state: 'visible', timeout: 20_000 })
      await input.fill('排队中的第二条')
      await input.press('Enter')
      const queued = page.locator('.msg-row').filter({ hasText: '排队中的第二条' })
      await queued.first().waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await queued.first().innerText(), /已排队/, '排队消息没有排队提示')
      // 工具返回（user 角色的 tool_result 消息）后，排队气泡不能被删掉。
      await page.waitForTimeout(1200)
      assert.equal(await queued.count(), 1, '工具返回后排队消息从对话流里消失了')
      // 队列被 agent 读取后：作为普通用户消息留在流里，位置在下一条 assistant 回复之前。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.msg-row')].filter((row) =>
            row.textContent?.includes('排队中的第二条'),
          ).length === 1 &&
          ![...document.querySelectorAll('.msg-row')].some((row) =>
            row.textContent?.includes('已排队，当前回合结束后发送'),
          ),
        null,
        { timeout: 40_000 },
      )
      // 等这一轮（被读取的排队消息）也拿到回复，再检查位置。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.msg-row')].filter((row) =>
            row.textContent?.includes('慢速回复开始'),
          ).length >= 2,
        null,
        { timeout: 40_000 },
      )
      const rows = await page.locator('.msg-row').evaluateAll((els) =>
        els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
      )
      const queuedIndex = rows.findIndex((text) => text.includes('排队中的第二条'))
      assert.ok(queuedIndex >= 0, '排队消息被读取后没有出现在对话流里')
      assert.equal(
        rows.filter((text) => text.includes('排队中的第二条')).length,
        1,
        '排队消息被读取后出现了重复',
      )
      assert.ok(
        rows.slice(queuedIndex + 1).some((text) => text.includes('慢速回复开始')),
        '排队消息没有被放到本轮用户消息的正确位置',
      )
      const saved = await api(base, token, '/api/sessions/slow2')
      assert.ok(
        saved.messages.some((m) =>
          m.content?.some((block) => block.type === 'text' && block.text.includes('排队中的第二条')),
        ),
        '排队消息没有被持久化到会话里',
      )
    })

desktop('反馈16#01：用量行默认隐藏、悬停显示、左缘一致、时间用相对格式', async (page) => {
      await openSession(page, 'codeblock')
      await page.locator('[data-message-id="r16a3"]').waitFor({ timeout: 15_000 })
      const metas = await page.evaluate(() =>
        [...document.querySelectorAll('.msg-row [data-usage-summary]')].map((el) => ({
          left: Math.round(el.getBoundingClientRect().left),
          opacity: getComputedStyle(el).opacity,
          text: (el.textContent ?? '').trim(),
        })),
      )
      assert.ok(metas.length >= 3, `assistant 用量行太少：${metas.length}`)
      const lefts = [...new Set(metas.map((m) => m.left))]
      assert.equal(lefts.length, 1, `用量行左缘不一致：${lefts.join(', ')}`)
      assert.ok(metas.every((m) => m.opacity === '0'), '用量行默认应隐藏（悬停才显示）')

      const target = page.locator('[data-message-id="r16a3"] .msg-group')
      await target.hover()
      await page.waitForTimeout(300)
      const shown = await page
        .locator('[data-message-id="r16a3"] [data-usage-summary]')
        .evaluate((el) => getComputedStyle(el).opacity)
      assert.equal(shown, '1', '悬停消息后用量行没有显示')

      const texts = metas.map((m) => m.text).join(' | ')
      assert.match(texts, /分钟前|小时前|刚刚/, `近期消息没有用相对时间：${texts}`)
      assert.match(texts, /\d{2}-\d{2} \d{2}:\d{2}/, `两天前的消息应显示 MM-DD HH:mm：${texts}`)
      assert.match(texts, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `去年的消息应带年份：${texts}`)

      await page.locator('[data-message-id="r16a3"] [data-msg-time]').first().hover()
      await page.waitForTimeout(900)
      const tip = await page.locator('[role="tooltip"]').last().innerText().catch(() => '')
      assert.match(tip, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `时间 tooltip 没有完整日期时间：${tip}`)
      mkdirSync('/tmp/fb16-after', { recursive: true })
      await page.locator('[data-message-id="r16a3"]').screenshot({ path: '/tmp/fb16-after/regression-usage-hover.png' })
    })

desktop('反馈12#02：自动换行时行号与代码逐行对齐、工具条不压内容', async (page) => {
      // 打开文件预览前先开启自动换行，共享 CodeBlock 会直接走「行号 + 换行」grid。
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '1'))
      await openSession(page, 'links')
      const ref = page.locator('code.file-ref-inline').filter({ hasText: 'src/hello.ts' }).first()
      await ref.waitFor({ state: 'visible' })
      await ref.click()
      const grid = page.getByTestId('code-wrap-grid')
      await grid.waitFor({ timeout: 10_000 })
      const rows = grid.locator('.file-code-wrap-row')
      assert.ok((await rows.count()) >= 3, '换行后没有按行拆成 grid 行')
      const metrics = await grid.evaluate((el) =>
        [...el.querySelectorAll('.file-code-wrap-row')].map((row) => {
          const no = row.querySelector('.file-code-wrap-no')?.getBoundingClientRect()
          const content = row.querySelector('.file-code-wrap-code')?.getBoundingClientRect()
          return no && content
            ? { noRight: no.right, contentLeft: content.left, noTop: no.top, contentTop: content.top }
            : null
        }),
      )
      for (const row of metrics) {
        assert.ok(row, '行号或代码缺失')
        assert.ok(row.noRight <= row.contentLeft + 1, `行号与代码横向重叠：${row.noRight} > ${row.contentLeft}`)
        assert.ok(Math.abs(row.noTop - row.contentTop) <= 1, `行号与代码顶端未对齐：${row.noTop} vs ${row.contentTop}`)
      }
      await page.getByRole('button', { name: '关闭文件预览' }).click()
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))

      // 会话内代码块：自动换行时顶部工具条常显，必须为它留出空间，长行不被遮住。
      await openSession(page, 'wide')
      const code = page.locator('[data-message-id="w2"] .chat-code').first()
      await code.waitFor({ timeout: 10_000 })
      await code.getByTestId('code-wrap-toggle').click()
      await page.waitForTimeout(300)
      await page.waitForFunction(
        () => document.querySelector('[data-message-id="w2"] .chat-code')?.getAttribute('data-wrap') === 'true',
        null,
        { timeout: 5_000 },
      )
      const spacing = await code.evaluate((el) => {
        const tools = el.querySelector('.chat-code-tools')?.getBoundingClientRect()
        const pre = el.querySelector('pre')
        const box = pre?.getBoundingClientRect()
        const pad = pre ? Number.parseFloat(getComputedStyle(pre).paddingTop) : 0
        return {
          toolsBottom: tools?.bottom ?? 0,
          contentTop: (box?.top ?? 0) + pad,
          toolsAttr: el.getAttribute('data-tools'),
          wrapAttr: el.getAttribute('data-wrap'),
          pad,
        }
      })
      assert.ok(
        spacing.toolsBottom <= spacing.contentTop + 1,
        `工具条压住代码内容：${spacing.toolsBottom} > ${spacing.contentTop}（tools=${spacing.toolsAttr} wrap=${spacing.wrapAttr} pad=${spacing.pad}）`,
      )
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))
    })

desktop('消息用量只保留一行小字（#7-03）', async (page) => {
      await openSession(page, 'long')
      const summary = page.locator('[data-usage-summary]').last()
      await summary.scrollIntoViewIfNeeded()
      // 操作条平时 pointer-events:none，先把鼠标移进消息组再悬停用量。
      await summary.locator('xpath=ancestor::div[contains(@class,"msg-group")]').hover()
      const text = await summary.innerText()
      for (const label of ['输入', '输出', '缓存命中', '花费']) {
        assert.ok(text.includes(label), `用量缺少「${label}」标签：${text}`)
      }
      assert.ok(!text.includes('→'), `用量仍在使用裸箭头：${text}`)
      await summary.hover()
      await page.waitForTimeout(700)
      assert.equal(await summary.getAttribute('aria-label'), null, '用量行仍标注为可交互明细')
      await page.keyboard.press('Escape')
    })

desktop('用量卡悬停显示按模型的金额明细与差额（反馈1724#06）', async (page) => {
      await openSession(page, 'mdmath')
      const total = page.locator('[data-usage-total]').first()
      await total.waitFor()
      await total.hover()
      const card = page.locator('[data-usage-breakdown]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      const text = await card.innerText()
      assert.match(text, /mock\s*1/i, `缺少按模型的行：${text}`)
      assert.match(text, /2 次/, `缺少调用次数：${text}`)
      assert.match(text, /\$0\.0070/, `模型小计不对：${text}`)
      assert.match(text, /其他（压缩、评审等）/, `缺少差额行：${text}`)
      assert.match(text, /\$0\.113/, `差额金额不对：${text}`)
      assert.match(text, /合计[\s\S]*\$0\.12/, `合计与总量不一致：${text}`)
      assert.match(text, /历史不重算/, '缺少历史金额不重算的说明')
      mkdirSync('/tmp/fix-1724', { recursive: true })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/fix-1724/1724-06-usage-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    })

desktop('消息耗时显示在用量行末尾，轮次大纲汇总模型与工具耗时（A）', async (page) => {
      await openSession(page, 'long')
      const summary = page.locator('[data-message-id="a40"] [data-usage-summary]')
      await summary.scrollIntoViewIfNeeded()
      await summary.locator('xpath=ancestor::div[contains(@class,"msg-group")]').hover()
      const usageText = await summary.innerText()
      assert.match(
        usageText,
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · 输入 .+ · 输出 .+ · 缓存命中 .+ · 花费 .+ · 12\.3s$/,
        `消息用量行没有时间在最前或缺少耗时：${usageText}`,
      )

      const hoverTurnOne = async () => {
        await page.locator('.turn-hit').hover()
        await page.waitForFunction(
          () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
          null,
          { timeout: 5_000 },
        )
        await page.waitForTimeout(800)
        const target = await page.evaluate(() => {
          const clip = document.querySelector('.turn-clip')?.getBoundingClientRect()
          for (const item of document.querySelectorAll('.turn-item')) {
            if (!(item.getAttribute('title') ?? '').includes('耗时')) continue
            const r = item.getBoundingClientRect()
            if (!clip || r.top < clip.top - 1 || r.bottom > clip.bottom + 1) continue
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
          return null
        })
        assert.ok(target, '展开后的面板中找不到带耗时 tooltip 的轮次')
        await page.mouse.move(target.x, target.y)
        await page.waitForTimeout(150)
      }
      await hoverTurnOne()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      const tipText = await tip.innerText()
      assert.match(tipText, /耗时 12\.3s/, `轮次 tooltip 没有模型耗时：${tipText}`)
      assert.match(tipText, /首 token 0\.8s/, `轮次 tooltip 没有首 token 延迟：${tipText}`)
      assert.equal(await page.locator('[data-usage-summary][title], [data-usage-summary][data-tip]').count(), 0, '用量行不应新增悬停提示')

      // 含工具执行时间的一轮：12.3s 模型 + 40s 工具 = 52.3s。
      await openSession(page, 'turns4')
      await hoverTurnOne()
      const tipTool = page.locator('#tandem-tooltip[data-open]')
      await tipTool.waitFor({ timeout: 5_000 })
      assert.match(
        await tipTool.innerText(),
        /耗时 52\.3s，其中工具 40s/,
        '轮次 tooltip 没有汇总工具耗时',
      )
    })

desktop('发送消息后服务端记录耗时、首 token 延迟并显示在消息下方（A）', async (page) => {
      await openSession(page, 'nockpt')
      const box = page.locator('[aria-label="消息输入框"]').first()
      await box.fill('测一下这一轮的耗时')
      await box.press('Enter')
      let assistant
      for (let attempt = 0; attempt < 80; attempt++) {
        const session = await api(base, token, '/api/sessions/nockpt')
        assistant = [...(session.messages ?? [])].reverse().find((m) => m.role === 'assistant')
        if (session.status === 'idle' && typeof assistant?.durationMs === 'number') break
        await sleep(250)
      }
      assert.ok(assistant, '没有生成 assistant 消息')
      assert.equal(typeof assistant.durationMs, 'number', '服务端没有记录消息耗时')
      assert.ok(assistant.durationMs >= 0, `消息耗时异常：${assistant.durationMs}`)
      assert.equal(typeof assistant.ttftMs, 'number', '服务端没有记录首 token 延迟')
      assert.ok(assistant.ttftMs >= 0, `首 token 延迟异常：${assistant.ttftMs}`)
      await page.getByText('回归回复。').last().waitFor({ timeout: 20_000 })
      const usage = page.locator('[data-usage-summary]').last()
      await usage.waitFor({ timeout: 10_000 })
      assert.match(await usage.innerText(), /· \d+(\.\d+)?s$/, '消息下方没有显示本次耗时')
    })

desktop('用户消息：气泡紧贴内容、时间与输入估算（反馈14#05/#06 · 反馈16#01 悬停显示）', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-turn-id="u40"]')
      const bubble = row.locator('[data-msg-bubble]').first()
      await bubble.waitFor({ timeout: 10_000 })
      const box = await bubble.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const text = range.getBoundingClientRect()
        const rect = el.getBoundingClientRect()
        return {
          width: rect.width,
          textWidth: text.width,
          right: rect.right,
          rowRight: el.closest('.msg-row')?.getBoundingClientRect().right ?? 0,
        }
      })
      assert.ok(
        box.width <= box.textWidth + 40,
        `短消息气泡被撑宽：气泡 ${box.width}px，文本 ${box.textWidth}px`,
      )
      assert.ok(
        Math.abs(box.right - box.rowRight) <= 2,
        `用户气泡没有右对齐：气泡右缘 ${box.right}，消息行右缘 ${box.rowRight}`,
      )
      const userMeta = row.locator('[data-user-usage]').first()
      await userMeta.waitFor({ timeout: 5_000 })
      assert.match(
        await userMeta.innerText(),
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · ~\d+ tok$/,
        '用户消息下方没有「时间 · 输入估算」',
      )
      // 反馈16#01：用量行默认隐藏，悬停消息才显示。
      assert.equal(
        await userMeta.evaluate((el) => getComputedStyle(el).opacity),
        '0',
        '用户消息用量行默认应隐藏',
      )
      await row.locator('.msg-group').hover()
      await page.waitForTimeout(250)
      assert.equal(
        await userMeta.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '悬停用户消息后用量行没有显示',
      )
      const assistantMeta = page.locator('[data-message-id="a40"] [data-usage-summary]').first()
      assert.match(
        await assistantMeta.innerText(),
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · 输入 /,
        'assistant 用量行没有把时间放在最前',
      )

      // 有单价的模型：用户消息要同时显示金额（服务端按发送时的输入估算写入）。
      await openSession(page, 'priced')
      const boxInput = page.locator('[aria-label="消息输入框"]').first()
      await boxInput.fill('这条输入的费用也显示一下')
      await boxInput.press('Enter')
      await page.getByText('回归回复。').last().waitFor({ timeout: 20_000 })
      let stored
      for (let attempt = 0; attempt < 60; attempt++) {
        const session = await api(base, token, '/api/sessions/priced')
        stored = [...(session.messages ?? [])].reverse().find((m) => m.role === 'user')
        if (stored?.usage?.inputTokens > 0) break
        await sleep(250)
      }
      assert.ok(stored?.usage?.inputTokens > 0, '服务端没有记录用户消息的输入估算')
      assert.equal(typeof stored.usage.costUsd, 'number', '服务端没有按单价折算用户消息费用')
      const liveBubble = page.locator('[data-msg-bubble]').last()
      const liveMeta = liveBubble
        .locator('xpath=ancestor::div[@data-turn-id]')
        .first()
        .locator('[data-user-usage]')
        .first()
      await liveMeta.waitFor({ timeout: 10_000 })
      const liveCostText = await liveMeta.innerText()
      assert.match(
        liveCostText,
        /^(刚刚|\d+ 分钟前|\d+ 小时前|\d{2}:\d{2}) · ~\d+ tok · (?:<)?\$\d/,
        '用户消息下方缺少 token 或金额',
      )
      // 反馈1601#03：金额极小时显示「<$0.0001」，不能四舍五入成 $0.0000。
      assert.ok(!liveCostText.includes('$0.0000'), `用户消息金额显示成了 $0.0000：${liveCostText}`)

      // 预置的小额花费（Host 记录的输入估算）：直接检查行的格式。
      await openSession(page, 'tinycost')
      const tinyMeta = page.locator('[data-turn-id="tc1"] [data-user-usage]').first()
      await tinyMeta.waitFor({ timeout: 5_000 })
      assert.match(
        await tinyMeta.innerText(),
        /· <\$0\.0001$/,
        '用户消息的极小金额没有显示成 <$0.0001',
      )
    })

desktop('tooltip 按内容宽度换行，不会每行一个字（#01 R15）', async (page) => {
      await openSession(page, 'long')
      const folder = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      await folder.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ state: 'visible', timeout: 5_000 })
      const info = await tip.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          width: rect.width,
          height: rect.height,
          text: (el.textContent ?? '').trim(),
          lineHeight: parseFloat(cs.lineHeight),
        }
      })
      assert.ok(info.text.length > 0, 'tooltip 没有内容')
      assert.ok(info.width >= 72, `tooltip 宽度只有 ${info.width}px，可能退化成每行一个字`)
      assert.ok(info.height <= info.lineHeight * 4 + 4, `tooltip 异常高（${info.height}px），文字可能逐字换行`)
      await page.mouse.move(DESKTOP.width / 2, DESKTOP.height / 2)
    })

desktop('轮次固定：命中区 ≥24px、一个视图两用（Alt/点击只看已固定）、阅读区不重排（#12/反馈6追加/反馈8#04）', async (page) => {
      await openSession(page, 'long')
      const hit = page.locator('.turn-hit')
      await hit.hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const readOrder = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.turn-item')]
            .filter((el) => {
              const cs = getComputedStyle(el)
              return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
            .map((el) => el.dataset.turnNo),
        )
      const readPinnedLayout = () =>
        page.evaluate(() => {
          const clip = document.querySelector('.turn-clip')?.getBoundingClientRect()
          const first = [...document.querySelectorAll('.turn-item')]
            .filter((el) => {
              const cs = getComputedStyle(el)
              return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
          if (!clip || !first) return null
          return { gap: first.getBoundingClientRect().y - clip.y, height: clip.height }
        })
      const beforeOrder = await readOrder()
      const beforeClipHeight = (await readPinnedLayout())?.height ?? 0
      const beforeScroll = await page.locator('.chat-scroll').evaluate((el) => el.scrollTop)
      const target = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.turn-item')].filter((el) => {
          const cs = getComputedStyle(el)
          return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
        })
        const row = rows.find((el) => (el.querySelector('.turn-item-n')?.textContent ?? '').trim() === '30') ?? rows[0]
        const pin = row?.querySelector('.turn-item-p')
        if (!pin) return null
        const rect = pin.getBoundingClientRect()
        return {
          turn: row.querySelector('.turn-item-n')?.textContent ?? '',
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
        }
      })
      assert.ok(target, '找不到可固定的轮次')
      assert.ok(target.width >= 24 && target.height >= 24, `图钉命中区只有 ${target.width}×${target.height}`)
      await page.mouse.move(target.x, target.y)
      await page.waitForTimeout(250)
      await page.mouse.click(target.x, target.y)

      // 反馈8#04：固定状态只在原位显示小图钉。
      await page.waitForFunction(
        (turn) => document.querySelector(`[data-turn-no="${turn}"]`)?.getAttribute('data-pinned') === 'true',
        target.turn,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      const afterOrder = await readOrder()
      assert.deepEqual(afterOrder, beforeOrder, `固定后阅读区顺序变了：${beforeOrder} → ${afterOrder}`)
      assert.equal(
        await page.locator('.chat-scroll').evaluate((el) => el.scrollTop),
        beforeScroll,
        '固定轮次后对话滚动位置变了',
      )
      assert.ok(
        (await page.locator('[aria-label="已固定到轮次大纲"]').count()) >= 1,
        '消息流里没有图钉标记',
      )

      // 大纲下方的小字提示：按住 Alt 只看已固定，松开恢复全部。
      const hint = page.getByTestId('turn-pinned-hint')
      await hint.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await hint.innerText(), /只看已固定/, '大纲下方没有 Alt 提示')
      await hint.hover()
      await page.waitForTimeout(250)
      assert.equal(
        await page.locator('.turn-rail').getAttribute('data-open'),
        'true',
        '指针移到大纲下方提示行时面板收起（反馈8#04 的空白间隙问题）',
      )
      // 输入框聚焦时单独按 Alt/Option 也要生效（用户常边打字边看大纲）。
      await page.locator('[aria-label="消息输入框"]').first().focus()
      await page.keyboard.down('Alt')
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(600)
      const filtered = await readOrder()
      assert.deepEqual(filtered, [target.turn], `Alt 只看已固定时显示了多余的轮次：${filtered}`)
      const pinnedLayout = await readPinnedLayout()
      assert.ok(pinnedLayout, '只看已固定时读不到大纲行')
      assert.ok(
        pinnedLayout.gap <= 24,
        `只看已固定时第一项离列表顶部 ${Math.round(pinnedLayout.gap)}px，应从列表顶部排列`,
      )
      assert.ok(
        pinnedLayout.height <= 70 && pinnedLayout.height < beforeClipHeight,
        `只看已固定时列表没有收缩到内容高度：${pinnedLayout.height}（全部轮次时 ${beforeClipHeight}）`,
      )
      await page.keyboard.up('Alt')
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') !== 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.ok((await readOrder()).length > 1, '松开 Alt 后没有恢复全部轮次')
      assert.ok((await readOrder()).includes(target.turn), '恢复全部后找不到刚固定的轮次')

      // 点提示行 = 鼠标/触屏也能切换；再点恢复全部。
      await hint.click()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.deepEqual(await readOrder(), [target.turn], '点击提示行没有切到只看已固定')
      const clickedLayout = await readPinnedLayout()
      assert.ok(clickedLayout, '点击提示行后读不到大纲行')
      assert.ok(
        clickedLayout.gap <= 24,
        `点击切到只看已固定后第一项离列表顶部 ${Math.round(clickedLayout.gap)}px，应从列表顶部排列`,
      )
      await hint.click()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') !== 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.ok((await readOrder()).length > 1, '再次点击提示行没有恢复全部轮次')

      // 取消固定：原位图钉消失，提示行回到「暂无」。
      const row = page.locator(`.turn-item[data-turn-no="${target.turn}"]`)
      const rowBox = await row.boundingBox()
      assert.ok(rowBox, '找不到刚固定的行')
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
      await page.waitForTimeout(250)
      const pin = row.locator('.turn-item-p')
      const pinBox = await pin.boundingBox()
      assert.ok(pinBox, '找不到行尾图钉')
      await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2)
      await page.waitForFunction(
        (turn) => document.querySelector(`[data-turn-no="${turn}"]`)?.getAttribute('data-pinned') !== 'true',
        target.turn,
        { timeout: 5_000 },
      )
      assert.match(await hint.innerText(), /暂无/, '取消固定后提示行没有更新')
    })

desktop('反馈0220#04：只为明确的文件引用生成链接（R06）', async (page) => {
      const outDir = '/tmp/fix-0220c/regression'
      mkdirSync(outDir, { recursive: true })
      await openSession(page, 'links2')
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      const row = page.locator('[data-message-id="lk2"]')
      await row.waitFor({ timeout: 15_000 })
      // 行内代码里存在的文件：等存在性查询回来后才变成链接
      await row
        .locator('code.file-ref-inline')
        .filter({ hasText: 'src/hello.ts' })
        .first()
        .waitFor({ timeout: 10_000 })
      await row
        .locator('code.file-ref-inline')
        .filter({ hasText: 'demo.ts' })
        .first()
        .waitFor({ timeout: 10_000 })

      // 不存在的行内代码保持普通代码
      for (const missing of ['missing-demo.cpp', 'there/is/no/file.ts']) {
        assert.equal(
          await row.locator('code.file-ref-inline').filter({ hasText: missing }).count(),
          0,
          `不存在的 ${missing} 仍被当成链接`,
        )
        assert.ok(
          await row.locator('code').filter({ hasText: missing }).count() > 0,
          `不存在的 ${missing} 没有按普通行内代码显示`,
        )
      }

      // 纯文本里长得像文件名的一律不是链接
      const linkedText = await row.evaluate((el) =>
        [...el.querySelectorAll('a.file-ref, code.file-ref-inline')].map((node) => (node.textContent ?? '').trim()),
      )
      for (const plain of ['menu.cpp', '.cpp', '.cppm', 'unique_ptr', 'buffer_type.c']) {
        assert.ok(!linkedText.includes(plain), `纯文本 ${plain} 被识别成了文件链接`)
      }
      // 显式 Markdown 链接不受影响，仍可点开预览
      const link = row.locator('a.file-ref', { hasText: 'D 盘文件' }).first()
      await link.waitFor({ timeout: 10_000 })
      await link.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '关闭文件预览' }).click()
      await row.locator('code.file-ref-inline').filter({ hasText: 'src/hello.ts' }).first().click()
      await page.getByRole('button', { name: '关闭文件预览' }).waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.getByText(/读取失败|文件不存在/).count(), 0, '存在的文件应能打开预览')
      await page.screenshot({ path: path.join(outDir, 'file-ref-rule.png') })
      await page.getByRole('button', { name: '关闭文件预览' }).click()
    })

desktop('Windows 盘符路径文件链接可打开预览', async (page) => {
      await openSession(page, 'links')
      const link = page.locator('a[data-tip^="打开 D:/"]').first()
      await link.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.locator('[data-tip*="D:/repo/demo.ts"]').count() > 0, true, '预览路径未归一化为 D:/repo/demo.ts')
      await page.getByRole('button', { name: '关闭文件预览' }).click()
      const inline = page.locator('code.file-ref-inline').first()
      await inline.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '关闭文件预览' }).click()
    })

desktop('改动审阅把未跟踪目录展开为文件', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('one.ts', { exact: true }).waitFor({ timeout: 10_000 })
      assert.equal(await panel.getByText('two.ts', { exact: true }).count(), 1, '未跟踪目录里的嵌套文件没有展开')
      await panel.getByText('one.ts', { exact: true }).click()
      await panel.getByText(/export const one/).waitFor({ timeout: 10_000 })
    })

desktop('改动审阅：文件列表贴顶、diff 紧跟、自动换行无横向截断（R14）', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByTestId('changes-file-list').waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      const diff = panel.getByTestId('changes-diff').locator('.chat-diff').first()
      await diff.waitFor({ timeout: 10_000 })

      const panelBox = await panel.boundingBox()
      const diffBox = await diff.boundingBox()
      assert.ok(panelBox && diffBox, '改动审阅面板或 diff 不可见')
      assert.ok(
        diffBox.y - panelBox.y < 320,
        `diff 仍从面板中段开始：diff y=${Math.round(diffBox.y)} panel y=${Math.round(panelBox.y)}`,
      )
      assert.equal(await panel.locator('[data-panel-bar]').count(), 1, '改动审阅没有统一面板工具条')
      assert.ok((await panel.locator('[data-panel-body]').count()) >= 1, '改动审阅没有统一内容区')

      const body = diff.locator('.chat-diff-body')
      const before = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
      assert.ok(before.sw > before.cw + 1, `长行没有产生横向溢出：${before.sw} / ${before.cw}`)
      await diff.getByTestId('diff-wrap-toggle').click()
      const after = await diff.evaluate((el) => {
        const body = el.querySelector('.chat-diff-body')
        return {
          wrap: el.getAttribute('data-wrap'),
          sw: body?.scrollWidth ?? 0,
          cw: body?.clientWidth ?? 0,
        }
      })
      assert.equal(after.wrap, 'true', '自动换行开关没有生效')
      assert.ok(after.sw <= after.cw + 1, `自动换行后仍横向溢出：${after.sw} > ${after.cw}`)
    })

desktop('改动审阅行内评论浮窗与行标记', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('hello.ts', { exact: true }).waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      const row = panel.locator('.chat-diff-row[data-kind="add"]').first()
      await row.waitFor({ timeout: 10_000 })
      const rb = await row.boundingBox()
      assert.ok(rb, '没有可评论的 diff 行')
      await page.mouse.click(rb.x + 120, rb.y + rb.height / 2)
      const input = page.getByRole('textbox', { name: '行内评论' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('这里需要调整')
      await input.press('Enter')
      await page.waitForTimeout(400)
      assert.ok((await panel.locator('.diff-comment-btn').count()) >= 1, '评论发送后行右侧没有标记')
      assert.ok((await panel.locator('[data-commented="true"]').count()) >= 1, '评论行没有 data-commented 标记')
      assert.match(
        await panel.getByRole('button', { name: /1 条待发送评论/ }).first().innerText(),
        /1 条评论/,
      )
    })

desktop('提交前 AI 评审挂行、忽略无效行并采纳意见', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('hello.ts', { exact: true }).waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      await panel.getByRole('button', { name: 'AI 评审', exact: true }).click()
      await panel.getByText('有阻塞问题').waitFor({ timeout: 20_000 })
      const text = await panel.innerText()
      assert.match(text, /已忽略 1 条指向不存在行的意见/, '无效行意见没有被忽略并提示')
      assert.match(text, /阻塞 1 · 警告 0 · 细节 1/, '评审结论计数不正确')
      const markers = panel.locator('.diff-comment-btn[data-ai]')
      await markers.first().waitFor({ timeout: 10_000 })
      assert.equal(await markers.count(), 2, 'blocker 与 nit 应各有一个行标记')
      assert.ok((await panel.getByText('1 个阻塞').count()) >= 1, '提交按钮旁没有阻塞提示')
      await markers.first().click()
      await page.getByRole('button', { name: '采纳', exact: true }).click()
      await page
        .getByRole('button', { name: /1 条待发送评论/ })
        .first()
        .waitFor({ timeout: 5_000 })
      assert.match(await panel.innerText(), /1 条评论/, '采纳后没有进入待发送评论')
      assert.equal(await panel.locator('.diff-comment-btn[data-ai]').count(), 1, '采纳后的 AI 标记应移除')
    })

desktop('改动审阅提交范围带文件数与二次确认', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      const commitButton = panel.getByRole('button', { name: /^提交 \d+ 个文件$/ })
      await commitButton.waitFor({ timeout: 10_000 })
      const label = await commitButton.innerText()
      const count = Number(/(\d+)/.exec(label)?.[1] ?? 0)
      assert.ok(count >= 5, `提交按钮只显示 ${count} 个文件`)
      await panel.getByPlaceholder('提交信息').fill('回归提交')
      await commitButton.click()
      const confirm = page.getByRole('dialog', { name: '提交全部改动' })
      await confirm.waitFor({ state: 'visible' })
      withinViewport(await confirm.boundingBox(), DESKTOP, '提交确认弹窗')
      assert.match(await confirm.innerText(), /未跟踪文件/)
      assert.match(await confirm.innerText(), new RegExp(`全部\\s*${count}\\s*个文件`))
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
    })

desktop('编辑消息保持气泡宽度并随内容自适应（反馈11#07 R45）', async (page) => {
      await openSession(page, 'long')
      const rows = page.locator('.msg-row[data-turn-id][data-actions="true"]')
      const row = rows.nth(Math.min(3, (await rows.count()) - 1))
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      const before = await row.evaluate((el) => {
        const bubble = el.querySelector('.msg-group .bg-surface-2')
        return bubble ? Math.round(bubble.getBoundingClientRect().width) : 0
      })
      assert.ok(before > 0, '找不到用户气泡')
      await row.getByRole('button', { name: '编辑并重发' }).click()
      const editor = row.locator('textarea[aria-label="编辑并重发"]')
      await editor.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(120)
      const after = await row.evaluate((el) => {
        const box = el.querySelector('.bg-surface-2')
        return box ? Math.round(box.getBoundingClientRect().width) : 0
      })
      assert.ok(Math.abs(after - before) <= 2, `编辑前后宽度 ${before} → ${after}px`)
      const oneLine = await editor.evaluate((el) => el.getBoundingClientRect().height)
      await editor.fill(`${await editor.inputValue()}\n第二行\n第三行`)
      await page.waitForTimeout(150)
      const height = await editor.evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(height > oneLine + 20, `编辑框高度没有随内容增长：${oneLine} → ${height}`)
      await page.screenshot({ path: '/tmp/fb11-after/07.png' })
      await page.keyboard.press('Escape')
      await editor.waitFor({ state: 'hidden', timeout: 5_000 })
      const restored = await row.evaluate((el) => {
        const bubble = el.querySelector('.msg-group .bg-surface-2')
        return bubble ? Math.round(bubble.getBoundingClientRect().width) : 0
      })
      assert.ok(Math.abs(restored - before) <= 2, `取消编辑后宽度 ${restored} ≠ ${before}`)
    })

desktop('回退对话框精简为单行引用/单选/一行警告（反馈11#08 R46）', async (page) => {
      await openSession(page, 'nockpt')
      const row = page.locator('[data-turn-id="n3"]').first()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await page.waitForTimeout(300)
      const box = await dialog.boundingBox()
      assert.ok(box && box.height < 380, `回退对话框高度 ${box?.height}，没有精简`)
      const text = await dialog.innerText()
      assert.equal(
        (text.match(/没有可回退的文件改动/g) ?? []).length,
        1,
        '回退对话框仍重复说明文件改动',
      )
      const radios = dialog.getByRole('radio')
      assert.equal(await radios.count(), 3, '恢复范围不是三个单选项')
      for (let i = 0; i < 3; i++) {
        const r = await radios.nth(i).boundingBox()
        assert.ok(r && r.height <= 34, `第 ${i + 1} 个恢复范围高度 ${r?.height}，不是单行`)
      }
      const warning = dialog.locator('.text-warning').last()
      const w = await warning.boundingBox()
      assert.ok(w && w.height <= 32, `警告占到 ${w?.height}px，不是一行`)
      await page.screenshot({ path: '/tmp/fb11-after/08.png' })
    })

desktop('工具行调高且工具-only 行收紧空白（反馈11#04 R47）', async (page) => {
      await openSession(page, 'secrets')
      const tool = page.locator('.tool-row').first()
      await tool.waitFor({ state: 'visible', timeout: 10_000 })
      const height = await tool.evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(height >= 32, `工具行高度 ${height}px，仍显扁平`)
      const margin = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.className = 'msg-row'
        probe.dataset.toolOnly = 'true'
        document.body.appendChild(probe)
        const value = parseFloat(getComputedStyle(probe).marginTop)
        probe.remove()
        return value
      })
      assert.ok(margin < 0, `工具-only 行没有收紧上下间距（${margin}px）`)
      await page.screenshot({ path: '/tmp/fb11-after/04.png' })

      const dialog = await openSettings(page, '外观', 'desktop')
      const preview = dialog.locator('[data-setting-id="appearance.theme"] button').first()
      const previewHeight = await preview
        .locator('div')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(previewHeight >= 90, `主题预览卡只有 ${previewHeight}px 高`)
      await page.keyboard.press('Escape')
    })

desktop('会话信息面板不再提供删除会话（反馈11#02 R05）', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await panel.getByText('删除会话', { exact: true }).count(), 0, '会话信息面板仍有删除会话')
      await page.screenshot({ path: '/tmp/fb11-after/02.png' })
      const row = page.locator('[data-session-id="long"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      assert.ok(
        (await menu.getByRole('menuitem', { name: '删除', exact: true }).count()) === 1,
        '侧栏删除会话入口不见了',
      )
      await page.keyboard.press('Escape')
    })

desktop('无检查点的会话仍可只回退对话', async (page) => {
      await openSession(page, 'nockpt')
      const row = page.locator('[data-turn-id="n3"]').first()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await page.waitForTimeout(300)
      const text = await dialog.innerText()
      assert.match(text, /只能恢复对话/, '没有提示只能恢复对话')
      assert.equal(
        await dialog.getByRole('radio', { name: /恢复代码和对话/ }).isDisabled(),
        true,
        '没有检查点时仍能选择恢复代码',
      )
      await dialog.getByRole('button', { name: '回退', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
      await page.waitForFunction(() => !document.querySelector('[data-turn-id="n3"]'))
      assert.ok(await page.locator('[data-turn-id="n1"]').count(), '回退时误删了更早的消息')
    })

desktop('删除 dirty worktree 的确认列出文件与分支', async (page) => {
      await openSession(page, 'wtdirty')
      const row = page.locator('[data-session-id="wtdirty"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      await menu.getByRole('menuitem', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog').last()
      await dialog.getByText('确定删除').waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await page.waitForFunction(() => document.body.innerText.includes('tandem/dirty'), null, {
        timeout: 10_000,
      })
      const dirtyDialog = page.getByRole('dialog').filter({ hasText: 'worktree 有未提交改动' })
      const text = await dirtyDialog.innerText()
      assert.match(text, /dirty\.txt/, '二次确认没有列出未提交文件')
      assert.match(text, /tandem\/dirty/, '二次确认没有说明将删除的分支')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    })

desktop('回退对话框引用目标消息并显示删除范围', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-turn-id="u2"]')
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await dialog.getByText('第 2 轮：检查文件').waitFor({ timeout: 5_000 })
      assert.match(await dialog.innerText(), /第 2 轮：检查文件/, '没有展示被回退的用户消息')
      withinViewport(await dialog.boundingBox(), DESKTOP, '回退对话框')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    })

desktop('会话信息面板左缘拖宽、记住宽度并可双击复位（#03 R01）', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.rightPanelWidth.v1'))
      await openSession(page, 'long')
      const toggle = page.getByRole('button', { name: '切换信息面板' }).first()
      const handle = page.getByRole('separator', { name: '调整会话信息面板宽度' })
      if (!(await handle.isVisible().catch(() => false))) await toggle.click()
      await handle.waitFor({ state: 'visible', timeout: 5_000 })
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      const before = (await panel.boundingBox())?.width ?? 0
      assert.ok(before >= 280 && before <= 600, `信息面板默认宽度异常：${before}`)
      const box = await handle.boundingBox()
      assert.ok(box, '找不到信息面板拖动手柄')
      await page.mouse.move(box.x + box.width / 2, box.y + 200)
      await page.mouse.down()
      await page.mouse.move(box.x - 140, box.y + 200, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      const widened = (await panel.boundingBox())?.width ?? 0
      assert.ok(widened >= 400, `向左拖动后信息面板未变宽：${widened}`)
      const stored = Number(await page.evaluate(() => localStorage.getItem('tandem.rightPanelWidth.v1')))
      assert.ok(stored >= 400 && stored <= 600, `信息面板宽度没有记住：${stored}`)
      // 关闭再打开仍使用记住的宽度。
      await toggle.click()
      await handle.waitFor({ state: 'hidden', timeout: 5_000 })
      await toggle.click()
      await handle.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(200)
      const reopened = (await panel.boundingBox())?.width ?? 0
      assert.ok(Math.abs(reopened - stored) <= 2, `重开后面板宽度 ${reopened}，记住的是 ${stored}`)
      // 双击复位默认 300。
      await handle.dblclick()
      await page.waitForTimeout(200)
      const reset = (await panel.boundingBox())?.width ?? 0
      assert.ok(Math.abs(reset - 300) <= 2, `双击后没有恢复默认宽度：${reset}`)
    })

desktop('会话信息面板：空分组默认隐藏、⋯ 菜单可显式显示（反馈9#06 / 10#03 R14）', async (page) => {
      const empty = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '空分组回归',
        }),
      })
      await gotoSession(page, empty.id)
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      if (!(await panel.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      // 没有数据的分组与上下文卡片默认不渲染。
      for (const text of ['暂无待办', '暂无用量', '暂无记忆', '暂无上下文数据']) {
        assert.equal(await panel.getByText(text, { exact: true }).count(), 0, `空分组默认显示：${text}`)
      }
      assert.equal(await panel.locator('[data-group="context"]').count(), 0, '新会话无数据时仍显示上下文卡')
      assert.equal(await panel.locator('[data-group="details"]').count(), 1, '详情分组应始终显示')

      // 反馈10#03：空分组由顶部 ⋯ 菜单逐个勾选。
      const groupMenu = page.locator('[role="menu"][aria-label="显示分组"]').first()
      const toggleEmptyGroup = async (name) => {
        if (!(await groupMenu.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: '自定义信息面板' }).click()
          await groupMenu.waitFor({ timeout: 5_000 })
        }
        await groupMenu.getByRole('menuitemcheckbox', { name, exact: true }).click()
      }
      await toggleEmptyGroup('待办')
      await toggleEmptyGroup('用量')
      await toggleEmptyGroup('记忆')
      await page.keyboard.press('Escape')
      await panel.getByText('暂无待办', { exact: true }).waitFor({ timeout: 5_000 })
      await panel.getByText('暂无用量', { exact: true }).waitFor({ timeout: 5_000 })
      await panel.getByText('暂无记忆', { exact: false }).waitFor({ timeout: 5_000 })
      assert.equal(await panel.getByRole('button', { name: '编辑' }).count(), 1, '空记忆卡缺少编辑入口')
      const prefs = JSON.parse(await page.evaluate(() => localStorage.getItem('tandem.rightPanel.v1') ?? '{}'))
      for (const id of ['todos', 'usage', 'memory']) {
        assert.ok(prefs.shown?.includes(id), `「${id}」没有记住显示空分组`)
      }
      await toggleEmptyGroup('待办')
      await toggleEmptyGroup('用量')
      await toggleEmptyGroup('记忆')
      await page.keyboard.press('Escape')

      // 有数据后出现：刚创建的空会话没有用量；发送一条后用量分组淡入。
      assert.equal(await panel.locator('[data-group="usage"]').count(), 0, '无用量时仍显示用量卡')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('让用量分组出现')
      await input.press('Enter')
      await panel.locator('[data-group="usage"]').waitFor({ state: 'visible', timeout: 20_000 })
      assert.equal(await panel.getByText('暂无用量', { exact: true }).count(), 0, '有数据后仍显示空状态')
      assert.match(await panel.locator('[data-group="usage"]').innerText(), /输入[\s\S]*输出/, '用量卡出现后没有数据')
    })

/** 消息区距底部像素数。 */
const chatDistance = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.chat-scroll')
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1
  })

desktop('[S1] 打开会话第一眼在底部，内容撑高后仍贴底', async (page) => {
      const stop = await startScrollSampler(page, '__s1')
      await openSession(page, 'huge')
      await page.waitForTimeout(1200)
      const frames = await stop()
      assert.ok(frames.length > 30, `采样帧太少：${frames.length}`)
      assert.ok(
        new Set(frames.map((frame) => frame.height)).size > 1,
        '采样期间消息区高度没有变化，无法验证内容撑高后仍贴底',
      )
      const off = frames.filter((frame) => frame.distance > 2)
      assert.equal(
        off.length,
        0,
        `打开会话后有 ${off.length}/${frames.length} 帧不在底部（最大 ${Math.max(...off.map((frame) => frame.distance))}px）`,
      )
    })

desktop('[S2] 停在底部时流式输出持续贴底（距底部 ≤4px）', async (page) => {
      await openSession(page, 'scroll')
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 10_000 },
      )
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SCROLL_E2E 请逐段输出')
      await input.press('Enter')
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      const distances = []
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(250)
        distances.push(await chatDistance(page))
      }
      assert.ok(
        distances.every((distance) => distance <= 4),
        `流式输出期间距底部像素：${distances.join(', ')}`,
      )
      await page.waitForFunction(
        () => !document.querySelector('.md.chat-md.is-streaming'),
        null,
        { timeout: 25_000 },
      )
      assert.ok((await chatDistance(page)) <= 4, '流式结束后没有停在底部')
    })

desktop('[S3] 上翻即停：滚轮或键盘上滚后，流式增高不再把视口拉回底部', async (page) => {
      await openSession(page, 'scroll')
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 10_000 },
      )
      const scroller = page.locator('.chat-scroll').filter({ has: page.locator('.msg-row') }).first()
      const streaming = () => page.locator('.md.chat-md.is-streaming').count()
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SCROLL_E2E 请逐段输出')
      await input.press('Enter')
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      // 滚轮上滚：立即停止跟随，之后内容增高只能把视口留在原处。
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(300)
      const scrolledUp = await chatDistance(page)
      assert.ok(scrolledUp > 120, `滚轮上滚后距底部只有 ${scrolledUp}px，视口被拉回底部`)
      assert.ok((await streaming()) > 0, '上滚时流式输出已经结束，无法验证不跟随')
      await page.waitForTimeout(800)
      const later = await chatDistance(page)
      assert.ok(later > 120, `上滚后流式输出把视口拉回底部：${scrolledUp}px → ${later}px`)
      assert.ok(later >= scrolledUp - 2, `上滚后视口往下移动了：${scrolledUp}px → ${later}px`)
      // 键盘上滚同样是用户意图：先回到底部恢复跟随，再按 PageUp。
      await page.locator('.chat-jump').click()
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 5_000 },
      )
      const fromKey = await chatDistance(page)
      await page.evaluate(() => {
        document
          .querySelector('.chat-scroll')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
      })
      await page.waitForTimeout(800)
      const afterKey = await chatDistance(page)
      assert.ok((await streaming()) > 0, '键盘上滚时流式输出已经结束，无法验证不跟随')
      assert.ok(
        afterKey > fromKey + 40,
        `键盘上滚后仍在贴底：${fromKey}px → ${afterKey}px`,
      )
    })

desktop('[S3] 打开会话后立即上滚，不被贴底校准吸回底部', async (page) => {
      await openSession(page, 'scroll')
      const row = page.locator('[data-session-row]').filter({ hasText: '超大会话 · 320 轮' }).first()
      await row.waitFor({ timeout: 10_000 })
      await row.locator('[data-session-open], button').first().click()
      await page.waitForFunction(() => window.location.hash.includes('/s/huge'), null, {
        timeout: 10_000,
      })
      await page.locator('.msg-row[data-message-id^="hu"]').first().waitFor({ timeout: 10_000 })
      // 切会话的点击把鼠标留在侧栏：挪回消息区后立即上滚（此时仍在打开后的贴底校准窗口里）。
      const area = await page.locator('.chat-scroll').boundingBox()
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
      await page.mouse.wheel(0, -900)
      await page.waitForTimeout(700)
      const distance = await chatDistance(page)
      assert.ok(distance > 120, `打开会话后立即上滚仍被拉回底部：距底部 ${distance}px`)
    })

desktop('[S4] 回到底部：平滑滚到底并恢复跟随', async (page) => {
      await openSession(page, 'scroll')
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 10_000 },
      )
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SCROLL_E2E 请逐段输出')
      await input.press('Enter')
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      const scroller = page.locator('.chat-scroll').filter({ has: page.locator('.msg-row') }).first()
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(400)
      assert.ok((await chatDistance(page)) > 120, '上滚后没有离开底部，无法验证回到底部')
      await page.evaluate(() => {
        const state = (window.__s4 = { on: true, samples: [] })
        const loop = () => {
          if (!state.on) return
          const el = document.querySelector('.chat-scroll')
          if (el) state.samples.push(el.scrollTop)
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      })
      await page.locator('.chat-jump').click()
      await page.waitForTimeout(900)
      const samples = await page.evaluate(() => {
        window.__s4.on = false
        return window.__s4.samples
      })
      const positions = new Set(samples.map((value) => Math.round(value)))
      assert.ok(positions.size >= 3, `回到底部没有平滑过程（只出现 ${positions.size} 个位置）`)
      assert.ok(
        samples.at(-1) > samples[0] + 100,
        `回到底部后没有滚到底：${samples[0]} → ${samples.at(-1)}`,
      )
      const distances = []
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(250)
        distances.push(await chatDistance(page))
      }
      assert.ok(
        distances.every((distance) => distance <= 4),
        `回到底部后没有恢复跟随，距底部像素：${distances.join(', ')}`,
      )
    })

desktop('[S10] 切换会话不闪：保留旧画面，新会话首帧即贴底', async (page) => {
      // 只用静态会话：前面用例的流式回合可能还在后台写入，内容增高时底部首行本就会移动。
      await openSession(page, 'codeblock')
      const stop = await startScrollSampler(page, '__s10')
      const clientHostId = await clientHostIdOf(page)
      // 走真实路由切换（侧栏行点击与深链最终都调用 store.openSession），不依赖侧栏分组展开状态。
      const switchTo = async (sessionId, messagePrefix) => {
        await page.evaluate(
          (hash) => {
            window.location.hash = hash
          },
          `#/h/${clientHostId}/s/${sessionId}`,
        )
        await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), sessionId, {
          timeout: 10_000,
        })
        await page
          .locator(`.msg-row[data-message-id^="${messagePrefix}"]`)
          .first()
          .waitFor({ timeout: 10_000 })
        await page.waitForTimeout(500)
      }
      await switchTo('long', 'u1')
      await switchTo('codeblock', 'r16u')
      const frames = await stop()
      assert.ok(frames.length > 30, `切换期间采样帧太少：${frames.length}`)
      const skeleton = frames.filter((frame) => frame.skeleton > 0)
      assert.equal(skeleton.length, 0, `切换会话时有 ${skeleton.length} 帧显示骨架屏`)
      const notBottom = frames.filter((frame) => frame.distance > 2)
      assert.equal(
        notBottom.length,
        0,
        `切换会话时有 ${notBottom.length}/${frames.length} 帧不在底部（最大 ${Math.max(...notBottom.map((frame) => frame.distance))}px）`,
      )
      // 同一行在显示期间不能被后到的内容推走（先下移一帧再回弹）。
      const topsById = new Map()
      for (const frame of frames) {
        if (!frame.firstId || frame.firstTop === null) continue
        const tops = topsById.get(frame.firstId) ?? []
        tops.push(frame.firstTop)
        topsById.set(frame.firstId, tops)
      }
      for (const [id, tops] of topsById) {
        const spread = Math.max(...tops) - Math.min(...tops)
        assert.ok(spread <= 2, `消息 ${id} 显示期间上下跳动 ${spread}px`)
      }
    })

desktop('[S11] 窗口尺寸变化：阅读中保持视口首行，底部保持贴底', async (page) => {
      await openSession(page, 'huge')
      await page.waitForTimeout(300)
      const topRow = () =>
        page.evaluate(() => {
          const el = document.querySelector('.chat-scroll')
          if (!el) return null
          const boxTop = el.getBoundingClientRect().top
          const row = [...el.querySelectorAll('.msg-row[data-message-id]')].find(
            (item) => item.getBoundingClientRect().bottom > boxTop + 1,
          )
          return row
            ? {
                id: row.getAttribute('data-message-id'),
                top: row.getBoundingClientRect().top - boxTop,
              }
            : null
        })
      // 阅读态：滚到会话中部，记录视口首行与偏移。
      await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        if (el) el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
      })
      await page.waitForTimeout(400)
      const before = await topRow()
      assert.ok(before?.id, '滚动到中部后没有可见的消息行')
      await page.setViewportSize({ width: 900, height: 700 })
      await page.waitForTimeout(500)
      const after = await page.evaluate((id) => {
        const el = document.querySelector('.chat-scroll')
        if (!el) return null
        const boxTop = el.getBoundingClientRect().top
        const row = el.querySelector(`.msg-row[data-message-id="${CSS.escape(id)}"]`)
        return {
          top: row ? row.getBoundingClientRect().top - boxTop : null,
          distance: el.scrollHeight - el.scrollTop - el.clientHeight,
        }
      }, before.id)
      assert.notEqual(after?.top ?? null, null, `尺寸变化后视口首行 ${before.id} 被卸载`)
      assert.ok(
        Math.abs(after.top - before.top) <= 4,
        `尺寸变化后视口首行移动了 ${Math.round(after.top - before.top)}px`,
      )
      // 贴底态：点「回到底部」后缩小窗口高度，仍必须停在底部。
      await page.locator('.chat-jump').click()
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 5_000 },
      )
      await page.setViewportSize({ width: 1100, height: 480 })
      await page.waitForTimeout(500)
      const distance = await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1
      })
      assert.ok(distance <= 2, `尺寸变化后不再贴底：距底部 ${distance}px`)
    })

desktop('公式渲染：行内与块级用 KaTeX、代码里的 $ 保持源码（反馈1724#04）', async (page) => {
      await openSession(page, 'mdmath')
      // KaTeX 按需加载：等公式 chunk 渲染完成。
      await page.waitForFunction(
        () => document.querySelectorAll('.md-math .katex').length >= 2,
        null,
        { timeout: 20_000 },
      )
      const info = await page.evaluate(() => {
        const block = document.querySelector('.md-math-block')
        const inline = document.querySelector('.md-math-inline')
        const pre = document.querySelector('.chat-code pre')
        const md = block?.closest('.md.chat-md')
        return {
          katex: document.querySelectorAll('.md-math .katex').length,
          inlineText: inline?.textContent ?? '',
          blockWidth: block?.getBoundingClientRect().width ?? 0,
          blockScrollWidth: block?.scrollWidth ?? 0,
          blockOverflowX: block ? getComputedStyle(block).overflowX : '',
          columnWidth: md?.getBoundingClientRect().width ?? 0,
          preText: pre?.textContent ?? '',
          preKatex: !!pre?.querySelector('.katex'),
          inlineCode: [...document.querySelectorAll('.md.chat-md p code')].map((el) => el.textContent ?? ''),
          rawTexVisible: (document.querySelector('.md.chat-md')?.innerText ?? '').includes('\\begin{aligned}'),
        }
      })
      assert.ok(info.katex >= 2, `公式没有渲染成 KaTeX（${info.katex}）`)
      assert.ok(info.inlineText.includes('E'), '行内公式内容缺失')
      assert.equal(info.blockOverflowX, 'auto', '块级公式没有在公式内横向滚动')
      assert.ok(
        info.blockScrollWidth > info.blockWidth + 4,
        `过宽公式没有超出可滚动区域（${info.blockScrollWidth} / ${info.blockWidth}）`,
      )
      assert.ok(
        info.blockWidth <= info.columnWidth + 1,
        `块级公式撑开了正文列（${info.blockWidth} > ${info.columnWidth}）`,
      )
      assert.ok(info.preText.includes('echo $HOME'), `代码块里的 $ 被改动：${info.preText}`)
      assert.equal(info.preKatex, false, '代码块里也渲染了公式')
      assert.ok(info.inlineCode.some((text) => text.includes('$HOME')), '行内代码里的 $ 被当成公式')
      assert.equal(info.rawTexVisible, false, '公式仍然显示 TeX 源码')
      mkdirSync('/tmp/fix-1724', { recursive: true })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/fix-1724/1724-04-math-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    })


}
