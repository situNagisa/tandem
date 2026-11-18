#!/usr/bin/env node
/**
 * 会话图与会话信息面板（拓扑、分支、子代理、活动状态）。
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

export const feature = 'session-graph'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [59, 132, 133, 133.5, 134, 135, 136, 137, 138, 139, 140, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201]

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

fb2102('反馈2102#02：会话图快速连点两个节点，最终停在第二个目标且滚动单调', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      const firstId = await nodes.nth(Math.floor(count * 0.3)).getAttribute('data-graph-turn-id')
      const secondId = await nodes.nth(Math.floor(count * 0.6)).getAttribute('data-graph-turn-id')
      const scrollTop = () => page.evaluate(() => document.querySelector('.chat-scroll').scrollTop)
      // 跳转落点是目标轮居中（scrollIntoView block: center）：返回目标中心相对视口中心的偏移。
      const centerOffset = (id) =>
        page.evaluate((id) => {
          const root = document.querySelector('.chat-scroll')
          const el = root.querySelector(`[data-turn-id="${CSS.escape(id)}"]`)
          if (!el) return null
          const box = root.getBoundingClientRect()
          const target = el.getBoundingClientRect()
          return target.top + target.height / 2 - (box.top + box.height / 2)
        }, id)
      await page.evaluate(() => {
        window.__fb02 = { on: true, samples: [] }
        const sample = () => {
          const state = window.__fb02
          if (!state.on) return
          state.samples.push(document.querySelector('.chat-scroll').scrollTop)
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const beforeClicks = await scrollTop()
      await page.evaluate(() => {
        window.__fb02.clickedAt = window.__fb02.samples.length
      })
      await nodes.nth(Math.floor(count * 0.3)).click()
      await page.waitForTimeout(60)
      await nodes.nth(Math.floor(count * 0.6)).click()
      await page.waitForTimeout(1800)
      const { samples, clickedAt } = await page.evaluate(() => {
        window.__fb02.on = false
        return window.__fb02
      })
      const offset = await centerOffset(secondId)
      const final = await scrollTop()
      assert.ok(offset !== null, `找不到第二个目标 ${secondId}`)
      assert.ok(
        Math.abs(offset) < 60,
        `快速连点后第二个目标没有居中，偏移 ${Math.round(offset)}px（起点 ${Math.round(beforeClicks)}，停在 ${Math.round(final)}）`,
      )
      // 第二次点击之后，滚动只能朝第二个目标单调前进：不能先冲到第一个目标再回弹。
      const after = samples.slice(clickedAt ?? 0)
      const lowest = Math.min(...after)
      assert.ok(
        lowest >= final - 40,
        `滚动越过了第二个目标（最低 ${Math.round(lowest)}，最终 ${Math.round(final)}），快速连点时视口来回抖动`,
      )
      let rises = 0
      for (let i = 1; i < after.length; i++) if (after[i] > after[i - 1] + 2) rises += 1
      assert.ok(rises <= 2, `快速连点后滚动方向出现 ${rises} 次回弹`)
      await page.screenshot({ path: '/tmp/fix-2102a/after-02.png' })
    })

desktop('反馈12#03/#05：子代理卡片定位子会话、层级不用子/孙、可跳转只读视图', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = demo.scenarios.find((item) => item.id === 'subagents')
      const [mainId, childId] = scenario.sessionIds
      await openSession(page, mainId)

      const taskRow = page.locator('.tool-row').filter({ hasText: '子代理' }).first()
      await taskRow.waitFor({ timeout: 10_000 })
      // 反馈2108#02：点子代理行直接进入子代理会话；没有关联到子会话时不会跳转，等待即超时。
      await taskRow.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.ok((await page.locator('[data-turn-id]').count()) > 0, '子代理只读视图没有消息')
      assert.ok((await page.locator('nav[aria-label="会话列表"]').count()) === 1, '只读视图破坏侧栏')
      // 子会话里的 Task 卡片继续跳到下一层（面包屑三层）。
      const nested = page.locator('.tool-row').filter({ hasText: '子代理' }).first()
      await nested.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '竞品文案' }).waitFor({ timeout: 10_000 })
      const crumbText = await page.locator('[data-agent-breadcrumb]').innerText()
      assert.match(crumbText, /价格页前端/, `面包屑缺少上一级：${crumbText}`)
      assert.match(crumbText, /竞品文案/, `面包屑缺少当前层：${crumbText}`)
      await page.locator('button[data-tip^="返回主会话"]').first().click()
      await page.locator('[data-turn-id]').first().waitFor()

      // 右侧代理树：统一叫子代理，用缩进 + 竖引导线，不出现「孙」。
      if (!(await page.locator('[data-group="agents"]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      const agents = page.locator('[data-group="agents"]')
      await agents.waitFor({ timeout: 10_000 })
      const treeText = await agents.innerText()
      assert.equal(/孙代理|孙\b/.test(treeText), false, `代理树仍出现孙代理：${treeText}`)
      assert.ok((await agents.locator('.agent-guide').count()) >= 1, '代理树没有层级引导线')
      await agents.getByRole('button').filter({ hasText: '价格页前端' }).first().click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.ok(childId, '演示场景缺少子代理会话')
    })

desktop('反馈1603#06：代理卡行尾不再有 ⋯，右键子代理行仍可换模型重跑/交回', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      if (!(await page.locator('[data-group="agents"]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      const agents = page.locator('[data-group="agents"]')
      await agents.waitFor({ timeout: 10_000 })
      const row = agents.locator('button[data-tip]').first()
      await row.waitFor({ timeout: 10_000 })
      await row.hover()
      await page.waitForTimeout(200)
      assert.equal(
        await agents.locator('button[aria-label="子代理操作"]').count(),
        0,
        '代理卡仍有行尾 ⋯ 按钮',
      )
      // 功能不丢：右键子代理行打开同一组操作。
      await row.click({ button: 'right' })
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ timeout: 5_000 })
      const text = await menu.innerText()
      assert.match(text, /换模型重跑/, `右键菜单缺少换模型重跑：${text}`)
      assert.match(text, /交回主会话/, `右键菜单缺少交回主会话：${text}`)
      const dir = '/tmp/fix-1603c'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/06-agents-context-menu.png` })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      assert.equal(await page.locator('[role="menu"]').count(), 0, 'Esc 后右键菜单没有关闭')
    })

desktop('反馈1920#02：子代理工具卡不内嵌会话预览，展开后只有一行信息，点击进入子代理会话', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      await page.getByRole('button', { name: '更多', exact: true }).first().click()
      await page.locator('[role="menuitem"]').filter({ hasText: '子代理' }).first().click()
      await page.locator('[role="menu"][aria-label="子代理"] [role="menuitem"]').filter({ hasText: '价格页前端' }).first().evaluate((el) => el.click())
      const card = page.locator('[data-tool-use-id]').filter({ has: page.locator('button.tool-row', { hasText: '子代理' }) }).first()
      await card.locator('.tool-detail').waitFor({ timeout: 10_000 })
      const detail = await card.locator('.tool-detail').innerText()
      assert.match(detail, /价格页前端/, `展开的子代理卡缺少标题行：${detail}`)
      assert.equal(detail.includes('任务提示词'), false, '子代理卡仍内嵌了任务提示词块')
      assert.equal(detail.includes('子代理会话'), false, '子代理卡仍内嵌了子代理会话预览')
      assert.ok((await card.locator('button[aria-label^="打开"]').count()) > 0, '子代理卡缺少进入会话入口')
      await card.locator('button.tool-row').click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      await page.locator('button[data-tip^="返回主会话"]').first().click()
      await page.locator('[data-turn-id]').first().waitFor()
    })

desktop('反馈2108#02：子代理工具行点击直接进入子代理会话，不展开卡片', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const taskRow = page.locator('button.tool-row').filter({ hasText: '子代理' }).first()
      await taskRow.waitFor({ timeout: 10_000 })
      await taskRow.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.equal(await page.locator('.tool-detail').count(), 0, '点击子代理行仍展开了卡片')
      assert.equal(await taskRow.getAttribute('aria-expanded'), null, '子代理行仍是展开按钮')
      await page.locator('button[data-tip^="返回主会话"]').first().click()
      await page.locator('[data-turn-id]').first().waitFor()
    })

desktop('反馈2108#03：点会话图子代理节点进入子代理会话', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const [mainId, childId] = demo.scenarios.find((item) => item.id === 'subagents').sessionIds
      await openSession(page, mainId)
      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      await graph.locator(`div[data-kind="subagent-turn"][data-subagent-id="${childId}"]`).first().click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.match(await page.locator('[data-agent-breadcrumb]').innerText(), /只读/, '子代理节点没有打开只读子会话')
    })

desktop('反馈2108#04：分叉会话的「查看」回到来源会话', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const [mainId, , , forkId] = demo.scenarios.find((item) => item.id === 'subagents').sessionIds
      await openSession(page, mainId)
      // 从会话图点分叉节点打开分叉会话（不经过地址栏的链接），再点横幅「查看」。
      await page.locator('[data-session-graph] div[data-kind="fork"]').first().click()
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), forkId, { timeout: 10_000 })
      await page.getByRole('button', { name: '查看', exact: true }).click()
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), mainId, { timeout: 10_000 })
      await page.getByRole('button', { name: '查看', exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
    })

desktop('反馈12#06/#07：会话信息无顶栏、分组可收起并记住', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      if (!(await panel.count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      await page.locator('[data-group]').first().waitFor({ timeout: 10_000 })
      assert.equal(await panel.getByText('会话信息', { exact: true }).count(), 0, '面板仍有顶栏标题')
      assert.equal(await panel.getByRole('button', { name: '关闭信息面板' }).count(), 0, '面板仍有 × 按钮')
      assert.ok(
        (await page.getByRole('button', { name: '自定义信息面板' }).count()) > 0,
        '顶栏没有自定义信息面板按钮',
      )

      const details = page.locator('[data-group="details"]')
      await details.waitFor()
      const before = await details.boundingBox()
      await details.locator('[data-card-toggle]').click()
      await page.waitForTimeout(250)
      assert.equal(await details.getAttribute('data-collapsed'), 'true', '分组没有收起')
      const after = await details.boundingBox()
      assert.ok(after.height < before.height - 10, `收起后高度未变化：${before.height} → ${after.height}`)
      const stored = await page.evaluate(() => localStorage.getItem('tandem.rightPanelCollapsed.v1') ?? '')
      assert.match(stored, /details/, '收起状态没有记住')
      await page.reload()
      await openSession(page, mainId)
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      await page.locator('[data-group="details"]').waitFor({ timeout: 10_000 })
      assert.equal(
        await page.locator('[data-group="details"]').getAttribute('data-collapsed'),
        'true',
        '重开后收起状态丢失',
      )
    })

desktop('反馈16#06：会话信息面板与卡片宽度不随展开/折叠变化', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      await page.locator('[data-group]').first().waitFor({ timeout: 10_000 })
      const measure = () =>
        page.evaluate(() => {
          const aside = [...document.querySelectorAll('aside')].find((el) =>
            el.querySelector('[data-group]'),
          )
          return {
            aside: aside ? aside.getBoundingClientRect().width : 0,
            cards: [...document.querySelectorAll('[data-group]')].map((el) => ({
              id: el.getAttribute('data-group'),
              width: el.getBoundingClientRect().width,
            })),
          }
        })
      const sameWidth = (a, b, label) => {
        assert.ok(Math.abs(a.aside - b.aside) <= 0.5, `${label}：面板宽度变化 ${a.aside} → ${b.aside}`)
        assert.equal(a.cards.length, b.cards.length, `${label}：卡片数量变化`)
        for (let i = 0; i < a.cards.length; i += 1) {
          assert.equal(a.cards[i].id, b.cards[i].id, `${label}：卡片顺序变化`)
          assert.ok(
            Math.abs(a.cards[i].width - b.cards[i].width) <= 0.5,
            `${label}：卡片 ${a.cards[i].id} 宽度变化 ${a.cards[i].width} → ${b.cards[i].width}`,
          )
        }
      }

      const before = await measure()
      const toggles = page.locator('[data-group] [data-card-toggle]')
      const count = await toggles.count()
      assert.ok(count > 0, '会话信息面板没有可收起的分组')
      for (let i = 0; i < count; i += 1) {
        await toggles.nth(i).click()
        await page.waitForTimeout(220)
        sameWidth(before, await measure(), `第 ${i + 1} 张卡片收起`)
        await toggles.nth(i).click()
        await page.waitForTimeout(220)
        sameWidth(before, await measure(), `第 ${i + 1} 张卡片展开`)
      }

    })

desktop('反馈16#07/#08：卡片折叠箭头与拖动手柄在标题右侧且常显', async (page) => {
      // 前序用例可能把 details 卡折叠状态写进偏好；本用例要求展开态，先清掉再打开。
      await page.evaluate(() => localStorage.removeItem('tandem.rightPanelCollapsed.v1'))
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const card = page.locator('[data-group="details"]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      if ((await card.getAttribute('data-collapsed')) === 'true') {
        await card.locator('[data-card-toggle]').first().click()
        await page.waitForTimeout(220)
      }
      const title = card.locator('[data-card-toggle] h3').first()
      const toggle = card.locator('[data-card-toggle]').first()
      const chevron = toggle.locator('svg').last()
      const handle = card.locator('[aria-label^="拖动排序"]').first()
      const [titleBox, chevronBox, handleBox] = await Promise.all([
        title.boundingBox(),
        chevron.boundingBox(),
        handle.boundingBox(),
      ])
      assert.ok(titleBox && chevronBox && handleBox, '标题/折叠箭头/拖动手柄缺少布局')
      assert.ok(
        chevronBox.x >= titleBox.x + titleBox.width - 1,
        `折叠箭头不在标题文字右侧：title ${titleBox.x}+${titleBox.width}, chevron ${chevronBox.x}`,
      )
      assert.ok(
        handleBox.x > chevronBox.x,
        `拖动手柄不在标题行右侧：chevron ${chevronBox.x}, handle ${handleBox.x}`,
      )
      assert.equal(
        await chevron.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '折叠箭头不是常显',
      )
      assert.equal(
        await handle.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '拖动手柄只有 hover 才显示',
      )
      // 点击标题行（非箭头/手柄）仍可折叠。
      await title.click()
      await page.waitForTimeout(220)
      assert.equal(await card.getAttribute('data-collapsed'), 'true', '点击标题行没有折叠')
      await title.click()
      await page.waitForTimeout(220)
      assert.equal(await card.getAttribute('data-collapsed'), null, '再次点击标题行没有展开')
    })

desktop('反馈16#03/#09：会话图高度按轮数自适应并封顶', async (page) => {
      const graphHeight = async () => {
        const el = page.locator('[data-group="graph"] [data-graph-height]').first()
        await el.waitFor({ state: 'attached', timeout: 10_000 })
        return Number(await el.getAttribute('data-graph-height'))
      }
      await openSession(page, 'nockpt')
      assert.equal(await graphHeight(), 84, '2 轮时会话图高度不是最小高度（3 行）')

      await openSession(page, 'turns4')
      assert.equal(await graphHeight(), 112, '4 轮时会话图高度没有随轮数增长')

      await openSession(page, 'huge')
      assert.equal(await graphHeight(), 336, '30 轮以上会话图高度没有封顶到 12 行 / 336px')
      const scrollable = await page.evaluate(() => {
        const el = document.querySelector('[data-group="graph"] [data-graph-height]')
        return el ? { client: el.clientHeight, scroll: el.scrollHeight } : null
      })
      assert.ok(scrollable && scrollable.scroll > scrollable.client, '封顶后会话图内部不能滚动')
    })

desktop('会话图：时间倒序、子代理始终展开、悬停会话线高亮、子代理视图回主会话', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/孙代理/分叉会话')
      const [mainId, childId, , forkId] = scenario.sessionIds
      const mainTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)).title
      const titles = new Map()
      for (const id of scenario.sessionIds) {
        titles.set(id, (await api(base, token, `/api/sessions/${encodeURIComponent(id)}`)).title)
      }
      await openSession(page, mainId)

      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const group = page.locator('[data-group="graph"]').first()
      const scroller = graph.locator('[data-graph-height]').first()

      // 反馈1926#01：卡片不再显示「N 轮 · N 子代理 · N 分叉」汇总行。
      assert.doesNotMatch(
        await group.innerText(),
        /\d+\s*轮\s*·\s*\d+\s*子代理/,
        '会话图仍显示汇总描述行',
      )
      // 反馈1926#08：不再有「结果已返回」行。
      assert.equal(
        await graph.getByText('结果已返回', { exact: true }).count(),
        0,
        '会话图仍有「结果已返回」行',
      )
      // 反馈1926#02/#04：没有展开/收起按钮与标记，子代理直接展开。
      assert.equal(
        await graph.locator('[data-expand-subagent]').count(),
        0,
        '会话图仍有子代理展开按钮',
      )
      assert.doesNotMatch(await graph.innerText(), /[▸└]/, '会话图仍有展开/收起标记')
      assert.ok(
        (await graph.locator('div[data-kind="subagent-turn"]').count()) >= 2,
        '子代理没有直接展开成自己的轮次',
      )
      // 反馈1926#05：主线节点没有轮次序号（文字以用户发言开头）。
      const turnTexts = await graph.locator('div[data-kind="turn"]').allInnerTexts()
      assert.ok(turnTexts.length > 3, `会话图主线轮次太少：${turnTexts.length}`)
      assert.ok(
        turnTexts.every((text) => !/^\s*\d/.test(text)),
        `主线节点仍带轮次序号：${turnTexts.find((text) => /^\s*\d/.test(text))}`,
      )
      // 反馈1926#09：行内与 tooltip 都不显示 token/耗时等用量。
      const graphText = await graph.innerText()
      assert.doesNotMatch(graphText, /tok|token/i, '会话图仍在显示 token')
      assert.doesNotMatch(graphText, /\b\d+(?:\.\d+)?k\b/, '会话图仍在显示用量数字')
      const tips = await graph
        .locator('div[data-kind]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-tip') ?? ''))
      assert.ok(
        tips.every((tip) => !/tok|token|耗时|\$\d/i.test(tip)),
        `节点 tooltip 仍带用量：${tips.find((tip) => /tok|token|耗时|\$\d/i.test(tip))}`,
      )

      // 反馈1926#06：时间倒序，最新一轮在最上，越早越下。
      const showTop = async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        await page.waitForFunction(
          () => {
            const root = document.querySelector('[data-session-graph]')
            return (
              !!root?.querySelector('div[data-kind="fork"]') &&
              [...root.querySelectorAll('div[data-kind="turn"]')].some((el) =>
                el.textContent?.includes('收到，先按这个做'),
              )
            )
          },
          null,
          { timeout: 5_000 },
        )
      }
      await showTop()
      assert.match(
        (await graph.locator('div[data-kind="turn"]').first().innerText()).trim(),
        /收到，先按这个做/,
        '会话图最上面不是最新一轮',
      )
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-session-graph] div[data-kind="turn"]')].some((el) =>
            el.textContent?.includes('我们先把价格页'),
          ),
        null,
        { timeout: 5_000 },
      )
      assert.match(
        (await graph.locator('div[data-kind="turn"]').last().innerText()).trim(),
        /我们先把价格页/,
        '会话图最下面不是最早一轮',
      )
      await showTop()

      // 泳道色与节点形状仍按 2026-11-09 决定：所有节点同一 8px 圆，主线/子代理/分叉颜色不同。
      assert.ok((await graph.locator('[data-marker="circle"]').count()) >= 3, '会话图节点不足')
      assert.equal(
        await graph.locator('[data-marker]:not([data-marker="circle"])').count(),
        0,
        '存在非圆形节点',
      )
      const colors = await graph.evaluate((root) => {
        const color = (kind) => {
          const el = root.querySelector(`div[data-kind="${kind}"] [data-marker="circle"]`)
          return el ? getComputedStyle(el).backgroundColor : ''
        }
        return { main: color('turn'), sub: color('subagent-turn'), fork: color('fork') }
      })
      assert.ok(colors.main && colors.sub && colors.fork, `缺少主线/子代理/分叉节点 ${JSON.stringify(colors)} kinds=${await graph.locator('div[data-kind]').evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')).join(','))}`)
      assert.notEqual(colors.main, colors.sub, '子代理泳道与主线同色')
      assert.notEqual(colors.sub, colors.fork, '子代理与分叉泳道同色')
      // 子代理有汇回父会话的线；分叉线不汇回，节点行尾有「分叉」标签。
      assert.ok(
        (await graph.locator('path[data-kind="subagent"][data-merge="1"]').count()) > 0,
        '子代理分支没有汇回线',
      )
      assert.ok((await graph.locator('path[data-kind="fork"]').count()) > 0, '分叉没有连线')
      assert.equal(
        await graph.locator('path[data-kind="fork"][data-merge]').count(),
        0,
        '分叉不应汇回主线',
      )
      // 分叉会话的起点节点带着「分叉」标记（其余节点是它自己的轮次）。
      assert.match(
        await graph.locator('div[data-kind="fork"][data-session-label]').first().innerText(),
        /分叉/,
      )

      // 几何：连线落在泳道中心/行中心；汇回线从分支最后一行接回父泳道；主线贯穿首尾轮。
      const geometry = await graph.evaluate((root) => {
        const rootBox = root.getBoundingClientRect()
        const center = (el) => {
          const box = el.getBoundingClientRect()
          return {
            x: box.left - rootBox.left + box.width / 2,
            y: box.top - rootBox.top + box.height / 2,
          }
        }
        const nodes = [...root.querySelectorAll('div[data-kind]')].map((el) => {
          const marker = el.querySelector('[data-marker="circle"]')
          return {
            kind: el.getAttribute('data-kind'),
            lane: Number(el.getAttribute('data-lane')),
            row: Number(el.getAttribute('data-row')),
            ...(marker ? center(marker) : { x: -999, y: -999 }),
          }
        })
        const laneX = new Map()
        for (const node of nodes) laneX.set(node.lane, node.x)
        const svg = root.querySelector('[data-session-graph-edges]')
        const svgBox = svg.getBoundingClientRect()
        const paths = [...svg.querySelectorAll('path[data-kind]')].map((path) => {
          const start = path.getPointAtLength(0)
          const end = path.getPointAtLength(path.getTotalLength())
          return {
            kind: path.getAttribute('data-kind'),
            owner: path.getAttribute('data-edge-owner'),
            merge: path.getAttribute('data-merge') === '1',
            fromLane: Number(path.getAttribute('data-from-lane')),
            toLane: Number(path.getAttribute('data-to-lane')),
            fromRow: Number(path.getAttribute('data-from-row')),
            toRow: Number(path.getAttribute('data-to-row')),
            start: { x: start.x + svgBox.left - rootBox.left, y: start.y + svgBox.top - rootBox.top },
            end: { x: end.x + svgBox.left - rootBox.left, y: end.y + svgBox.top - rootBox.top },
          }
        })
        return { nodes, paths, laneX: [...laneX] }
      })
      const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= 1
      const laneXOf = (lane) => geometry.laneX.find(([id]) => id === lane)?.[1]
      const onLane = (point, lane) => Math.abs(point.x - (laneXOf(lane) ?? -999)) <= 0.8
      const onRowCenter = (y) => Math.abs(((y - 14) % 28 + 28) % 28) <= 0.8
      const nodeAt = (lane, row) =>
        geometry.nodes.find((node) => node.lane === lane && node.row === row)
      const mainNodes = geometry.nodes.filter((node) => node.kind === 'turn')
      assert.ok(mainNodes.length >= 6, `演示会话主线轮次太少：${mainNodes.length}`)
      for (const path of geometry.paths) {
        assert.ok(path.owner, '连线缺少归属会话')
        assert.ok(onLane(path.start, path.fromLane), `连线起点不在泳道中心：${JSON.stringify(path.start)}`)
        assert.ok(onLane(path.end, path.toLane), `连线终点不在泳道中心：${JSON.stringify(path.end)}`)
        assert.ok(onRowCenter(path.start.y), `连线起点不在行中心：${path.start.y}`)
        assert.ok(onRowCenter(path.end.y), `连线终点不在行中心：${path.end.y}`)
      }
      const mainPath = geometry.paths.find((path) => path.kind === 'main')
      assert.ok(mainPath, '缺少主线竖线')
      assert.ok(
        mainNodes.every((node) => Math.abs(node.x - mainNodes[0].x) <= 0.5),
        '主线节点圆心 x 不一致',
      )
      assert.ok(
        mainNodes.every((node) => node.y >= mainPath.start.y - 1 && node.y <= mainPath.end.y + 1),
        '主线节点不在竖线范围内',
      )
      const branchOut = geometry.paths.filter(
        (path) => path.kind === 'subagent' && path.fromLane === 0 && path.toLane > 0,
      )
      const branchBack = geometry.paths.filter(
        (path) => path.kind === 'subagent' && path.fromLane > 0 && path.toLane === 0,
      )
      assert.ok(branchOut.length >= 2, '演示会话应有多个子代理分出线')
      assert.ok(branchBack.length >= 2, '子代理没有汇回父会话')
      for (const path of branchOut) {
        const parent = nodeAt(path.fromLane, path.fromRow)
        assert.ok(parent && near(path.start, parent), '子代理分出线起点不是父轮节点')
        assert.ok(onLane(path.end, path.toLane), '子代理分出线终点不在子泳道')
      }
      for (const path of branchBack) {
        // 汇回从子代理最后一行（泳道上的节点）出发，接回父会话的下一轮或轨道行。
        const last = geometry.nodes.find(
          (node) => node.lane === path.fromLane && near(path.start, node),
        )
        assert.ok(last, '汇回线起点没有接上子代理泳道上的节点')
        assert.ok(onLane(path.end, 0), '汇回线终点不在主线泳道')
        const target = nodeAt(0, path.toRow)
        if (!target) {
          // 父会话最后一轮派出的子代理：汇回主线轨道上的空行（在主线竖线范围内）。
          assert.ok(
            path.end.y >= mainPath.start.y - 1 && path.end.y <= mainPath.end.y + 1,
            '汇回线终点既不在父轮节点也不在主线轨道上',
          )
        }
      }
      const matchNode = (point, kind) =>
        geometry.nodes.some((node) => (!kind || node.kind === kind) && near(point, node))
      const forkPath = geometry.paths.find((path) => path.kind === 'fork')
      assert.ok(forkPath, '缺少分叉线')
      assert.ok(matchNode(forkPath.start, 'turn'), '分叉线起点不是主线节点')
      assert.ok(matchNode(forkPath.end, 'fork'), '分叉线终点不是分支节点')
      assert.equal(
        geometry.paths.some((path) => path.kind === 'fork' && path.toLane === 0),
        false,
        '分叉线不应汇回主线',
      )

      // 反馈1926#10：悬停主线时整条线高亮、其余线降亮，tooltip 显示会话名。
      const mainHover = await page.evaluate(() => {
        const scroller = document.querySelector('[data-session-graph] [data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const hit of document.querySelectorAll(
          '[data-session-graph-edges] [data-edge-hit][data-edge-kind="main"]',
        )) {
          const total = hit.getTotalLength()
          const box = hit.ownerSVGElement.getBoundingClientRect()
          for (let i = 1; i <= 9; i += 1) {
            const point = hit.getPointAtLength((total * i) / 10)
            const x = Math.round(box.left + point.x)
            const y = Math.round(box.top + point.y)
            if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
              const top = document.elementFromPoint(x, y)
              // 必须是这一条线（交叉处上层可能是另一条线，归属会串）。
              if (top !== hit) continue
              return {
                x,
                y,
                owner: hit.getAttribute('data-edge-owner'),
                label: hit.getAttribute('data-tip'),
              }
            }
          }
        }
        return null
      })
      assert.ok(mainHover, '主线没有可悬停的命中区')
      await page.mouse.move(mainHover.x, mainHover.y)
      await page.waitForTimeout(700)
      const hoverState = await graph.evaluate((root, owner) => {
        const paths = [...root.querySelectorAll('path[data-kind]')]
        const mine = paths.filter((path) => path.getAttribute('data-edge-owner') === owner)
        const others = paths.filter((path) => path.getAttribute('data-edge-owner') !== owner)
        return {
          mine: mine.length,
          marked: mine.every((path) => path.getAttribute('data-hovered') === 'true'),
          mineOpacity: Math.min(...mine.map((path) => Number(getComputedStyle(path).opacity))),
          otherOpacity: others.length
            ? Math.max(...others.map((path) => Number(getComputedStyle(path).opacity)))
            : 0,
        }
      }, mainHover.owner)
      assert.ok(hoverState.mine > 0, '悬停线没有归属高亮')
      assert.ok(hoverState.marked, '悬停的线没有被标记高亮')
      assert.ok(hoverState.mineOpacity > 0.9, `悬停线没有保持全亮：${hoverState.mineOpacity}`)
      assert.ok(hoverState.otherOpacity <= 0.3, `其他线没有降亮：${hoverState.otherOpacity}`)
      assert.equal(mainHover.label, mainTitle, '主线 tooltip 不是当前会话名')
      assert.equal(
        (await page.locator('#tandem-tooltip[data-open]').innerText()).trim(),
        mainTitle,
        '悬停主线的 tooltip 没有显示会话名',
      )
      await page.mouse.move(4, 4)
      await page.waitForTimeout(200)

      // 悬停子代理线：tooltip 为该子代理会话名。
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(300)
      const subHover = await page.evaluate(() => {
        const scroller = document.querySelector('[data-session-graph] [data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const hit of document.querySelectorAll(
          '[data-session-graph-edges] [data-edge-hit][data-edge-kind="subagent"]',
        )) {
          const total = hit.getTotalLength()
          const box = hit.ownerSVGElement.getBoundingClientRect()
          for (let i = 1; i <= 9; i += 1) {
            const point = hit.getPointAtLength((total * i) / 10)
            const x = Math.round(box.left + point.x)
            const y = Math.round(box.top + point.y)
            if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
              const top = document.elementFromPoint(x, y)
              // 必须是这一条线（交叉处上层可能是另一条线，归属会串）。
              if (top !== hit) continue
              return {
                x,
                y,
                owner: hit.getAttribute('data-edge-owner'),
                label: hit.getAttribute('data-tip'),
              }
            }
          }
        }
        return null
      })
      assert.ok(subHover, '子代理线没有可悬停的命中区')
      await page.mouse.move(subHover.x, subHover.y)
      await page.waitForTimeout(700)
      assert.equal(subHover.label, titles.get(subHover.owner), '子代理线 tooltip 不是该会话名')
      assert.equal(
        (await page.locator('#tandem-tooltip[data-open]').innerText()).trim(),
        titles.get(subHover.owner),
        '悬停子代理线没有 tip 出会话名',
      )
      assert.ok(
        (await graph.locator(`path[data-edge-owner="${subHover.owner}"][data-hovered="true"]`).count()) > 0,
        '悬停子代理线没有高亮该会话轨道',
      )
      await page.mouse.move(4, 4)

      // 反馈1926#07：覆盖式滚动条让位到卡片外，不挡卡片头部的全高展开控件。
      await scroller.evaluate((el) => {
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, 60)
      })
      await page.waitForSelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]', { timeout: 3_000 })
      const gutter = await page.evaluate(() => {
        const bar = document.querySelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]')
        const card = document.querySelector('[data-group="graph"]')
        const control = card?.querySelector('[aria-label="全高显示会话图"]')
        const barBox = bar.getBoundingClientRect()
        const cardBox = card.getBoundingClientRect()
        const controlBox = control.getBoundingClientRect()
        const hit = document.elementFromPoint(
          controlBox.left + controlBox.width / 2,
          controlBox.top + controlBox.height / 2,
        )
        return {
          barLeft: barBox.left,
          cardRight: cardBox.right,
          hitControl: !!hit?.closest?.('[aria-label="全高显示会话图"]'),
          hitBar: hit === bar,
        }
      })
      assert.ok(
        gutter.barLeft >= gutter.cardRight - 0.5,
        `覆盖滚动条压住卡片：${gutter.barLeft} < ${gutter.cardRight}`,
      )
      assert.ok(gutter.hitControl && !gutter.hitBar, '覆盖滚动条挡住了卡片头部控件')

      // 反馈1926#03：在子代理只读视图里点会话图主线节点，回到主会话并定位该轮。
      await graph.locator('div[data-kind="subagent-turn"]').first().click()
      const breadcrumb = page.locator('[data-agent-breadcrumb]')
      await breadcrumb.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await breadcrumb.innerText(), /只读/, '子代理节点没有打开只读子会话')
      await showTop()
      await graph.locator('div[data-kind="turn"]').first().click()
      await breadcrumb.waitFor({ state: 'detached', timeout: 10_000 })
      await page.locator('[data-turn-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '从子代理视图返回后消息仍被高亮')

      // 卡片右上角可全高展开，顶部返回恢复面板；全高页头不再有汇总。
      await group.locator('[aria-label="全高显示会话图"]').click()
      const full = page.locator('[data-graph-full]')
      await full.waitFor({ state: 'visible', timeout: 10_000 })
      assert.doesNotMatch(await full.innerText(), /\d+\s*轮\s*·\s*\d+\s*子代理/, '全高会话图仍有汇总行')
      await full.getByRole('button', { name: /返回/ }).click()
      await full.waitFor({ state: 'detached', timeout: 5_000 })

      // 点分叉节点打开那个分叉会话。
      await showTop()
      const forkTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)).title
      await graph.locator('div[data-kind="fork"]').first().click()
      await page.getByText(forkTitle, { exact: true }).first().waitFor({ timeout: 10_000 })
    })

desktop('反馈0220#08：一棵会话树共用一张拓扑，分叉以自己为主线（仿 git 切分支）', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少分叉/子代理会话')
      const [mainId, , , forkId] = scenario.sessionIds
      const turnsOf = async (id) =>
        (await api(base, token, `/api/sessions/${encodeURIComponent(id)}/turns`)).turns.map(
          (turn) => turn.messageId,
        )
      const mainTurns = await turnsOf(mainId)
      const forkTurns = await turnsOf(forkId)
      const forkDetail = await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)
      const mainDetail = await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)
      const forkOwn = forkTurns.filter((id) => !mainTurns.includes(id))
      // 分叉点可能落在某一轮的助手消息上：取该消息所属的用户轮。
      const pointIndex = mainDetail.messages.findIndex(
        (message) => message.id === forkDetail.forkedFrom?.messageId,
      )
      let forkPoint = mainTurns[0]
      for (let i = 0; i <= pointIndex; i += 1) {
        const message = mainDetail.messages[i]
        if (mainTurns.includes(message.id)) forkPoint = message.id
      }
      const rootPrefix = mainTurns.slice(0, mainTurns.indexOf(forkPoint) + 1)
      assert.ok(forkOwn.length >= 2, '演示分叉缺少自有轮次')
      assert.ok(rootPrefix.length >= 2, '演示分叉缺少分叉点之前的来源轮次')

      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      const scroller = page.locator('[data-group="graph"] [data-graph-height]').first()
      const waitLoaded = async () => {
        await graph.waitFor({ state: 'visible', timeout: 15_000 })
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-group="graph"] [data-graph-count]')
            return Number(el?.getAttribute('data-graph-count') ?? 0) > 0
          },
          null,
          { timeout: 15_000 },
        )
      }
      // 虚拟滚动：逐段滚动收集所有节点（按 data-row 定位，不依赖当前视口）。
      const collect = async () => {
        const found = new Map()
        const height = await scroller.evaluate((el) => el.clientHeight)
        const total = await scroller.evaluate((el) => el.scrollHeight)
        for (let top = 0; top <= total; top += Math.max(40, height - 40)) {
          await scroller.evaluate((el, y) => {
            el.scrollTop = y
          }, top)
          await page.waitForTimeout(40)
          const batch = await graph.locator('[data-kind][data-row]').evaluateAll((els) =>
            els.map((el) => ({
              id: el.getAttribute('data-graph-turn-id'),
              session: el.getAttribute('data-session-id'),
              lane: Number(el.getAttribute('data-lane')),
              row: Number(el.getAttribute('data-row')),
              kind: el.getAttribute('data-kind'),
              trunk: el.getAttribute('data-trunk') === 'true',
              text: el.textContent ?? '',
            })),
          )
          for (const item of batch) found.set(item.id, item)
        }
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        return [...found.values()]
      }

      await openSession(page, mainId)
      await waitLoaded()
      const mainCount = Number(await scroller.getAttribute('data-graph-count'))
      const mainNodes = await collect()
      assert.equal(mainNodes.length, mainCount, `主会话视图节点没有全部收集到：${mainNodes.length}/${mainCount}`)
      const mainTrunk = mainNodes
        .filter((node) => node.trunk)
        .sort((a, b) => a.row - b.row)
        .map((node) => node.id)
      assert.deepEqual(mainTrunk, [...mainTurns].reverse(), '主会话视图的主线不是本会话轮次（最新在上）')
      assert.ok(
        mainNodes.every((node) => (node.trunk ? node.lane === 0 : true)),
        '主线节点不在第 0 列',
      )

      await openSession(page, forkId)
      await waitLoaded()
      const forkCount = Number(await scroller.getAttribute('data-graph-count'))
      const forkNodes = await collect()
      // 同一棵树：节点完全一样，只有主线不同。
      assert.equal(forkCount, mainCount, `分叉视图节点数与主会话视图不一致：${forkCount} vs ${mainCount}`)
      assert.deepEqual(
        forkNodes.map((node) => node.id).sort(),
        mainNodes.map((node) => node.id).sort(),
        '分叉视图与主会话视图的节点集合不一致',
      )
      const forkTrunk = forkNodes
        .filter((node) => node.trunk)
        .sort((a, b) => a.row - b.row)
        .map((node) => node.id)
      assert.deepEqual(
        forkTrunk,
        [...forkOwn].reverse().concat([...rootPrefix].reverse()),
        '分叉视图主线不是「分叉点前的来源轮次 + 分叉自己的轮次」',
      )
      assert.ok(
        forkNodes.filter((node) => node.trunk).every((node) => node.lane === 0),
        '分叉视图主线不在第 0 列（没有一条线上去）',
      )
      // 来源会话在分叉点之后的轮次是分支泳道（不是单节点「原会话」支线）。
      assert.doesNotMatch(await graph.innerText(), /原会话/, '分叉视图仍在画「原会话」支线')
      const sourceBranch = forkNodes.filter((node) => node.session === mainId && !node.trunk)
      assert.deepEqual(
        sourceBranch.sort((a, b) => b.row - a.row).map((node) => node.id),
        mainTurns.slice(mainTurns.indexOf(forkPoint) + 1),
        '分叉视图里来源会话分叉点之后的轮次没有画成分支泳道',
      )
      assert.equal(new Set(sourceBranch.map((node) => node.lane)).size, 1, '来源会话的分支泳道不连续')
      const laneNodes = new Map()
      for (const node of forkNodes) laneNodes.set(node.lane, (laneNodes.get(node.lane) ?? 0) + 1)
      const forkEdges = await graph.locator('path[data-kind="fork"][data-from-lane][data-to-lane]').evaluateAll((els) =>
        els.map((el) => ({
          fromLane: Number(el.getAttribute('data-from-lane')),
          toLane: Number(el.getAttribute('data-to-lane')),
          fromRow: Number(el.getAttribute('data-from-row')),
          owner: el.getAttribute('data-edge-owner'),
          merge: el.getAttribute('data-merge') === '1',
        })),
      )
      const connectors = forkEdges.filter((edge) => edge.fromLane !== edge.toLane)
      assert.ok(connectors.length > 0, '分叉视图缺少分叉连线')
      for (const edge of connectors) {
        assert.ok(
          (laneNodes.get(edge.toLane) ?? 0) > 1,
          `分叉连线连到只有 1 个节点的支线（不是 git 图）：lane ${edge.toLane}`,
        )
      }
      const point = forkNodes.find((node) => node.id === forkPoint)
      assert.ok(point, '分叉视图缺少分叉点轮次节点')
      assert.ok(
        connectors.some((edge) => edge.owner === mainId && edge.fromRow === point.row),
        '来源会话的分支不是从分叉点那一轮分出去的',
      )
      // 主会话上的子代理节点在分叉视图里可见。
      const subagentIds = new Set(scenario.sessionIds.slice(1).filter((id) => id !== forkId))
      const subNodes = forkNodes.filter((node) => subagentIds.has(node.session))
      assert.ok(subNodes.length >= 3, `分叉视图看不到主会话上的子代理节点：${subNodes.length}`)
      assert.ok(
        subNodes.every((node) => node.kind === 'subagent-turn'),
        '子代理节点类型不对',
      )
    })

desktop('反馈0220#07：悬停浮层名称行高亮左侧拓扑、点节点/线跳转会话；命中区加大', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      const [mainId, , , forkId] = scenario.sessionIds
      const forkTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)).title
      await openSession(page, mainId)
      const row = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await row.waitFor({ timeout: 15_000 })
      const card = page.locator('[data-hover-card]').first()
      const topology = card.locator('[data-session-topology]')
      const cardScroller = card.locator('[data-graph-height]').first()
      const openCard = async () => {
        await page.mouse.move(4, 4)
        await row.hover()
        await card.waitFor({ state: 'visible', timeout: 10_000 })
        await topology.waitFor({ state: 'visible', timeout: 10_000 })
        // 卡片高度封顶后内部滚动：滚到底看分叉/子代理分支，并让目标进入命中区。
        await cardScroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await page.waitForTimeout(150)
      }
      await openCard()

      // 浮层里确实有分叉/派出点节点（不是根节点一个点伸出几条线）。
      // 拓扑同样做了虚拟滚动：逐段滚动收集所有节点后再对连线起点。
      const scan = async () => {
        const combined = new Set()
        const height = await cardScroller.evaluate((el) => el.clientHeight)
        const total = await cardScroller.evaluate((el) => el.scrollHeight)
        for (let top = 0; top <= total; top += Math.max(40, height - 40)) {
          await cardScroller.evaluate((el, y) => {
            el.scrollTop = y
          }, top)
          await page.waitForTimeout(40)
          const batch = await topology.locator('[data-attach-point="true"]').evaluateAll((els) =>
            els.map((el) => `${el.getAttribute('data-lane')}:${el.getAttribute('data-row')}`),
          )
          for (const key of batch) combined.add(key)
        }
        await cardScroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        return combined
      }
      const attachPoints = await scan()
      assert.ok(attachPoints.size >= 2, '悬停拓扑图没有画出分叉点/派出点轮次')
      const attachEdges = await topology
        .locator('path[data-edge-hit][data-edge-kind="subagent"], path[data-edge-hit][data-edge-kind="fork"]')
        .evaluateAll((els) =>
          els
            .map((el) => ({
              fromLane: Number(el.getAttribute('data-from-lane')),
              toLane: Number(el.getAttribute('data-to-lane')),
              fromRow: Number(el.getAttribute('data-from-row')),
              merge: el.getAttribute('data-merge') === '1',
            }))
            .filter((edge) => edge.fromLane !== edge.toLane && !edge.merge),
        )
      assert.ok(attachEdges.length > 0, '悬停拓扑图缺少分叉/子代理连线')
      for (const edge of attachEdges) {
        assert.ok(
          attachPoints.has(`${edge.fromLane}:${edge.fromRow}`),
          `分叉/子代理泳道不是连在分叉点/派出点轮次上（${edge.fromLane}:${edge.fromRow}）`,
        )
      }

      // 悬停分叉会话的名称行：左侧该会话的线与节点一起高亮。
      const forkRow = topology.locator(`[data-session-id="${forkId}"][data-kind]`).first()
      await forkRow.waitFor({ state: 'attached', timeout: 10_000 })
      await forkRow.hover()
      await page.waitForTimeout(150)
      const hovered = await topology.evaluate((root, owner) => {
        const mine = [...root.querySelectorAll('path[data-kind][data-edge-owner]')].filter(
          (el) => el.getAttribute('data-edge-owner') === owner,
        )
        const rows = [...root.querySelectorAll('[data-session-id]')].filter(
          (el) => el.getAttribute('data-session-id') === owner,
        )
        return {
          mine: mine.length,
          marked: mine.every((el) => el.getAttribute('data-hovered') === 'true'),
          rows: rows.length,
          rowHighlighted: rows.some((el) => {
            const bg = getComputedStyle(el).backgroundColor
            return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
          }),
        }
      }, forkId)
      assert.ok(hovered.mine > 0, '悬停名称行后左侧没有该会话的线')
      assert.ok(hovered.marked, '悬停名称行后左侧对应的线没有高亮')
      assert.ok(hovered.rows > 0 && hovered.rowHighlighted, '悬停名称行后对应节点没有高亮')

      // 点名称行跳转会话。
      await forkRow.click()
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), forkId, { timeout: 10_000 })

      // 点左侧的线也跳转。
      await openSession(page, mainId)
      await openCard()
      // 取该会话自己泳道竖线上、没有被别的线盖住的一点再点。
      const linePoint = await topology.evaluate((root, owner) => {
        const scroller = root.querySelector('[data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const el of root.querySelectorAll('path[data-edge-hit]')) {
          if (el.getAttribute('data-edge-owner') !== owner) continue
          if (el.getAttribute('data-from-lane') !== el.getAttribute('data-to-lane')) continue
          const total = el.getTotalLength()
          const box = el.ownerSVGElement.getBoundingClientRect()
          for (let i = 2; i <= 8; i += 1) {
            const point = el.getPointAtLength((total * i) / 10)
            const x = Math.round(box.left + point.x)
            const y = Math.round(box.top + point.y)
            if (y <= rect.top + 8 || y >= rect.bottom - 8) continue
            if (x <= rect.left + 8 || x >= rect.right - 8) continue
            if (document.elementFromPoint(x, y) !== el) continue
            return { x, y }
          }
        }
        return null
      }, forkId)
      assert.ok(linePoint, '找不到可点击的分支泳道线')
      await page.mouse.click(linePoint.x, linePoint.y)
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), forkId, { timeout: 10_000 })

      // 命中区：命中描边覆盖线中心两侧各 6px，偏 6px 悬停仍能命中并 tip 出会话名。
      await openSession(page, mainId)
      await openCard()
      const hit = await topology.evaluate((root, owner) => {
        const scroller = root.querySelector('[data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const el of root.querySelectorAll('path[data-edge-hit]')) {
          if (el.getAttribute('data-edge-owner') !== owner) continue
          const total = el.getTotalLength()
          const box = el.ownerSVGElement.getBoundingClientRect()
          for (let i = 2; i <= 8; i += 1) {
            const point = el.getPointAtLength((total * i) / 10)
            const x = Math.round(box.left + point.x)
            const y = Math.round(box.top + point.y)
            if (y <= rect.top + 8 || y >= rect.bottom - 8) continue
            if (x <= rect.left + 8 || x >= rect.right - 8) continue
            // 偏 6px 处命中的必须仍是这条线（不是相邻泳道的线）。
            const offset = document.elementFromPoint(x + 6, y)
            if (offset?.getAttribute?.('data-edge-owner') !== owner) continue
            return { x, y }
          }
        }
        return null
      }, forkId)
      assert.ok(hit, '找不到分叉会话的线')
      await page.mouse.move(hit.x + 6, hit.y)
      await page.waitForTimeout(700)
      assert.equal(
        (await page.locator('#tandem-tooltip[data-open]').innerText()).trim(),
        forkTitle,
        '线外 6px 悬停没有命中（命中区太窄）',
      )
      await page.mouse.move(4, 4)
    })

desktop('反馈0220#06：没有分叉/子代理的会话不弹悬停拓扑卡片；树里有分支才弹', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      const mainId = scenario.sessionIds[0]

      await openSession(page, 'long')
      const singleId = await page.evaluate(() => window.location.hash.match(/\/s\/([^/?#]+)/)?.[1])
      assert.ok(singleId, '没有打开单会话')
      const singleRow = page.locator(`[data-session-row][data-session-id="${singleId}"]`).first()
      await singleRow.waitFor({ timeout: 15_000 })
      await singleRow.hover()
      await page.waitForTimeout(900)
      assert.equal(
        await page.locator('[data-hover-card]').count(),
        0,
        '没有分叉或子代理的会话仍弹出了悬停卡片',
      )
      await page.mouse.move(4, 4)

      await openSession(page, mainId)
      const treeRow = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await treeRow.hover()
      await page.locator('[data-hover-card]').first().waitFor({ state: 'visible', timeout: 10_000 })
    })

desktop('反馈0220#06：进入反馈模式后悬停拓扑卡片停住不消失（共享层）', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = state.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const row = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await row.waitFor({ timeout: 15_000 })
      await row.hover()
      const card = page.locator('[data-hover-card]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.press('Control+Shift+F')
      await page.waitForFunction(() => document.documentElement.classList.contains('feedback-mode'), null, {
        timeout: 5_000,
      })
      // 指针移到捕获层上（离开会话行），卡片不能被指针离开事件收起。
      await page.mouse.move(4, 4)
      await page.waitForTimeout(1200)
      assert.ok(await card.isVisible(), '进入反馈模式后悬停拓扑卡片消失了')
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        () => !document.documentElement.classList.contains('feedback-mode'),
        null,
        { timeout: 5_000 },
      )
    })

desktop('反馈0220#01：外部会话的会话图节点点击能定位该轮', async (page) => {
      const codexId = globalThis.__regCodexId
      assert.ok(codexId, '缺少 Codex 外部会话夹具')
      await openExternal(page, 'codex', codexId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const node = graph.locator('[data-kind="turn"]').nth(1)
      await node.waitFor({ state: 'attached', timeout: 10_000 })
      const messageId = await node.getAttribute('data-graph-turn-id')
      assert.ok(messageId, '外部会话图节点没有携带消息 id')
      await node.click()
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        messageId,
        { timeout: 12_000 },
      )
    })

desktop('反馈2156#01：会话图跳转只定位，目标消息没有高亮背景', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const node = graph.locator('div[data-kind="turn"]').nth(2)
      await node.waitFor({ state: 'attached', timeout: 15_000 })
      const messageId = await node.getAttribute('data-graph-turn-id')
      assert.ok(messageId, '会话图节点没有携带目标消息 id')
      await node.click()
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        messageId,
        { timeout: 12_000 },
      )
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后消息仍被加上高亮类')
      const style = await page.evaluate((id) => {
        const row = document
          .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
          ?.closest('.msg-row')
        if (!row) return null
        const computed = getComputedStyle(row)
        return { background: computed.backgroundColor, shadow: computed.boxShadow }
      }, messageId)
      assert.ok(style, '跳转后找不到目标消息行')
      assert.ok(
        style.background === 'rgba(0, 0, 0, 0)' || style.background === 'transparent',
        `目标消息仍有高亮背景：${style.background}`,
      )
      assert.equal(style.shadow, 'none', `目标消息仍有高亮描边：${style.shadow}`)
    })

desktop('反馈2156#03：正在输出的轮次节点有与侧栏一致的呼吸动画', async (page) => {
      await openSession(page, 'slow')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 展示运行中节点动画')
      await input.press('Enter')
      const running = page.locator('[data-session-graph] [data-running="true"]').first()
      await running.waitFor({ state: 'visible', timeout: 10_000 })
      const ring = running.locator('[data-marker-ring="running"]')
      await ring.waitFor({ state: 'visible', timeout: 5_000 })
      const style = await ring.evaluate((el) => ({
        className: el.className,
        animation: getComputedStyle(el).animationName,
      }))
      assert.ok(style.className.includes('running-dot'), `运行中节点没有复用 running-dot：${style.className}`)
      assert.equal(style.animation, 'tandem-breathe', `运行中节点动画不对：${style.animation}`)
      const sidebarDot = page.locator('[data-session-row] .running-dot').first()
      await sidebarDot.waitFor({ state: 'attached', timeout: 5_000 })
      assert.equal(
        await sidebarDot.evaluate((el) => getComputedStyle(el).animationName),
        style.animation,
        '会话图运行中动画与侧栏运行中不一致',
      )
      await running.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
    })

desktop('反馈1110：会话图悬停的节点额外放大加外圈，同线其他节点不变', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/分叉会话')
      const mainId = scenario.sessionIds[0]
      await openSession(page, mainId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const nodes = graph.locator(`[data-graph-turn-id][data-session-id="${mainId}"]`)
      await nodes.first().waitFor({ timeout: 10_000 })
      assert.ok((await nodes.count()) >= 2, '同一会话的节点不足两个，无法比较悬停差异')
      await nodes.first().hover()
      await page.waitForTimeout(220)
      const info = await page.evaluate((sessionId) => {
        const all = [...document.querySelectorAll('[data-group="graph"] [data-graph-turn-id]')].filter(
          (el) => el.getAttribute('data-session-id') === sessionId,
        )
        const dot = (el) => el.querySelector('[data-marker="circle"]')
        const shape = (el) =>
          el
            ? {
                hovered: el.getAttribute('data-hovered') === 'true',
                rowHovered: el.getAttribute('data-row-hovered') === 'true',
                size: dot(el).getBoundingClientRect().width,
                shadow: getComputedStyle(dot(el)).boxShadow,
                bg: getComputedStyle(el).backgroundColor,
              }
            : null
        const hovered = all.find((el) => el.getAttribute('data-hovered') === 'true')
        return {
          count: all.length,
          rowHoveredCount: document.querySelectorAll('[data-row-hovered="true"]').length,
          hovered: shape(hovered),
          other: shape(all.find((el) => el !== hovered)),
        }
      }, mainId)
      assert.ok(info.hovered, '悬停的节点没有 data-hovered')
      assert.ok(info.other, '找不到同线的其他节点')
      assert.equal(info.hovered.size, 10, `悬停节点没有放大到 10px（${info.hovered.size}）`)
      assert.equal(info.other.size, 8, `同线其他节点也被放大了（${info.other.size}）`)
      assert.equal(info.other.hovered, false, '同线其他节点也被标成悬停')
      assert.notEqual(info.hovered.shadow, 'none', '悬停节点没有外圈')
      assert.equal(info.hovered.rowHovered, true, '悬停的轮次行没有 data-row-hovered')
      assert.equal(info.other.rowHovered, false, '同会话其他行也被标成悬停（反馈1603#05）')
      assert.equal(info.rowHoveredCount, 1, `同时高亮了 ${info.rowHoveredCount} 行（只应高亮悬停的一行）`)
      assert.notEqual(
        info.other.bg,
        info.hovered.bg,
        '悬停行与同线其他行的背景一致（同分支标题行不应一起高亮，反馈1603#05）',
      )
      const dir = '/tmp/fix-1110'
      mkdirSync(dir, { recursive: true })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${dir}/hover-node-dark.png` })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${dir}/hover-node-light.png` })
    })

desktop('反馈1110：会话图所有运行中的会话都在最新轮显示运行动画', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/分叉会话')
      const [mainId, childId, , forkId] = scenario.sessionIds
      // 真实运行状态由 Host 的 status 下发：这里拦截拓扑响应同时标记主会话/子代理/分叉在运行。
      const runningIds = new Set([mainId, childId, forkId])
      await page.route(/\/api\/sessions\/[^/]+\/graph$/, async (route) => {
        const response = await route.fetch()
        const json = await response.json()
        for (const session of json.sessions ?? []) {
          if (runningIds.has(session.id)) session.running = true
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
      })
      await openSession(page, mainId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('[data-group="graph"] [data-running="true"]').first().waitFor({ timeout: 10_000 })
      const info = await page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-graph-turn-id]')].map((el) => ({
          session: el.getAttribute('data-session-id'),
          row: Number(el.getAttribute('data-row')),
          running: el.getAttribute('data-running') === 'true',
          ring: el.querySelector('[data-marker-ring="running"]'),
        }))
        const latest = new Map()
        for (const node of all) {
          latest.set(node.session, Math.min(latest.get(node.session) ?? Infinity, node.row))
        }
        return {
          latest: [...latest],
          running: all
            .filter((node) => node.running)
            .map((node) => ({
              session: node.session,
              row: node.row,
              ring: !!node.ring,
              className: node.ring?.className ?? '',
              animation: node.ring ? getComputedStyle(node.ring).animationName : '',
            })),
        }
      })
      assert.ok(info.running.length >= 3, `运行中的会话线太少：${info.running.length}`)
      assert.equal(
        new Set(info.running.map((node) => node.session)).size,
        info.running.length,
        '同一条会话线出现了多个运行标识（应只在最新一轮）',
      )
      for (const node of info.running) {
        const latestRow = info.latest.find(([session]) => session === node.session)?.[1]
        assert.equal(node.row, latestRow, `${node.session} 的运行标识不在最新一轮`)
        assert.ok(node.ring, `${node.session} 的运行标识没有外圈动画`)
        assert.match(node.className, /running-dot/, `${node.session} 的运行标识没有复用 running-dot`)
        assert.equal(node.animation, 'tandem-breathe', `${node.session} 的运行动画不对：${node.animation}`)
      }
      const dir = '/tmp/fix-1110'
      mkdirSync(dir, { recursive: true })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${dir}/running-multi-dark.png` })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${dir}/running-multi-light.png` })
    })

desktop('反馈1603#05：会话图悬停只高亮被悬停的那一行标题', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = state.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const rows = graph.locator(`[data-graph-turn-id][data-session-id="${mainId}"]`)
      await rows.first().waitFor({ timeout: 10_000 })
      assert.ok((await rows.count()) >= 2, '同一会话的节点不足两个，无法比较悬停差异')
      await rows.first().hover()
      await page.waitForTimeout(220)
      const info = await page.evaluate((sessionId) => {
        const all = [...document.querySelectorAll('[data-graph-turn-id]')].filter(
          (el) => el.getAttribute('data-session-id') === sessionId,
        )
        const hovered = all.find((el) => el.getAttribute('data-hovered') === 'true')
        return {
          count: all.length,
          rowHovered: document.querySelectorAll('[data-row-hovered="true"]').length,
          hoveredBg: hovered ? getComputedStyle(hovered).backgroundColor : null,
          otherBg: all.filter((el) => el !== hovered).map((el) => getComputedStyle(el).backgroundColor),
          lines: document.querySelectorAll('[data-session-graph-edges] [data-hovered="true"]').length,
        }
      }, mainId)
      assert.equal(info.rowHovered, 1, `同时高亮了 ${info.rowHovered} 行（只应高亮悬停的一行）`)
      assert.ok(info.hoveredBg, '悬停的轮次行没有背景高亮')
      assert.ok(
        info.otherBg.every((bg) => bg !== info.hoveredBg),
        '同分支的其他标题行也被高亮了',
      )
      assert.ok(info.lines > 0, '悬停时整条泳道线的高亮消失了')
      const dir = '/tmp/fix-1603b'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/05-hover-row.png` })
    })

desktop('反馈1603#07：等待输入的会话最新轮有等待标记，运行中/子代理仍有呼吸动画', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const permissionId = state.scenarios.find((item) => item.id === 'permission').sessionIds[0]
      await openSession(page, permissionId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const waiting = graph.locator('[data-waiting="true"]').first()
      await waiting.waitFor({ state: 'visible', timeout: 10_000 })
      const marker = waiting.locator('[data-marker-ring="waiting"]')
      await marker.waitFor({ state: 'visible', timeout: 5_000 })
      const latestRow = await page.evaluate((sessionId) => {
        const rows = [...document.querySelectorAll('[data-graph-turn-id]')]
          .filter((el) => el.getAttribute('data-session-id') === sessionId)
          .map((el) => Number(el.getAttribute('data-row')))
        return rows.length ? Math.min(...rows) : null
      }, permissionId)
      assert.equal(
        Number(await waiting.getAttribute('data-row')),
        latestRow,
        '等待标记不在该会话最新一轮',
      )
      const style = await marker.evaluate((el) => ({
        className: el.className,
        animation: getComputedStyle(el).animationName,
        background: getComputedStyle(el).backgroundColor,
      }))
      assert.match(style.className, /bg-accent/, '等待标记没有复用侧栏待审批色')
      assert.match(style.className, /running-dot/, '等待标记没有呼吸动画')
      assert.equal(style.animation, 'tandem-breathe', `等待标记动画不对：${style.animation}`)
      // tooltip 必须是等待输入的说明，而不是轮次标题。标记在呼吸动画中，直接用指针坐标悬停。
      const markerBox = await marker.boundingBox()
      assert.ok(markerBox, '等待标记没有可悬停区域')
      await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2)
      await page.waitForFunction(
        () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
        null,
        { timeout: 5_000 },
      )
      const tip = await page.locator('#tandem-tooltip').innerText()
      assert.equal(tip.trim(), '等待你的输入/审批', `等待标记 tooltip 不对：${tip.trim()}`)
      await page.mouse.move(4, 4)
      const dir = '/tmp/fix-1603b'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/07-waiting.png` })

      // 子代理在自己的泳道上运行时也显示 running-dot。
      const subState = await api(base, token, '/api/demo')
      const [mainId, childId] = subState.scenarios.find((item) => item.id === 'subagents').sessionIds
      await page.route(/\/api\/sessions\/[^/]+\/graph$/, async (route) => {
        const response = await route.fetch()
        const json = await response.json()
        for (const session of json.sessions ?? []) {
          if (session.id === childId) session.running = true
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
      })
      await openSession(page, mainId)
      const childRunning = page.locator(
        `[data-group="graph"] [data-graph-turn-id][data-session-id="${childId}"][data-running="true"]`,
      )
      await childRunning.waitFor({ state: 'visible', timeout: 10_000 })
      const childRing = childRunning.locator('[data-marker-ring="running"]')
      await childRing.waitFor({ state: 'visible', timeout: 5_000 })
      const childStyle = await childRing.evaluate((el) => ({
        className: el.className,
        animation: getComputedStyle(el).animationName,
      }))
      assert.match(childStyle.className, /running-dot/, '子代理运行标记没有复用 running-dot')
      assert.equal(childStyle.animation, 'tandem-breathe', '子代理运行标记没有呼吸动画')
      await page.unroute(/\/api\/sessions\/[^/]+\/graph$/)
    })

desktop('反馈1603#08：分叉/主会话切换后子代理会话每次都能加载', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const [mainId, childId, , forkId] = state.scenarios.find((item) => item.id === 'subagents').sessionIds
      await openSession(page, mainId)
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const waitRoute = (id) =>
        page.waitForFunction((sid) => window.location.hash.includes(`/s/${sid}`), id, { timeout: 10_000 })
      const clickNode = async (sessionId) => {
        const node = page
          .locator(`[data-group="graph"] [data-graph-turn-id][data-session-id="${sessionId}"]`)
          .first()
        await node.waitFor({ state: 'visible', timeout: 10_000 })
        await node.click()
      }
      const expectAgentLoaded = async (where) => {
        await page.locator('[data-agent-breadcrumb]').waitFor({ state: 'visible', timeout: 10_000 })
        await page.locator('[data-turn-id]').first().waitFor({ timeout: 10_000 })
        assert.ok((await page.locator('[data-turn-id]').count()) > 0, `${where} 子代理视图没有消息`)
        assert.equal(await page.locator('.skeleton').count(), 0, `${where} 子代理视图停在骨架屏`)
      }
      // 按轨迹循环 5 轮：主会话 → 分叉 → 主会话 → 打开子代理 → 返回。
      for (let round = 1; round <= 5; round += 1) {
        await clickNode(forkId)
        await waitRoute(forkId)
        await page.waitForTimeout(250)
        await clickNode(mainId)
        await waitRoute(mainId)
        await page.waitForTimeout(900)
        const row = page
          .locator('aside button')
          .filter({ hasText: '竞品文案' })
          .first()
        await row.waitFor({ timeout: 10_000 })
        await row.click()
        await expectAgentLoaded(`第 ${round} 轮`)
        await page.locator('button[data-tip^="返回主会话"]').first().click()
        await page.locator('[data-agent-breadcrumb]').waitFor({ state: 'detached', timeout: 5_000 })
      }
      // 最后从分叉视图的会话图子代理节点直接进入（此时没有主会话视图）。
      await clickNode(forkId)
      await waitRoute(forkId)
      await page.waitForTimeout(500)
      const subNode = page
        .locator(`[data-group="graph"] [data-graph-turn-id][data-session-id="${childId}"]`)
        .first()
      await subNode.waitFor({ state: 'visible', timeout: 10_000 })
      await subNode.click()
      await expectAgentLoaded('从分叉视图进入')
      // 与用户反馈同序的 6 轮：侧栏重新点主会话 → 会话图分叉节点 → 点第 2/最后节点
      // → 轮换右栏「代理」卡里的不同子代理 → Escape。每一轮都必须有消息，不能停在骨架屏。
      for (let round = 0; round < 6; round += 1) {
        await page.locator('[data-session-row]').filter({ hasText: '子代理层级' }).first().click()
        await page.waitForTimeout(800)
        const fork = page.locator('[data-group="graph"] [data-fork-id]').first()
        if (await fork.count()) {
          await fork.click()
          await page.waitForTimeout(700)
        }
        const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
        const n = await nodes.count()
        if (n > 2) {
          await nodes.nth(1).click()
          await page.waitForTimeout(300)
          await nodes.nth(n - 1).click()
          await page.waitForTimeout(600)
        }
        const items = page
          .locator('section')
          .filter({ hasText: '代理' })
          .first()
          .locator('button, [role="button"]')
          .filter({ hasText: '子代理' })
        const k = await items.count()
        assert.ok(k > 0, `侧栏轮次 ${round + 1}：右栏代理卡没有子代理行`)
        await items.nth(round % k).click()
        await page.waitForTimeout(1500)
        await expectAgentLoaded(`侧栏轮次 ${round + 1}`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }

      const dir = '/tmp/fix-1603b'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/08-agent-loaded.png` })
    })

desktop('会话图泳道线 tooltip 以指针定位并完整显示在视口内（反馈1926#10）', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/孙代理/分叉会话')
      await openSession(page, scenario.sessionIds[0])
      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })

      // 返回最左/最右一条可见泳道线的可悬停点（线是细长目标，包围盒不能代表指针位置）。
      const edgeHoverPoint = (side, root = '[data-group="graph"]') =>
        page.evaluate(({ edgeSide, rootSel }) => {
          const scope = document.querySelector(rootSel)
          const scroller = scope?.querySelector('[data-graph-height]')
          if (!scope || !scroller) return null
          const rect = scroller.getBoundingClientRect()
          const hits = [...scope.querySelectorAll('[data-session-graph-edges] [data-edge-hit]')]
            .map((hit) => ({ hit, box: hit.getBoundingClientRect() }))
            .sort((a, b) => (edgeSide === 'left' ? a.box.left - b.box.left : b.box.right - a.box.right))
          for (const { hit } of hits) {
            const total = hit.getTotalLength()
            const box = hit.ownerSVGElement.getBoundingClientRect()
            for (let i = 1; i <= 9; i += 1) {
              const point = hit.getPointAtLength((total * i) / 10)
              // 取整到设备像素，避免浮点坐标与指针命中测试取到相邻的线。
              const x = Math.round(box.left + point.x)
              const y = Math.round(box.top + point.y)
              if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
                const top = document.elementFromPoint(x, y)
                // 必须是这一条线（交叉处上层可能是另一条线，归属会串）。
                if (top !== hit) continue
                return {
                  x,
                  y,
                  label: hit.getAttribute('data-tip'),
                  owner: hit.getAttribute('data-edge-owner'),
                  kind: hit.getAttribute('data-edge-kind'),
                  fromLane: hit.getAttribute('data-from-lane'),
                  toLane: hit.getAttribute('data-to-lane'),
                  fromRow: hit.getAttribute('data-from-row'),
                  toRow: hit.getAttribute('data-to-row'),
                }
              }
            }
          }
          return null
        }, { edgeSide: side, rootSel: root })

      const assertTipVisible = async (hover, where) => {
        await page.mouse.move(hover.x, hover.y)
        await page.waitForFunction(
          () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
          null,
          { timeout: 5_000 },
        )
        const tip = await page.evaluate(() => {
          const el = document.getElementById('tandem-tooltip')
          const r = el.getBoundingClientRect()
          return {
            text: el.textContent,
            inBody: el.parentElement === document.body,
            inCard: !!el.closest('[data-group="graph"]'),
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            viewport: { w: window.innerWidth, h: window.innerHeight },
          }
        })
        assert.equal(tip.text, hover.label, `${where} tooltip 不是该泳道线归属会话名`)
        // 必须渲染在 body 直接子树，否则会被卡片的 overflow 裁切。
        assert.ok(tip.inBody && !tip.inCard, `${where} tooltip 不在 document.body 直接子树`)
        assert.ok(
          tip.left >= 0 && tip.top >= 0 && tip.right <= tip.viewport.w && tip.bottom <= tip.viewport.h,
          `${where} tooltip 超出视口：${JSON.stringify(tip)}`,
        )
        // 细长连线按指针锚定，而不是整条线包围盒的中心；贴边时按视口 8px 边距夹紧。
        const half = (tip.right - tip.left) / 2
        const edge = 8
        const expectedX = Math.min(
          Math.max(hover.x, edge + half),
          Math.max(edge + half, tip.viewport.w - edge - half),
        )
        assert.ok(
          Math.abs((tip.left + tip.right) / 2 - expectedX) <= 2,
          `${where} tooltip 没有按指针锚定：${JSON.stringify(tip)} @${hover.x}`,
        )
        await page.mouse.move(4, 4)
        await page.waitForTimeout(250)
      }

      // 右栏卡片（约 280px 宽）：最左、最右两条泳道线。
      for (const side of ['left', 'right']) {
        const hover = await edgeHoverPoint(side)
        assert.ok(hover, `卡片内${side === 'left' ? '最左' : '最右'}侧泳道线没有可悬停的命中区`)
        await assertTipVisible(hover, `卡片${side === 'left' ? '左' : '右'}缘`)
      }

      // 全屏尺寸：同样验证最左/最右泳道线。
      const group = page.locator('[data-group="graph"]').first()
      await group.locator('[aria-label="全高显示会话图"]').click()
      const full = page.locator('[data-graph-full]')
      await full.waitFor({ state: 'visible', timeout: 10_000 })
      await full.locator('[data-graph-height]').first().evaluate((el) => {
        el.scrollTop = 0
      })
      await page.waitForTimeout(300)
      for (const side of ['left', 'right']) {
        const hover = await edgeHoverPoint(side, '[data-graph-full]')
        assert.ok(hover, `全屏${side === 'left' ? '最左' : '最右'}侧泳道线没有可悬停的命中区`)
        await assertTipVisible(hover, `全屏${side === 'left' ? '左' : '右'}缘`)
      }
      await full.getByRole('button', { name: /返回/ }).click()
      await full.waitFor({ state: 'detached', timeout: 5_000 })
    })

desktop('侧栏分叉并入原会话行、悬停拓扑图、右栏切分支', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 6, '演示子代理场景缺少子代理/孙代理/分叉会话')
      const [mainId, , , forkId] = scenario.sessionIds
      const mainTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)).title
      const forkTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)).title

      await openSession(page, mainId)
      const mainRow = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await mainRow.waitFor({ state: 'visible', timeout: 15_000 })

      // 分叉不占新行：演示分叉没有自己的侧栏行，树行数 = 1。
      assert.equal(
        await page.locator(`[data-session-row][data-session-id="${forkId}"]`).count(),
        0,
        '分叉仍单独占一行',
      )
      assert.equal(await page.locator(`[data-session-row][data-session-id="${mainId}"]`).count(), 1, '树行重复')

      // 新建分叉后侧栏行数不增加。
      const detail = await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)
      const messageId = [...detail.messages].reverse().find((message) => message.role === 'user')?.id
      assert.ok(messageId, '主会话没有用户消息，无法分叉')
      const rowsBefore = await page.locator('[data-session-row]').count()
      const extra = await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}/fork`, {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      })
      await page.waitForTimeout(800)
      assert.equal(
        await page.locator('[data-session-row]').count(),
        rowsBefore,
        '分叉后侧栏行数增加了',
      )
      assert.equal(
        await page.locator(`[data-session-row][data-session-id="${extra.id}"]`).count(),
        0,
        '新分叉占用了单独一行',
      )
      await api(base, token, `/api/sessions/${encodeURIComponent(extra.id)}`, {
        method: 'DELETE',
        body: '{}',
      })
      await page.waitForTimeout(500)

      // 悬停会话行：右侧弹出拓扑图（与右栏同一张图，紧凑模式不显示轮次文字）。
      await mainRow.hover()
      const topology = page.locator('[data-hover-card] [data-session-topology]').first()
      await topology.waitFor({ state: 'visible', timeout: 10_000 })
      const topologyText = await topology.innerText()
      assert.doesNotMatch(topologyText, /收到，先按这个做|我们先把价格页/, '拓扑图仍在显示轮次文字')
      assert.doesNotMatch(topologyText, /tok|token/i, '拓扑图显示了 token')
      assert.ok(
        (await topology.locator('[data-session-graph-edges] [data-edge-hit][data-tip]').count()) > 0,
        '拓扑图的连线没有会话名 tooltip',
      )
      // 虚拟滚动：逐段滚动收集，确认树里每个会话都有节点、分叉点/派出点被画出来。
      const cardScroller = topology.locator('[data-graph-height]').first()
      const scanTopology = async () => {
        const sessions = new Set()
        const attach = new Set()
        const labels = new Set()
        const height = await cardScroller.evaluate((el) => el.clientHeight)
        const total = await cardScroller.evaluate((el) => el.scrollHeight)
        for (let top = 0; top <= total; top += Math.max(40, height - 40)) {
          await cardScroller.evaluate((el, y) => {
            el.scrollTop = y
          }, top)
          await page.waitForTimeout(40)
          const batch = await topology.locator('div[data-session-id]').evaluateAll((els) =>
            els.map((el) => ({
              session: el.getAttribute('data-session-id'),
              lane: el.getAttribute('data-lane'),
              row: el.getAttribute('data-row'),
              attach: el.getAttribute('data-attach-point') === 'true',
              label: el.getAttribute('data-session-label') === 'true',
            })),
          )
          for (const item of batch) {
            sessions.add(item.session)
            if (item.attach) attach.add(`${item.lane}:${item.row}`)
            if (item.label) labels.add(item.session)
          }
        }
        await cardScroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        return { sessions, attach, labels }
      }
      const scanned = await scanTopology()
      assert.equal(
        scanned.sessions.size,
        scenario.sessionIds.length,
        `拓扑图节点数不等于树内会话数：${[...scanned.sessions].join(',')}`,
      )
      assert.ok(scanned.attach.size >= 2, '拓扑图没有画出分叉点/派出点轮次')
      assert.equal(scanned.labels.size, scenario.sessionIds.length, '不是每个会话都显示了一次会话名')

      // 点分叉节点打开该分叉会话；侧栏同一行内小字标出所在分叉名。
      await topology.locator(`div[data-session-id="${forkId}"]`).first().click()
      await page.waitForFunction(
        (id) => window.location.hash.includes(`/s/${id}`),
        forkId,
        { timeout: 10_000 },
      )
      const branch = mainRow.locator('[data-session-branch]').first()
      await branch.waitFor({ state: 'visible', timeout: 10_000 })
      const branchLabel = forkTitle.split('·').map((part) => part.trim()).filter(Boolean).pop()
      assert.equal((await branch.innerText()).trim(), branchLabel, '行内没有标出当前分叉名')

      // 右栏会话图切分支：在分叉里，主线是当前分叉（一条直线上去）；来源会话是分支泳道，没有「原会话」支线。
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-group="graph"] path[data-kind="main"]')
            ?.getAttribute('data-edge-owner') === id,
        forkId,
        { timeout: 10_000 },
      )
      assert.ok(
        (await graph.locator('div[data-kind="fork"][data-trunk="true"]').count()) >= 2,
        '分叉自己的轮次不在主线',
      )
      assert.doesNotMatch(await graph.innerText(), /原会话/, '分叉视图仍在画「原会话」支线')
      assert.ok(
        (await graph.locator(`path[data-kind="fork"][data-edge-owner="${mainId}"]`).count()) > 0,
        '来源会话没有作为分支泳道',
      )

      // 回到主会话：主线切回主会话本身。
      await openSession(page, mainId)
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-group="graph"] path[data-kind="main"]')
            ?.getAttribute('data-edge-owner') === id,
        mainId,
        { timeout: 10_000 },
      )
      assert.equal(await mainRow.locator('[data-session-branch]').count(), 0, '主会话行仍显示分叉名')
    })

desktop('反馈2236#02：会话图方向按钮切换最新在上/下，刷新、全高视图与悬停拓扑跟随', async (page) => {
      const fix2236Dir = '/tmp/fix-2236'
      mkdirSync(fix2236Dir, { recursive: true })
      const cardIds = async () =>
        page
          .locator('[data-group="graph"] [data-graph-turn-id]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-graph-turn-id')))

      await openSession(page, 'turns4')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-group="graph"] [data-graph-turn-id]').length >= 4,
        null,
        { timeout: 15_000 },
      )
      let card = page.locator('[data-group="graph"]').first()
      const directionButton = () => card.locator('[aria-label="切换会话图方向"]').first()
      assert.equal(await directionButton().count(), 1, '会话图卡片标题栏没有方向按钮')
      assert.equal(
        (await directionButton().evaluate((el) => el.textContent ?? '')).trim(),
        '最新在上',
        '默认方向的提示不是「最新在上」',
      )
      const newestTop = await cardIds()
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await card.screenshot({ path: path.join(fix2236Dir, '02-最新在上.png') })

      await directionButton().click()
      await page.waitForFunction(
        (first) => {
          const el = document.querySelector('[data-group="graph"] [data-graph-turn-id]')
          return el && el.getAttribute('data-graph-turn-id') !== first
        },
        newestTop[0],
        { timeout: 5_000 },
      )
      const newestBottom = await cardIds()
      assert.deepEqual(newestBottom, [...newestTop].reverse(), '方向按钮没有反转节点顺序')
      assert.equal(
        (await directionButton().evaluate((el) => el.textContent ?? '')).trim(),
        '最新在下',
        '切换后的提示不是「最新在下」',
      )
      await card.screenshot({ path: path.join(fix2236Dir, '02-最新在下.png') })
      assert.equal(
        await page.evaluate(() => localStorage.getItem('tandem.graphDirection.v1')),
        'newest-bottom',
        '方向没有写入全局存储',
      )

      // 全高展开：同一方向、同样带方向按钮。
      await card.locator('[aria-label="全高显示会话图"]').click()
      const full = page.locator('[data-graph-full]')
      await full.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await full.locator('[aria-label="切换会话图方向"]').count(), 1, '全高会话图没有方向按钮')
      const fullIds = await full
        .locator('[data-graph-turn-id]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-graph-turn-id')))
      assert.deepEqual(fullIds, newestBottom, '全高会话图没有跟随方向设置')
      await full.getByRole('button', { name: /返回/ }).click()
      await full.waitFor({ state: 'detached', timeout: 5_000 })

      // 刷新后保持。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-group="graph"] [data-graph-turn-id]').length >= 4,
        null,
        { timeout: 15_000 },
      )
      card = page.locator('[data-group="graph"]').first()
      assert.deepEqual(await cardIds(), newestBottom, '刷新后方向没有保持')

      // 侧栏悬停拓扑跟随同一设置（用有分叉的演示树；单会话树不弹悬停卡片）。
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 2, '演示子代理场景缺少会话')
      const mainId = scenario.sessionIds[0]
      await openSession(page, mainId)
      await page.waitForFunction(
        () => document.querySelectorAll('[data-group="graph"] [data-graph-turn-id]').length > 0,
        null,
        { timeout: 15_000 },
      )
      const mainTop = (await cardIds())[0]
      const row = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await row.waitFor({ timeout: 15_000 })
      await page.mouse.move(4, 4)
      await row.hover()
      const topology = page.locator('[data-hover-card] [data-session-topology]').first()
      await topology.waitFor({ state: 'visible', timeout: 10_000 })
      const topoIds = await topology
        .locator('[data-graph-turn-id]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-graph-turn-id')))
      assert.ok(topoIds.length >= 2, '悬停拓扑没有节点')
      assert.equal(topoIds[0], mainTop, '悬停拓扑没有跟随「最新在下」方向')
      await page.mouse.move(4, 4)

      // 恢复默认，避免共享 context 的方向设置泄漏给后续用例。
      await openSession(page, 'turns4')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-group="graph"] [data-graph-turn-id]').length >= 4,
        null,
        { timeout: 15_000 },
      )
      card = page.locator('[data-group="graph"]').first()
      await directionButton().click()
      await page.waitForFunction(
        () => localStorage.getItem('tandem.graphDirection.v1') === 'newest-top',
        null,
        { timeout: 5_000 },
      )
      await page.evaluate(() => localStorage.removeItem('tandem.graphDirection.v1'))
    })
}
