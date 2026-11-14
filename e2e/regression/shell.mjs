#!/usr/bin/env node
/**
 * 应用外壳（顶栏、菜单、命令面板、导览、断网条、新功能提示条）。
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

export const feature = 'shell'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [106, 110, 111, 116, 142, 161, 162, 164, 165, 166, 219]

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

desktop('反馈2102#04：顶栏右侧不出现两个同图标的按钮', async (page) => {
      const panelToggle = page.locator('button[aria-label="切换信息面板"]')
      const ensurePanelOpen = async () => {
        if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click()
        await page.locator('button[aria-label="切换信息面板"][aria-pressed="true"]').waitFor({ timeout: 5_000 })
      }
      await openSession(page, 'links')
      const wasOpen = (await panelToggle.getAttribute('aria-pressed')) === 'true'
      try {
        await ensurePanelOpen()
        await withViewport(page, async () => {
          for (const next of ['dark', 'light']) {
            await setTheme(page, next)
            await openSession(page, 'links')
            await ensurePanelOpen()
            await page.screenshot({ path: path.join(shotDir, `04-顶栏-${next}.png`) })
          }
        })
        const dups = await page.evaluate(() => {
          const header = document.querySelector('header.relative.z-20')
          const seen = new Map()
          for (const button of header ? header.querySelectorAll('button') : []) {
            if (button.offsetParent === null) continue
            const icon = [...(button.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-'))
            if (!icon) continue
            const label = button.getAttribute('aria-label') || button.textContent?.trim() || ''
            seen.set(icon, [...(seen.get(icon) ?? []), label])
          }
          return [...seen].filter(([, labels]) => labels.length > 1)
        })
        assert.deepEqual(dups, [], `顶栏有同图标的按钮：${JSON.stringify(dups)}`)
      } finally {
        const pressed = (await panelToggle.getAttribute('aria-pressed')) === 'true'
        if (pressed !== wasOpen) await panelToggle.click().catch(() => {})
      }
    })

checks.push({ name: '断网后立即显示重新连接条', viewport: 'desktop', context: 'offline', fn: async (page) => {
      await openSession(page, 'long')
      await page.waitForTimeout(500)
      await page.context().setOffline(true)
      const banner = page.getByText('重新连接中…').first()
      await banner.waitFor({ state: 'visible', timeout: 6_000 })
      await page.context().setOffline(false)
      await page.waitForTimeout(500)
    } })

checks.push({ name: 'Windows 桌面顶栏 36px 且按钮不溢出', viewport: 'desktop', context: 'win32', fn: async (page) => {
      const header = page.locator('header').first()
      await header.waitFor()
      const info = await header.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const buttons = [...el.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { right: r.right, top: r.top, bottom: r.bottom, height: r.height }
        })
        return {
          height: rect.height,
          paddingRight: getComputedStyle(el).paddingRight,
          overflow: el.scrollWidth > el.clientWidth + 1,
          buttons,
          width: rect.width,
          viewport: window.innerWidth,
        }
      })
      assert.ok(Math.abs(info.height - 36) <= 1, `Windows 顶栏高度 ${info.height}，预期 36`)
      assert.ok(Math.abs(parseFloat(info.paddingRight) - 140) <= 1, `右侧留白 ${info.paddingRight}，预期 140`)
      assert.equal(info.overflow, false, '顶栏出现横向溢出')
      for (const button of info.buttons) {
        assert.ok(button.right <= info.viewport + 1, `顶栏按钮右缘越界 ${button.right}`)
        assert.ok(button.top >= 0 && button.bottom <= info.height + 1, '顶栏按钮垂直错位')
      }
    } })

desktop('断点续跑胶囊显示倒计时与操作', async (page) => {
      await openSession(page, 'retry')
      const text = page.getByText(/网络中断，\d+ 秒后重试/).first()
      await text.waitFor({ state: 'visible', timeout: 8_000 })
      const pill = text.locator('..')
      withinViewport(await pill.boundingBox(), DESKTOP, '重试胶囊')
      await page.getByRole('button', { name: '立即重试' }).first().waitFor()
      await page.getByRole('button', { name: '停止', exact: true }).first().waitFor()
    })

desktop('反馈14#01/#02：所有菜单首次与再次打开，位置与尺寸稳定（15 帧 ≤1px）', async (page) => {
      // 真实按下/松开鼠标：触发器按下缩放会带着 Radix 定位的面板一起动（R52 复发根因）。
      const sampleOnce = async (trigger) => {
        const box = await trigger.boundingBox()
        assert.ok(box, '菜单触发器不可见')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(120)
        await page.mouse.down()
        const frames = await page.evaluate(async () => {
          const out = []
          for (let i = 0; i < 15; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const panels = [...document.querySelectorAll('.popover-panel')].filter(
              (el) => el.getClientRects().length > 0,
            )
            const panel = panels[panels.length - 1]
            if (!panel) continue
            const rect = panel.getBoundingClientRect()
            out.push([rect.x, rect.y, rect.width, rect.height])
          }
          return out
        })
        await page.mouse.up()
        const after = await page.evaluate(async () => {
          const out = []
          for (let i = 0; i < 20; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const panels = [...document.querySelectorAll('.popover-panel')].filter(
              (el) => el.getClientRects().length > 0,
            )
            const panel = panels[panels.length - 1]
            if (!panel) continue
            const rect = panel.getBoundingClientRect()
            out.push([rect.x, rect.y, rect.width, rect.height])
          }
          return out
        })
        return [...frames, ...after]
      }
      const assertStable = (frames, label) => {
        assert.ok(frames.length >= 8, `${label} 打开后采样帧数不足：${frames.length}`)
        const spread = (index) =>
          Math.max(...frames.map((frame) => frame[index])) -
          Math.min(...frames.map((frame) => frame[index]))
        const [dx, dy, dw, dh] = [spread(0), spread(1), spread(2), spread(3)]
        assert.ok(
          dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1,
          `${label} 打开时抖动：位置 ${dx.toFixed(1)}×${dy.toFixed(1)}px，尺寸 ${dw.toFixed(1)}×${dh.toFixed(1)}px`,
        )
      }
      const checkMenu = async (trigger, label) => {
        assertStable(await sampleOnce(trigger), `${label}（首次）`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(280)
        assertStable(await sampleOnce(trigger), `${label}（再次）`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }

      // 新会话页输入框底栏。
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.waitForTimeout(600)
      const newComposer = page.locator('[aria-label="消息输入框"]').first()
      await newComposer.waitFor({ timeout: 10_000 })
      await checkMenu(page.locator('button[aria-label^="选择模型"]').first(), '模型芯片（新会话页）')

      // 会话页：输入框菜单、环境条三个胶囊、窗口 ⋯ 菜单、权限模式。
      await openSession(page, 'long')
      await checkMenu(page.locator('button[aria-label^="选择模型"]').first(), '模型芯片')
      await checkMenu(page.locator('button[aria-label^="权限模式"]').first(), '权限模式')
      const envTriggers = page.locator('[data-env-bar] button[aria-haspopup]')
      const envCount = await envTriggers.count()
      assert.ok(envCount >= 3, `环境条弹层触发器只有 ${envCount} 个`)
      await checkMenu(envTriggers.nth(0), '主机胶囊')
      await checkMenu(envTriggers.nth(1), '文件夹胶囊')
      await checkMenu(envTriggers.nth(2), '分支胶囊')
      await checkMenu(page.locator('button[aria-label="更多"]').first(), '窗口 ⋯ 菜单')

      // 设置里的下拉（共享 MenuSelect）。
      await page.getByRole('button', { name: '设置', exact: true }).last().click()
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible', timeout: 10_000 })
      await settings.locator('[data-settings-page="permissions"]').click()
      await page.waitForTimeout(300)
      let select = settings.locator('button[aria-label="工具"]').first()
      if ((await select.count()) === 0) select = settings.locator('button[aria-haspopup="menu"]').first()
      assert.ok((await select.count()) > 0, '设置页没有下拉菜单')
      await checkMenu(select, '设置下拉')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    })

desktop('命令面板：搜「桌面通知」定位到对应设置项', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ timeout: 5_000 })
      await input.fill('桌面通知')
      await page.waitForTimeout(220)
      const row = page
        .locator('[data-palette-index]')
        .filter({ hasText: '桌面通知' })
        .filter({ hasText: '设置 · 通知' })
        .first()
      await row.click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const marker = dialog.locator('[data-setting-id="notifications.desktop"]')
      await marker.waitFor({ state: 'visible', timeout: 10_000 })
      // 定位在打开设置后异步执行，等高亮真正加上再断言，避免弹层入场动画期间读到旧状态。
      await page
        .waitForFunction(
          () =>
            (document.querySelector('[data-setting-id="notifications.desktop"]')?.className ?? '')
              .toString()
              .includes('setting-highlight'),
          null,
          { timeout: 5_000 },
        )
        .catch(() => {})
      const cls = (await marker.getAttribute('class')) ?? ''
      assert.ok(cls.includes('setting-highlight'), '定位后没有高亮目标设置项')
      const navTab = dialog.locator('nav').first().getByRole('button', { name: '通知', exact: true })
      assert.equal(await navTab.getAttribute('aria-current'), 'page', '没有切到「通知」页')
      const box = await marker.boundingBox()
      assert.ok(box && box.y >= 0 && box.y < DESKTOP.height, `设置项不在视口内：${JSON.stringify(box)}`)
      await closeSettings(page)
    })

desktop('命令面板：前缀筛选与拼音首字母匹配', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ timeout: 5_000 })
      const kinds = async () =>
        page.locator('[data-palette-index]').evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-palette-kind')),
        )
      await input.fill('>')
      await page.waitForTimeout(220)
      const commandKinds = await kinds()
      assert.ok(commandKinds.length > 0, '`>` 前缀没有命令结果')
      assert.ok(commandKinds.every((kind) => kind === 'command'), '`>` 前缀混入了非命令结果')
      await input.fill('#')
      await page.waitForTimeout(220)
      const settingKinds = await kinds()
      assert.ok(settingKinds.length > 0, '`#` 前缀没有设置结果')
      assert.ok(settingKinds.every((kind) => kind === 'setting'), '`#` 前缀混入了非设置结果')
      await input.fill('@')
      await page.waitForTimeout(220)
      const sessionKinds = await kinds()
      assert.ok(sessionKinds.length > 0, '`@` 前缀没有会话结果')
      assert.ok(sessionKinds.every((kind) => kind === 'session'), '`@` 前缀混入了非会话结果')
      await input.fill('xhh')
      await page.waitForTimeout(220)
      const newSession = page
        .locator('[data-palette-kind="command"]')
        .filter({ hasText: '新会话' })
        .first()
      await newSession.waitFor({ state: 'visible', timeout: 3_000 })
      await page.keyboard.press('Escape')
    })

desktop('顶栏图标数 ≤5 且低频入口收进更多菜单', async (page) => {
      await openSession(page, 'long')
      const labels = await page.locator('header button[aria-label]').evaluateAll((els) =>
        els
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => el.getAttribute('aria-label') ?? ''),
      )
      assert.ok(labels.length <= 5, `顶栏图标 ${labels.length} 个：${labels.join(' / ')}`)
      assert.ok(labels.some((label) => label === '更多'), '顶栏没有「更多」入口')
      const more = page.getByRole('button', { name: '更多', exact: true })
      await more.click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 3_000 })
      for (const item of ['后台任务', '子代理', '浏览器', '文件', 'PR 与 CI', '评测与轨迹', '分屏']) {
        assert.ok((await menu.getByRole('menuitem', { name: item }).count()) >= 1, `更多菜单缺少「${item}」`)
      }
      await page.keyboard.press('Escape')
    })

desktop('命令面板可搜到更多菜单的全部入口', async (page) => {
      for (const keyword of ['后台任务', '子代理', '浏览器', '文件', 'PR 与 CI', '评测与轨迹', '分屏打开']) {
        await page.keyboard.press('Control+k')
        const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
        await input.waitFor({ state: 'visible', timeout: 5_000 })
        await input.fill(`>${keyword}`)
        await page.waitForTimeout(200)
        const row = page
          .locator('[data-palette-kind="command"]')
          .filter({ hasText: keyword })
          .first()
        assert.ok(await row.isVisible().catch(() => false), `命令面板搜不到「${keyword}」`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(120)
      }
    })

desktop('新功能导览：出现、跳转并全部标为已读', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[aria-label="消息输入框"]').first().waitFor({ timeout: 20_000 })
      const pill = page.getByRole('button', { name: /新功能 · \d+ 项/ }).first()
      await pill.waitFor({ state: 'visible', timeout: 10_000 })
      const pillText = (await pill.textContent()) ?? ''
      const expectedItems = Number(/新功能 · (\d+) 项/.exec(pillText)?.[1] ?? 0)
      assert.ok(expectedItems >= 12, `导览项数量异常：${pillText}`)
      await pill.click()
      const panel = page.getByRole('region', { name: '新功能导览' })
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await panel.getByRole('button', { name: /去看看/ }).count(), expectedItems, '导览项数量与入口不一致')
      await panel.getByRole('button', { name: /自动模型路由/ }).click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await dialog.locator('[data-settings-page-content="routing"]').count(),
        1,
        '导览跳转没有打开自动路由页',
      )
      assert.equal(
        await dialog.locator('[data-settings-page="routing"]').getAttribute('aria-current'),
        'page',
        '导览跳转后导航没有选中自动路由',
      )
      await closeSettings(page)
      // 再次出现后标记全部已读。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /新功能 · \d+ 项/ }).first().waitFor({ timeout: 10_000 })
      await page.getByRole('button', { name: /新功能 · \d+ 项/ }).first().click()
      const panel2 = page.getByRole('region', { name: '新功能导览' })
      await panel2.waitFor({ state: 'visible', timeout: 5_000 })
      await panel2.getByRole('button', { name: '全部标为已读' }).click()
      await page.waitForTimeout(250)
      assert.equal(await page.getByRole('button', { name: /新功能 · \d+ 项/ }).count(), 0, '已读后导览卡仍出现')
      const seen = await page.evaluate(() => localStorage.getItem('tandem.changelogSeen.v1'))
      assert.ok(seen, '已读版本没有写入 localStorage')
    })

fb2102('反馈1323#01：新功能提示条 30 秒未点开自动收起，本版本不再弹', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const closePill = page.getByRole('button', { name: '暂时关闭新功能提示' })
      // 假时钟：页面里的 30 秒计时由 page.clock 控制，不真等 30 秒。
      await page.clock.install({ time: new Date(today) })
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload()
      await closePill.waitFor({ timeout: 20_000 })
      await page.screenshot({ path: shot1323('01-tour-pill-visible-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('01-tour-pill-visible-light.png') })

      await page.clock.fastForward(29_000)
      assert.equal(await closePill.count(), 1, '不到 30 秒提示条不应收起')
      await page.clock.fastForward(2_000)
      assert.equal(await closePill.count(), 0, '30 秒没点开，提示条应自动收起')
      const seen = await page.evaluate(() => localStorage.getItem('tandem.changelogSeen.v1'))
      assert.ok(seen, '收起后应记为本版本已读')

      await page.reload()
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
      assert.equal(await closePill.count(), 0, '同一版本内不应再弹出')

      // 点开过就按现有逻辑：导览面板不会因为 30 秒到点被自动收起。
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload()
      const openPill = page.getByRole('button', { name: /^新功能 · \d+ 项/ })
      await openPill.waitFor({ timeout: 20_000 })
      await openPill.click()
      const panel = page.getByRole('region', { name: '新功能导览' })
      await panel.waitFor({ timeout: 5_000 })
      await page.clock.fastForward(31_000)
      assert.equal(await panel.count(), 1, '点开后的导览不应被自动收起')
    })
}
