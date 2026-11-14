#!/usr/bin/env node
/**
 * 手机与 360 小屏（设置、环境条、弹层、触控、分屏、看板）。
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

export const feature = 'mobile'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 152, 153, 154, 155, 160, 174, 177, 206, 212]

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

mobile('手机设置全屏、三列导航且无横向溢出', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      const box = await dialog.boundingBox()
      withinViewport(box, MOBILE, '手机设置')
      assert.ok(box.width >= 389 && box.height >= 843, `手机设置没有全屏：${box.width}×${box.height}`)
      const nav = dialog.locator('nav').first()
      const info = await nav.evaluate((el) => ({
        columns: getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
        height: el.getBoundingClientRect().height,
        minHeight: Math.min(...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)),
      }))
      assert.equal(info.columns, 3, `手机设置导航 ${info.columns} 列`)
      assert.ok(info.height <= 360, `手机设置导航过高 ${info.height}px`)
      assert.ok(info.minHeight >= 43, `手机设置页签触控高度 ${info.minHeight}px`)
      const pageWidth = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: window.innerWidth,
      }))
      assertNoOverflow('手机设置页', pageWidth)
      await dialog.locator('nav').first().getByRole('button', { name: '权限', exact: true }).click()
      await page.waitForTimeout(200)
      const next = await dialog.boundingBox()
      assert.ok(Math.abs(next.height - box.height) <= 1, '切换页签后手机设置脱离全屏')
      await closeSettings(page)
    })

mobile('手机收件箱审批卡任务描述默认两行，点按展开全文（R15）', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.getByRole('button', { name: /收件箱/ }).first().click().catch(() => {})
      const card = page
        .getByTestId('inbox-pending')
        .filter({ hasText: '在 taskcli 项目里运行' })
        .first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      const title = card.locator('button[aria-expanded]').first()
      const before = await title.boundingBox()
      const label = await title.getAttribute('data-tip')
      assert.ok(
        label?.includes('点击展开全文') || label?.includes('等待审批'),
        '审批卡任务描述没有全文提示',
      )
      await title.click()
      const after = await title.boundingBox()
      assert.ok(before && after, '审批卡任务描述不可见')
      assert.ok(after.height > before.height + 6, `任务描述没有展开：${before.height} → ${after.height}`)
      assert.equal(await title.getAttribute('aria-expanded'), 'true')
    })

mobile('手机反馈工具栏移入顶部，不遮住底部环境条', async (page) => {
      await openSession(page, 'long')
      await page.keyboard.press('Control+Shift+F')
      const toolbar = page.getByRole('region', { name: '反馈模式工具栏' })
      await toolbar.waitFor({ state: 'visible', timeout: 8_000 })
      const bar = await toolbar.boundingBox()
      const envTrigger = page.locator(`button[data-tip="${repo}"]`).first()
      await envTrigger.waitFor({ state: 'visible', timeout: 5_000 })
      const env = await envTrigger.boundingBox()
      assert.ok(bar && env, '反馈工具栏或环境条不可见')
      assert.ok(bar.y < 120, `反馈工具栏仍在底部：y=${Math.round(bar.y)}`)
      assert.ok(bar.y + bar.height <= env.y, '反馈工具栏遮住了环境条')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

mobile('手机环境条不越界、容器透明、触控 44px', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => b.getAttribute('data-tip') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        if (!wrap) return null
        const rect = wrap.getBoundingClientRect()
        const children = [...wrap.children].map((child) => {
          const r = child.getBoundingClientRect()
          return { width: r.width, right: r.right, height: r.height }
        })
        return {
          bg: getComputedStyle(wrap).backgroundColor,
          overflowX: getComputedStyle(wrap).overflowX,
          text: wrap.innerText,
          scrollWidth: wrap.scrollWidth,
          clientWidth: wrap.clientWidth,
          left: rect.left,
          right: rect.right,
          children,
        }
      }, repo)
      assert.ok(info, '找不到手机环境条')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `手机环境条容器不透明：${info.bg}`)
      assert.ok(['auto', 'scroll'].includes(info.overflowX), `手机环境条不可横向滚动：${info.overflowX}`)
      assert.ok(info.scrollWidth >= info.clientWidth, '手机环境条滚动宽度异常')
      assert.ok(info.right <= MOBILE.width + 1, `环境条右缘 ${info.right} 越界`)
      assert.ok(info.text.includes(path.basename(repo)), `手机环境条看不到文件夹名：${info.text}`)
      assert.match(info.text, /main/, '手机环境条看不到分支名')
      assert.match(info.text, /Worktree/, '手机环境条 Worktree 开关没有文字')
      for (const child of info.children) {
        assert.ok(child.width > 0, '环境条存在不可见子项')
        assert.ok(child.height >= 43, `环境条触控高度 ${child.height}px，低于 44px`)
      }
    })

mobile('手机重试胶囊独立一行且不压顶栏', async (page) => {
      await openSession(page, 'retry')
      const retryText = page.getByText(/网络中断，\d+ 秒后重试/).first()
      await retryText.waitFor({ state: 'visible', timeout: 8_000 })
      const header = page.locator('header').first()
      const headerBox = await header.boundingBox()
      const rowBox = await retryText.locator('..').boundingBox()
      assert.ok(rowBox.y >= headerBox.y + headerBox.height - 1, '重试提示与顶栏重叠')
      assert.ok(Math.abs(rowBox.width - MOBILE.width) <= 2, `重试提示行宽度 ${rowBox.width}`)
      const headerText = await header.innerText()
      assert.equal(headerText.includes('网络中断'), false, '手机顶栏内仍渲染重试胶囊')
      withinViewport(rowBox, MOBILE, '手机重试提示')
      await page.getByRole('button', { name: '立即重试' }).first().waitFor()
    })

mobile('手机账号卡只有一行编辑/删除操作', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      await dialog.getByText('自建端点').waitFor()
      for (const name of ['主力账号', '自建端点']) {
        assert.equal(await dialog.getByRole('button', { name: `编辑 ${name}` }).count(), 1, `${name} 出现重复编辑入口`)
        assert.equal(await dialog.getByRole('button', { name: `删除 ${name}` }).count(), 1, `${name} 出现重复删除入口`)
      }
      await closeSettings(page)
    })

mobile('手机权限规则匹配模式独占一行', async (page) => {
      const dialog = await openSettings(page, '权限', 'mobile')
      const input = dialog.getByRole('textbox', { name: '匹配模式' })
      await input.waitFor({ timeout: 10_000 })
      const box = await input.boundingBox()
      assert.ok(box.width >= 180, `匹配模式输入框只有 ${box.width}px 宽`)
      withinViewport(box, MOBILE, '匹配模式输入框')
      await closeSettings(page)
    })

mobile('手机用量柱状图可点按查看每日花费', async (page) => {
      const dialog = await openSettings(page, '用量', 'mobile')
      const chart = dialog.locator('svg[aria-label="按天花费柱状图"]')
      await chart.waitFor({ timeout: 10_000 })
      const box = await chart.boundingBox()
      assert.ok(box.width >= 300, `手机用量图只有 ${box.width}px 宽`)
      const bars = chart.locator('g[aria-label*="花费"]')
      assert.ok((await bars.count()) >= 3, '用量图没有每日柱子')
      // 按造数时的日期定位当天柱子，不依赖「最后一根」；跨零点时也稳定。
      const todayBar = chart.locator(`g[aria-label^="${dayString(0)} "]`)
      await todayBar.waitFor({ timeout: 3_000 })
      await todayBar.click({ force: true })
      await page.waitForTimeout(250)
      const tip = dialog.getByText(dayString(0), { exact: true })
      await tip.waitFor({ state: 'visible', timeout: 3_000 })
      withinViewport(await tip.locator('..').boundingBox(), MOBILE, '用量 tooltip')
      await closeSettings(page)
    })

mobile('手机提示词点选后编辑区滚入视口', async (page) => {
      const dialog = await openSettings(page, '提示词', 'mobile')
      const list = dialog.locator('nav').nth(1)
      const first = list.getByRole('button').first()
      await first.waitFor({ timeout: 10_000 })
      await first.click()
      await page.waitForTimeout(700)
      const editor = dialog.locator('[data-setting-id="prompts.editor"]').first()
      const box = await editor.boundingBox()
      assert.ok(box, '提示词编辑区不存在')
      assert.ok(box.y >= 0 && box.y < 720, `提示词编辑区仍在视口外 y=${box.y}`)
      withinViewport(box, MOBILE, '提示词编辑区')
      await closeSettings(page)
    })

mobile('手机消息操作只剩一个更多操作按钮且触控 44px', async (page) => {
      await openSession(page, 'long')
      const lastRow = page.locator('[data-turn-id="u40"]')
      const more = lastRow.locator('.msg-more button[aria-label="消息操作"]')
      await more.waitFor({ state: 'visible', timeout: 5_000 })
      const box = await more.boundingBox()
      assert.ok(box.height >= 43, `消息操作按钮高度 ${box.height}px`)
      const desktopActionsVisible = await page.evaluate(() =>
        [...document.querySelectorAll('.msg-actions')].some((el) => getComputedStyle(el).display !== 'none'),
      )
      assert.equal(desktopActionsVisible, false, '触屏下仍显示桌面消息操作条')
    })

mobile('手机模型菜单与文件夹弹层都在视口内', async (page) => {
      await openSession(page, 'long')
      await waitModelReady(page)
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const menu = page.locator('[role="menu"]').first()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), MOBILE, '手机模型菜单')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const popover = page.locator('[role="menu"]:has(> .popover-panel)').first()
      await popover.waitFor()
      withinViewport(await popover.boundingBox(), MOBILE, '手机文件夹弹层')
      await page.keyboard.press('Escape')
    })

mobile('手机嵌套弹窗按 Esc 只关闭最上层', async (page) => {
      const dialog = await openSettings(page, 'MCP', 'mobile')
      const remove = dialog.getByRole('button', { name: '删除 reg-fs' })
      await remove.waitFor({ timeout: 10_000 })
      await remove.click()
      const confirm = page.getByRole('dialog', { name: '移除 MCP 服务器' })
      await confirm.waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      await confirm.waitFor({ state: 'hidden' })
      assert.ok(await dialog.isVisible(), 'Esc 同时关闭了设置弹窗')
      await closeSettings(page)
    })

small('360 小屏：会话顶栏标题与状态不重叠、输入框不横向溢出', async (page) => {
      await openSession(page, 'approve')
      const info = await page.evaluate(() => {
        const header = document.querySelector('header')
        const hb = header.getBoundingClientRect()
        const title = [...header.querySelectorAll('h1')].find((e) => (e.textContent || '').includes('等待审批'))
        const tr = title?.getBoundingClientRect()
        const pill = [...header.querySelectorAll('span')].find((e) => (e.textContent || '').trim().startsWith('待审批'))
        const pr = pill?.getBoundingClientRect()
        const card = document.querySelector('.composer-card')
        const cr = card.getBoundingClientRect()
        return {
          headerH: hb.height,
          headerRight: hb.right,
          titleW: tr?.width ?? 0,
          pillRight: pr?.right ?? 0,
          cardRight: cr.right,
          cardSW: card.scrollWidth,
          cardCW: card.clientWidth,
          docSW: document.documentElement.scrollWidth,
        }
      })
      assert.ok(info.titleW >= 80, `手机顶栏标题被挤到 ${Math.round(info.titleW)}px`)
      assert.ok(info.headerH >= 88, `手机顶栏没有分两行：${Math.round(info.headerH)}px`)
      assert.ok(info.pillRight <= info.headerRight - 40, `状态胶囊压到了右侧图标：${Math.round(info.pillRight)} > ${Math.round(info.headerRight - 40)}`)
      assert.ok(info.cardSW <= info.cardCW + 1, `输入框横向溢出 ${info.cardSW} > ${info.cardCW}`)
      assert.ok(info.cardRight <= SMALL.width + 1, `输入框右缘 ${Math.round(info.cardRight)} 越界`)
      assert.ok(info.docSW <= SMALL.width, `页面横向溢出 ${info.docSW} > ${SMALL.width}`)
    })

small('360 小屏：更多菜单项 44px 且弹层不越界', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: /更多设置/ }).click()
      const menu = page.locator('[role="menu"]').first()
      await menu.waitFor()
      await waitAnimations(menu)
      const info = await menu.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const items = [...el.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
          (i) => i.getBoundingClientRect().height,
        )
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, min: Math.min(...items), count: items.length }
      })
      assert.ok(info.count >= 5, `更多菜单只有 ${info.count} 项`)
      assert.ok(info.min >= 43, `手机菜单项高度 ${Math.round(info.min)}px，低于 44px`)
      assert.ok(info.top >= -1 && info.bottom <= info.vh + 1, `菜单超出视口 ${Math.round(info.top)}–${Math.round(info.bottom)} / ${info.vh}`)
      await page.keyboard.press('Escape')
    })

small('360 小屏：内联审批卡的拒绝/允许按钮触控 44px（反馈14#07）', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor()
      for (const selector of ['[data-permission-deny]', '[data-permission-allow]']) {
        const button = card.locator(selector).first()
        const box = await button.boundingBox()
        assert.ok(box, `${selector} 不可见`)
        assert.ok(box.height >= 43, `${selector} 高度 ${Math.round(box.height)}px`)
        const cardBox = await card.boundingBox()
        assert.ok(
          box.x >= cardBox.x - 1 && box.x + box.width <= cardBox.x + cardBox.width + 1,
          `${selector} 超出卡片`,
        )
      }
    })

small('手机长按用户消息打开操作菜单', async (page) => {
      await openSession(page, 'long')
      const bubble = page.locator('.msg-group [data-msg-bubble]').last()
      await bubble.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(250)
      const box = await bubble.boundingBox()
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + 16, y: box.y + 12 }],
      })
      await page.waitForTimeout(650)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const menu = page.getByRole('menu', { name: '消息操作' })
      await menu.waitFor({ state: 'visible', timeout: 3_000 })
      await page.waitForTimeout(250)
      const item = menu.getByRole('menuitem').first()
      const itemBox = await item.boundingBox()
      assert.ok(itemBox.height >= 43, `长按菜单项高度 ${Math.round(itemBox.height)}px`)
      await page.keyboard.press('Escape')
    })

small('360 小屏：侧栏行与图标触控 44px', async (page) => {
      await page.getByRole('button', { name: '打开侧栏' }).click()
      const aside = page.locator('aside').first()
      await aside.waitFor({ state: 'visible' })
      const info = await aside.evaluate((el) => {
        const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)
        const rows = [...el.querySelectorAll('[data-session-row]')].map((r) => r.getBoundingClientRect().height)
        return { minButton: Math.min(...buttons), minRow: Math.min(...rows) }
      })
      assert.ok(info.minButton >= 43, `侧栏按钮最小高度 ${Math.round(info.minButton)}px`)
      assert.ok(info.minRow >= 43, `会话行高度 ${Math.round(info.minRow)}px`)
      await page.keyboard.press('Escape')
    })

small('360 小屏：设置页按钮触控 44px', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      withinViewport(await dialog.boundingBox(), SMALL, '手机设置')
      const min = await dialog.evaluate((el) =>
        Math.min(...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)),
      )
      assert.ok(min >= 43, `设置页按钮最小高度 ${Math.round(min)}px`)
      await closeSettings(page)
    })

mobile('手机点按文件引用打开预览并可关闭', async (page) => {
      await openSession(page, 'links')
      const ref = page.locator('code.file-ref-inline, a.file-ref').first()
      await ref.waitFor({ state: 'visible' })
      await ref.tap()
      const close = page.getByRole('button', { name: '关闭文件预览' })
      await close.waitFor({ state: 'visible', timeout: 5_000 })
      const box = await close.boundingBox()
      assert.ok(box.height >= 43, `预览关闭按钮高度 ${Math.round(box.height)}px`)
      await close.tap()
      await close.waitFor({ state: 'hidden', timeout: 5_000 })
    })

mobile('手机评测结果表可横向滚动并打开轨迹', async (page) => {
      const dialog = await openSettings(page, '评测', 'mobile')
      await dialog.getByText('回归用例 A').first().waitFor({ timeout: 10_000 })
      const table = dialog.locator('.overflow-x-auto').last()
      const info = await table.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      assert.ok(info.clientWidth <= MOBILE.width + 1, `结果表超出屏幕：${info.clientWidth}`)
      await dialog.locator('tbody tr').first().locator('td').nth(1).locator('button').first().tap()
      const trace = page.getByRole('dialog', { name: '评测轨迹' })
      await trace.waitFor({ state: 'visible', timeout: 10_000 })
      await trace.getByRole('button', { name: '关闭' }).tap()
      await trace.waitFor({ state: 'hidden', timeout: 5_000 })
    })

mobile('手机顶栏搜索按钮打开命令面板', async (page) => {
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('# 主题')
      await page.waitForTimeout(220)
      const kinds = await page
        .locator('[data-palette-index]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-palette-kind')))
      assert.ok(kinds.length > 0, '手机命令面板没有设置结果')
      assert.ok(kinds.every((kind) => kind === 'setting'), '手机命令面板前缀筛选失效')
      await page.keyboard.press('Escape')
    })

mobile('手机分屏：圆点指示与左右滑动切换', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      await page.getByRole('button', { name: '打开侧栏' }).click()
      await page.waitForTimeout(300)
      const row = page.locator('[data-session-row][data-session-id="split-b"]')
      await row.getByRole('button', { name: '会话操作' }).click()
      await page.getByRole('menuitem', { name: '在分屏中打开' }).click()
      await page.waitForTimeout(800)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)

      const tabs = page.getByRole('tab')
      assert.equal(await tabs.count(), 2, '手机分屏圆点数量不是 2')
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true')
      await tabs.nth(0).click()
      await page.waitForTimeout(500)
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 A/,
        '点击圆点未切到第一个窗格',
      )

      const box = await page.locator('[data-split-pager]').boundingBox()
      assert.ok(box, '手机分屏容器不存在')
      const client = await page.context().newCDPSession(page)
      const y = box.y + Math.min(120, box.height * 0.3)
      const startX = box.x + box.width * 0.8
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      })
      for (let i = 1; i <= 6; i++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX - (box.width * 0.1) * i, y }],
        })
        await sleep(20)
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(700)
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 B/,
        '左滑后未切到第二个窗格',
      )
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true')

      // 手机也能退出分屏：关闭当前窗格后回到单会话。
      await page.getByRole('button', { name: '关闭当前窗格' }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[role="tab"]').length === 0,
        null,
        { timeout: 10_000 },
      )
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 A/,
        '手机关闭当前窗格后未回到相邻会话',
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

fbAdjustMobile('调整工具（手机布局）：点选/手柄/插入预览/继续调整都可用', async (page) => {
      const state = await api(base, token, '/api/demo')
      if (!state.active) await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const chatId = (await api(base, token, '/api/demo')).scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
      await openSession(page, chatId)
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 8000 })
      await page.waitForTimeout(500)
      await page.getByRole('region', { name: '反馈模式工具栏' }).getByRole('button', { name: '调整', exact: true }).click()
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
      const toolbar = await page.locator('[data-adjust-toolbar]').boundingBox()
      assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= 413, '手机上调整工具栏超出视口')
      const target = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        for (const node of stage.querySelectorAll('[data-testid], button')) {
          const r = node.getBoundingClientRect()
          if (r.width > 60 && r.height > 20 && r.top > 80 && r.bottom < innerHeight - 200) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
        }
        return null
      })
      assert.ok(target, '手机布局找不到可选中控件')
      await page.touchscreen.tap(target.x, target.y)
      await page.waitForTimeout(250)
      assert.equal(await page.evaluate(() => window.__feedbackAdjust.selected()?.inStage), true, '手机触屏点选失败')
      const bar = await page.locator('[data-adjust-selection-bar]').boundingBox()
      assert.ok(bar.x >= 0 && bar.x + bar.width <= 413, '手机操作条超出视口')
      await page.locator('[data-adjust-toolbar]').getByRole('button', { name: '插入控件' }).click()
      await page.locator('[data-insert-option="button-primary"]').hover()
      const preview = page.locator('[data-adjust-insert-preview="button-primary"]')
      await preview.waitFor({ timeout: 5000 })
      const panelBox = await page.locator('[data-adjust-insert-panel]').boundingBox()
      const previewBox = await preview.boundingBox()
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 413, '手机插入面板越界')
      assert.ok(previewBox.x >= 0 && previewBox.x + previewBox.width <= 413, '手机插入预览越界')
      await page.locator('[data-insert-option="button-primary"]').click()
      await page.waitForTimeout(350)
      const handle = await page.locator('[data-adjust-handle="se"]').boundingBox()
      assert.ok(handle, '手机布局没有手柄')
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + 16, handle.y + handle.height / 2 + 8, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      const inserted = await page.evaluate(() => window.__feedbackAdjust.inserted())
      assert.ok(inserted[0]?.width % 4 === 0, '手机插入控件没有吸附 4px')
      await page.locator('[data-adjust-toolbar]').getByRole('button', { name: /完成并保存/ }).click()
      const drawer = page.locator('aside[aria-label="反馈条目"]')
      await drawer.waitFor({ timeout: 30000 })
      await drawer.getByRole('button', { name: '继续调整' }).click()
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
      await page.waitForTimeout(300)
      assert.ok((await page.evaluate(() => window.__feedbackAdjust.changes())).length >= 1, '手机继续调整没有恢复改动')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'), null, { timeout: 10000 })
    })

desktop('调试版手机预览：弹窗按移动布局渲染并可打开侧栏抽屉（B）', async (page) => {
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: '命令面板' })
      await palette.waitFor({ timeout: 10_000 })
      await palette.getByPlaceholder(/命令|搜索/).first().fill('手机预览')
      const row = palette.getByText('打开手机预览', { exact: true }).first()
      await row.waitFor({ timeout: 10_000 })
      const popupPromise = page.waitForEvent('popup', { timeout: 10_000 })
      await row.click()
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      const bar = popup.locator('[data-mobile-preview-bar]')
      await bar.waitFor({ state: 'visible', timeout: 20_000 })
      const barText = await bar.innerText()
      assert.ok(barText.includes('手机预览 · 模拟'), `预览窗口没有模拟顶栏：${barText}`)
      assert.ok(barText.includes('无触摸模拟'), `浏览器版没有提示无法触摸模拟：${barText}`)
      assert.equal(
        await popup.evaluate(() => document.documentElement.dataset.mobilePreview),
        '1',
        '预览页面没有标记为手机预览',
      )
      // 平板预设也强制移动端布局；这里至少确认没有桌面侧栏、存在移动端「打开侧栏」。
      assert.equal(
        await popup.locator('aside[aria-label="侧栏"]').count(),
        0,
        '预览窗口仍是桌面布局（渲染了固定侧栏）',
      )
      await popup.getByRole('button', { name: '打开侧栏' }).first().click()
      const drawer = popup.locator('aside[aria-label="侧栏"]')
      await drawer.waitFor({ state: 'visible', timeout: 5_000 })
      // 模拟条独占顶部区域：抽屉标题「Tandem」必须完整露在它下方，不能与工具栏相交。
      const barBox = await bar.boundingBox()
      const title = drawer.getByText('Tandem', { exact: true }).first()
      await title.waitFor({ state: 'visible', timeout: 5_000 })
      const titleBox = await title.boundingBox()
      assert.ok(barBox && titleBox, '取不到模拟条或抽屉标题的位置')
      const overlap =
        titleBox.y < barBox.y + barBox.height &&
        titleBox.y + titleBox.height > barBox.y &&
        titleBox.x < barBox.x + barBox.width &&
        titleBox.x + titleBox.width > barBox.x
      assert.equal(overlap, false, `抽屉标题被手机预览工具栏遮挡：标题 ${JSON.stringify(titleBox)}，工具栏 ${JSON.stringify(barBox)}`)
      assert.ok(
        titleBox.y >= barBox.y + barBox.height - 0.5,
        `抽屉标题没有从工具栏下方开始：标题 ${JSON.stringify(titleBox)}，工具栏 ${JSON.stringify(barBox)}`,
      )
      const drawerBox = await drawer.boundingBox()
      assert.ok(
        drawerBox && titleBox.y + titleBox.height <= drawerBox.y + drawerBox.height + 0.5 && titleBox.y >= drawerBox.y - 0.5,
        '抽屉标题超出抽屉范围（被裁掉）',
      )
      await popup.close()
    })
}
