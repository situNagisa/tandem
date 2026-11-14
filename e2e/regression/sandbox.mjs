#!/usr/bin/env node
/**
 * 权限与沙箱（审批卡、快捷规则、Secrets）。
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

export const feature = 'sandbox'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [25, 143, 144, 145, 146, 147, 149, 150, 151]

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

desktop('Secrets 工具输出显示打码标签', async (page) => {
      await openSession(page, 'secrets')
      await page.locator('.tool-row').first().click()
      const tag = page.locator('[data-secret-redacted="DB_PASSWORD"]').first()
      await tag.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await tag.innerText(), '[secret:DB_PASSWORD]', '打码标签文案不对')
      const detail = await page.locator('.tool-detail').first().innerText()
      assert.ok(detail.includes('[secret:DB_PASSWORD]'), '工具输出里没有打码标签')
      assert.ok(!detail.includes('S3cr3t'), '工具输出泄露了 secret 明文')
      await tag.hover()
      await page.waitForFunction(
        () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
        null,
        { timeout: 5_000 },
      )
      const tip = await page.locator('#tandem-tooltip').innerText()
      assert.match(tip, /已隐藏 secret：DB_PASSWORD/, `hover 提示不对：${tip}`)
    })

desktop('审批策略：同类请求多次批准后审批卡出现项目快捷规则', async (page) => {
      await openSession(page, 'learn')
      const learned = page.locator('[data-permission-learned]')
      await learned.waitFor({ timeout: 10_000 })
      const text = await learned.innerText()
      assert.match(text, /以后在本项目自动允许/)
      assert.match(text, /vitest run\*/)
    })

desktop('命令沙箱：工作目录外写入在 acceptEdits 下仍出现审批卡', async (page) => {
      await openSession(page, 'outside')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      const text = await card.innerText()
      assert.match(text, /工作目录之外/, '审批卡没有说明写入工作目录之外')
      assert.match(text, /tandem-reg-outside\.txt/, '审批卡没有显示越界路径')
    })

desktop('沙箱：worktree 会话写 cwd 内文件不弹审批', async () => {
      const { evaluateSandbox } = await import(
        pathToFileURL(path.join(ROOT, 'packages/server/dist/sandbox.js')).href
      )
      const wtCwd = path.join(configDir, 'worktrees', 'repo', 'tandem-demo')
      const settings = { enabled: true, network: 'host', strict: false, allowedHosts: ['localhost'] }
      const base = {
        settings,
        cwd: wtCwd,
        worktreePath: wtCwd,
        home: os.homedir(),
        tandemHome: configDir,
      }
      const write = evaluateSandbox(
        'Write',
        { file_path: path.join(wtCwd, 'src', 'a.ts'), content: 'x' },
        base,
      )
      assert.equal(write.notices.length, 0, `worktree 内写入被拦截：${write.notices[0]?.reason ?? ''}`)
      const bash = evaluateSandbox('Bash', { command: 'echo x > src/a.ts' }, base)
      assert.equal(bash.notices.length, 0, `worktree 内 Bash 写入被拦截：${bash.notices[0]?.reason ?? ''}`)
      const config = evaluateSandbox(
        'Write',
        { file_path: path.join(configDir, 'config.json'), content: 'x' },
        base,
      )
      assert.equal(config.notices[0]?.kind, 'protected', 'Tandem 配置文件没有受保护')
    })

desktop('审批策略：危险命令审批卡不出现项目快捷规则', async (page) => {
      await openSession(page, 'danger')
      await page.locator('.permission-card').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      assert.equal(
        await page.locator('[data-permission-learned]').count(),
        0,
        '危险命令出现了自动允许快捷选项',
      )
    })

desktop('审批策略：权限页显示统计与建议，危险命令只建议询问', async (page) => {
      const dialog = await openSettings(page, '权限', 'desktop')
      const stats = await dialog.locator('[data-approval-stats]').innerText()
      assert.match(stats, /弹窗 9 次/)
      assert.match(stats, /被规则自动处理 2 次/)
      const learned = dialog.locator('[data-suggestion="vitest run*"]')
      await learned.waitFor({ timeout: 10_000 })
      assert.match(await learned.innerText(), /自动允许/)
      assert.equal(await learned.getByRole('button', { name: '采纳' }).count(), 1)
      assert.equal(await learned.getByRole('button', { name: '忽略' }).count(), 1)
      const danger = dialog.locator('[data-suggestion="rm*"]')
      await danger.waitFor()
      const dangerText = await danger.innerText()
      assert.match(dangerText, /总是询问/)
      assert.equal(/自动允许/.test(dangerText), false, '危险命令被建议自动允许')
      await dialog.getByLabel('用一句话生成权限规则').waitFor()
      await closeSettings(page)
    })

desktop('反馈1603#03：审批卡宽度 352、按钮 拒绝/更多/允许一次（主按钮）贴底', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      const inner = card.locator(':scope > div').first()
      const width = (await inner.boundingBox()).width
      assert.ok(
        Math.abs(width - 352) <= 2,
        `审批卡宽度 ${Math.round(width)}px，没有按 352 收窄`,
      )
      const deny = card.locator('[data-permission-deny]')
      const allow = card.locator('[data-permission-allow]')
      const more = card.getByRole('button', { name: '更多' })
      const [denyBox, moreBox, allowBox] = await Promise.all([
        deny.boundingBox(),
        more.boundingBox(),
        allow.boundingBox(),
      ])
      assert.ok(denyBox && moreBox && allowBox, '按钮不可见')
      assert.ok(
        denyBox.x + denyBox.width < moreBox.x && moreBox.x + moreBox.width < allowBox.x,
        `按钮顺序不是 拒绝 / 更多 / 允许一次：${denyBox.x} ${moreBox.x} ${allowBox.x}`,
      )
      assert.equal(await deny.getAttribute('data-variant'), 'secondary', '拒绝按钮变体不是次要按钮')
      assert.equal(await allow.getAttribute('data-variant'), 'primary', '允许一次不是主按钮')
      assert.match(await allow.innerText(), /Ctrl/, '允许一次缺少 Ctrl⏎ 提示')
      // 按钮行贴卡片底部内边距（py-3 = 12px），卡片变高时仍停在底部。
      const innerBox = await inner.boundingBox()
      const gap = innerBox.y + innerBox.height - (allowBox.y + allowBox.height)
      assert.ok(Math.abs(gap - 12) <= 2, `按钮行离卡片底部 ${Math.round(gap)}px，没有贴底`)
      const dir = '/tmp/fix-1603c'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/03-permission-card.png` })
    })

desktop('反馈14#07：审批是对话流里的一条消息，样式参考 Claude Code Desktop', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      // 卡片在对话流里（随消息滚动），不在输入框上方停靠。
      assert.ok(await card.evaluate((el) => !!el.closest('.chat-scroll')), '审批卡没有渲染在对话流里')
      assert.equal(
        await page.locator('[data-composer-anchor] .permission-card').count(),
        0,
        '审批卡仍停靠在输入框上方',
      )
      const row = page.locator('[data-message-id="ap2"]').first()
      const rowBox = await row.boundingBox()
      const cardBox = await card.boundingBox()
      assert.ok(rowBox && cardBox && cardBox.y >= rowBox.y, '审批卡不在触发它的工具调用之后')
      const text = await card.innerText()
      assert.match(text, /允许运行/)
      assert.match(text, /npm test/)
      assert.match(text, /批准后本条命令会立即执行/)
      // 不再有编号列表与大代码块，只有两个动作按钮 + 更多。
      assert.equal(await card.locator('[role="radiogroup"], [role="radio"]').count(), 0, '审批卡仍是编号列表')
      assert.equal(await card.locator('pre, .code-block').count(), 0, '审批卡里还有大代码块')
      assert.equal(await card.locator('[data-permission-deny]').count(), 1, '缺少拒绝按钮')
      assert.equal(await card.locator('[data-permission-allow]').count(), 1, '缺少允许一次按钮')
      assert.match(await card.locator('[data-permission-allow]').innerText(), /Ctrl/)
      // 输入框保持可用。
      const composer = page.locator('[aria-label="消息输入框"]').first()
      assert.ok(await composer.isEnabled(), '有待审批时输入框被禁用')
      // 更多菜单：本会话总是允许 / 添加为规则。
      await card.getByRole('button', { name: '更多' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ timeout: 5_000 })
      const menuText = await menu.innerText()
      for (const item of ['本会话总是允许', '添加为规则']) {
        assert.ok(menuText.includes(item), `更多菜单缺少「${item}」：${menuText}`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      // Ctrl+Enter（焦点在空输入框）允许一次，卡片收成一行结果留在流里。
      await composer.click()
      await page.keyboard.press('Control+Enter')
      const result = page.locator('[data-permission-result]').first()
      await result.waitFor({ timeout: 10_000 })
      const resultText = await result.innerText()
      assert.match(resultText, /已允许/)
      assert.match(resultText, /npm test/)
      assert.equal(await page.locator('.permission-card').count(), 0, '允许后审批卡没有收起')
      assert.ok(await result.evaluate((el) => !!el.closest('.chat-scroll')), '审批结果不在对话流里')
    })

desktop('反馈14#07：Esc 拒绝、发送消息视为拒绝并说明', async (page) => {
      await openSession(page, 'danger')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      const composer = page.locator('[aria-label="消息输入框"]').first()
      await composer.click()
      await page.keyboard.press('Escape')
      const result = page.locator('[data-permission-result]').first()
      await result.waitFor({ timeout: 10_000 })
      assert.match(await result.innerText(), /已拒绝/)
      assert.equal(await page.locator('.permission-card').count(), 0, 'Esc 后审批卡没有收起')

      await openSession(page, 'learn')
      const learnCard = page.locator('.permission-card').first()
      await learnCard.waitFor({ timeout: 10_000 })
      await composer.fill('先别跑，改成 dry-run')
      await composer.press('Enter')
      const learnResult = page.locator('[data-permission-result]').first()
      await learnResult.waitFor({ timeout: 10_000 })
      assert.match(await learnResult.innerText(), /已拒绝/)
      await page.getByText('先别跑，改成 dry-run').first().waitFor({ timeout: 10_000 })
    })
}
