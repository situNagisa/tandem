#!/usr/bin/env node
/**
 * 自动路由与分工路由。
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

export const feature = 'routing'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [69, 180, 181, 221]

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

desktop('自动路由偏好点击即时切换且不闪回（R17）', async (page) => {
      const before = await api(base, token, '/api/settings')
      assert.equal(before.modelRouting, undefined, '用例前置：路由设置应为空')
      const dialog = await openSettings(page, '自动路由', 'desktop')
      const group = dialog.getByRole('group', { name: '取向默认' })
      await group.waitFor({ state: 'visible' })
      const clicked = async (label) => {
        const response = page.waitForResponse(
          (res) => res.url().includes('/api/settings') && res.request().method() === 'PUT',
          { timeout: 10_000 },
        )
        await group.getByRole('button', { name: label, exact: true }).click()
        await response
        await page.waitForTimeout(200)
      }

      await page.evaluate(() => {
        window.__routingPreferenceNode = document.querySelector('[data-setting-id="routing.preference"]')
      })
      await clicked('省钱')
      assert.equal(
        await group.getByRole('button', { name: '省钱', exact: true }).getAttribute('aria-pressed'),
        'true',
        '点击省钱后偏好没有保持选中',
      )
      assert.equal(
        await group.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '切换偏好时控件变灰闪烁',
      )
      assert.ok(
        await page.evaluate(
          () =>
            window.__routingPreferenceNode ===
            document.querySelector('[data-setting-id="routing.preference"]'),
        ),
        '保存设置后整页重新挂载',
      )
      const costSaved = await api(base, token, '/api/settings')
      assert.equal(costSaved.modelRouting?.preference, 'cost', '省钱偏好没有落库')

      await clicked('质量优先')
      assert.equal(
        await group.getByRole('button', { name: '质量优先', exact: true }).getAttribute('aria-pressed'),
        'true',
        '点击质量优先后偏好没有保持选中',
      )
      const qualitySaved = await api(base, token, '/api/settings')
      assert.equal(qualitySaved.modelRouting?.preference, 'quality', '质量优先偏好没有落库')

      await clicked('均衡')
      const reset = await api(base, token, '/api/settings')
      assert.equal(reset.modelRouting, undefined, '恢复均衡后设置应回到未配置')
      await closeSettings(page)
    })

desktop('自动模型路由：简单快速、困难强力、失败升级、连续成功回落与节省统计', async (page) => {
      await api(base, token, '/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          resumeOnRestart: 'auto',
          modelRouting: {
            preference: 'balanced',
            candidates: [
              { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
              { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
              { profileId: 'p-route', model: 'route-power', tier: 'power' },
            ],
          },
        }),
      })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-route',
          model: 'auto',
          permissionMode: 'bypassPermissions',
          title: '自动路由回归',
        }),
      })
      assert.equal(session.autoRoute, true, '创建会话时未启用自动路由')

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
      const clientHostId = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
      )
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${session.id}`)
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: /^选择模型：自动/ }).first().waitFor({ timeout: 15_000 })

      const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
      const sendTurn = async (text, expected) => {
        const before = (await sessionOf()).messages.length
        await page.locator('[aria-label="消息输入框"]').fill(text)
        await page.getByRole('button', { name: '发送消息' }).click()
        await waitUntil(`自动路由回复：${text.slice(0, 10)}`, async () => {
          const current = await sessionOf()
          return (
            current.status === 'idle' &&
            current.messages.length > before &&
            JSON.stringify(current.messages).includes(expected)
          )
        })
        return sessionOf()
      }

      const simple = await sendTurn('改个名', '路由模型 route-mini 已回复。')
      assert.equal(simple.route?.model, 'route-mini', '简单任务未走快速档')
      assert.match(simple.route?.reason ?? '', /简单/, '简单任务理由不明确')
      assert.ok(
        simple.messages.some((message) => message.notice && message.route?.model === 'route-mini'),
        '自动路由切换未插入提示行',
      )

      // 困难 + 长消息：偏强力档
      const hard = await sendTurn(
        '请帮我重构整个并发架构，解释为什么这里会有死锁和竞态，并设计迁移方案。'.repeat(4),
        '路由模型 route-power 已回复。',
      )
      assert.equal(hard.route?.model, 'route-power', '困难任务未升级到强力档')

      // 两个工具调用同时失败：下一次请求自动升级一档
      const failed = await sendTurn('触发失败 改个名', '路由模型 route-mid 已回复。')
      assert.equal(failed.route?.model, 'route-mid', '工具连续失败后未升级')
      assert.ok(failed.route?.scores?.escalated, '升级决策没有打上 escalated 标记')

      // 连续 3 轮简单成功：下一轮回落一档
      for (let i = 0; i < 3; i++) {
        const mid = await sendTurn('简单总结一下', '路由模型 route-mid 已回复。')
        assert.equal(mid.route?.model, 'route-mid', `第 ${i + 1} 轮回落过早`)
      }
      const downgraded = await sendTurn('简单总结一下', '路由模型 route-mini 已回复。')
      assert.equal(downgraded.route?.model, 'route-mini', '连续简单成功后未回落')
      assert.ok(downgraded.route?.scores?.downgraded, '回落决策没有打上 downgraded 标记')
      assert.ok((downgraded.routeSavings?.savedUsd ?? 0) > 0, '自动路由节省统计没有累计')

      // 模型按钮显示「自动 · 当前模型名」，切换提示可 hover 看打分明细
      await page.getByRole('button', { name: /自动 · Route Mini/ }).first().waitFor({ timeout: 10_000 })
      assert.match(
        (await page.getByRole('button', { name: /^选择模型：/ }).first().getAttribute('aria-label')) ?? '',
        /自动 · Route Mini/,
      )
      const lastNotice = page.locator('[data-route-notice]').last()
      const detail = (await lastNotice.getAttribute('title')) ?? ''
      assert.match(detail, /复杂度 \d+\/100/, '提示行缺少打分明细')
      await lastNotice.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await lastNotice.hover({ position: { x: 8, y: 4 } })
      await page.locator('#tandem-tooltip[data-open]').waitFor({ timeout: 5000 })
      assert.match(
        (await page.locator('#tandem-tooltip').innerText().catch(() => '')) ?? '',
        /复杂度 \d+\/100/,
        'hover 后没有展示打分明细',
      )
      assert.ok(
        provider.routeSeen.some((item) => item.model === 'route-mini') &&
          provider.routeSeen.some((item) => item.model === 'route-power') &&
          provider.routeSeen.some((item) => item.model === 'route-mid'),
        'mock provider 没有收到三种档位的请求',
      )

      // 菜单展示参考单价与「自动」项；清掉最近模型记录，让菜单回退列出当前分组全部模型。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      await page.getByRole('button', { name: /^选择模型：/ }).first().click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuText = await menu.innerText()
      assert.match(menuText, /自动/, '模型菜单缺少「自动」')
      // 反馈 #15：单价放在行 tooltip 里，行本身只显示单行模型名。
      // 先等异步单价读入（tooltip/隐藏说明里出现价格），再悬停读取标准 tooltip。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="menu"]')].some((m) =>
            (m.textContent ?? '').includes('输入 $0.1'),
          ),
        null,
        { timeout: 10_000 },
      )
      const routeRow = menu.getByRole('menuitem', { name: /Route Mini/ }).first()
      await routeRow.hover()
      const priceTip = page.locator('#tandem-tooltip[data-open]')
      await priceTip.waitFor({ timeout: 5_000 })
      const priceText = await priceTip.innerText()
      assert.match(priceText, /输入 \$0\.1 · 输出 \$0\.2/, '模型菜单缺少参考单价')
      assert.match(priceText, /缓存 \$0\.05/, '模型菜单缺少缓存命中价')
      await page.keyboard.press('Escape')
    })

desktop('分工路由：取向关闭不注入取向段、分工关闭零派发、取向省钱整单交执行者、分工积极协作、确认卡与学到的偏好', async (page) => {
        const shotsDir = '/tmp/route2-shots'
        mkdirSync(shotsDir, { recursive: true })
        const divisionSettings = {
          preference: 'balanced',
          candidates: [
            { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
            { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
            { profileId: 'p-route', model: 'route-kimi', tier: 'balanced' },
            { profileId: 'p-route', model: 'route-power', tier: 'power' },
          ],
          division: {
            planner: { profileId: 'p-route', model: 'route-power', tier: 'power' },
            executor: { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
            domains: [
              { profileId: 'p-route', model: 'route-kimi', domain: 'ui', minComplexity: 35, note: '前端强项' },
            ],
            planThreshold: 35,
            confirm: 'never',
          },
        }
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ resumeOnRestart: 'auto', modelRouting: divisionSettings }),
        })
        const session = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: repo,
            profileId: 'p-route',
            model: 'route-power',
            permissionMode: 'bypassPermissions',
            title: '多代理协作回归',
          }),
        })
        assert.equal(session.delegation, 'less', '新会话分工默认适度')
        assert.equal(session.routeBias, undefined, '新会话取向未设置时跟随全局设置')

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
        const clientHostId = await page.evaluate(
          () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
        )
        await page.evaluate((hash) => {
          window.location.hash = hash
        }, `#/h/${clientHostId}/s/${session.id}`)
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
        await page.getByRole('button', { name: /^选择模型：/ }).first().waitFor({ timeout: 15_000 })
        await page.getByRole('button', { name: /^选择模型：/ }).first().click()
        const modelMenu = page.getByRole('menu')
        await modelMenu.waitFor()
        const modelMenuText = await modelMenu.innerText()
        assert.match(modelMenuText, /自动/, '模型菜单缺少自动')
        await page.screenshot({ path: path.join(shotsDir, 'model-menu-division.png') })
        await page.keyboard.press('Escape')

        const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
        const childrenOf = async () => {
          const list = await api(base, token, '/api/sessions')
          return list.filter((item) => item.parentId === session.id)
        }
        const sendTurn = async (text, expected) => {
          const before = (await sessionOf()).messages.length
          await page.locator('[aria-label="消息输入框"]').fill(text)
          await page.getByRole('button', { name: '发送消息' }).click()
          await waitUntil(`分工回复：${text.slice(0, 8)}`, async () => {
            const current = await sessionOf()
            return (
              current.status === 'idle' &&
              current.messages.length > before &&
              JSON.stringify(current.messages).includes(expected)
            )
          })
          return sessionOf()
        }
        const planCount = async () => (await sessionOf()).messages.filter((m) => m.routePlan).length
        // 1601#04：选择即写入会话（后续消息都用），没有「记住为会话偏好」。
        const pickRoute = async (group, label) => {
          await page.getByRole('button', { name: /^选择模型：/ }).first().click()
          const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
          await menu.waitFor()
          await menu.getByRole('menuitem', { name: new RegExp(`^${group}`) }).hover()
          const sub = page.locator(`[role="menu"][aria-label="${group}"]`).first()
          await sub.waitFor({ state: 'visible', timeout: 5_000 })
          await sub.getByRole('menuitemradio', { name: label, exact: true }).click()
          await page.waitForTimeout(200)
        }
        const manualText =
          '请帮我完成前端批量改造：批量修改所有组件的按钮间距与布局样式，然后跑一遍 lint 和测试，最后整理结果。请注意不要改动后端接口，保持现有样式变量不变，完成后说明改了哪些文件。'
        const biasMenuOf = async () => {
          await page.getByRole('button', { name: /^选择模型：/ }).first().click()
          const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
          await menu.waitFor()
          return menu
        }

        // 0. 菜单结构（反馈1724#02）：没有「原生」；分工、取向是一组，其下分隔线再是思考强度。
        const structureMenu = await biasMenuOf()
        const structureText = await structureMenu.innerText()
        assert.ok(!structureText.includes('原生'), `模型菜单仍有「原生」：${structureText}`)
        const footerRows = await structureMenu.evaluate((el) => {
          const footer = el.querySelector('[data-menu-footer]') ?? el
          return [...footer.children].map((child) => ({
            separator: child.getAttribute('role') === 'separator',
            text: (child.textContent ?? '').trim(),
          }))
        })
        const biasRow = footerRows.findIndex((row) => row.text.startsWith('取向'))
        const separatorRow = footerRows.findIndex((row, index) => index > biasRow && row.separator)
        const effortRow = footerRows.findIndex((row) => row.text.startsWith('思考强度'))
        assert.ok(biasRow >= 0, `菜单缺少取向分组：${JSON.stringify(footerRows)}`)
        assert.ok(
          separatorRow > biasRow && (effortRow < 0 || separatorRow < effortRow),
          `分工/取向下缺少与后续设置之间的分隔线：${JSON.stringify(footerRows)}`,
        )
        await structureMenu.getByRole('menuitem', { name: /^取向/ }).hover()
        const offSub = page.locator('[role="menu"][aria-label="取向"]').first()
        await offSub.waitFor({ state: 'visible', timeout: 5_000 })
        assert.ok(
          (await offSub.innerText()).includes('关闭'),
          '取向子菜单缺少「关闭」',
        )
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')

        // 分工积极 + 取向均衡：注入分工与取向两段（对照）。
        await pickRoute('分工', '积极')
        await pickRoute('取向', '均衡')
        assert.equal((await sessionOf()).routeBias, 'balanced', '取向均衡没有写入会话')
        const biasStart = provider.routeSeen.length
        const withBias = await sendTurn(manualText, '多代理协作完成：已审查执行结果，样式与测试均通过。')
        const biasCalls = provider.routeSeen.slice(biasStart)
        assert.ok(
          biasCalls.some((item) => item.systemText.includes('取向 · 本轮')),
          '取向均衡时应注入取向段',
        )
        const biasPlan = withBias.messages.filter((m) => m.routePlan).at(-1)?.routePlan
        assert.deepEqual(
          (biasPlan?.injected ?? []).map((item) => item.name),
          ['分工', '多代理协作 · 本轮', '取向 · 本轮'],
          '取向均衡时提示行的注入段不全',
        )

        // 取向关闭：不注入取向说明，分工照常；Task 仍可用，写入会话后后续消息都沿用。
        await pickRoute('取向', '关闭')
        assert.equal((await sessionOf()).routeBias, 'off', '取向关闭没有写入会话')
        for (const round of [1, 2]) {
          const offStart = provider.routeSeen.length
          const off = await sendTurn(manualText, '多代理协作完成：已审查执行结果，样式与测试均通过。')
          const offCalls = provider.routeSeen.slice(offStart)
          const planner = offCalls.find((item) => item.model === 'route-power')
          assert.ok(planner, `取向关闭第 ${round} 条消息没有请求规划者`)
          assert.ok(planner.toolNames.includes('Task'), `取向关闭第 ${round} 条消息 Task 不可用`)
          assert.ok(
            planner.systemText.includes('# 分工：'),
            `取向关闭第 ${round} 条消息未注入分工说明`,
          )
          assert.ok(
            planner.systemText.includes('多代理协作 · 本轮'),
            `取向关闭第 ${round} 条消息未注入规划说明`,
          )
          assert.ok(
            !planner.systemText.includes('取向 · 本轮'),
            `取向关闭第 ${round} 条消息仍注入取向说明`,
          )
          const plan = off.messages.filter((m) => m.routePlan).at(-1)?.routePlan
          assert.equal(plan?.bias, 'off', `取向关闭第 ${round} 条消息提示行取向不是关闭`)
          assert.deepEqual(
            (plan?.injected ?? []).map((item) => item.name),
            ['分工', '多代理协作 · 本轮'],
            `取向关闭第 ${round} 条消息注入段应只有分工`,
          )
        }

        // 1. 分工关闭：主会话自己完成，零 Task 子代理，也不出提示行；下一条与再下一条都用它。
        await pickRoute('分工', '关闭')
        assert.equal((await sessionOf()).delegation, 'none', '分工关闭没有写入会话')
        const plansBeforeOff = await planCount()
        const childrenBeforeOff = (await childrenOf()).length
        for (const round of [1, 2]) {
          const directStart = provider.routeSeen.length
          await sendTurn('解释一下这个函数的作用', '路由模型 route-power 已回复。')
          const directCalls = provider.routeSeen.slice(directStart)
          assert.equal(directCalls.length, 1, `分工关闭第 ${round} 条不应产生额外模型请求`)
          assert.equal(directCalls[0].model, 'route-power', `分工关闭第 ${round} 条应由主会话模型处理`)
          assert.equal(
            (await childrenOf()).length,
            childrenBeforeOff,
            `分工关闭第 ${round} 条不应派发子代理`,
          )
          assert.equal(await planCount(), plansBeforeOff, `分工关闭第 ${round} 条不应出现提示行`)
        }
        assert.equal((await sessionOf()).delegation, 'none', '分工关闭在后续消息中没有保留')

        // 2. 分工适度 + 取向省钱：机械任务整单交给执行者子代理，主会话模型不参与。
        await pickRoute('分工', '适度')
        await pickRoute('取向', '省钱')
        assert.equal((await sessionOf()).delegation, 'less', '分工适度没有写入会话')
        assert.equal((await sessionOf()).routeBias, 'cost', '取向省钱没有写入会话')
        const cheapStart = provider.routeSeen.length
        const childrenBeforeCheap = (await childrenOf()).length
        const cheap = await sendTurn('安装依赖并跑通构建', '便宜执行完成：依赖已安装，构建通过。')
        const cheapCalls = provider.routeSeen.slice(cheapStart)
        assert.deepEqual(cheapCalls.map((item) => item.model), ['route-mini'], '省钱应只调用执行模型')
        const cheapChildren = await childrenOf()
        assert.equal(cheapChildren.length, childrenBeforeCheap + 1, '省钱应创建一个执行子代理')
        assert.equal(cheap.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.mode, 'cheap')

        // 3. 分工关闭：长任务也不派发。
        await pickRoute('分工', '关闭')
        const manualStart = provider.routeSeen.length
        const childCountBefore = (await childrenOf()).length
        await sendTurn(manualText, '路由模型 route-power 已回复。')
        assert.equal((await childrenOf()).length, childCountBefore, '分工关闭不应派发子代理')
        assert.ok(
          provider.routeSeen.slice(manualStart).every((item) => item.model === 'route-power'),
          '分工关闭不应调用执行模型',
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-direct.png') })

        // 4. 分工积极：规划者 Task → Kimi 前端 + DeepSeek 测试 → 规划者收尾。
        await pickRoute('分工', '积极')
        const divisionStart = provider.routeSeen.length
        const division = await sendTurn(
          manualText,
          '多代理协作完成：已审查执行结果，样式与测试均通过。',
        )
        const divisionCalls = provider.routeSeen.slice(divisionStart)
        assert.ok(divisionCalls.some((item) => item.model === 'route-power'), '多代理协作应调用规划者')
        assert.ok(divisionCalls.some((item) => item.model === 'route-kimi'), '前端子任务未调用专长模型')
        assert.ok(divisionCalls.some((item) => item.model === 'route-mini'), '测试子任务未调用执行模型')
        const divisionChildren = await childrenOf()
        const titles = divisionChildren.map((item) => item.title)
        assert.ok(titles.includes('改组件样式'), '缺少前端子代理')
        assert.ok(titles.includes('跑 lint 测试'), '缺少测试子代理')
        const plannerUsage = division.messages.filter((m) => m.model === 'route-power')
        assert.ok(
          plannerUsage.some((m) => (m.usage?.cacheReadTokens ?? 0) > 0),
          '主会话第二次请求应命中 prompt 缓存',
        )
        assert.ok(
          (division.routeSavings?.byRole?.specialist?.calls ?? 0) > 0 ||
            (division.routeSavings?.byRole?.executor?.calls ?? 0) > 0,
          '按角色节省统计未累计',
        )
        assert.match(
          division.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.reason ?? '',
          /前端|多代理协作/,
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-roles.png') })

        // 4b. 多代理协作前确认：卡片改模型 + 删除子任务 + 收件箱事件（分工回到适度）。
        await pickRoute('分工', '适度')
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: { ...divisionSettings.division, confirm: 'always' },
            },
          }),
        })
        const childCountBeforeCard = (await childrenOf()).length
        await page.locator('[aria-label="消息输入框"]').fill(manualText)
        await page.getByRole('button', { name: '发送消息' }).click()
        const card = page.locator('[data-division-plan]').last()
        await card.waitFor({ timeout: 15_000 })
        const inbox = await wsInboxSnapshot(base, token)
        assert.ok(
          inbox.events.some((event) => event.kind === 'division_plan'),
          '多代理协作计划没有进入收件箱',
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-confirm-card.png') })
        const confirmStart = provider.routeSeen.length
        await card.locator('button[aria-label*="使用的模型"]').first().click()
        await page.getByRole('menuitemradio', { name: /route-mid/ }).click()
        await card.getByRole('button', { name: '删除子任务' }).nth(1).click()
        await card.getByRole('button', { name: '开始', exact: true }).click()
        await waitUntil('确认卡执行完成', async () => {
          const current = await sessionOf()
          return current.status === 'idle' && JSON.stringify(current.messages).includes('多代理协作完成')
        })
        const confirmCalls = provider.routeSeen.slice(confirmStart)
        assert.ok(confirmCalls.some((item) => item.model === 'route-mid'), '改模型后未按新模型执行')
        assert.ok(!confirmCalls.some((item) => item.model === 'route-kimi'), '删除的专长子任务仍被派发')
        assert.ok(!confirmCalls.some((item) => item.model === 'route-mini'), '删除的测试子任务仍被派发')
        assert.equal((await childrenOf()).length, childCountBeforeCard + 1, '应只执行剩余的一个子任务')
        await page.screenshot({ path: path.join(shotsDir, 'division-confirm-card-done.png') })

        // 设置页与用量页按角色统计
        const routingDialog = await openSettings(page, '自动路由', 'desktop')
        await routingDialog.getByText('多代理协作').first().waitFor({ timeout: 10_000 })
        assert.match(await routingDialog.innerText(), /领域专长/, '设置页缺少领域映射')
        await page.screenshot({ path: path.join(shotsDir, 'settings-division.png') })
        await closeSettings(page)
        const usageDialog = await openSettings(page, '用量', 'desktop')
        const roleTable = usageDialog.locator('[data-setting-id="usage.roles"]')
        await roleTable.waitFor({ timeout: 10_000 })
        await roleTable.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(shotsDir, 'usage-by-role.png') })
        await closeSettings(page)

        // 5. 成本上限（只对积极生效）：首轮规划请求触顶后不再继续请求强模型。
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: {
                ...divisionSettings.division,
                confirm: 'never',
                costCapUsdPerTurn: 0.0001,
              },
            },
          }),
        })
        await pickRoute('分工', '积极')
        const capStart = provider.routeSeen.length
        const capped = await sendTurn(manualText, '本轮花费已达上限')
        assert.match(
          JSON.stringify(capped.messages),
          /本轮花费已达上限/,
          '成本上限触发后没有提示',
        )
        assert.equal(
          provider.routeSeen.slice(capStart).filter((item) => item.model === 'route-power').length,
          1,
          '成本上限触发后仍继续请求规划者',
        )

        // 6. 学习偏好：分工前确认卡里两次选「改为单代理」，同类任务默认单代理（即使开着确认）。
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: { ...divisionSettings.division, confirm: 'always', costCapUsdPerTurn: undefined },
            },
          }),
        })
        for (let i = 0; i < 2; i++) {
          await page.locator('[aria-label="消息输入框"]').fill(manualText)
          await page.getByRole('button', { name: '发送消息' }).click()
          const learnCard = page.locator('[data-division-plan]').last()
          await learnCard.waitFor({ timeout: 15_000 })
          await learnCard.getByRole('button', { name: '改为单代理', exact: true }).click()
          await waitUntil(`确认卡改为单代理第 ${i + 1} 次`, async () => {
            const current = await sessionOf()
            const cardIndex = current.messages.map((m) => !!m.divisionPlan).lastIndexOf(true)
            const last = current.messages.at(-1)
            return (
              current.status === 'idle' &&
              cardIndex >= 0 &&
              current.messages.length - 1 > cardIndex &&
              last?.role === 'assistant' &&
              !last.notice
            )
          })
        }
        const learnStart = provider.routeSeen.length
        const childCountBeforeLearned = (await childrenOf()).length
        const learned = await sendTurn(manualText, '路由模型 route-power 已回复。')
        assert.equal((await childrenOf()).length, childCountBeforeLearned, '学到的单代理仍派发了子代理')
        assert.ok(
          provider.routeSeen
            .slice(learnStart)
            .every((item) => item.model === 'route-power'),
          '学到的单代理仍调用了执行模型',
        )
        assert.match(
          learned.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.reason ?? '',
          /同类任务/,
          '学到的偏好理由未展示',
        )

        const learnedDialog = await openSettings(page, '自动路由', 'desktop')
        const learnedLabel = learnedDialog.getByText('学到的偏好').first()
        await learnedLabel.waitFor({ timeout: 10_000 })
        await learnedLabel.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(shotsDir, 'settings-learned.png') })
        await closeSettings(page)
      })

fb2102('反馈1323#03：路由提示行可展开看本轮注入，未注入时说明', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const divisionSettings = {
        preference: 'balanced',
        candidates: [
          { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
          { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
          { profileId: 'p-route', model: 'route-kimi', tier: 'balanced' },
          { profileId: 'p-route', model: 'route-power', tier: 'power' },
        ],
        division: {
          planner: { profileId: 'p-route', model: 'route-power', tier: 'power' },
          executor: { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
          domains: [
            { profileId: 'p-route', model: 'route-kimi', domain: 'ui', minComplexity: 35, note: '前端强项' },
          ],
          planThreshold: 35,
          confirm: 'never',
        },
      }
      await api(base, token, '/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ resumeOnRestart: 'auto', modelRouting: divisionSettings }),
      })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-route',
          model: 'route-power',
          permissionMode: 'bypassPermissions',
          delegation: 'more',
          title: '提示行透明回归',
        }),
      })
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
      const clientHostId = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
      )
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${session.id}`)
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
      const sendTurn = async (text, expected) => {
        const before = (await sessionOf()).messages.length
        await page.locator('[aria-label="消息输入框"]').fill(text)
        await page.getByRole('button', { name: '发送消息' }).click()
        await waitUntil(`提示行回归：${text.slice(0, 8)}`, async () => {
          const current = await sessionOf()
          return (
            current.status === 'idle' &&
            current.messages.length > before &&
            JSON.stringify(current.messages).includes(expected)
          )
        })
        return sessionOf()
      }

      // 单代理直接问答：没有注入，悬停说明只用于选择分工与模型。
      const direct = await sendTurn('解释一下这个函数的作用', '路由模型 route-power 已回复。')
      const directPlan = direct.messages.filter((message) => message.routePlan).at(-1)?.routePlan
      assert.equal(directPlan?.mode, 'direct', '问答回合应为单代理')
      assert.equal(directPlan?.injected, undefined, '单代理回合不应记录注入文本')
      const directLine = page.locator('[data-route-plan="direct"]').last()
      await directLine.waitFor({ timeout: 10_000 })
      assert.equal(await directLine.getAttribute('data-route-injected'), null, '无注入时不应出现展开按钮')
      await directLine.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /未向模型注入内容/, '无注入时没有说明')
      await page.screenshot({ path: shot1323('03-route-line-no-injection-dark.png') })

      // 多代理协作：提示行展开就是本轮实际注入的原文。
      const divisionText =
        '请帮我完成前端批量改造：批量修改所有组件的按钮间距与布局样式，然后跑一遍 lint 和测试，最后整理结果。请注意不要改动后端接口，保持现有样式变量不变，完成后说明改了哪些文件。'
      const division = await sendTurn(divisionText, '多代理协作完成：已审查执行结果，样式与测试均通过。')
      const plan = division.messages.filter((message) => message.routePlan).at(-1)?.routePlan
      assert.equal(plan?.mode, 'division', '任务应为多代理协作')
      assert.ok((plan?.injected?.length ?? 0) >= 2, '多代理协作应记录注入段落')
      assert.match(plan.injected[0].content, /分工：积极/, '缺少分工系统提示段')
      assert.match(plan.injected[1].content, /\[多代理协作 · 本轮\]/, '缺少本轮规划者说明')
      const line = page.locator('[data-route-plan="division"]').last()
      await line.waitFor({ timeout: 10_000 })
      assert.equal(await line.getAttribute('data-route-injected'), 'true', '有注入时提示行应可展开')
      assert.match(await line.innerText(), /本轮注入 3 段/, '提示行没有标明注入段数')
      await page.screenshot({ path: shot1323('03-route-line-collapsed-dark.png') })
      await line.getByRole('button').click()
      const injection = line.locator('[data-route-injection]')
      await injection.waitFor({ timeout: 5_000 })
      const shown = await injection.innerText()
      assert.match(shown, /分工：积极/, '展开后看不到分工注入原文')
      assert.match(shown, /\[多代理协作 · 本轮\]/, '展开后看不到规划者注入原文')
      assert.match(shown, /分类理由：/, '展开后看不到分类理由')
      assert.match(shown, /\[取向 · 本轮\]/, '展开后看不到取向注入原文')
      await page.screenshot({ path: shot1323('03-route-line-expanded-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('03-route-line-expanded-light.png') })
    })
}
