#!/usr/bin/env node
/**
 * 设置窗口（分组、页签、字号、焦点、诊断、无障碍、快捷键）。
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

export const feature = 'settings'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [27, 28, 29, 30, 31, 32, 54, 99, 101, 102, 108, 109, 148, 163, 173]

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

desktop('设置窗口固定尺寸，切换页签不跳动', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const box = await dialog.boundingBox()
      withinViewport(box, DESKTOP, '设置窗口')
      assert.ok(Math.abs(box.width - 1320) <= 2, `设置窗口宽度 ${box.width}，预期 1320`)
      assert.ok(Math.abs(box.height - 920) <= 2, `设置窗口高度 ${box.height}，预期 920`)
      for (const tab of ['权限', 'MCP', '用量', '同步与备份', '外观', '记忆']) {
        await openSettings(page, tab, 'desktop')
        await page.waitForTimeout(160)
        const next = await dialog.boundingBox()
        assert.ok(Math.abs(next.width - box.width) <= 1 && Math.abs(next.height - box.height) <= 1, `切到「${tab}」后尺寸变化`)
        withinViewport(next, DESKTOP, `设置窗口（${tab}）`)
      }
      await closeSettings(page)
    })

desktop('反馈15：设置内容区限宽留白、通知卡图标在卡片内且与标题对齐（R01）', async (page) => {
      // 用户实际视口 1912×914；设置内容统一容器限宽 820px，剩余空间左右居中留白。
      await page.setViewportSize({ width: 1912, height: 914 })
      const measureContent = () =>
        page.evaluate(() => {
          const pane = document.querySelector('[data-settings-page-content]')
          const content = document.querySelector('[data-settings-content]')
          if (!pane || !content) return null
          const p = pane.getBoundingClientRect()
          const c = content.getBoundingClientRect()
          return {
            page: pane.getAttribute('data-settings-page-content'),
            width: c.width,
            leftGap: c.left - p.left,
            rightGap: p.right - c.right,
          }
        })
      const dialog = await openSettings(page, '记忆', 'desktop')
      const memory = await measureContent()
      assert.ok(memory, '设置内容区容器缺失')
      assert.ok(memory.width <= 840, `设置内容区宽 ${Math.round(memory.width)}px，应 ≤840`)
      assert.ok(
        memory.leftGap >= 32 && memory.rightGap >= 32,
        `设置内容区左右留白 ${Math.round(memory.leftGap)}/${Math.round(memory.rightGap)}px，应 ≥32`,
      )
      // 页头操作按钮（主机下拉、刷新）随内容区右缘对齐。
      const header = await page.evaluate(() => {
        const content = document.querySelector('[data-settings-content]')
        const row = document.querySelector('[data-setting-id="memory.host"]')
        const refresh = row
          ? [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '刷新')
          : null
        if (!content || !row || !refresh) return null
        const c = content.getBoundingClientRect()
        const r = refresh.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        return { rightGap: c.right - r.right, leftGap: rowBox.left - c.left }
      })
      assert.ok(header, '记忆页头缺少主机选择或刷新按钮')
      assert.ok(
        header.rightGap >= -1 && header.rightGap <= 8,
        `页头「刷新」未随内容区右缘对齐：差 ${Math.round(header.rightGap)}px`,
      )

      // 所有设置页共用同一容器：逐页确认宽度与左右留白。
      await openSettings(page, '通知', 'desktop')
      const pageIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-settings-page]')].map((el) =>
          el.getAttribute('data-settings-page'),
        ),
      )
      assert.ok(pageIds.length > 10, `设置导航页数异常：${pageIds.length}`)
      const wide = []
      for (const id of pageIds) {
        const pageButton = dialog.locator(`[data-settings-page="${id}"]`)
        if (!(await pageButton.count())) continue
        await pageButton.click()
        await page.waitForTimeout(110)
        const info = await measureContent()
        if (!info) {
          wide.push(`${id}: 无内容容器`)
          continue
        }
        if (info.width > 840 || info.leftGap < 32 || info.rightGap < 32) {
          wide.push(
            `${id}: ${Math.round(info.width)}px / 留白 ${Math.round(info.leftGap)}/${Math.round(info.rightGap)}`,
          )
        }
        // 同类图标溢出：设置行标题图标必须在所在卡片的 ≥8px 内边距里。
        const iconOverflow = await page.evaluate(() =>
          [...document.querySelectorAll('[data-settings-content] .setting-row-icon')]
            .map((el) => {
              const card = el.closest('section, .setting-card, .settings-item')
              if (!card) return null
              const c = card.getBoundingClientRect()
              const i = el.getBoundingClientRect()
              const inset = Math.min(i.left - c.left, c.right - i.right, i.top - c.top, c.bottom - i.bottom)
              return inset >= 8 ? null : Math.round(inset)
            })
            .filter((value) => value !== null),
        )
        if (iconOverflow.length) wide.push(`${id}: 图标越出卡片 ${iconOverflow.join('/')}px`)
      }
      assert.deepEqual(wide, [], `设置内容区未统一限宽留白：${wide.join('；')}`)

      // 通知页：桌面通知 / App 通知 / 后台保持连接三个卡片的图标须在卡片内边距里，
      // 与标题文字垂直居中；下方提示行缩进与标题左对齐。
      await openSettings(page, '通知', 'desktop')
      const cards = await page.evaluate(() =>
        ['notifications.desktop', 'notifications.app', 'notifications.background'].map((id) => {
          const card = document.querySelector(`[data-setting-id="${id}"]`)
          if (!card) return { id, missing: true }
          const icon = card.querySelector('.setting-row-icon svg')
          const label = card.querySelector('.setting-row-label')
          const title = label?.querySelector(':scope > :not(.setting-row-icon):not(.setting-row-hint)')
          const note = card.querySelector('.setting-note')
          const noteText = note?.querySelector(':scope > span:last-child')
          if (!icon || !title) return { id, missing: true }
          const box = card.getBoundingClientRect()
          const i = icon.getBoundingClientRect()
          const t = title.getBoundingClientRect()
          const n = noteText?.getBoundingClientRect()
          return {
            id,
            insets: [i.left - box.left, box.right - i.right, i.top - box.top, box.bottom - i.bottom],
            iconLeft: i.left,
            centerDiff: Math.abs(i.top + i.height / 2 - (t.top + t.height / 2)),
            note: n ? { leftDiff: n.left - t.left, rightOverflow: n.right - box.right } : null,
          }
        }),
      )
      for (const card of cards) {
        assert.ok(!card.missing, `通知卡片缺失：${card.id}`)
        assert.ok(
          card.insets.every((value) => value >= 8),
          `${card.id} 图标不在卡片内边距里（上/右/下/左 ${card.insets.map(Math.round).join('/')}）`,
        )
        assert.ok(
          card.centerDiff <= 2,
          `${card.id} 图标与标题中线差 ${card.centerDiff.toFixed(1)}px`,
        )
        if (card.note) {
          assert.ok(
            Math.abs(card.note.leftDiff) <= 2,
            `${card.id} 提示行未与标题左对齐（差 ${Math.round(card.note.leftDiff)}px）`,
          )
          assert.ok(card.note.rightOverflow <= 0, `${card.id} 提示行溢出卡片`)
        }
        // 三个卡片同一列图标：左缘一致。
      }
      const iconLefts = cards.map((card) => card.iconLeft)
      assert.ok(
        Math.max(...iconLefts) - Math.min(...iconLefts) <= 1,
        `通知卡图标左缘不一致：${iconLefts.map(Math.round).join('/')}`,
      )
      await closeSettings(page)
    })

desktop('反馈9：滚动条唯一且不占宽、设置行单行、高级展开不位移、右键菜单接管', async (page) => {
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('[data-settings-nav-scroll]')
      const adv = dialog.locator('[data-settings-group="advanced"] > button').first()
      if ((await adv.getAttribute('aria-expanded')) === 'true') {
        await adv.click()
        await page.waitForTimeout(150)
      }
      await nav.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(200)
      const before = await adv.boundingBox()
      await adv.click()
      await page.waitForTimeout(350)
      const after = await adv.boundingBox()
      assert.ok(before && after, '高级分组不可见')
      assert.ok(
        Math.abs(after.y - before.y) <= 1,
        `高级分组展开后标题位移 ${Math.round(after.y - before.y)}px`,
      )
      // 设置内容区一定会溢出：滚动它来触发 overlay 滚动条。
      // 用 scrollBy 保证一定产生 scroll 事件（直接赋当前值不会触发）；可见性由 rAF 更新，等到出现为止。
      const content = dialog.locator('[data-settings-page-content]')
      await content.evaluate((el) => {
        const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
        el.scrollBy(0, atBottom ? -40 : 40)
      })
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.overlay-scrollbar')].some(
            (el) => el.dataset.visible === 'true',
          ),
        null,
        { timeout: 3_000 },
      )
      const scroll = await page.evaluate(() => {
        const list = document.querySelector('[data-settings-nav-scroll]')
        const pane = document.querySelector('[data-settings-page-content]')
        const visible = [...document.querySelectorAll('.overlay-scrollbar')].filter(
          (el) => el.dataset.visible === 'true',
        )
        return {
          listGutter: list ? list.offsetWidth - list.clientWidth : null,
          paneGutter: pane ? pane.offsetWidth - pane.clientWidth : null,
          paneOverflow: pane ? pane.scrollHeight > pane.clientHeight : false,
          visibleBars: visible.length,
        }
      })
      assert.equal(scroll.listGutter, 0, '设置导航的滚动条占用了布局宽度')
      assert.equal(scroll.paneGutter, 0, '设置内容区的滚动条占用了布局宽度')
      assert.ok(scroll.paneOverflow, '用例前置：设置内容区应可滚动')
      assert.equal(scroll.visibleBars, 1, `同时可见 ${scroll.visibleBars} 根滚动条`)
      // 裸 title 由 scripts/ui-audit.mjs 的 native-title 规则做源码级检查。

      // 数值单位必须与输入框同一行、紧贴右侧；行高保持单行。
      const row = dialog.locator('.setting-row', { hasText: '触发阈值' }).first()
      await row.waitFor({ state: 'visible', timeout: 5_000 })
      const layout = await row.evaluate((el) => {
        const input = el.querySelector('input')
        const unit = el.querySelector('.setting-row-unit')
        const label = el.querySelector('.setting-row-label')
        const a = input?.getBoundingClientRect()
        const b = unit?.getBoundingClientRect()
        const c = label?.getBoundingClientRect()
        return a && b && c
          ? {
              height: el.getBoundingClientRect().height,
              inputWidth: a.width,
              unitGap: b.left - a.right,
              sameLine: Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)) < 4,
            }
          : null
      })
      assert.ok(layout, '触发阈值行缺少输入框或单位')
      assert.ok(layout.height <= 36, `设置行高 ${layout.height}px，未收成单行`)
      assert.ok(layout.inputWidth <= 90, `数值输入宽 ${layout.inputWidth}px，应为窄宽度`)
      assert.ok(layout.unitGap >= 0 && layout.unitGap <= 10, `单位与输入框间距 ${layout.unitGap}px`)
      assert.ok(layout.sameLine, '单位或输入框换到了下一行')

      // 右键菜单由 ui/Menu 接管，原生菜单不再出现（能检测到的是我们的 role=menu）。
      await page.mouse.click(900, 420, { button: 'right' })
      await page.waitForTimeout(250)
      const menu = page.getByRole('menu')
      assert.equal(await menu.count(), 1, '没有出现自定义右键菜单')
      for (const name of ['复制', '剪切', '粘贴', '全选']) {
        assert.ok(await menu.getByRole('menuitem', { name }).count(), `右键菜单缺少「${name}」`)
      }
      await page.keyboard.press('Escape')
      await closeSettings(page)

      // 输入框关闭签名控件；文本仍可选择复制。
      const attrs = await page.evaluate(() => {
        const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]')
        return {
          suggestions: document.documentElement.getAttribute('writingsuggestions'),
          spellcheck: input?.getAttribute('spellcheck'),
          autocomplete: input?.getAttribute('autocomplete'),
          selectable: getComputedStyle(document.body).userSelect,
        }
      })
      assert.equal(attrs.suggestions, 'false', 'writingsuggestions 未关闭')
      assert.equal(attrs.spellcheck, 'false', '输入框拼写检查未关闭')
      assert.equal(attrs.autocomplete, 'off', '输入框自动填充未关闭')
      assert.notEqual(attrs.selectable, 'none', '不应禁用文本选择')
    })

desktop('反馈11：设置页输入框全局屏蔽、设置导航滚动条进 gutter 不压文字（R37/R36）', async (page) => {
      // 用户实际视口 1912×914：用相近尺寸让设置导航溢出（2552 宽高下导航无需滚动）。
      await page.setViewportSize({ width: 1366, height: 860 })
      // 设置导航：滚动时指示条应落在 nav 的右侧留白里，不与行文字/行背景相交。
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('[data-settings-nav-scroll]')
      const navBox = await nav.boundingBox()
      assert.ok(navBox, '设置导航不可见')
      await page.mouse.move(navBox.x + navBox.width - 3, navBox.y + navBox.height / 2)
      await nav.evaluate((el) => {
        el.scrollTop = Math.min(120, el.scrollHeight - el.clientHeight)
      })
      await page.waitForFunction(
        () => document.querySelector('.overlay-scrollbar[data-axis="y"]')?.dataset.visible === 'true',
        null,
        { timeout: 3_000 },
      )
      const bar = await page.evaluate(() => {
        const nav = document.querySelector('[data-settings-nav-scroll]')
        const bar = document.querySelector('.overlay-scrollbar[data-axis="y"]')
        const b = bar.getBoundingClientRect()
        const n = nav.getBoundingClientRect()
        let maxRight = 0
        const walk = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT)
        while (walk.nextNode()) {
          const node = walk.currentNode
          if (!node.textContent.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (rect.width > 0) maxRight = Math.max(maxRight, rect.right)
          }
        }
        return { left: b.left, right: b.right, navRight: n.right, textRight: maxRight }
      })
      assert.ok(
        bar.left >= bar.navRight + 1,
        `设置导航滚动条仍在内容区内：bar ${Math.round(bar.left)} / nav ${Math.round(bar.navRight)}`,
      )
      assert.ok(
        bar.left > bar.textRight + 4,
        `滚动条与最近文字相交：bar ${Math.round(bar.left)} / text ${Math.round(bar.textRight)}`,
      )
      // 全局默认关闭拼写/自动填充：覆盖设置页（Portal）里所有非密码输入框。
      const loose = await page.evaluate(() =>
        [...document.querySelectorAll('input, textarea')]
          .filter((el) => !(el instanceof HTMLInputElement && el.type === 'password'))
          .filter(
            (el) =>
              el.getAttribute('spellcheck') !== 'false' || !el.getAttribute('autocomplete'),
          )
          .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('type') ?? ''}]`),
      )
      assert.deepEqual(loose, [], `设置页输入框仍会触发原生拼写/自动填充：${loose.join(', ')}`)
      assert.equal(
        await page.evaluate(() => document.documentElement.getAttribute('spellcheck')),
        'false',
        '根节点未关闭拼写检查',
      )
      await closeSettings(page)

    })

desktop('Host 诊断：面板打开、失败项排在最前、报告不含 Key', async (page) => {
      const dialog = await openSettings(page, 'Host 管理', 'desktop')
      await dialog.locator('[data-host-row]').first().click()
      const detail = page.getByRole('dialog', { name: '主机详情' })
      await detail.waitFor({ state: 'visible', timeout: 10_000 })
      await detail.getByRole('button', { name: '诊断', exact: true }).click()
      const doctor = page.getByRole('dialog', { name: '主机诊断' })
      await doctor.waitFor({ state: 'visible', timeout: 10_000 })
      await doctor.locator('[data-doctor-check]').first().waitFor({ timeout: 60_000 })
      const skipText = (await doctor.locator('[data-doctor-check="profiles"]').textContent()) ?? ''
      assert.ok(skipText.includes('未执行'), `默认不应执行账号连通性：${skipText.slice(0, 80)}`)

      // 勾选后：mock 账号正常，自建端点（127.0.0.1:4321）连不上
      const toggle = doctor.getByRole('switch', { name: '检测账号连通性' })
      await toggle.click()
      await toggle.waitFor({ state: 'visible' })
      await page.waitForFunction(
        () => document.querySelector('[role="switch"][aria-label="检测账号连通性"]')?.getAttribute('aria-checked') === 'true',
        null,
        { timeout: 5_000 },
      )
      await doctor.getByRole('button', { name: '重新检查' }).click()
      await doctor
        .locator('[data-doctor-check^="profile."][data-doctor-status="fail"]')
        .first()
        .waitFor({ timeout: 90_000 })
      const statuses = await doctor
        .locator('[data-doctor-check]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-doctor-status')))
      assert.equal(statuses[0], 'fail', `失败项没有排在最前：${statuses.join(',')}`)
      assert.ok(statuses.lastIndexOf('ok') > statuses.indexOf('fail'), '正常项应排在失败项之后')
      const text = (await doctor.textContent()) ?? ''
      assert.ok(text.includes('自建端点'), '诊断面板缺少坏账号结果')
      assert.ok(text.includes('连接正常'), '诊断面板缺少正常账号结果')
      assert.ok(!/reg-key/.test(text), '诊断面板泄露了 Key')

      await doctor.getByRole('button', { name: '复制报告' }).click()
      await page.waitForTimeout(250)
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
      if (clip) {
        assert.ok(!/reg-key/.test(clip), '诊断报告泄露了 Key')
        assert.ok(/Tandem (主机|Host) 诊断报告/.test(clip), '复制内容不是诊断报告')
      }
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

desktop('设置弹窗焦点陷阱与关闭后焦点还原', async (page) => {
      await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor()
      // 等焦点陷阱真正接管（弹窗可见与 effect 执行之间有一帧；不要用固定 sleep）。
      await page.waitForFunction(
        () => !!document.activeElement?.closest('[role="dialog"]'),
        null,
        { timeout: 5_000 },
      )
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
        assert.ok(inside, `第 ${i + 1} 次 Tab 后焦点逃出弹窗`)
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.waitForTimeout(250)
      const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
      assert.match(text, /设置/, '关闭后焦点没有回到「设置」按钮')
    })

fb2102('反馈2102#03：设置弹窗打开时，背景滚动条不压在弹窗之上；弹窗自己的滚动条在弹窗之上', async (page) => {
      await openSession(page, 'scroll')
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const probe = (axis) =>
        page.evaluate((axis) => {
          const bar = document.querySelector(`.overlay-scrollbar[data-axis="${axis}"][data-visible="true"]`)
          if (!bar) return null
          const r = bar.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return { own: hit === bar, tag: hit?.tagName ?? null, cls: String(hit?.className ?? '').slice(0, 60) }
        }, axis)
      // 背景聊天区在遮罩下方滚动，覆盖式滚动条会在它的右缘出现。
      await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        if (el) el.scrollTop = 160
      })
      await page.waitForSelector('.overlay-scrollbar[data-visible="true"]', { timeout: 3_000 })
      const background = await probe('y')
      assert.ok(background, '背景滚动后没有出现覆盖式滚动条')
      assert.ok(!background.own, `背景滚动条压在设置弹窗之上：命中 ${background.tag}.${background.cls}`)
      // 弹窗自己的滚动区域：滚动条应显示在弹窗之上。
      const scrolled = await page.evaluate(() => {
        const root = document.querySelector('[role="dialog"][aria-label="设置"]')
        const el = root
          ? [...root.querySelectorAll('*')].find((node) => {
              const style = getComputedStyle(node)
              return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40
            })
          : null
        if (!el) return false
        el.scrollTop = 60
        return true
      })
      if (scrolled) {
        // 背景滚动条还会淡出 800ms：等它改归属到弹窗区域（滚动事件异步派发）后再判定。
        await page
          .waitForFunction(
            () => {
              const bar = document.querySelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]')
              if (!bar) return false
              const r = bar.getBoundingClientRect()
              return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === bar
            },
            null,
            { timeout: 3_000 },
          )
          .catch(() => {})
        const own = await probe('y')
        assert.ok(own?.own, `弹窗自己的滚动条被遮挡：命中 ${own?.tag}.${own?.cls}`)
      }
      await page.screenshot({ path: '/tmp/fix-2102a/after-03.png' })
      await dialog.locator('button[aria-label="关闭"]').first().click().catch(() => page.keyboard.press('Escape'))
    })

desktop('移除 MCP 服务器需要二次确认', async (page) => {
      await openSettings(page, 'MCP', 'desktop')
      const remove = page.getByRole('button', { name: '删除 reg-fs' })
      await remove.waitFor({ timeout: 10_000 })
      await remove.click()
      const confirm = page.getByRole('dialog', { name: '移除 MCP 服务器' })
      await confirm.waitFor({ state: 'visible' })
      assert.match(await confirm.innerText(), /mcp\.json/)
      assert.ok(JSON.stringify(JSON.parse(readFileSync(path.join(configDir, 'mcp.json'), 'utf8'))).includes('reg-fs'), '确认前已删除配置')
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await page.waitForTimeout(200)
      assert.ok(JSON.stringify(JSON.parse(readFileSync(path.join(configDir, 'mcp.json'), 'utf8'))).includes('reg-fs'), '取消后配置被删除')
      await closeSettings(page)
    })

desktop('同步与备份：空口令时导出按钮禁用', async (page) => {
      await openSettings(page, '同步与备份', 'desktop')
      const exportButton = page.getByRole('button', { name: '导出并下载' })
      await exportButton.waitFor()
      assert.equal(await exportButton.isDisabled(), true, '空口令仍可点击导出')
      await closeSettings(page)
    })

desktop('同步与备份：替换导入需二次确认并标注危险', async (page) => {
      await openSettings(page, '同步与备份', 'desktop')
      const fileInput = page.locator('input[type="file"][accept*="json"]')
      await fileInput.setInputFiles({
        name: 'tandem-config.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            encrypted: 'AAAA',
            salt: 'AAAA',
            iv: 'AAAA',
            createdAt: Date.now(),
            hostName: 'reg',
          }),
        ),
      })
      await page.getByRole('button', { name: /^替换/ }).click()
      assert.equal(await page.getByRole('button', { name: /^替换/ }).getAttribute('aria-pressed'), 'true')
      await page.getByPlaceholder('导出时设置的口令').fill('reg-pass')
      await page.getByRole('button', { name: '导入配置' }).click()
      const confirm = page.getByRole('dialog', { name: /替换现有配置/ })
      await confirm.waitFor({ state: 'visible', timeout: 3_000 })
      withinViewport(await confirm.boundingBox(), DESKTOP, '替换确认弹窗')
      assert.match(await confirm.innerText(), /账号/, '确认文案没有说明将删除的账号数量')
      assert.match(await confirm.innerText(), /主机/, '确认文案没有说明将删除的主机数量')
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await closeSettings(page)
    })

desktop('记忆编辑器不暴露内部元数据行', async (page) => {
      const dialog = await openSettings(page, '记忆', 'desktop')
      await dialog.getByRole('button', { name: '编辑 全局' }).click()
      const textarea = page.getByRole('textbox', { name: '记忆 Markdown' })
      await textarea.waitFor({ state: 'visible', timeout: 5_000 })
      const value = await textarea.inputValue()
      assert.equal(value.includes('tandem-memory'), false, '编辑器仍显示内部元数据注释')
      assert.match(value, /用户喜欢深色主题/)
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

desktop('设置页字号不低于 11px（记忆/提示词/Skills）', async (page) => {
      const dialog = await openSettings(page, '记忆', 'desktop')
      for (const tab of ['记忆', '提示词', 'Skills']) {
        await openSettings(page, tab, 'desktop')
        await page.waitForTimeout(350)
        const smallest = await dialog.evaluate((root) => {
          let min = Infinity
          let text = ''
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walker.nextNode())) {
            const content = node.textContent?.trim()
            if (!content) continue
            const el = node.parentElement
            if (!el) continue
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const rect = el.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) continue
            if (el.closest('svg')) continue
            const size = parseFloat(style.fontSize)
            if (Number.isFinite(size) && size < min) {
              min = size
              text = content.slice(0, 24)
            }
          }
          return { min, text }
        })
        assert.ok(smallest.min >= 10.9, `「${tab}」页出现 ${smallest.min}px 文字：${smallest.text}`)
      }
      await closeSettings(page)
    })

desktop('无障碍扫描：主要页面 serious/critical 违规为 0', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.waitForTimeout(400)
      await auditA11y(page, '新会话页')
      await openSession(page, 'long')
      await auditA11y(page, '会话页（工具卡）')
      await openSession(page, 'approve')
      await page.locator('.permission-card').first().waitFor()
      await auditA11y(page, '审批卡')
      await page.evaluate(() => (window.location.hash = '#/dev/ui'))
      await page.getByRole('heading', { name: '组件画廊' }).waitFor()
      await auditA11y(page, '组件画廊')
      await openSettings(page, '通用', 'desktop')
      await auditA11y(page, '设置 · 通用')
      await closeSettings(page)
    })

desktop('设置分组：6 组、合并页与高级折叠', async (page) => {
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('nav').first()
      for (const group of ['基础', '模型与账号', '权限与安全', 'Agent 与自动化', '外观与辅助', '高级']) {
        assert.equal(
          await nav.locator(`[data-settings-group] > button`).filter({ hasText: group }).count(),
          1,
          `设置导航缺少分组「${group}」`,
        )
      }
      for (const pageName of ['用量与预算', 'Agent 能力', '分享']) {
        assert.equal(await nav.getByRole('button', { name: pageName, exact: true }).count(), 1, `缺少合并页「${pageName}」`)
      }
      const advanced = nav.locator('[data-settings-group="advanced"] > button').first()
      assert.equal(await advanced.getAttribute('aria-expanded'), 'false', '高级组默认没有折叠')
      assert.equal(await nav.locator('[data-settings-page="evals"]').count(), 0, '高级组折叠时仍渲染评测页')
      assert.equal(await nav.locator('[data-settings-page]').count(), 15, '设置导航可见页面数不是 15')
      await advanced.click()
      await page.waitForTimeout(150)
      assert.equal(await advanced.getAttribute('aria-expanded'), 'true', '高级组无法展开')
      for (const id of ['extensions', 'evals', 'gateway', 'sync']) {
        assert.equal(await nav.locator(`[data-settings-page="${id}"]`).count(), 1, `高级组缺少 ${id}`)
      }
      // 合并页：一个导航入口，两个子页签。
      await nav.locator('[data-settings-page="usage-budgets"]').click()
      await page.waitForTimeout(150)
      const subtabs = dialog.locator('[data-settings-subtabs="usage-budgets"]')
      await subtabs.waitFor({ state: 'visible', timeout: 3_000 })
      assert.equal(await subtabs.getByRole('button').count(), 2, '用量与预算子页签数量不对')
      assert.equal(await nav.locator('[data-settings-page="usage-budgets"]').getAttribute('aria-current'), 'page')
      await closeSettings(page)
    })

desktop('快捷键：外观页由命令注册表生成、自定义生效、冲突提示', async (page) => {
      const dialog = await openSettings(page, '外观', 'desktop')
      const rows = dialog.locator('[data-command-shortcut]')
      assert.ok((await rows.count()) >= 10, `快捷键表只有 ${await rows.count()} 行`)
      const themeRow = dialog.locator('[data-command-shortcut="app.toggle-theme"]')
      const before = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      await themeRow.getByRole('button', { name: '修改 切换主题 快捷键' }).click()
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(220)
      const kbd = (await themeRow.locator('kbd').textContent()) ?? ''
      assert.ok(kbd.includes('T') && kbd.includes('Shift'), `自定义快捷键未保存：${kbd}`)
      await closeSettings(page)
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(260)
      const after = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      assert.notEqual(after, before, '自定义快捷键没有触发切换主题')
      const dialog2 = await openSettings(page, '外观', 'desktop')
      const sidebarRow = dialog2.locator('[data-command-shortcut="app.toggle-sidebar"]')
      await sidebarRow.getByRole('button', { name: '修改 切换侧栏 快捷键' }).click()
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(220)
      const warning = (await dialog2.getByRole('status').textContent()) ?? ''
      assert.ok(warning.includes('冲突'), `冲突没有提示：${warning}`)
      await dialog2.getByRole('button', { name: '全部恢复默认' }).click()
      await closeSettings(page)
    })
}
