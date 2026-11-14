#!/usr/bin/env node
/**
 * 工作区能力（评测、浏览器、应用预览、分屏、Wiki、演示工作区）。
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

export const feature = 'workspace'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [156, 157, 158, 175, 176, 184, 185]

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

desktop('评测：对比表字号 ≥12px、时间中文化、轨迹与并排可开', async (page) => {
      const dialog = await openSettings(page, '评测', 'desktop')
      await dialog.getByText('回归用例 A').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      const text = await dialog.innerText()
      assert.ok(!/\b(AM|PM)\b/.test(text), '运行时间仍是 12 小时制英文格式')
      // 徽标是 P05 允许的 11px（U3-B 描边标签），表格正文/数据仍要求 ≥12px。
      const minFont = await dialog.evaluate((el) => {
        const nodes = [...el.querySelectorAll('tbody td *')]
          .filter((n) => (n.textContent ?? '').trim())
          .filter((n) => !n.closest('[data-badge]'))
        return Math.min(...nodes.map((n) => parseFloat(getComputedStyle(n).fontSize)))
      })
      assert.ok(minFont >= 12, `结果表最小字号 ${minFont}px`)
      await dialog.locator('tbody tr').first().locator('td').nth(1).locator('button').first().click()
      const trace = page.getByRole('dialog', { name: '评测轨迹' })
      await trace.waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.press('Escape')
      await trace.waitFor({ state: 'hidden', timeout: 5_000 })
      await dialog.getByRole('button', { name: '并排' }).first().click()
      const compare = page.getByRole('dialog', { name: '评测并排对比' })
      await compare.waitFor({ state: 'visible', timeout: 10_000 })
      assertNoOverflow('并排对比', await compare.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))
      await page.keyboard.press('Escape')
      await compare.waitFor({ state: 'hidden', timeout: 5_000 })
      await closeSettings(page)
    })

desktop('浏览器：工具卡与浏览器面板空态', async (page) => {
      await openSession(page, 'browser')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '浏览器', exact: true }).click()
      const panel = page.getByRole('dialog', { name: '浏览器' })
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      await panel.getByText(/本会话还没有打开浏览器|页面还没有截图/).first().waitFor({ timeout: 5_000 })
      assertNoOverflow('浏览器面板', await panel.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden', timeout: 5_000 })
    })

desktop('应用预览：自动识别、设备切换、点选元素、Edit 自动刷新与改前对比', async (page) => {
      const sessionId = 'preview'
      const waitPreview = async (predicate, label, timeout = 40_000) => {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          try {
            const state = await api(base, token, `/api/sessions/${sessionId}/preview/state`)
            if (predicate(state)) return state
          } catch {
            /* Host 可能正在启动预览 */
          }
          await sleep(250)
        }
        throw new Error(`等待预览状态超时：${label}`)
      }
      const requestCount = (host) => previewApp.requests.filter((item) => item.host === host).length

      // 非白名单地址：API 直接拒绝，且 Host 不应向目标发出任何请求。
      const blockedHost = `0.0.0.0:${previewApp.blockedPort}`
      const blockedBefore = requestCount(blockedHost)
      const blocked = await fetch(`${base}/api/sessions/${sessionId}/preview/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://${blockedHost}/` }),
      })
      assert.equal(blocked.status, 400, '非白名单地址应被拒绝')
      assert.match(await blocked.text(), /不在浏览器允许列表/)
      await sleep(600)
      assert.equal(requestCount(blockedHost), blockedBefore, '非白名单地址不应发出真实网络请求')

      // 自动识别：package.json dev 脚本端口 + 本机探测可达。
      const candidates = await api(base, token, `/api/sessions/${sessionId}/preview/detect`)
      const auto = candidates.find((item) => item.url === `http://localhost:${previewApp.port}/`)
      assert.ok(auto, `没有识别到 package.json dev 端口：${JSON.stringify(candidates)}`)
      assert.equal(auto.source, 'package')
      assert.equal(auto.reachable, true, 'dev 端口应探测为可访问')

      await openSession(page, sessionId)
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '应用预览', exact: true }).click()
      const panel = page.getByTestId('preview-panel')
      await panel.waitFor({ state: 'visible', timeout: 10_000 })

      // 不需要输入地址：面板自动识别并打开本机应用。
      const shotImg = panel.getByTestId('preview-shot')
      await shotImg.waitFor({ state: 'visible', timeout: 40_000 })
      const address = panel.getByRole('textbox', { name: '应用地址' })
      assert.match(await address.inputValue(), new RegExp(`localhost:${previewApp.port}`))
      const opened = await waitPreview((state) => state.active && !!state.screenshotId, '自动打开')
      const beforeShotId = opened.screenshotId

      // 设备尺寸：手机 390×844，Host 同步改变 viewport。
      await panel.locator('[data-tip="手机 390×844"]').click()
      await waitPreview((state) => state.width === 390 && state.height === 844, '手机尺寸')
      await panel.getByText('390×844', { exact: true }).waitFor({ timeout: 5_000 })
      const phoneShot = await waitPreview(
        (state) => state.width === 390 && state.screenshotId !== beforeShotId,
        '手机截图',
      )

      // 点选元素：选择模式下点击预览里的 React 按钮。
      await panel.getByRole('button', { name: '选择元素' }).click()
      const box = await shotImg.boundingBox()
      assert.ok(box, '预览截图没有可见区域')
      const clickX = box.x + (100 / phoneShot.width) * box.width
      const clickY = box.y + (170 / phoneShot.height) * box.height
      await page.mouse.click(clickX, clickY)
      const selectionStrip = panel.getByTestId('preview-selections')
      await selectionStrip.waitFor({ state: 'visible', timeout: 15_000 })
      const selectionText = await selectionStrip.innerText()
      assert.match(selectionText, /<button> 登录/, `元素胶囊内容不对：${selectionText}`)
      assert.match(selectionText, /src\/App\.tsx/, `没有读到 React 源码位置：${selectionText}`)
      mkdirSync('/tmp/preview-shots', { recursive: true })
      await panel.screenshot({ path: '/tmp/preview-shots/selection.png' }).catch(() => {})

      // R14：面板与对话区并存，选完元素焦点回到输入框，附件胶囊立即可见。
      assert.ok(await panel.isVisible(), '选中元素后面板被关闭')
      const textarea = page.locator('[aria-label="消息输入框"]')
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '消息输入框',
        null,
        { timeout: 3_000 },
      )
      assert.equal(await textarea.isEnabled(), true, '预览打开时输入框不可用')
      const chip = page.getByTestId('composer-preview-selections')
      await chip.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await chip.innerText(), /登录/)
      assert.match(await chip.innerText(), /src\/App\.tsx/)
      const composerBox = await textarea.boundingBox()
      const panelBox = await panel.boundingBox()
      assert.ok(composerBox && panelBox, '输入框或预览面板没有可见区域')
      assert.ok(
        composerBox.x + composerBox.width <= panelBox.x + 1,
        '预览面板盖住了输入框',
      )

      // R14：关闭再打开恢复地址、设备尺寸与已选元素。
      const addressBefore = await address.inputValue()
      await panel.getByRole('button', { name: '关闭应用预览' }).click()
      await panel.waitFor({ state: 'detached', timeout: 5_000 })
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu2 = page.locator('[role="menu"]').last()
      await menu2.waitFor({ state: 'visible', timeout: 5_000 })
      await menu2.getByRole('menuitem', { name: '应用预览', exact: true }).click()
      const panel2 = page.getByTestId('preview-panel')
      await panel2.waitFor({ state: 'visible', timeout: 10_000 })
      const address2 = panel2.getByRole('textbox', { name: '应用地址' })
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="preview-panel"] input[aria-label="应用地址"]')?.value ===
          expected,
        addressBefore,
        { timeout: 10_000 },
      )
      assert.equal(await address2.inputValue(), addressBefore, '重开预览没有恢复地址')
      await panel2.getByText('390×844', { exact: true }).waitFor({ timeout: 10_000 })
      const selectionStrip2 = panel2.getByTestId('preview-selections')
      await selectionStrip2.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await selectionStrip2.innerText(), /登录/, '重开预览没有恢复已选元素')

      // 改前快照。
      await panel2.getByRole('button', { name: '截取改前快照' }).click()
      await panel2.getByText('改前快照', { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})

      // 面板保持打开时也能输入并发送：元素上下文 + PREVIEW_EDIT 指令，mock 会回复并发一次 Edit。
      const contentFile = path.join(previewApp.root, 'content.js')
      await textarea.fill(`PREVIEW_EDIT ${contentFile}`)
      await page.getByRole('button', { name: '发送消息' }).click()
      await page.getByText('收到选中的元素，修改预览页面。').first().waitFor({ timeout: 20_000 })
      const fileDeadline = Date.now() + 20_000
      while (Date.now() < fileDeadline && !readFileSync(contentFile, 'utf8').includes('PREVIEW_MARKER_EDITED')) {
        await sleep(200)
      }
      assert.match(readFileSync(contentFile, 'utf8'), /PREVIEW_MARKER_EDITED/, 'agent 的 Edit 没有落盘')
      assert.ok(
        provider.seenUserTexts.some((text) => text.includes('关于这个元素：<button> 登录按钮')),
        `模型没有收到元素上下文：${provider.seenUserTexts.slice(-2).join(' | ')}`,
      )

      // 改完自动刷新：面板角落显示「已根据 1 处改动刷新」。
      const refreshed = await waitPreview((state) => state.autoRefresh?.count >= 1, '改完自动刷新')
      assert.notEqual(refreshed.screenshotId, beforeShotId, '自动刷新后截图应更新')
      await panel2.getByTestId('preview-auto-refresh').waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await panel2.getByTestId('preview-auto-refresh').innerText(), /已根据 1 处改动刷新/)
      assert.ok(await panel2.isVisible(), '发送后面板被关闭')

      // 改前 / 当前对比：截取快照后自动进入对比，改完刷新后仍保留。
      const compare = panel2.getByTestId('preview-compare')
      await compare.waitFor({ state: 'visible', timeout: 15_000 })
      assert.ok((await compare.locator('img').count()) >= 2, '对比视图应有改前与当前两张图')
      for (const image of await compare.locator('img').all()) {
        await image.evaluate((el) => (el.decode ? el.decode().catch(() => {}) : undefined))
      }
      await page.waitForTimeout(250)
      await panel2.getByRole('button', { name: '左右' }).click().catch(() => {})
      await page.screenshot({ path: '/tmp/preview-shots/compare.png' }).catch(() => {})

      // 界面里再试一次非白名单地址：错误提示出现，预览状态不被破坏。
      await address2.fill(`http://${blockedHost}/`)
      await panel2.getByRole('button', { name: '打开', exact: true }).click()
      await page.getByText(/不在浏览器允许列表/).first().waitFor({ timeout: 10_000 })
      await panel2.getByRole('button', { name: '关闭应用预览' }).click()
      await panel2.waitFor({ state: 'detached', timeout: 5_000 })
      assert.equal(requestCount(blockedHost), blockedBefore, '界面输入非白名单地址也不应发出请求')
    })

desktop('分屏：双窗格收发、焦点跟随右栏与比例恢复', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      await page
        .locator('[data-session-row][data-session-id="split-b"]')
        .click({ modifiers: ['Control'] })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(500)
      const panes = page.locator('[data-split-pane]')
      assert.equal(await panes.count(), 2, '分屏窗格数量不是 2')
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        'Ctrl+点击后焦点不在新窗格',
      )

      // 窗格 B 独立发送并收到回复。
      const paneB = panes.nth(1)
      await paneB.locator('[aria-label="消息输入框"]').fill('分屏 B 测试')
      await paneB.locator('[aria-label="消息输入框"]').press('Enter')
      await paneB.locator('.msg-row', { hasText: '分屏 B 测试' }).waitFor({ timeout: 10_000 })
      await paneB.locator('.msg-row', { hasText: '回归回复。' }).waitFor({ timeout: 15_000 })

      // 焦点切到 A：右栏待办跟随。
      await panes.nth(0).getByText('分屏会话 A', { exact: true }).click()
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-split-pane][data-focused="true"]')?.textContent ?? '').includes(
            '分屏会话 A',
          ),
        null,
        { timeout: 10_000 },
      )
      await page.getByText('分屏 A 的待办').first().waitFor({ timeout: 10_000 })

      // 窗格 A 独立发送，不与 B 串台。
      const paneA = panes.nth(0)
      await paneA.locator('[aria-label="消息输入框"]').fill('分屏 A 测试')
      await paneA.locator('[aria-label="消息输入框"]').press('Enter')
      await paneA.locator('.msg-row', { hasText: '分屏 A 测试' }).waitFor({ timeout: 10_000 })
      await paneA.locator('.msg-row', { hasText: '回归回复。' }).waitFor({ timeout: 15_000 })
      assert.equal(
        await paneB.locator('.msg-row', { hasText: '分屏 A 测试' }).count(),
        0,
        'A 的消息串到 B 窗格',
      )
      assert.equal(
        await paneA.locator('.msg-row', { hasText: '分屏 B 测试' }).count(),
        0,
        'B 的消息串到 A 窗格',
      )

      // 再切回 B：右栏待办跟着变。
      await panes.nth(1).getByText('分屏会话 B', { exact: true }).click()
      await page.getByText('分屏 B 的待办').first().waitFor({ timeout: 10_000 })

      // 拖动分隔条后比例写入 localStorage。
      const splitter = page.locator('[data-split-splitter="x"]').first()
      const box = await splitter.boundingBox()
      assert.ok(box, '找不到分屏分隔条')
      await page.mouse.move(box.x + box.width / 2, box.y + 80)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 70, box.y + 80, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(300)
      const saved = await page.evaluate(() => {
        const raw = localStorage.getItem('tandem.split.v1')
        return raw ? JSON.parse(raw) : null
      })
      assert.ok(saved && saved.panes.length === 2, '分屏布局未写入 localStorage')
      assert.ok(saved.cols[0] < 0.49, `拖动分隔条后比例未更新：${saved.cols[0]}`)
      const ratioOf = async () =>
        page.locator('[data-split-pane]').evaluateAll((els) => {
          const widths = els.map((el) => el.getBoundingClientRect().width)
          return widths[0] / widths.reduce((sum, width) => sum + width, 0)
        })
      const ratioBefore = await ratioOf()

      // 刷新后两个窗格、聚焦会话与比例都恢复。
      await page.reload()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 15_000 },
      )
      await page.waitForTimeout(900)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        '刷新后聚焦窗格丢失',
      )
      await page.getByText('分屏 B 的待办').first().waitFor({ timeout: 10_000 })
      const ratioAfter = await ratioOf()
      assert.ok(
        Math.abs(ratioBefore - ratioAfter) < 0.05,
        `刷新后分屏比例未恢复：${ratioBefore} -> ${ratioAfter}`,
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

desktop('分屏：拖拽分区、Ctrl+1 焦点与 Ctrl+W 关闭', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      const root = page.locator('[data-split-root]')
      const box = await root.boundingBox()
      assert.ok(box, '单窗格缺少拖拽落区')
      await page
        .locator('[data-session-row][data-session-id="split-b"]')
        .dragTo(root, {
          targetPosition: { x: box.width * 0.8, y: box.height * 0.4 },
        })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        '拖入右半边后焦点不在新窗格',
      )

      await page.keyboard.press('Control+1')
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 A/,
        'Ctrl+1 未切到第一个窗格',
      )

      // 浏览器可能拦截真实 Ctrl+W，这里派发同形态的键盘事件验证应用快捷键。
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'w',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 0,
        null,
        { timeout: 10_000 },
      )
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 B/,
        'Ctrl+W 关闭聚焦窗格后未落到相邻会话',
      )

      // 命令面板「分屏打开…」+ 会话选择弹层。
      await page.keyboard.press('Control+k')
      const paletteInput = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await paletteInput.fill('分屏打开')
      await page.getByText('分屏打开…', { exact: true }).click()
      const dialog = page.getByRole('dialog').filter({ hasText: '分屏打开会话' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByPlaceholder('搜索会话标题、目录或 Host…').fill('分屏会话 A')
      await page.waitForTimeout(250)
      await dialog.getByRole('button', { name: /分屏会话 A/ }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 A/,
        '命令面板分屏打开后焦点不在新窗格',
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

desktop('项目 Wiki：浏览、全文搜索与手写段落', async (page) => {
      await openSession(page, 'search')
      // Wiki 卡片（右栏）显示页数与 commit，点「浏览」打开 Wiki 视图。
      await page.getByText('共 3 页').first().waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: '浏览', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: '项目 Wiki' })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /基于 commit [0-9a-f]{7}/)
      assert.match(await dialog.innerText(), /Mock 概览/)
      // 反馈13#01：阅读列固定宽度，切换页面时不得随内容收缩/抖动。
      const readWidth = () =>
        page.evaluate(() => {
          const el = document.querySelector('[role="dialog"][aria-label="项目 Wiki"] .wiki-markdown')
          return el ? el.getBoundingClientRect().width : 0
        })
      const readWidths = []
      for (const name of ['项目概览', 'src', '术语表', '项目概览']) {
        await dialog.getByRole('button', { name, exact: true }).first().click()
        await page.waitForTimeout(220)
        readWidths.push(await readWidth())
      }
      const minWidth = Math.min(...readWidths)
      const maxWidth = Math.max(...readWidths)
      assert.ok(
        maxWidth - minWidth <= 1,
        `Wiki 阅读列宽度随页面变化：${readWidths.map((width) => Math.round(width)).join(' / ')}`,
      )
      const samples = []
      for (let i = 0; i < 12; i += 1) {
        samples.push(await readWidth())
        await page.waitForTimeout(80)
      }
      assert.ok(
        Math.max(...samples) - Math.min(...samples) <= 1,
        `Wiki 阅读列在 1 秒内仍在抖动：${samples.map((width) => Math.round(width)).join(' / ')}`,
      )
      await dialog.getByRole('button', { name: '项目概览', exact: true }).first().click()
      await page.waitForTimeout(200)
      // 左树切换到模块页。
      await dialog.getByRole('button', { name: 'src', exact: true }).first().click()
      await dialog.getByText('Mock 职责：示例源码。').waitFor()
      // 全文搜索：命中概览页并可跳转。
      await dialog.getByLabel('搜索 Wiki', { exact: true }).fill('regrepo')
      await dialog.getByRole('button', { name: /项目概览/ }).first().click()
      await dialog.getByText('Mock 概览：回归仓库。').waitFor()
      // 回到模块页编辑手写段落。
      await dialog.getByRole('button', { name: 'src', exact: true }).first().click()
      await dialog.getByText('Mock 职责：示例源码。').waitFor()
      await dialog.getByRole('button', { name: '编辑手写段落' }).click()
      const manual = dialog.getByLabel('手写段落')
      await manual.fill('手写：回归新增的说明。')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByText('已保存手写段落').waitFor()
      const saved = await api(base, token, `/api/wiki/page?project=${encodeURIComponent(repo)}&page=m-src`)
      assert.equal(saved.manual, '手写：回归新增的说明。')
      assert.match(saved.auto, /Mock 职责/)
      await dialog.getByLabel('关闭').click()
    })

desktop('演示工作区可创建、场景可打开、可清除且不污染真实数据', async (page) => {
      // 前面的设备/演示用例可能已经打开演示工作区；先清掉，基线才代表真实数据。
      await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' }).catch(() => undefined)
      const beforeSessions = await api(base, token, '/api/sessions')
      const beforeUsage = await api(base, token, '/api/usage')
      const beforeLong = beforeSessions.find((item) => item.id === 'long')
      const beforeLongDetail = await api(base, token, '/api/sessions/long')
      const state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      assert.equal(state.active, true, '演示工作区未创建')
      assert.equal(state.scenarios.length, 17, `场景数不对：${state.scenarios.length}`)
      assert.equal(state.networkRequests, 0, '演示模型不应发出网络请求')
      assert.equal(state.profile?.kind, 'demo', '演示账号类型不对')
      assert.equal(state.profile?.baseUrl, 'http://127.0.0.1:1', '演示账号应使用不可达地址证明不发网络请求')

      const profiles = (await api(wsBase, token, '/api/workstation/profiles')).profiles
      assert.ok(!profiles.some((profile) => profile.kind === 'demo'), '演示账号不应出现在正常账号列表')

      const byId = new Map(state.scenarios.map((scenario) => [scenario.id, scenario]))
      for (const required of [
        'chat-tools', 'permission', 'plan', 'subagents', 'background', 'delegation',
        'auto-compact', 'handoff', 'ai-review', 'changes', 'board', 'evals', 'wiki',
        'preview', 'inbox', 'resume', 'hooks',
      ]) {
        assert.ok(byId.has(required), `缺少演示场景 ${required}`)
      }
      for (const scenario of state.scenarios) {
        for (const sessionId of scenario.sessionIds ?? []) {
          const session = await api(base, token, `/api/sessions/${encodeURIComponent(sessionId)}`)
          assert.equal(session.demo, true, `场景 ${scenario.id} 的会话未标记演示数据`)
        }
        if (scenario.boardId) {
          const board = await api(base, token, `/api/boards/${encodeURIComponent(scenario.boardId)}`)
          assert.ok(board.cards.length >= 6, '演示看板卡片不足')
          assert.equal(board.cards.filter((card) => card.deps.length > 0).length >= 3, true, '缺少依赖卡')
          assert.ok(board.cards.some((card) => card.status === 'approval'), '缺少待审批卡')
          assert.ok(board.cards.some((card) => card.status === 'review'), '缺少待评审卡')
          assert.ok(board.cards.some((card) => card.status === 'failed'), '缺少失败卡')
          assert.ok(board.cards.some((card) => card.proposedBy), '缺少 AI 拆分草稿')
        }
        if (scenario.evalRunId) {
          const run = await api(base, token, `/api/evals/runs/${encodeURIComponent(scenario.evalRunId)}`)
          assert.equal(run.results.length, 6, '演示评测对比结果不足')
        }
        if (scenario.kind === 'wiki') {
          const wiki = await api(base, token, `/api/wiki?project=${encodeURIComponent(state.project)}`)
          assert.equal(wiki.exists, true, '演示 Wiki 不存在')
          assert.ok(wiki.pages.length >= 3, '演示 Wiki 页面不足')
        }
      }

      // 重新播放：只替换该场景会话，旧会话被删除。
      const chatBeforeReplay = byId.get('chat-tools').sessionIds[0]
      const replayed = await api(base, token, '/api/demo/scenarios/chat-tools/replay', { method: 'POST', body: JSON.stringify({}) })
      const chatAfterReplay = replayed.scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
      assert.notEqual(chatAfterReplay, chatBeforeReplay, '重新播放没有创建新会话')
      const oldChat = await fetch(`${base}/api/sessions/${encodeURIComponent(chatBeforeReplay)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(oldChat.status, 404, '重新播放后旧会话仍然存在')
      const replayState = await api(base, token, '/api/demo')
      byId.set('chat-tools', replayState.scenarios.find((item) => item.id === 'chat-tools'))

      // UI：看板场景可打开并显示预置卡片。
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => { window.location.hash = hash }, `#/h/${clientHostId}/b/demo-board`)
      await page.getByText('演示 · 任务看板', { exact: true }).first().waitFor({ timeout: 15_000 })
      await page.getByText('AI 拆分草稿：补充测试与截图', { exact: true }).first().waitFor({ timeout: 10_000 })
      await page.getByText('待审批：更新发布说明', { exact: true }).first().waitFor({ timeout: 10_000 })

      // UI：演示会话可继续对话，演示模型不发网络请求（baseUrl 不可达也能完成）。
      const chatId = byId.get('chat-tools').sessionIds[0]
      await openSession(page, chatId)
      const composer = page.locator('[aria-label="消息输入框"]').first()
      await composer.fill('再总结一下这个演示项目')
      await composer.press('Enter')
      await page.getByText(/工具结果已返回。演示模型只执行固定剧本/).first().waitFor({ timeout: 20_000 })
      const usageAfterTurn = await api(base, token, '/api/usage')
      assert.deepEqual(usageAfterTurn, beforeUsage, '演示模型不应写入真实用量统计')

      // 清除：会话、看板、评测、Wiki、任务、账号与目录都不留痕迹；真实会话不受影响。
      await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' })
      const afterDemo = await api(base, token, '/api/demo')
      assert.equal(afterDemo.active, false, '清除后演示状态仍为 active')
      const afterSessions = await api(base, token, '/api/sessions')
      assert.equal(afterSessions.length, beforeSessions.length, `清除后会话数 ${afterSessions.length} != ${beforeSessions.length}`)
      assert.ok(afterSessions.some((item) => item.id === 'long'), '清除演示数据误删了真实会话')
      const afterLongDetail = await api(base, token, '/api/sessions/long')
      assert.equal(afterLongDetail.messages.length, beforeLongDetail.messages.length, '真实会话消息被改动')
      assert.ok(beforeLong, '真实会话 long 不存在')
      assert.deepEqual(await api(base, token, '/api/usage'), beforeUsage, '清除后真实用量被改动')
      assert.ok(!(await api(wsBase, token, '/api/workstation/profiles')).profiles.some((profile) => profile.kind === 'demo'), '演示账号未清除')
      assert.ok(!(await api(base, token, '/api/boards')).some((board) => board.id === 'demo-board'), '演示看板未清除')
      assert.ok(!(await api(base, token, '/api/evals/runs')).some((run) => run.id === 'demo-eval-run'), '演示评测未清除')
      assert.ok(!(await api(base, token, '/api/tasks')).some((task) => task.cwd?.startsWith(state.root)), '演示后台任务未清除')
      assert.equal(existsSync(state.root), false, '演示目录未删除')
      const search = await api(base, token, `/api/search?q=${encodeURIComponent('演示 · 基础对话')}`)
      assert.equal(search.hits.length, 0, '演示会话仍留在搜索索引')
      const wikiAfter = await api(base, token, `/api/wiki?project=${encodeURIComponent(state.project)}`)
      assert.equal(wikiAfter.exists, false, '演示 Wiki 未清除')
    })
}
