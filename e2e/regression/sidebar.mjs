#!/usr/bin/env node
/**
 * 侧栏与列表（会话、项目、收件箱、搜索、命令面板入口、筛选）。
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

export const feature = 'sidebar'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [33, 48, 49, 50, 58, 92, 103, 104, 141, 159, 167, 168, 169, 170, 171, 172, 218]

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

desktop('侧栏会话 ⋯ 菜单与 tooltip 不被裁切', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-session-id="long"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), DESKTOP, '会话操作菜单')
      assert.match(await menu.innerText(), /重命名|置顶|归档/, '会话菜单缺少常用项')
      await page.keyboard.press('Escape')
      await page.mouse.move(DESKTOP.width / 2, DESKTOP.height / 2)
      await page.waitForTimeout(200)
      await row.hover()
      const tip = page.locator('#tandem-tooltip')
      await page.waitForFunction(() => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'), null, { timeout: 5_000 })
      withinViewport(await tip.boundingBox(), DESKTOP, '侧栏 tooltip')
      assert.match(await tip.innerText(), /回归长会话/, 'tooltip 不是会话完整标题')
    })

desktop('侧栏项目分「固定 / 最近」两组，固定图标语义与悬停规则（R01）', async (page) => {
      const recent = page.locator('[data-recent-projects]')
      await recent.waitFor({ state: 'visible' })
      assert.match(await recent.innerText(), /最近项目/, '最近项目分组缺少标题')
      const project = recent.locator('[data-project-row][data-project-key$=":repo"]').first()
      await project.waitFor({ state: 'visible' })
      const pin = project.getByRole('button', { name: '固定项目 repo', exact: true })
      assert.equal(
        await pin.evaluate((el) => getComputedStyle(el).opacity),
        '0',
        '未固定项目平时不应显示固定图标',
      )
      await project.hover()
      await pin.waitFor({ state: 'visible' })
      const pinnedIcon = (await pin.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(pinnedIcon.includes('lucide-pin'), `未固定项目的图标应为普通图钉：${pinnedIcon.join(' ')}`)
      assert.ok(!pinnedIcon.includes('lucide-pin-off'), '未固定项目误用了带斜杠的图钉')
      await pin.click()

      const pinnedSection = page.locator('[data-pinned-projects]')
      await pinnedSection.waitFor({ state: 'visible' })
      assert.match(await pinnedSection.innerText(), /固定项目/, '固定分组缺少标题')
      const pinnedProject = pinnedSection.locator('[data-project-row][data-project-key$=":repo"]').first()
      await pinnedProject.waitFor({ state: 'visible' })
      assert.equal(
        await recent.locator('[data-project-row][data-project-key$=":repo"]').count(),
        0,
        '固定后项目仍留在最近分组',
      )
      await pinnedProject.hover()
      const unpin = pinnedProject.getByRole('button', { name: '取消固定项目 repo', exact: true })
      await unpin.waitFor({ state: 'visible' })
      const unpinIcon = (await unpin.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(unpinIcon.includes('lucide-pin-off'), '已固定项目悬停应显示带斜杠的图钉')
      assert.ok(!unpinIcon.includes('lucide-pin'), '已固定项目误用了普通图钉')
      await unpin.click()
      await recent.locator('[data-project-row][data-project-key$=":repo"]').first().waitFor({ state: 'visible' })
      assert.equal(await page.locator('[data-pinned-projects]').count(), 0, '取消固定后固定分组仍在')

      // 会话级置顶遵循同一图标规则：平时不显示，悬停显示固定 / 取消固定。
      const sessionRow = page.locator('[data-session-row][data-session-id="long"]').first()
      await sessionRow.hover()
      const pinSession = sessionRow.getByRole('button', { name: '在项目中置顶', exact: true })
      await pinSession.waitFor({ state: 'visible' })
      const sessionPinIcon = (await pinSession.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(sessionPinIcon.includes('lucide-pin'), '未置顶会话应显示普通图钉')
      await pinSession.click()
      assert.equal(await sessionRow.getAttribute('data-session-pinned'), 'true', '会话置顶状态未生效')
      await sessionRow.hover()
      const unpinSession = sessionRow.getByRole('button', { name: '取消项目置顶', exact: true })
      await unpinSession.waitFor({ state: 'visible' })
      const sessionUnpinIcon = (await unpinSession.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(sessionUnpinIcon.includes('lucide-pin-off'), '已置顶会话应显示带斜杠的图钉')
      await unpinSession.click()
      assert.equal(await sessionRow.getAttribute('data-session-pinned'), null, '取消置顶未生效')
    })

desktop('侧栏项目 tooltip 显示主机与完整路径（R06）', async (page) => {
      const hostName = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.name ?? '',
      )
      const project = page.locator('[data-project-row][data-project-key$=":repo"] button').first()
      await project.hover()
      await page.waitForFunction(
        () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
        null,
        { timeout: 5_000 },
      )
      const tip = await page.locator('#tandem-tooltip').innerText()
      assert.ok(tip.includes(hostName), `项目 tooltip 缺少主机名：${tip}`)
      assert.ok(tip.includes(repo), `项目 tooltip 缺少完整路径：${tip}`)
      assert.ok(!tip.trim().startsWith('repo ·'), `项目 tooltip 仍在重复项目名：${tip}`)
    })

desktop('后台任务悬停展开列表并跳到对应输出（R01）', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible' })
      await menu.getByRole('menuitem', { name: /后台任务/ }).hover()
      const submenu = page.locator('[aria-label="后台任务"]')
      await submenu.waitFor({ state: 'visible', timeout: 5_000 })
      const listText = await submenu.innerText()
      assert.match(listText, /npm run dev/, `后台任务列表缺少命令：${listText}`)
      assert.match(listText, /已结束/, `后台任务列表缺少状态：${listText}`)
      await submenu.getByRole('menuitem', { name: /npm run dev/ }).waitFor({ state: 'visible' })
      const taskItem = submenu.getByRole('menuitem', { name: /npm run dev/ })
      const box = await taskItem.boundingBox()
      assert.ok(box, '找不到后台任务列表项')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
      await page.mouse.down()
      await page.mouse.up()
      const dialog = page.getByRole('dialog', { name: '后台任务' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(
        (await dialog.innerText()).includes('npm run dev -- --port 4173'),
        '打开的面板没有定位到对应后台任务',
      )
      await dialog.getByRole('button', { name: '关闭' }).click()

      await openSession(page, 'turns4')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const emptyMenu = page.locator('[role="menu"]').last()
      await emptyMenu.waitFor({ state: 'visible' })
      await emptyMenu.getByRole('menuitem', { name: /后台任务/ }).hover()
      const emptySubmenu = page.locator('[aria-label="后台任务"]')
      await emptySubmenu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await emptySubmenu.innerText(), /暂无后台任务/, '没有后台任务时未显示空态')
      await page.keyboard.press('Escape')
    })

desktop('反馈1601#05：侧栏主机与项目文件夹的折叠状态会被记住，重开仍折叠（R10）', async (page) => {
      await openSession(page, 'long')
      // 主机分组只在多主机时出现：加一台空主机（同一地址），测完清理。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        if (hosts.length < 2) {
          localStorage.setItem(
            'tandem.hosts.v1',
            JSON.stringify([...hosts, { ...hosts[0], id: 'reg-host-2', name: '演示主机' }]),
          )
        }
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      await page.waitForTimeout(900)
      const project = page.locator('[data-project-row]').first()
      await project.waitFor({ timeout: 10_000 })
      const projectKey = await project.getAttribute('data-project-key')
      const projectToggle = project.locator('button[aria-expanded]').first()
      assert.equal(await projectToggle.getAttribute('aria-expanded'), 'true', '项目默认应展开')
      await projectToggle.click()
      assert.equal(await projectToggle.getAttribute('aria-expanded'), 'false', '点击后项目没有折叠')
      const hostGroup = page.locator('[data-host-group]').first()
      await hostGroup.waitFor({ timeout: 10_000 })
      const hostToggle = hostGroup.locator('button[aria-expanded]').first()
      assert.equal(await hostToggle.getAttribute('aria-expanded'), 'true', '主机默认应展开')
      await hostToggle.click()
      assert.equal(await hostToggle.getAttribute('aria-expanded'), 'false', '点击后主机没有折叠')
      const stored = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}').collapsedProjects ?? [],
      )
      // 主机按主机标识、项目按项目路径记（不再用显示名）。
      assert.ok(stored.some((key) => key.startsWith('host:')), `没有记住主机折叠：${stored.join(',')}`)
      assert.ok(
        stored.some((key) => /:[/\\]/.test(key)),
        `项目折叠没有按项目路径记住：${stored.join(',')}`,
      )
      // 重开（刷新）：两级都应保持折叠。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      await page.waitForTimeout(900)
      const hostAfter = page.locator('[data-host-group]').first()
      await hostAfter.waitFor({ timeout: 10_000 })
      assert.equal(
        await hostAfter.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),
        'false',
        '重开后主机分组又展开了',
      )
      const projectAfter = page.locator(`[data-project-row][data-project-key="${projectKey}"]`).first()
      await projectAfter.waitFor({ timeout: 10_000 })
      assert.equal(
        await projectAfter.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),
        'false',
        '重开后项目文件夹又展开了',
      )
      // 清理：移除测试主机与折叠状态，避免影响后续用例。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').filter(
          (h) => h.id !== 'reg-host-2',
        )
        localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
        const prefs = JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}')
        delete prefs.collapsedProjects
        localStorage.setItem('tandem.ui.v1', JSON.stringify(prefs))
      })
    })

desktop('worktree 会话按原仓库归组而不是目录名 cache', async (page) => {
      await openSession(page, 'wt')
      const nav = page.locator('nav[aria-label="会话列表"]')
      await nav.getByText('重构 worktree 缓存').waitFor()
      const text = await nav.innerText()
      assert.match(text, new RegExp(path.basename(repo)), '侧栏没有显示原仓库名')
      const lines = text.split('\n').map((line) => line.trim())
      assert.equal(lines.includes('cache'), false, '侧栏把 worktree 目录当成项目名')
    })

desktop('侧栏「新会话」清空草稿并聚焦输入框', async (page) => {
      await openSession(page, 'long')
      const textarea = page.locator('[aria-label="消息输入框"]')
      await textarea.fill('第一段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.getAttribute('data-value'), '', '已在首页再点「新会话」没有清空草稿')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '消息输入框', '清空后没有聚焦输入框')
      await textarea.fill('第二段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.getAttribute('data-value'), '', '第二次点击「新会话」没有清空草稿')
    })

desktop('新会话默认带上工作目录且双击发送只创建一次', async (page) => {
      await waitModelReady(page)
      await page.waitForFunction(
        () => {
          const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => /^\//.test(b.getAttribute('data-tip') ?? ''))
          return !!trigger
        },
        null,
        { timeout: 10_000 },
      )
      const folderTitle = await page.evaluate(() => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => /^\//.test(b.getAttribute('data-tip') ?? ''))
        return trigger?.getAttribute('data-tip') ?? ''
      })
      assert.ok(folderTitle.includes(path.sep), `默认工作目录为空：${folderTitle}`)

      let posts = 0
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/sessions')) posts += 1
      })
      await page.locator('[aria-label="消息输入框"]').fill('新会话双击发送回归')
      const send = page.getByRole('button', { name: '发送消息' })
      await send.waitFor()
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        return button && !button.disabled
      })
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        button?.click()
        button?.click()
      })
      await page.waitForTimeout(1500)
      assert.equal(posts, 1, `连续点击发送创建了 ${posts} 个会话`)
      const sessions = await api(base, token, '/api/sessions')
      const created = sessions
        .filter((session) => session.title.includes('新会话双击') || session.cwd)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      assert.ok(created?.cwd, '新会话没有工作目录')
      await page.getByText('先选择一个工作目录').waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {})
      assert.equal(await page.getByText('先选择一个工作目录').count(), 0, '发送时仍提示先选择目录')
    })

desktop('反馈12#08：侧栏项目与会话缩进收紧、标题左对齐', async (page) => {
      await openSession(page, 'long')
      const project = page
        .locator('[data-project-row]')
        .filter({ has: page.locator('[data-session-row]') })
        .first()
      await project.waitFor({ timeout: 10_000 })
      const projectPad = await project
        .locator('button')
        .first()
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft))
      assert.ok(projectPad <= 8, `项目行缩进 ${projectPad}px，超过 8px`)
      const metrics = await project.evaluate((el) => {
        const projectTitle = [...el.querySelectorAll('button span')].find(
          (span) => span.className.includes('truncate') && span.textContent?.trim(),
        )
        const row = el.querySelector('[data-session-row]')
        // 标题只在溢出时才挂 data-tip，取标题文本节点（truncate span）更稳。
        const sessionTitle = [...(row?.querySelectorAll('span') ?? [])].find(
          (span) => span.className.includes('truncate') && span.textContent?.trim(),
        )
        const box = (node) => (node ? node.getBoundingClientRect().left : null)
        return { project: box(projectTitle), session: box(sessionTitle) }
      })
      assert.ok(metrics.project != null && metrics.session != null, '找不到项目/会话标题')
      assert.ok(
        Math.abs(metrics.project - metrics.session) <= 2,
        `会话标题与项目标题没有左对齐：${metrics.project} vs ${metrics.session}`,
      )
    })

desktop('收件箱：同一回合多次审批聚合为一条，展开可见流水', async (page) => {
      const sessionId = 'inboxmulti'
      await openSession(page, sessionId)
      const sessionOf = () => api(base, token, `/api/sessions/${sessionId}`)
      const before = (await sessionOf()).messages.length
      await page.locator('[aria-label="消息输入框"]').fill('INBOX_MULTI')
      await page.getByRole('button', { name: '发送消息' }).click()

      // 逐个允许本轮的两个 Bash 审批。
      for (let i = 0; i < 2; i += 1) {
        const allow = page.locator('button[data-permission-allow]').last()
        await allow.waitFor({ state: 'visible', timeout: 25_000 })
        await allow.click()
        await page.waitForTimeout(400)
      }
      await waitUntil('收件箱聚合用例回合完成', async () => {
        const current = await sessionOf()
        return current.status === 'idle' && current.messages.length > before
      })

      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      const dialog = page.getByRole('dialog', { name: '收件箱' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const group = dialog
        .getByTestId('inbox-history-group')
        .filter({ hasText: '收件箱聚合用例' })
        .filter({ hasText: '回合完成' })
      await group.first().waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await group.count(), 1, '同一回合的审批流水被拆成多条')
      const groupText = await group.first().innerText()
      assert.match(groupText, /回合完成 · 运行了 2 条命令（已允许）/, `聚合标题不对：${groupText}`)
      assert.equal(/已允许 · Bash/.test(groupText), false, '未展开时不应逐条显示审批流水')

      // 右侧独立箭头只负责展开；行主体点击打开会话并定位到该回合。
      await group.first().getByTestId('aggregate-toggle').click()
      const details = group.first().getByTestId('inbox-history-details')
      await details.waitFor({ state: 'visible', timeout: 5_000 })
      const detailText = await details.innerText()
      assert.equal(
        (detailText.match(/已允许 · Bash/g) ?? []).length,
        2,
        `明细条数不对：${detailText}`,
      )
      assert.match(detailText, /打开会话/, '展开明细后没有打开会话入口')

      // 明细里的命令也可点：跳到会话中对应的工具卡并定位。
      const firstDetail = details.getByTestId('aggregate-detail').first()
      await firstDetail.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/inboxmulti'), null, {
        timeout: 15_000,
      })
      await page.locator('[data-tool-use-id]').first().waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后工具卡仍被高亮')
      assert.equal(
        await page.locator('.tool-card, [data-tool-use-id]').first().isVisible(),
        true,
        '跳转后没有看到工具卡',
      )

      // 重新打开收件箱，点击行主体：打开会话（而不是展开明细）。
      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const groupAgain = dialog
        .getByTestId('inbox-history-group')
        .filter({ hasText: '收件箱聚合用例' })
        .filter({ hasText: '回合完成' })
        .first()
      await groupAgain.waitFor({ state: 'visible', timeout: 10_000 })
      await groupAgain.getByTestId('aggregate-open').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/inboxmulti'), null, {
        timeout: 15_000,
      })
    })

desktop('反馈1603#01：超过 7 天的会话默认收起，点开才加载，固定/未读始终显示', async (page) => {
      const row = (id) => page.locator(`[data-session-row][data-session-id="${id}"]`)
      await row('long').waitFor({ state: 'visible', timeout: 15_000 })
      const project = page.locator('[data-project-row]').filter({ has: row('long') }).first()
      const older = project.locator('[data-older-sessions]')

      // 默认收起：7 天前的空闲会话不渲染，固定/未读的仍然显示。
      assert.equal(await row('oldidle1').count(), 0, '7 天前的会话没有收起')
      assert.equal(await row('oldidle2').count(), 0, '7 天前的会话没有收起')
      assert.equal(await row('oldpinned').count(), 1, '项目固定的旧会话被收起了')
      assert.equal(await row('oldunread').count(), 1, '未读的旧会话被收起了')
      await older.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await older.innerText(), /更早的 2 个会话/, '组末没有「更早的 N 个会话」入口')
      assert.equal(await older.getAttribute('aria-expanded'), 'false', '收起态的展开按钮语义不对')

      // 点击才加载并展开。
      await older.click()
      await row('oldidle1').waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await row('oldidle2').count(), 1, '展开后旧会话没有全部出现')
      assert.equal(await older.getAttribute('aria-expanded'), 'true', '展开后的语义不对')

      // 展开状态按项目记住：重新加载页面后仍是展开的。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await row('long').waitFor({ state: 'visible', timeout: 20_000 })
      await row('oldidle1').waitFor({ state: 'visible', timeout: 10_000 })
      // 再点收起，回到默认并按项目记住。
      await project.locator('[data-older-sessions]').click()
      await row('oldidle1').waitFor({ state: 'detached', timeout: 5_000 })
      assert.equal(await row('oldpinned').count(), 1, '收起后固定的旧会话消失了')
      const stored = await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}').expandedOlderProjects ?? null
        } catch {
          return null
        }
      })
      assert.ok(stored === null || !stored.length, `收起后仍记着展开状态：${JSON.stringify(stored)}`)
      const dir = '/tmp/fix-1603c'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/01-older-sessions-collapsed.png` })
      await older.click()
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${dir}/01-older-sessions-expanded.png` })
    })

desktop('会话筛选：状态筛选与「已筛选 · 清除」', async (page) => {
      const row = (id) => page.locator(`[data-session-row][data-session-id="${id}"]`)
      await row('long').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '筛选会话' }).click()
      await page.getByRole('menuitemradio', { name: '已完成未读' }).click()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      await row('unreadonly').waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await row('long').isVisible(), false, '状态筛选后仍显示其他会话')
      const tag = page.getByRole('button', { name: /已筛选/ })
      await tag.waitFor({ state: 'visible', timeout: 3_000 })
      await tag.click()
      await row('long').waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await page.getByRole('button', { name: /已筛选/ }).count(), 0, '清除后筛选标签仍在')
    })

desktop('反馈1603#02：菜单危险项（删除）文字与图标常态 danger 色', async (page) => {
      const row = page.locator('[data-session-row][data-session-id="long"]').first()
      await row.waitFor({ state: 'visible', timeout: 15_000 })
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ timeout: 5_000 })
      const info = await menu.evaluate((el) => {
        const item = [...el.querySelectorAll('[role="menuitem"]')].find((node) =>
          (node.textContent ?? '').trim().startsWith('删除'),
        )
        if (!item) return null
        const style = getComputedStyle(item)
        const svg = item.querySelector('svg')
        return {
          text: style.color,
          icon: svg ? getComputedStyle(svg).color : null,
          danger: getComputedStyle(document.documentElement).getPropertyValue('--t-danger').trim(),
        }
      })
      assert.ok(info, '会话菜单里没有删除项')
      const toRgb = (value) => {
        const hex = value.replace('#', '')
        if (hex.length !== 6) return value
        return `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
      }
      const danger = toRgb(info.danger)
      assert.equal(info.text, danger, `删除项文字不是 danger 色：${info.text} / ${danger}`)
      assert.equal(info.icon, danger, `删除项图标不是 danger 色：${info.icon} / ${danger}`)
      // 其他普通项仍是中性色，不能整菜单变红。
      const normal = await menu.evaluate((el) => {
        const item = [...el.querySelectorAll('[role="menuitem"]')].find((node) =>
          (node.textContent ?? '').trim().startsWith('重命名'),
        )
        return item ? getComputedStyle(item).color : null
      })
      assert.ok(normal && normal !== danger, `普通菜单项也被染成 danger 色：${normal}`)
      const dir = '/tmp/fix-1603c'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/02-menu-danger-item.png` })
      await page.keyboard.press('Escape')
    })

desktop('反馈2156#02：打开会话后重新加载，未读点不再出现', async (page) => {
      const row = (id) => page.locator(`[data-session-row][data-session-id="${id}"]`)
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      await row('unreadopen').waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(
        await row('unreadopen').locator('[data-unread-dot="true"]').count(),
        1,
        '未读会话缺少未读点',
      )
      await row('unreadopen').locator('[data-session-open="true"]').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/unreadopen'), null, {
        timeout: 10_000,
      })
      await row('unreadopen').locator('[data-unread-dot="true"]').waitFor({
        state: 'detached',
        timeout: 10_000,
      })
      // 切到别的会话再重新加载：路由不再自动打开 unreadopen，能验证服务端已读是否落库。
      await openSession(page, 'long')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await row('unreadopen').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(800)
      assert.equal(
        await row('unreadopen').locator('[data-unread-dot="true"]').count(),
        0,
        '重新加载后未读点又出现了（已读没有写回服务端）',
      )
    })

checks.push({
      name: '侧栏按主机分组显示全部会话，无主机切换按钮；离线仍可浏览（#02）',
      viewport: 'desktop',
      // 独立 context：本用例会临时添加第二台主机，不影响其他用例。
      context: 'win32',
      fn: async (page) => {
        await page.waitForFunction(
          () => {
            try {
              return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
            } catch {
              return false
            }
          },
          null,
          { timeout: 20_000 },
        )
        const firstName = await page.evaluate(
          ({ base, token }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            const first = hosts[0]
            const second = {
              ...first,
              id: 'host-second',
              name: '第二台主机',
              addedAt: Date.now() + 1,
            }
            localStorage.setItem('tandem.hosts.v1', JSON.stringify([first, second]))
            return first?.name ?? '本机'
          },
          { base, token },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        const hostGroups = page.locator('[data-host-group]')
        await hostGroups.first().waitFor({ state: 'visible', timeout: 20_000 })
        await page.waitForTimeout(600)

        // 反馈6#02：去掉「本机 ⌄」主机切换按钮，会话列表一次显示所有主机。
        assert.equal(
          await page.getByRole('button', { name: '切换主机' }).count(),
          0,
          '侧栏仍存在主机切换按钮',
        )
        assert.equal(await hostGroups.count(), 2, '会话列表没有按两台主机分组')
        const headings = await hostGroups.allInnerTexts()
        assert.match(headings[0] ?? '', new RegExp(firstName), `第一台主机分组标题不对：${headings[0]}`)
        assert.match(headings[1] ?? '', /第二台主机/, `第二台主机分组标题不对：${headings[1]}`)
        assert.equal(
          await page.locator('[data-host-group] [data-project-row]').count() > 0,
          true,
          '主机分组下没有项目分组',
        )

        // 离线：分组标题标出离线状态，缓存的会话仍可浏览。
        await page.evaluate(() => window.dispatchEvent(new Event('offline')))
        await page.getByText('离线', { exact: true }).first().waitFor({ timeout: 5_000 })
        await page
          .locator('[data-session-row][data-session-id="long"]')
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 })
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await page.waitForTimeout(300)

        // 筛选菜单里保留「按主机筛选」。
        await page.getByRole('button', { name: '筛选会话' }).click()
        await page.getByRole('menuitem', { name: '主机' }).click()
        const sub = page.locator('[aria-label="按主机筛选"]')
        await sub.waitFor({ state: 'visible', timeout: 5_000 })
        const subText = await sub.innerText()
        assert.match(subText, /全部主机/, '筛选菜单缺少全部主机')
        assert.match(subText, /第二台主机/, '筛选菜单缺少按主机筛选的选项')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
      },
    })

desktop('全文搜索：命中片段、打开会话并定位消息', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('中文短语')
      const hit = page
        .locator('[data-search-hit]')
        .filter({ hasText: '全文检索会话' })
        .first()
      await hit.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(
        (await hit.locator('mark.chat-match').count()) > 0,
        '搜索命中没有高亮片段',
      )
      assert.ok(
        ((await hit.textContent()) ?? '').includes('中文短语'),
        '搜索命中片段缺少关键词',
      )
      await hit.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/search'), null, {
        timeout: 10_000,
      })
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-message-id="s2"]')
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        null,
        { timeout: 12_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '搜索跳转后消息仍被高亮')
    })

fb2102('反馈1323#04：侧栏底部一行账号 + 齿轮，账号菜单只放账号与工作站设置', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      // 工作区账号只存在 localStorage；主机仍用已连上的直连地址，不新增网络依赖。
      await page.evaluate(() => {
        const now = Date.now()
        localStorage.setItem(
          'tandem.account.v1',
          JSON.stringify({
            centerUrl: 'http://127.0.0.1:9',
            accessToken: 'reg-access',
            refreshToken: 'reg-refresh',
            accessExpiresAt: now + 86_400_000,
            refreshExpiresAt: now + 30 * 86_400_000,
            account: { id: 'acc-reg', name: '调试账号', username: 'debug', role: 'admin', debug: true },
            workspace: { id: 'ws-reg', name: '调试' },
          }),
        )
      })
      await page.reload()
      const footer = page.locator('aside [data-sidebar-footer]')
      await footer.waitFor({ timeout: 20_000 })
      const controls = await footer.locator('button').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { y: r.y, h: r.height, w: r.width, x: r.x }
        }),
      )
      assert.equal(controls.length, 2, `侧栏底部应只有账号与齿轮两个控件：${controls.length}`)
      assert.ok(
        Math.abs(controls[0].y + controls[0].h / 2 - (controls[1].y + controls[1].h / 2)) <= 1,
        '账号与齿轮不在同一行',
      )
      assert.ok(controls[0].w > controls[1].w && controls[0].x < controls[1].x, '账号在左、齿轮在右')
      const footerText = await footer.innerText()
      assert.match(footerText, /调试账号/, '底部没有显示账号名')
      assert.doesNotMatch(footerText, /工作站/, `底部不应再有整行「工作站」：${footerText}`)
      assert.doesNotMatch(footerText, /^设置$/m, `底部不应再有整行「设置」：${footerText}`)

      // 齿轮是唯一设置入口。
      await footer.getByRole('button', { name: '设置', exact: true }).click()
      const settingsDialog = page.getByRole('dialog', { name: '设置' })
      await settingsDialog.waitFor({ timeout: 5_000 })
      await settingsDialog.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await settingsDialog.waitFor({ state: 'hidden', timeout: 5_000 })

      const accountTrigger = footer.getByRole('button', { name: /调试账号/ })
      await accountTrigger.click()
      const menu = page.getByRole('menu')
      await menu.waitFor({ timeout: 5_000 })
      const items = (await menu.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.ok(items.includes('账号设置'), `账号菜单缺少账号设置：${items.join(' / ')}`)
      assert.ok(items.includes('工作站设置'), `账号菜单缺少工作站设置：${items.join(' / ')}`)
      assert.ok(items.some((text) => text.includes('退出')), `账号菜单缺少退出登录：${items.join(' / ')}`)
      assert.ok(!items.includes('工作站'), `账号菜单不应再有设备入口：${items.join(' / ')}`)
      assert.ok(!items.includes('设备'), `账号菜单不应再有设备入口：${items.join(' / ')}`)
      assert.ok(!items.some((text) => text.includes('工作站管理')), `旧「工作站管理」应已改名：${items.join(' / ')}`)
      await page.waitForTimeout(200)
      await page.screenshot({ path: shot1323('04-sidebar-account-menu-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('04-sidebar-account-menu-light.png') })

      // 账号设置与工作站设置都直达唯一设置入口。
      await menu.getByRole('menuitem', { name: '账号设置', exact: true }).click()
      const accountSettings = page.getByRole('dialog', { name: '设置' })
      await accountSettings.waitFor({ timeout: 5_000 })
      await accountSettings.locator('[data-settings-page-content="profiles"]').waitFor({ timeout: 5_000 })
      await accountSettings.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await accountSettings.waitFor({ state: 'hidden', timeout: 5_000 })

      await accountTrigger.click()
      await menu.waitFor({ timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '工作站设置', exact: true }).click()
      const workstationDialog = page.getByRole('dialog', { name: '设置' })
      await workstationDialog.waitFor({ timeout: 5_000 })
      await workstationDialog.locator('[data-settings-page-content="workstation"]').waitFor({ timeout: 5_000 })
      await workstationDialog.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await page.getByRole('menu').waitFor({ state: 'detached', timeout: 2_000 }).catch(() => {})
      assert.equal(await page.getByRole('menu').count(), 0, '选中菜单项后账号菜单应收起')

      await page.evaluate(() => localStorage.removeItem('tandem.account.v1'))
    })
}
