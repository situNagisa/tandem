#!/usr/bin/env node
/**
 * 账号、分组与模型（Key、倍率、模型菜单、思考强度、上下文、额度交接）。
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

export const feature = 'model-accounts'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [21, 22, 23, 34, 35, 36, 37, 80, 81, 82, 83, 91, 114, 115, 220]

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

desktop('配额将尽时交接卡可切换备用分组', async (page) => {
      await openSession(page, 'quota')
      await waitOnline(page)
      await waitModelReady(page)
      const box = page.locator('[aria-label="消息输入框"]').first()
      await box.fill('第二轮：继续实现')
      await box.press('Enter')
      await page.getByText('配额主分组回复：第二次请求完成。').first().waitFor({ timeout: 20_000 })

      // 用量卡显示按当前速度的预估（受限于 Key 限流）
      const quotaLine = page.locator('[data-quota-line="usage"]')
      await quotaLine.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await quotaLine.innerText(), /按当前速度约可再跑 \d+ 轮（受限于：Key 限流）/)

      // 主分组下一次请求 429：出现交接卡（默认策略「询问」）
      await box.fill('第三轮：继续实现')
      await box.press('Enter')
      const card = page.locator('[data-handoff-card="true"]')
      await card.waitFor({ state: 'visible', timeout: 20_000 })
      const cardText = await card.innerText()
      assert.match(cardText, /额度将尽/)
      assert.match(cardText, /切换到 .*备用分组/, `交接卡缺少备用分组：${cardText}`)
      await page.screenshot({ path: path.join(shots, 'quota-handoff-card.png') })

      await card.getByRole('button', { name: /^切换到 / }).click()
      await page.getByText(/已从 .* 交接到 /).first().waitFor({ timeout: 20_000 })
      await page.getByText('配额备用分组回复：已继续。').first().waitFor({ timeout: 20_000 })
      await page.screenshot({ path: path.join(shots, 'quota-handoff-switched.png') })

      const after = await api(base, token, '/api/sessions/quota')
      assert.equal(after.groupId, 'g-quota-backup', '切换后会话应使用备用分组')
      assert.equal(after.model, 'quota-backup-model', '切换后应使用备用分组的默认模型')
      assert.equal(after.handoff?.status, 'done', '交接状态应为 done')
      assert.ok(after.handoff?.checkpointId, '切换前应保存检查点')
      const checkpoints = await api(base, token, '/api/sessions/quota/checkpoints')
      assert.ok(
        checkpoints.some((item) => item.id === after.handoff.checkpointId),
        '检查点列表里找不到交接检查点',
      )
      const quotaAfter = page.locator('[data-quota-line="usage"]')
      assert.match(await quotaAfter.innerText(), /按当前速度约可再跑 \d+ 轮/)
    })

desktop('反馈0220#02：额度将尽时可继续使用当前分组跑完本轮', async (page) => {
      const outDir = '/tmp/fix-0220c/regression'
      mkdirSync(outDir, { recursive: true })
      await openSession(page, 'quota-continue')
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await waitOnline(page)
      await waitModelReady(page)
      const box = page.locator('[aria-label="消息输入框"]').first()
      await box.fill('第二轮：用当前分组继续')
      await box.press('Enter')

      const card = page.locator('[data-handoff-card="true"]')
      await card.waitFor({ state: 'visible', timeout: 20_000 })
      const cardText = await card.innerText()
      assert.match(cardText, /额度将尽/, `交接卡缺少额度提示：${cardText}`)
      assert.match(cardText, /没有备用分组/, `交接卡不应有备用分组：${cardText}`)
      const firstButton = (await card.getByRole('button').first().innerText()).trim()
      assert.equal(firstButton, '继续使用当前分组', `继续按钮不在第一位：${firstButton}`)
      await page.screenshot({ path: path.join(outDir, 'handoff-continue-card.png') })

      await card.getByRole('button', { name: '继续使用当前分组' }).click()
      await page.getByText('继续使用当前分组后完成。').first().waitFor({ timeout: 20_000 })
      await page.screenshot({ path: path.join(outDir, 'handoff-continue-done.png') })

      const after = await api(base, token, '/api/sessions/quota-continue')
      assert.equal(after.handoff?.status, 'done', '继续后交接状态应为 done')
      assert.equal(after.groupId, 'g-continue', '继续使用当前分组不应切换分组')
      assert.equal(after.model, 'quota-continue-model', '继续使用当前分组不应切换模型')
      await page.waitForTimeout(300)
      assert.equal(await page.locator('[data-handoff-card="true"]').count(), 0, '继续后交接卡应消失')

      // 本会话后续同类提醒不再拦截：第 3 次请求仍 429，直接重试成功，不再弹卡。
      await box.fill('第三轮：继续用当前分组')
      await box.press('Enter')
      await page.getByText('继续后第三轮完成。').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(300)
      assert.equal(await page.locator('[data-handoff-card="true"]').count(), 0, '继续后同类提醒不应再弹交接卡')
      await page.screenshot({ path: path.join(outDir, 'handoff-continue-next-turn.png') })
    })

desktop('反馈0220#02：关闭额度交接后不再出现交接卡', async (page) => {
      const outDir = '/tmp/fix-0220c/regression'
      mkdirSync(outDir, { recursive: true })
      const original = await api(base, token, '/api/settings')
      try {
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ handoff: { policy: 'off' } }),
        })
        await openSession(page, 'quota-off')
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        await waitOnline(page)
        await waitModelReady(page)
        const box = page.locator('[aria-label="消息输入框"]').first()
        await box.fill('第二轮：关闭交接后继续')
        await box.press('Enter')
        await page.getByText('关闭交接后本轮完成。').first().waitFor({ timeout: 20_000 })
        await page.waitForTimeout(300)
        assert.equal(await page.locator('[data-handoff-card="true"]').count(), 0, '关闭交接后不应出现交接卡')
        const after = await api(base, token, '/api/sessions/quota-off')
        assert.notEqual(after.handoff?.status, 'pending', '关闭交接后不应产生待处理交接')
        await page.screenshot({ path: path.join(outDir, 'handoff-off-done.png') })
      } finally {
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ handoff: original.handoff ?? { policy: 'ask' } }),
        })
      }
    })

desktop('模型菜单级联（账号 → 分组 → 模型）逐级飞出且不越界（#7-04）', async (page) => {
      await openSession(page, 'long')
      await waitModelReady(page)
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const rootMenu = page.locator('[role="menu"]').first()
      await rootMenu.waitFor()
      withinViewport(await rootMenu.boundingBox(), DESKTOP, '模型菜单')
      assert.match(await rootMenu.innerText(), /切换账号/, '主菜单缺少「切换账号」级联入口')
      const accountTrigger = rootMenu.getByRole('menuitem', { name: /切换账号/ }).first()
      await accountTrigger.hover()
      const accountMenu = page.locator('[role="menu"][aria-label="切换账号"]').first()
      await accountMenu.waitFor({ state: 'visible' })
      withinViewport(await accountMenu.boundingBox(), DESKTOP, '切换账号子菜单')
      // 反馈 #7-04：悬停账号 → 右侧飞出分组，不允许在原地替换或出现返回行。
      assert.equal(
        await accountMenu.getByText(/返回|‹/).count(),
        0,
        '账号子菜单出现了「返回」式原地导航',
      )
      const mainAccount = accountMenu.getByRole('menuitem', { name: /主力账号/ }).first()
      await mainAccount.hover()
      const groupMenu = page.locator('[role="menu"][aria-label="主力账号"]').first()
      await groupMenu.waitFor({ state: 'visible', timeout: 5_000 })
      withinViewport(await groupMenu.boundingBox(), DESKTOP, '分组子菜单')
      assert.equal(
        await groupMenu.getByText(/返回|‹/).count(),
        0,
        '分组子菜单出现了「返回」式原地导航',
      )
      const backup = groupMenu.getByRole('menuitem', { name: /备用/ }).first()
      await backup.hover()
      const modelMenu = page.locator('[role="menu"][aria-label="主力账号 · 备用"]').first()
      await modelMenu.waitFor({ state: 'visible', timeout: 5_000 })
      withinViewport(await modelMenu.boundingBox(), DESKTOP, '模型子菜单')
      assert.ok((await modelMenu.getByRole('menuitem', { name: /O3/i }).count()) >= 1, '模型子菜单没有列出模型')
      const response = page.waitForResponse(
        (res) => res.url().includes('/api/sessions/long') && res.request().method() === 'PATCH',
        { timeout: 10_000 },
      )
      await modelMenu.getByRole('menuitem', { name: /O3/i }).click()
      await response
      await rootMenu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      assert.match(await page.getByRole('button', { name: '选择模型' }).first().innerText(), /O3/, '选择后模型按钮未更新')
      const stored = await api(base, token, '/api/sessions/long')
      assert.equal(stored.model, 'o3', '会话模型未落库')
      assert.equal(stored.groupId, 'g2', '会话分组未落库')
    })

desktop('思考强度档位来自模型能力，名称用厂商叫法（#7-05）', async (page) => {
      await openSession(page, 'priced')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const effortTrigger = menu.getByRole('menuitem', { name: /思考强度/ }).first()
      await effortTrigger.hover()
      const submenu = page.locator('[role="menu"][aria-label="思考强度"]').first()
      await submenu.waitFor({ state: 'visible', timeout: 5_000 })
      const text = await submenu.innerText()
      assert.match(text, /低 · low/, `o3 档位没有使用 reasoning_effort 原名：${text}`)
      assert.match(text, /中 · medium/, `o3 档位缺少 medium：${text}`)
      assert.match(text, /高 · high/, `o3 档位缺少 high：${text}`)
      assert.equal(await submenu.getByRole('menuitemradio', { name: '关', exact: true }).count(), 0, 'o3 不应出现「关」档位')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // 反馈2121#01：Anthropic adaptive 型号按官方 effort 表，不再显示 2K/8K/16K/32K 预算标签。
      await openSession(page, 'claude-effort')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const claudeMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await claudeMenu.waitFor()
      const claudeEffortTrigger = claudeMenu.getByRole('menuitem', { name: /思考强度/ }).first()
      await claudeEffortTrigger.hover()
      const claudeSubmenu = page.locator('[role="menu"][aria-label="思考强度"]').first()
      await claudeSubmenu.waitFor({ state: 'visible', timeout: 5_000 })
      const claudeText = await claudeSubmenu.innerText()
      for (const label of ['低 · low', '中 · medium', '高 · high', '超高 · xhigh', '最高 · max']) {
        assert.ok(claudeText.includes(label), `Sonnet 5.5 缺少档位 ${label}：${claudeText}`)
      }
      assert.doesNotMatch(claudeText, /\d+K/, `adaptive 型号仍显示 token 预算标签：${claudeText}`)
      assert.equal(
        await claudeSubmenu.getByRole('menuitemradio', { name: '关', exact: true }).count(),
        0,
        'Sonnet 5.5 不能关闭思考，不应出现「关」',
      )
      assert.match(await claudeEffortTrigger.innerText(), /最高 · max/, '当前档位没有显示厂商原名')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // 不支持思考的模型隐藏整个「思考强度」项。
      await openSession(page, 'nockpt')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const plainMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await plainMenu.waitFor()
      assert.equal(
        await plainMenu.getByRole('menuitem', { name: /思考强度/ }).count(),
        0,
        '未知/不支持思考的模型仍显示思考强度',
      )
      await page.keyboard.press('Escape')
    })

desktop('1M 上下文开关按型号能力显示，切换后上下文卡分母变化', async (page) => {
      // Sonnet 5.5 原生 1M：默认显示 1M，可切到 200K。
      await openSession(page, 'claude-effort')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const contextTrigger = menu.getByRole('menuitem', { name: /上下文/ }).first()
      assert.equal(await contextTrigger.count(), 1, `Sonnet 5.5 缺少上下文开关：${await menu.innerText()}`)
      assert.match(await contextTrigger.innerText(), /1M/, '原生 1M 型号默认应显示 1M')
      await contextTrigger.hover()
      const submenu = page.locator('[role="menu"][aria-label="上下文"]').first()
      await submenu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await submenu.getByRole('menuitemradio', { name: '200K' }).count(), 1, '上下文开关缺少 200K')
      assert.equal(await submenu.getByRole('menuitemradio', { name: '1M' }).count(), 1, '上下文开关缺少 1M')
      await submenu.getByRole('menuitemradio', { name: '200K' }).click()
      await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      const stored = await api(base, token, '/api/sessions/claude-effort')
      assert.equal(stored.longContext, false, '切到 200K 没有写入会话')
      const breakdown = await api(base, token, '/api/sessions/claude-effort/context')
      assert.equal(breakdown.contextWindow, 200_000, '上下文卡分母没有按 200K 计算')

      // Sonnet 4.5 只有 200K：菜单不显示上下文开关。
      await openSession(page, 'claude-45')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const plainMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await plainMenu.waitFor()
      assert.equal(
        await plainMenu.getByRole('menuitem', { name: /上下文/ }).count(),
        0,
        'Sonnet 4.5 不应出现 1M 上下文开关',
      )
      await page.keyboard.press('Escape')
    })

desktop('旧上下文快照的分母按当前型号与 1M 开关实时计算', async (page) => {
      // 升级前落库的快照分母是 200K、longContext 缺省；原生 1M 型号初次打开就应是 1M。
      const legacy = await api(base, token, '/api/sessions/claude-legacy')
      assert.equal(legacy.context?.contextWindow, 1_000_000, '读取旧快照时分母没有按型号能力重算')
      await openSession(page, 'claude-legacy')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const group = page.locator('[data-group="context"]').first()
      await group.waitFor({ state: 'visible', timeout: 15_000 })
      const card = group.locator('[data-context-card]').first()
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await card.innerText(), /61k \/ 1\.00m/, '旧快照初次打开的分母不是 1M')

      // 切到 200K 后分母变 200k。
      const switchContext = async (label) => {
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        await menu.getByRole('menuitem', { name: /上下文/ }).first().hover()
        const submenu = page.locator('[role="menu"][aria-label="上下文"]').first()
        await submenu.waitFor({ state: 'visible', timeout: 5_000 })
        await submenu.getByRole('menuitemradio', { name: label }).click()
        await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      }
      await switchContext('200K')
      assert.match(await card.innerText(), /61k \/ 200k/, '切到 200K 后分母没有变化')
      assert.equal(
        (await api(base, token, '/api/sessions/claude-legacy')).context?.contextWindow,
        200_000,
        '切到 200K 后快照分母没有落成 200K',
      )

      // 再切回 1M 分母回到 1M，刷新页面后保持。
      await switchContext('1M')
      assert.match(await card.innerText(), /61k \/ 1\.00m/, '切回 1M 后分母没有回到 1M')
      await page.reload()
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 20_000 })
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const reloaded = page.locator('[data-context-card]').first()
      await reloaded.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await reloaded.innerText(), /61k \/ 1\.00m/, '刷新后上下文卡分母不是 1M')
    })

desktop('模型菜单：单价未设置时可跳到该账号的单价覆盖', async (page) => {
      // 用未被其它用例改过模型的会话，保证看到内置表里没有的 mock-1。
      await openSession(page, 'nockpt')
      await waitModelReady(page)
      // 最近使用记录会让菜单主体改列别的分组模型（决策 menu-recent-models），
      // 清掉才会回退到当前分组的 mock-1。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      const modelButton = page.locator('button[aria-label^="选择模型"]').first()
      await modelButton.click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      // 反馈 #15：设置单价只在行尾悬停时出现，模型行保持单行。
      const row = menu.locator('[role="menuitem"]').filter({ hasText: 'mock-1' }).first()
      await row.hover()
      const setup = row.getByRole('button', { name: /设置单价/ }).first()
      await setup.waitFor({ timeout: 10_000 })
      assert.equal(await menu.getByText('单价未知', { exact: false }).count(), 0, '仍在显示「单价未知」')
      await setup.click()
      await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const prices = dialog.locator('[data-setting-id="profiles.prices"]')
      await prices.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(await dialog.getByText('自定义单价').first().isVisible(), '没有定位到单价覆盖区')
    })

desktop('模型菜单：内置价格表命中时显示「参考价」（R08）', async (page) => {
      await openSession(page, 'priced')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      // 反馈 #15：单价放 tooltip；悬停模型行后读取标准 tooltip。
      const row = menu.locator('[role="menuitem"]').filter({ hasText: 'O3' }).first()
      await row.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 10_000 })
      assert.match(await tip.innerText(), /参考价 · 输入 \$2 · 输出 \$8/, '内置参考价没有标注来源')
    })

desktop('模型菜单与用量卡：Opus 5.5 显示官方价 $4/$20，不再出现「估算」（R65）', async (page) => {
      await openSession(page, 'opus-price')
      await waitModelReady(page)
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const row = menu.locator('[role="menuitem"]').filter({ hasText: 'Opus 5.5' }).first()
      await row.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 10_000 })
      const tipText = await tip.innerText()
      assert.match(tipText, /参考价 · 输入 \$4 · 输出 \$20/, `Opus 5.5 单价不是官方价：${tipText}`)
      assert.equal(tipText.includes('估算'), false, `菜单仍在显示估算：${tipText}`)
      const menuText = await menu.innerText()
      assert.equal(menuText.includes('估算'), false, `模型菜单仍有估算字样：${menuText}`)
      await page.keyboard.press('Escape')

      const total = page.locator('[data-usage-total]').first()
      await total.waitFor()
      await total.hover()
      const card = page.locator('[data-usage-breakdown]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      const cardText = await card.innerText()
      assert.match(cardText, /\$4\.00(?!\d)/, `用量卡金额不是按 $4 记账：${cardText}`)
      assert.equal(cardText.includes('估算'), false, `用量卡仍有估算字样：${cardText}`)
    })

desktop('账号/分组倍率叠加并在模型菜单显示计算方式（#04）', async (page) => {
      const account = await api(wsBase, token, '/api/workstation/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: '倍率回归账号',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'reg-key-multiplier',
          models: ['gpt-4o-mini'],
          defaultModel: 'gpt-4o-mini',
          multiplier: 0.5,
          groups: [
            {
              name: '低价渠道',
              apiKey: 'reg-key-multiplier-group',
              models: ['gpt-4o-mini'],
              defaultModel: 'gpt-4o-mini',
              multiplier: 0.8,
            },
          ],
        }),
      })
      const groupId = account.groups?.[0]?.id
      assert.ok(groupId, '倍率账号没有创建分组')
      let session
      try {
        session = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: repo,
            profileId: account.id,
            groupId,
            model: 'gpt-4o-mini',
            permissionMode: 'bypassPermissions',
            title: '倍率回归会话',
          }),
        })
        // 账号是通过 API 新建的：刷新一次让客户端拉到最新账号列表。
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page
          .locator('[aria-label="消息输入框"], button:has-text("新会话")')
          .first()
          .waitFor({ timeout: 20_000 })
        const clientHostId = await page.evaluate(
          () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
        )
        await page.evaluate(
          (hash) => {
            window.location.hash = hash
          },
          `#/h/${clientHostId}/s/${session.id}`,
        )
        await page.waitForFunction(
          (id) => window.location.hash.includes(`/s/${id}`),
          session.id,
          { timeout: 10_000 },
        )
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        // 主菜单优先显示最近使用模型；清掉记录让当前分组的模型回退显示（价格 tooltip 用例）。
        await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        const row = menu.locator('[role="menuitem"]').filter({ hasText: /4o/i }).first()
        await row.hover()
        const tip = page.locator('#tandem-tooltip[data-open]')
        await tip.waitFor({ timeout: 10_000 })
        const text = await tip.innerText()
        assert.match(
          text,
          /官方 \$0\.15\/M × 账号 0\.5 × 分组 0\.8 = \$0\.06\/M/,
          `模型菜单没有显示倍率计算方式：${text}`,
        )
        assert.match(text, /输出 \$0\.6\/M → \$0\.24\/M/, `模型菜单没有显示输出最终价：${text}`)
        assert.match(text, /缓存读 \$0\.03/, `模型菜单没有显示最终缓存价：${text}`)
        await page.keyboard.press('Escape')

        // 发一条消息：用量明细要注明「分组倍率」，记账金额乘倍率。
        const box = page.locator('[aria-label="消息输入框"]').first()
        await box.fill('倍率回归：发一条消息')
        await box.press('Enter')
        await page.getByText('回归回复。').first().waitFor({ timeout: 20_000 })
        const total = page.locator('[data-usage-total]').first()
        await total.waitFor({ timeout: 10_000 })
        await total.hover()
        const card = page.locator('[data-usage-breakdown]').first()
        await card.waitFor({ state: 'visible', timeout: 10_000 })
        const cardText = await card.innerText()
        assert.match(cardText, /分组倍率 0\.8(?!\d)/, `用量明细没有显示倍率：${cardText}`)
        const usage = await api(base, token, `/api/sessions/${session.id}/usage`)
        const usageRow = usage.rows.find((item) => item.model === 'gpt-4o-mini')
        assert.ok(usageRow, `用量明细里没有 gpt-4o-mini：${JSON.stringify(usage.rows)}`)
        const expected = (usageRow.inputTokens * 0.06 + usageRow.outputTokens * 0.24) / 1e6
        assert.ok(
          Math.abs(usageRow.costUsd - expected) < 1e-8,
          `记账金额没有乘倍率：${usageRow.costUsd} != ${expected}`,
        )
        assert.equal(usage.prices['gpt-4o-mini']?.accountMultiplier, 0.5, '明细缺少账号倍率')
        assert.equal(usage.prices['gpt-4o-mini']?.groupMultiplier, 0.8, '明细缺少分组倍率')
      } finally {
        if (session?.id) {
          await api(base, token, `/api/sessions/${session.id}?deleteWorktree=false`, {
            method: 'DELETE',
          }).catch(() => {})
        }
        await api(wsBase, token, `/api/workstation/profiles/${account.id}`, { method: 'DELETE' }).catch(() => {})
      }
    })

desktop('自定义兼容账号显示「自定义接口」而不是 DeepSeek', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      await dialog.getByText('自建端点').waitFor()
      await dialog.getByRole('button', { name: '编辑 自建端点' }).click()
      const editor = page.getByRole('dialog')
      await editor.getByText('自定义接口').first().waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await editor.getByText('DeepSeek').count(), 0, '自定义端点被误标为 DeepSeek')
      await page.keyboard.press('Escape')
    })

desktop('账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉（反馈10#04 #05 #06 R43/R42/R37）', async (page) => {
      const created = { id: 'p-versioned' }
      const dialog = await openSettings(page, '账号与模型')
      await dialog.getByRole('button', { name: '刷新账号' }).click()
      await page.waitForTimeout(600)
      await dialog.getByRole('button', { name: /编辑 多代模型账号/ }).first().click()
      await page.waitForTimeout(400)
      await page.getByRole('button', { name: /编辑分组 aws/ }).first().click()
      await page.waitForTimeout(300)
      const keyBox = dialog.locator('.setting-row').filter({ hasText: '分组 Key' }).first()
      const keyText = await keyBox.innerText()
      assert.match(keyText, /已保存 · ••••ghij/, `Key 没有显示掩码占位：${keyText}`)
      assert.match(keyText, /更换 Key/, '缺少「更换 Key」入口')
      assert.equal(
        await keyBox.locator('input[type="password"]').count(),
        0,
        '已有 Key 时仍渲染可编辑的密码输入框',
      )
      await page.screenshot({ path: '/tmp/fb10-after/05.png' })

      // 拉取模型：默认只勾选每个系列的最新一代（反馈10#04）。
      await page.getByRole('button', { name: /自动拉取模型/ }).click()
      await page.waitForTimeout(1200)
      const checked = await page.evaluate(() =>
        [...document.querySelectorAll('label')]
          .filter((label) => label.querySelector('input[type="checkbox"]')?.checked)
          .map((label) => label.innerText.replace(/\s*默认.*/, '').trim())
          .filter((text) => text.startsWith('claude-')),
      )
      assert.deepEqual(
        checked,
        ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
        `拉取后默认勾选不对：${checked.join(', ')}`,
      )
      await page.screenshot({ path: '/tmp/fb10-after/04.png' })

      // 改分组倍率后保存，Key 不能被清空。
      await dialog.locator('[id^="group-multiplier-"]').fill('0.5')
      await page.getByRole('button', { name: '保存分组' }).click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /下一步/ }).click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /保存账号/ }).click()
      await page.waitForTimeout(1200)
      const stored = (await api(wsBase, token, '/api/workstation/profiles')).profiles.find((p) => p.id === created.id)
      assert.equal(stored?.groups?.[0]?.apiKeyMasked, 'sk-r****ghij', '编辑后 Key 被清空或改写')
      assert.equal(stored?.groups?.[0]?.multiplier, 0.5, '分组倍率没有保存')

      // 原生下拉全部迁移：页面里不能出现 select / datalist / input[list]。
      const native = await page.evaluate(() => ({
        select: document.querySelectorAll('select').length,
        datalist: document.querySelectorAll('datalist').length,
        list: document.querySelectorAll('input[list]').length,
      }))
      assert.deepEqual(native, { select: 0, datalist: 0, list: 0 }, `仍有浏览器自带下拉：${JSON.stringify(native)}`)
      // 单价模型输入是可输入的候选列表（ui/Combobox）。
      await dialog.getByRole('button', { name: /编辑 多代模型账号/ }).first().click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /下一步/ }).click()
      await page.waitForTimeout(400)
      const priceInput = page.getByRole('combobox', { name: '自定义单价模型' })
      await priceInput.focus()
      await page.waitForTimeout(400)
      assert.equal(await priceInput.getAttribute('aria-expanded'), 'true', '单价候选列表没有打开')
      assert.ok((await page.getByRole('menuitem').count()) > 0, '单价候选列表为空')
      await page.screenshot({ path: '/tmp/fb10-after/06.png' })
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

desktop('菜单行文字行高不被裁切（反馈10#07 R44）', async (page) => {
      await openSession(page, 'long')
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const modelMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await modelMenu.waitFor()
      await modelMenu.getByRole('menuitem', { name: /切换账号|切换分组|全部模型/ }).first().hover()
      const submenu = page.locator('[role="menu"][aria-label="切换账号"]').first()
      await submenu.waitFor({ timeout: 5_000 })
      const clipped = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menuitemradio"]')]
        return rows
          .map((el) => {
            const text = el.querySelector('span.truncate') ?? el
            return {
              label: (text.textContent ?? '').trim(),
              scroll: text.scrollHeight,
              client: text.clientHeight,
              lineHeight: getComputedStyle(text).lineHeight,
            }
          })
          .filter((row) => row.label && row.scroll > row.client + 1)
      })
      assert.deepEqual(clipped, [], `菜单/选项卡文字被裁切：${JSON.stringify(clipped)}`)
      await page.screenshot({ path: '/tmp/fb10-after/07.png' })
      await page.keyboard.press('Escape')
    })

fb2102('反馈1323#02：分组只显示一个 Key，无拖动/故障切换/轮询/添加 Key', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const accountRow = dialog.locator('button[aria-expanded]').filter({ hasText: '主力账号' }).first()
      await accountRow.waitFor({ timeout: 10_000 })
      if ((await accountRow.getAttribute('aria-expanded')) !== 'true') await accountRow.click()
      const card = dialog.locator('[data-group-card="g1"]')
      await card.waitFor({ timeout: 10_000 })
      const cardText = await card.innerText()
      assert.doesNotMatch(cardText, /拖动 Key|故障切换|轮询|添加 Key/, `分组卡仍有旧 Key 管理文案：${cardText}`)
      assert.doesNotMatch(cardText, /\d+ 个? ?Key|\d+ 个模型/, `分组卡仍显示 Key/模型数量：${cardText}`)
      const keys = card.locator('[data-key-masked]')
      assert.equal(await keys.count(), 1, '每个分组只应显示一个 Key')
      assert.match((await keys.first().innerText()).trim(), /^reg-\*{4}/, 'Key 掩码不对')
      assert.match(cardText, /可用/, 'Key 状态没有显示')
      const cardBox = await card.boundingBox()
      assert.ok(cardBox && cardBox.height <= 40, `分组卡不是单行紧凑排版：${cardBox?.height}`)
      await page.screenshot({ path: shot1323('02-group-single-key-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('02-group-single-key-light.png') })

      const groupOf = async () => {
        const profiles = (await api(wsBase, token, '/api/workstation/profiles')).profiles
        return profiles.find((item) => item.id === 'p-main')?.groups?.find((item) => item.id === 'g1')
      }
      assert.equal((await groupOf())?.keys?.length, 2, '夹具应有两个旧 Key')

      // 更换 Key：只改显示的那个，旧数据里另一个 Key 保留（不显示也不删除）。
      await card.locator('[data-key-replace]').click()
      await card.locator('[data-key-input]').fill('sk-new-reg-key-1234')
      await card.getByRole('button', { name: '保存', exact: true }).click()
      await waitUntil('分组 Key 更换生效', async () => {
        const group = await groupOf()
        return group?.keys?.[0]?.id === 'k-g1-a' && /^sk-n/.test(group?.keys?.[0]?.apiKeyMasked ?? '')
      })
      const replaced = await groupOf()
      assert.equal(replaced.keys.length, 2, '更换 Key 不应删除旧数据里的其他 Key')
      assert.equal(replaced.keys[1].id, 'k-g1-b', '隐藏的旧 Key 被改动')
      await card.locator('[data-key-masked]').first().waitFor({ timeout: 5_000 })
      assert.equal(await card.locator('[data-key-masked]').count(), 1, '更换后仍只显示一个 Key')

      // 删除显示的 Key 后，下一个旧 Key 接着显示。
      await card.locator('[data-key-delete]').click()
      await waitUntil('删除 Key 后显示下一个', async () => {
        const group = await groupOf()
        return group?.keys?.length === 1 && group.keys[0].id === 'k-g1-b'
      })
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-group-card="g1"] [data-key-masked]')
          return !!el && (el.textContent ?? '').startsWith('reg-')
        },
        null,
        { timeout: 5_000 },
      )
      assert.equal(await card.locator('[data-key-masked]').count(), 1, '删除后仍只显示一个 Key')
      assert.match((await card.locator('[data-key-masked]').first().innerText()).trim(), /^reg-\*{4}/, '删除后没有显示剩下的旧 Key')
      await closeSettings(page)
    })
}
