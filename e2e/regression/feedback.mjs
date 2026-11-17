#!/usr/bin/env node
/**
 * 反馈模式与调整工具（圈选、体验清单、草稿、截图）。
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

export const feature = 'feedback'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [78, 79, 201, 202, 203, 204, 205, 207]

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

desktop('反馈模式点击不穿透，选中的是底层元素', async (page) => {
      await openSession(page, 'long')
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      const settingsButton = page.locator('aside').getByRole('button', { name: '设置', exact: true })
      const sb = await settingsButton.boundingBox()
      assert.ok(sb, '找不到侧栏设置按钮')
      await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 8_000 })
      assert.equal(await page.getByRole('dialog', { name: '设置' }).count(), 0, '点击穿透打开了设置')
      withinViewport(await editor.boundingBox(), DESKTOP, '反馈输入浮窗')
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

desktop('反馈模式圈选浮层：模型菜单（含子菜单）、命令面板、环境条、看板抽屉', async (page) => {
      await openSession(page, 'nockpt')
      await waitModelReady(page)
      // 菜单主体只列最近使用模型（决策 menu-recent-models）；清掉记录才会回退到当前分组的
      // mock-1。共享 context 的 localStorage 会被前面发过消息的用例写入 O3。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      const editor = page.getByRole('dialog', { name: '反馈输入' })

      const enterFeedback = async () => {
        await page.keyboard.press('Control+Shift+F')
        await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      }
      const cancelEditor = async () => {
        await editor.getByRole('button', { name: '取消', exact: true }).click()
        await editor.waitFor({ state: 'hidden', timeout: 5_000 })
      }
      const exitFeedback = async () => {
        if (await editor.isVisible().catch(() => false)) await cancelEditor()
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
      }
      // 反馈模式下点击浮层里的目标：编辑器必须出现，且点击不能穿透到应用。
      const expectEditorAt = async (target, label) => {
        const box = await target.boundingBox()
        assert.ok(box, `${label} 不在视口内`)
        await page.mouse.click(box.x + Math.min(box.width / 2, 48), box.y + box.height / 2)
        await editor.waitFor({ state: 'visible', timeout: 8_000 })
        withinViewport(await editor.boundingBox(), DESKTOP, `反馈输入浮窗（${label}）`)
        await cancelEditor()
      }

      // 1) 模型菜单 + 级联子菜单：Radix 模态菜单把 body 锁成 pointer-events:none，
      //    旧实现 elementsFromPoint 只拿到 <html>，所有点选失效。
      const modelButton = page.locator('button[aria-label^="选择模型"]').first()
      await modelButton.click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const modelRow = menu.locator('[role="menuitem"]').filter({ hasText: 'mock-1' }).first()
      await modelRow.hover()
      await menu.getByText('切换账号', { exact: true }).hover()
      const submenu = page.locator('[role="menu"][aria-label="切换账号"]').first()
      await submenu.waitFor({ timeout: 5_000 })

      await enterFeedback()
      // 子菜单先圈选：反馈模式下无法再把指针移回 Radix 触发器展开子菜单。
      await expectEditorAt(submenu.locator('[role="menuitem"]').first(), '级联子菜单项')
      await expectEditorAt(modelRow, '模型菜单项')
      // 指针停在轮次大纲上退出反馈模式：relatedTarget 可能是 Window，旧实现直接 contains 会抛错。
      const rail = page.locator('.turn-hit').first()
      const railBox = await rail.boundingBox().catch(() => null)
      if (railBox) await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2)
      await exitFeedback()
      await page.mouse.move(900, 500)
      await page.waitForTimeout(250)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})

      // 2) 命令面板（Modal Portal）
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: '命令面板' })
      await palette.waitFor({ timeout: 8_000 })
      await enterFeedback()
      await expectEditorAt(palette.locator('[data-palette-index]').first(), '命令面板条目')
      await exitFeedback()
      await page.keyboard.press('Escape')
      await palette.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})

      // 3) 环境条下拉（Popover Portal）
      const folderTrigger = page.locator(`button[data-tip="${repo}"]`).first()
      await folderTrigger.click()
      const popover = page.locator('[role="menu"]:has(> .popover-panel)').first()
      await popover.waitFor()
      await enterFeedback()
      await expectEditorAt(popover.getByRole('menuitem').first(), '环境条下拉项')
      await exitFeedback()
      await page.keyboard.press('Escape')
      await popover.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})

      // 4) 看板卡片抽屉
      const board = await boardCall('', {
        method: 'POST',
        body: { cwd: repo, name: '反馈圈选看板', maxParallel: 1, defaults: { profileId: 'p-main' } },
      })
      await boardCall(`/${board.id}/cards`, {
        method: 'POST',
        body: { title: '圈选抽屉卡', prompt: '回复“完成”即可' },
      })
      await openBoardPage(page, board.id)
      await boardCardIn(page, 'todo', '圈选抽屉卡').click()
      const drawer = page.getByTestId('board-drawer')
      await drawer.waitFor()
      await enterFeedback()
      await expectEditorAt(drawer.getByText('圈选抽屉卡', { exact: true }).first(), '看板抽屉')
      await exitFeedback()
      await drawer.getByRole('button', { name: '关闭详情', exact: true }).first().click().catch(() => {})
    })

desktop('体验清单「有问题」进入反馈并带功能标签，导出与解包按功能分组', async (page) => {
      const state = await api(base, token, '/api/demo')
      if (!state.active) await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const chatId = (await api(base, token, '/api/demo')).scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
      await openSession(page, chatId)

      const settings = await openSettings(page, '通用', 'desktop')
      await settings.getByText('关于 Tandem', { exact: true }).click()
      const about = page.getByRole('dialog', { name: '关于 Tandem' })
      await about.waitFor({ state: 'visible' })
      await about.getByRole('button', { name: '体验清单' }).click()
      const checklist = page.getByRole('dialog', { name: '体验清单' })
      await checklist.waitFor({ state: 'visible' })
      assert.ok((await checklist.getByText('对话与工具调用', { exact: true }).count()) > 0, '体验清单缺少功能分组')
      assert.ok((await checklist.getByText('新', { exact: true }).count()) > 0, '体验清单缺少「新」标记')

      const pointText = '打开演示看板，确认七列、依赖卡与需我处理数字。'
      const row = checklist.getByText(pointText, { exact: true }).locator('..')
      await row.getByRole('button', { name: '有问题' }).click()
      const bar = page.getByRole('region', { name: '反馈模式工具栏' })
      await bar.waitFor({ state: 'visible' })
      await bar.getByText('标记：任务看板', { exact: true }).waitFor({ timeout: 5_000 })

      // 在消息区域点选一个元素，写下反馈并保存。
      await page.mouse.click(900, 300)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      await editor.locator('textarea').fill('体验清单测试：看板说明看不清楚')
      await editor.locator('textarea').press('Enter')
      await page.getByText(/已记录第 \d+ 条反馈/).first().waitFor({ timeout: 15_000 })

      await bar.getByRole('button', { name: /条目 \d+/ }).click()
      const drawer = page.locator('aside[aria-label="反馈条目"]')
      await drawer.getByText('任务看板', { exact: true }).first().waitFor({ timeout: 5_000 })
      await drawer.getByRole('button', { name: '关闭条目列表' }).click()

      // 新包格式：.tfb（zip 容器），解包后是正常文件；导出不再弹清空确认。
      const downloadPromise = page.waitForEvent('download')
      await bar.getByRole('button', { name: '导出', exact: true }).click()
      const download = await downloadPromise
      assert.match(
        download.suggestedFilename(),
        /^tandem-feedback-\d{8}-\d{4}\.tfb$/,
        '导出文件名不是 .tfb',
      )
      const downloadFile = path.join(home, 'feedback-export.tfb')
      await download.saveAs(downloadFile)
      const unpacked = mkdtempSync(path.join(home, 'feedback-unpack-'))
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/feedback-unpack.mjs'), downloadFile, unpacked], { encoding: 'utf8' })
      const exported = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
      assert.equal(exported.format, 'tfb', 'manifest 缺少 tfb 版本标记')
      assert.ok(Array.isArray(exported.featureGroups), '导出 manifest 缺少 featureGroups')
      assert.ok(exported.featureGroups.some((group) => group.name === '任务看板'), '导出未按功能分组')
      assert.equal(exported.items[0].featureName, '任务看板', '反馈条目没有功能标签')
      assert.equal(exported.checklist, '体验清单.md', '导出未附带体验清单报告')
      assert.ok(existsSync(path.join(unpacked, '01-元素截图.png')), '解包里没有条目截图文件')
      assert.ok(existsSync(path.join(unpacked, 'by-feature', '任务看板.md')), '缺少 by-feature 分组文件')
      assert.ok(existsSync(path.join(unpacked, '体验清单.md')), '缺少体验清单报告')
      const feedbackMd = readFileSync(path.join(unpacked, 'feedback.md'), 'utf8')
      assert.ok(feedbackMd.includes('## 功能：任务看板'), 'feedback.md 未按功能分组')
      assert.ok(feedbackMd.includes('`01-元素截图.png`'), 'feedback.md 没有引用截图文件')
      // 导出后条目清空、草稿标记为已导出（保留 7 天）。
      await bar.waitFor({ state: 'visible' })
      assert.equal(await bar.getByText('已记录 0 条', { exact: false }).count(), 1, '导出后条目没有清空')

      // 根因：同一编号出现两次标「复发」，并输出 by-cause。
      const causeFile = path.join(home, 'feedback-causes.json')
      writeFileSync(causeFile, JSON.stringify({
        version: 2,
        kind: 'feedback',
        exportedAt: new Date().toISOString(),
        items: [
          { id: 'c1', type: 'issue', text: '下拉被裁切', featureId: 'board', featureName: '任务看板', causeId: 'R03', causeTitle: '弹层被裁切或越界', selector: '', textSnippet: '', createdAt: 1, rect: { x: 0, y: 0, width: 1, height: 1, pageX: 0, pageY: 0 } },
          { id: 'c2', type: 'issue', text: '弹层挡住输入框', featureId: 'chat', featureName: '对话与工具调用', causeId: 'R03', causeTitle: '弹层被裁切或越界', selector: '', textSnippet: '', createdAt: 2, rect: { x: 0, y: 0, width: 1, height: 1, pageX: 0, pageY: 0 } },
        ],
      }), 'utf8')
      const causeOut = mkdtempSync(path.join(home, 'feedback-cause-out-'))
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/feedback-unpack.mjs'), causeFile, causeOut], { encoding: 'utf8' })
      assert.ok(existsSync(path.join(causeOut, 'by-cause', 'R03.md')), '缺少 by-cause 分组文件')
      const causeMd = readFileSync(path.join(causeOut, 'feedback.md'), 'utf8')
      assert.ok(causeMd.includes('R03 弹层被裁切或越界 · 2 次 · **复发**'), 'feedback.md 未标出复发根因')
    })

desktop('反馈草稿实时保存：刷新后条目与截图恢复，可手动删除草稿', async (page) => {
      await openSession(page, 'long')
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      const bar = page.getByRole('region', { name: '反馈模式工具栏' })
      await bar.waitFor({ state: 'visible' })
      await page.mouse.click(900, 300)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      await editor.locator('textarea').fill('刷新恢复测试：这条不导出')
      await editor.locator('textarea').press('Enter')
      await page.getByText(/已记录第 \d+ 条反馈/).first().waitFor({ timeout: 15_000 })
      const countBefore = (await bar.getByText(/已记录 \d+ 条/).first().textContent()) ?? ''
      // 等 IndexedDB 写完再刷新，避免把「还没落盘」当成草稿丢失。
      await page.waitForFunction(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('tandem-feedback', 1)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const record = await new Promise((resolve) => {
          const tx = db.transaction('state', 'readonly')
          const req = tx.objectStore('state').get('current')
          req.onsuccess = () => resolve(req.result)
        })
        db.close()
        return (record?.items?.length ?? 0) > 0 && !record?.draft?.exportedAt
      }, { timeout: 10_000 })

      // 不导出直接刷新：IndexedDB 里的条目与截图应恢复。
      await page.reload()
      await page.waitForSelector('html.feedback-mode', { state: 'detached', timeout: 10_000 }).catch(() => {})
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 8_000 })
      await page.getByText(/已恢复 \d+ 条未导出的反馈/).first().waitFor({ timeout: 10_000 })
      const barAfter = page.getByRole('region', { name: '反馈模式工具栏' })
      assert.equal(
        (await barAfter.getByText(countBefore.trim(), { exact: true }).count()) > 0,
        true,
        '刷新后条目数没有恢复',
      )
      await barAfter.getByRole('button', { name: /条目 \d+/ }).click()
      const drawer = page.locator('aside[aria-label="反馈条目"]')
      await drawer.getByText('刷新恢复测试：这条不导出', { exact: false }).first().waitFor({ timeout: 8_000 })
      assert.ok(
        (await drawer.locator('img').count()) > 0,
        '刷新后截图没有恢复（条目缩略图为空）',
      )
      await drawer.getByText(/草稿已保存到本机/).first().waitFor({ timeout: 5_000 })

      // 手动删除草稿：确认后条目清空。
      page.once('dialog', (dialog) => dialog.accept())
      await drawer.getByRole('button', { name: '删除草稿' }).click()
      await page.getByText('已删除草稿').first().waitFor({ timeout: 5_000 })
      await drawer.waitFor({ state: 'hidden' }).catch(() => {})
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

fbAdjust('调整工具：冻结副本改尺寸吸附 token、换图标/备注/删除/插入/平移并导出 adjust.md', async (page) => {
      const state = await api(base, token, '/api/demo')
      if (!state.active) await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const chatId = (await api(base, token, '/api/demo')).scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
      await openSession(page, chatId)

      // 真实界面结构签名（忽略走动的时间和 React 自增 id）。
      const signature = () =>
        page.evaluate(() => {
          const root = document.querySelector('#root')
          if (!root) return ''
          const stable = ['data-testid', 'data-session-id', 'data-session-row', 'data-turn-id', 'data-project-key', 'data-host-group', 'role']
          return [...root.querySelectorAll('*')]
            .filter((el) => !el.closest('[data-feedback-ui]'))
            .map((el) => {
              const attrs = [...el.attributes]
                .filter((attr) => stable.includes(attr.name))
                .map((attr) => `${attr.name}=${attr.value.replace(/\d+/g, '#')}`)
                .join('|')
              return `${el.tagName}:${attrs}`
            })
            .join('\u0001')
        })

      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 8000 })
      await page.waitForTimeout(700)
      const rootBefore = await signature()
      const sameSignature = async (label) => {
        const now = await signature()
        if (now === rootBefore) return
        const a = rootBefore.split('\u0001')
        const b = now.split('\u0001')
        const at = a.findIndex((line, index) => line !== b[index])
        throw new Error(
          `${label}：真实界面 DOM 被改动（第 ${at} 项 ${a[at] ?? '缺失'} → ${b[at] ?? '缺失'}；共 ${a.length}/${b.length}）`,
        )
      }
      const bar = page.getByRole('region', { name: '反馈模式工具栏' })
      await bar.getByRole('button', { name: '调整', exact: true }).click()
      const toolbar = page.locator('[data-adjust-toolbar]')
      await toolbar.waitFor({ timeout: 20000 })
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
      assert.equal(await page.locator('[data-adjust-stage]').count(), 1, '没有冻结副本')
      await sameSignature('冻结后')

      // 改尺寸：拖 e 手柄，宽度吸到 4px 栅格并记 token。
      assert.equal(await page.evaluate(() => window.__feedbackAdjust.select('[data-testid="sidebar-new-session"]')), true, '选不中新建会话按钮')
      await page.locator('[data-adjust-selection-bar]').waitFor({ timeout: 5000 })
      const handle = await page.locator('[data-adjust-handle="e"]').boundingBox()
      assert.ok(handle, '缺少 e 手柄')
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      let changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      const resize = changes.find((change) => change.kind === 'resize')
      assert.ok(resize, '改尺寸没有进改动清单')
      assert.ok(resize.after.width % 4 === 0, `宽度没有吸附 4px 栅格：${resize.after.width}`)
      assert.ok(resize.tokens?.width || resize.tokens?.height, '尺寸没有记录 token')
      assert.equal(resize.standard, true, '吸附后仍标成非标准值')
      assert.ok(resize.target.selector && resize.target.rect, '改动目标缺少选择器或位置')

      // 撤销 / 重做 / 单条回退。
      await page.keyboard.press('Control+z')
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.equal(changes.some((change) => change.kind === 'resize'), false, '撤销没有生效')
      await page.keyboard.press('Control+Shift+z')
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.equal(changes.some((change) => change.kind === 'resize'), true, '重做没有生效')

      // 换图标 + 行为备注。
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '换图标' }).click()
      const iconName = (await page.locator('[data-adjust-icon]').first().getAttribute('data-adjust-icon')) ?? ''
      await page.locator(`[data-adjust-icon="${iconName}"]`).click()
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '行为备注' }).click()
      await page.locator('[data-adjust-note-panel] textarea').fill('点击后打开新建会话；悬停显示快捷键。')
      await page.locator('[data-adjust-note-panel]').getByRole('button', { name: '保存备注' }).click()
      await page.waitForTimeout(200)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(changes.some((change) => change.kind === 'icon' && change.after.icon === iconName), '换图标没有记录')
      assert.ok(changes.some((change) => change.kind === 'note' && change.behavior?.includes('新建会话')), '行为备注没有记录')
      assert.ok(resize.target.source?.fileName, '调试版没有给出源码位置（data-tandem-src）')

      // 小于 12px 的元素：擦边 6px 也能选中；手柄外置、命中区 ≥20px、光标随方向。
      const tiny = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        let best = null
        for (const el of stage.querySelectorAll('[data-tandem-src]')) {
          const r = el.getBoundingClientRect()
          if (r.width < 5 || r.height < 5 || r.width > 12 || r.height > 12) continue
          if (r.left < 5 || r.top < 5 || r.bottom > innerHeight - 140) continue
          if (el.closest('button,a,[role="button"]')) continue
          const area = r.width * r.height
          if (!best || area < best.area) best = { area, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
        }
        if (!best) return null
        const hit = document
          .elementsFromPoint(best.x, best.y)
          .find((node) => stage.contains(node) && node.getBoundingClientRect().width <= 12)
        hit?.setAttribute('data-adjust-probe', 'tiny')
        return best
      })
      assert.ok(tiny, '找不到小于 12px 的元素')
      await page.mouse.move(tiny.x + tiny.w / 2 + 6, tiny.y)
      await page.waitForTimeout(150)
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('[data-adjust-hit-layer]')).cursor),
        'grab',
        '悬停可拖动元素没有 grab 光标',
      )
      await page.mouse.click(tiny.x + tiny.w / 2 + 6, tiny.y)
      await page.waitForTimeout(200)
      assert.equal(await page.evaluate(() => window.__feedbackAdjust.selected()?.inStage), true, '小元素擦边选中失败')
      const tinyHandle = await page.locator('[data-adjust-handle="se"]').boundingBox()
      assert.ok(tinyHandle && tinyHandle.width >= 20 && tinyHandle.height >= 20, '小元素手柄命中区不足 20px')
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('[data-adjust-handle="se"]')).cursor),
        'nwse-resize',
        '手柄光标不是 resize',
      )
      // 键盘：Enter 进子级、Tab/Shift+Tab 切兄弟。
      await page.keyboard.press('Enter')
      await page.waitForTimeout(120)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(120)
      assert.equal(await page.evaluate(() => window.__feedbackAdjust.selected()?.inStage), true, 'Tab 切换兄弟后没有选中')
      assert.equal(await page.evaluate(() => window.__feedbackAdjust.select('[data-adjust-probe="tiny"]')), true, '无法回到小元素')
      await page.waitForTimeout(150)
      const tinyHandle2 = await page.locator('[data-adjust-handle="se"]').boundingBox()
      await page.mouse.move(tinyHandle2.x + tinyHandle2.width / 2, tinyHandle2.y + tinyHandle2.height / 2)
      await page.mouse.down()
      await page.mouse.move(tinyHandle2.x + tinyHandle2.width / 2 + 12, tinyHandle2.y + tinyHandle2.height / 2 + 12, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(
        changes.some((change) => change.kind === 'resize' && change.target.source?.fileName),
        '小元素改大小没有记录或缺少源码位置',
      )

      // 删除 + 撤销恢复。
      assert.equal(
        await page.evaluate(() => window.__feedbackAdjust.select('[aria-label^="收件箱"]')),
        true,
        '选不中收件箱按钮',
      )
      await page.waitForTimeout(120)
      await page.keyboard.press('Delete')
      await page.waitForTimeout(200)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(changes.some((change) => change.kind === 'delete'), '删除没有记录')
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(150)
      assert.equal(
        await page.evaluate(() => !!document.querySelector('[data-adjust-stage] [aria-label^="收件箱"]')),
        true,
        '撤销删除后元素没有恢复',
      )

      // 插入面板悬停预览（真实 ui/* 组件），再插入列表并加两行、写容器备注。
      await toolbar.getByRole('button', { name: '插入控件' }).click()
      await page.locator('[data-insert-option="button-primary"]').hover()
      const insertPreview = page.locator('[data-adjust-insert-preview="button-primary"]')
      await insertPreview.waitFor({ timeout: 5000 })
      assert.equal(await insertPreview.locator('button').count(), 1, '插入面板悬停没有渲染真实控件预览')
      await page.locator('[data-insert-option="list"]').click()
      const listEditor = page.locator('[data-adjust-expand]')
      await listEditor.waitFor({ timeout: 5000 })
      await listEditor.getByRole('button', { name: '添加行' }).click()
      await listEditor.getByRole('button', { name: '添加行' }).click()
      await listEditor.locator('input[aria-label="第 1 行标题"]').fill('会话标题')
      await listEditor.locator('input[aria-label="第 1 行备注"]').fill('显示标题 + 项目名')
      await listEditor.locator('input[aria-label="第 2 行标题"]').fill('最后活动时间')
      await listEditor.locator('input[aria-label="第 2 行备注"]').fill('点击切换到该会话')
      await listEditor.locator('textarea[aria-label="容器行为备注"]').fill('按最近使用排序；空状态显示「还没有会话」。')
      await page.waitForTimeout(350)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      const insert = changes.find((change) => change.kind === 'insert')
      assert.equal(insert?.after?.rows?.length, 2, '示意行没有进改动清单')
      assert.ok(insert?.after?.note?.includes('最近使用'), '容器备注没有同步')

      // 插入的容器同样有手柄、吸附 token。
      const insertHandle = await page.locator('[data-adjust-handle="se"]').boundingBox()
      assert.ok(insertHandle, '插入的控件没有手柄')
      await page.mouse.move(insertHandle.x + insertHandle.width / 2, insertHandle.y + insertHandle.height / 2)
      await page.mouse.down()
      await page.mouse.move(insertHandle.x + insertHandle.width / 2 + 20, insertHandle.y + insertHandle.height / 2 + 8, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      const insertedResize = changes.find((change) => change.kind === 'resize' && change.target.testId)
      assert.ok(insertedResize, '插入控件改大小没有记录')
      assert.equal(insertedResize.after.width % 4, 0, '插入控件宽度没有吸附 4px 栅格')

      // Alt 拖动：自由平移并记 translate。
      const hasTurn = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        const turn = [...stage.querySelectorAll('[data-turn-id]')].find((row) => {
          const rect = row.getBoundingClientRect()
          return rect.top > 220 && rect.bottom < window.innerHeight - 200
        })
        if (!turn) return false
        turn.setAttribute('data-adjust-probe', 'turn')
        return window.__feedbackAdjust.select('[data-adjust-probe="turn"]')
      })
      assert.equal(hasTurn, true, '没有可拖动的可见轮次')
      const box = await page.evaluate(() => {
        const rect = document.querySelector('[data-adjust-stage] [data-adjust-probe="turn"]').getBoundingClientRect()
        return { x: rect.left + 40, y: rect.top + 20 }
      })
      await page.keyboard.down('Alt')
      await page.mouse.move(box.x, box.y)
      await page.mouse.down()
      await page.mouse.move(box.x + 60, box.y + 40, { steps: 10 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await page.waitForTimeout(250)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      const move = changes.find((change) => change.kind === 'move' && change.after?.offsetX)
      assert.ok(move, 'Alt 拖动没有记录 translate')

      // 换样式变体：只记变体名。
      const variantPicked = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        const el = [...stage.querySelectorAll('[data-variant]')].find((node) => {
          const r = node.getBoundingClientRect()
          return r.width > 40 && r.top > 60 && r.bottom < innerHeight - 140
        })
        if (!el) return null
        el.setAttribute('data-adjust-probe', 'variant')
        window.__feedbackAdjust.select('[data-adjust-probe="variant"]')
        return el.getAttribute('data-variant')
      })
      assert.ok(variantPicked, '没有可换变体的按钮')
      const nextVariant = variantPicked === 'primary' ? 'secondary' : 'primary'
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '换变体' }).click()
      await page.locator(`[data-adjust-variant="${nextVariant}"]`).click()
      await page.waitForTimeout(200)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(
        changes.some((change) => change.kind === 'variant' && change.after.variant === nextVariant),
        '换变体没有记录',
      )

      // 改纯文本。
      await page.evaluate(() => window.__feedbackAdjust.select('[data-testid="sidebar-new-session"] span'))
      await page.waitForTimeout(150)
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '改文字' }).click()
      await page.locator('[data-adjust-text-panel] input').fill('新建')
      await page.locator('[data-adjust-text-panel]').getByRole('button', { name: '保存文字' }).click()
      await page.waitForTimeout(200)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(changes.some((change) => change.kind === 'text' && change.after.text === '新建'), '改文字没有记录')

      // 隐藏（保留占位，与删除区分）。
      await page.evaluate(() => window.__feedbackAdjust.select('[aria-label^="收件箱"]'))
      await page.waitForTimeout(150)
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '隐藏' }).click()
      await page.waitForTimeout(200)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(changes.some((change) => change.kind === 'hide'), '隐藏没有记录')
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('[data-adjust-stage] [aria-label^="收件箱"]')).visibility),
        'hidden',
        '隐藏没有生效（应保留布局占位）',
      )

      // 重新冻结：临时退出副本 → 重新冻结并按选择器挂回改动。
      await toolbar.getByRole('button', { name: '重新冻结' }).click()
      await page.locator('[data-adjust-released]').waitFor({ timeout: 5000 })
      assert.equal(await page.locator('[data-adjust-stage]').count(), 0, '退出副本后 stage 没有移除')
      await page.locator('[data-adjust-released]').getByRole('button', { name: '现在重新冻结' }).click()
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
      await page.waitForTimeout(300)
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('[data-adjust-stage] [aria-label^="收件箱"]')).visibility),
        'hidden',
        '重新冻结后隐藏改动没有挂回',
      )
      assert.equal(
        await page.evaluate(() => window.__feedbackAdjust.changes().filter((change) => change.stale).length),
        0,
        '重新冻结后有改动没挂上',
      )
      await sameSignature('调整过程中')

      // 完成并保存 → 调整条目；继续调整恢复副本、修改并更新同一条目；再导出 .tfb。
      await toolbar.getByRole('button', { name: /完成并保存/ }).click()
      const drawer = page.locator('aside[aria-label="反馈条目"]')
      await drawer.waitFor({ timeout: 30000 })
      await drawer.getByText(/调整 \d+ 项/).first().waitFor({ timeout: 10000 })
      assert.equal(await page.locator('[data-adjust-stage]').count(), 0, '退出调整后冻结副本没有销毁')
      await sameSignature('退出调整后')

      await drawer.getByRole('button', { name: '继续调整' }).click()
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
      await page.waitForTimeout(300)
      const resumedChanges = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.ok(resumedChanges.length >= 7, `继续调整没有恢复改动：${resumedChanges.length}`)
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('[data-adjust-stage] [aria-label^="收件箱"]')).visibility),
        'hidden',
        '恢复副本没有带上隐藏改动',
      )
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('[data-adjust-inserted-layer] [data-adjust-inserted]').length),
        1,
        '恢复副本没有带回插入控件',
      )
      await page.evaluate(() => window.__feedbackAdjust.select('[data-testid="sidebar-new-session"] span'))
      await page.waitForTimeout(150)
      await page.locator('[data-adjust-selection-bar]').getByRole('button', { name: '改文字' }).click()
      await page.locator('[data-adjust-text-panel] input').fill('新建会话')
      await page.locator('[data-adjust-text-panel]').getByRole('button', { name: '保存文字' }).click()
      await page.waitForTimeout(200)
      await page.locator('[data-adjust-toolbar]').getByRole('button', { name: /完成并保存/ }).click()
      await drawer.waitFor({ timeout: 20000 })
      await page.waitForTimeout(300)
      assert.match(await drawer.innerText(), /反馈条目 · 1/, '继续调整后新建了条目（应更新同一条）')

      const downloadPromise = page.waitForEvent('download')
      await bar.getByRole('button', { name: '导出', exact: true }).click()
      const download = await downloadPromise
      const downloadFile = path.join(home, 'adjust-export.tfb')
      await download.saveAs(downloadFile)
      const unpacked = mkdtempSync(path.join(home, 'adjust-unpack-'))
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/feedback-unpack.mjs'), downloadFile, unpacked], { encoding: 'utf8' })
      const manifest = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
      const adjustItem = manifest.items.find((item) => item.mode === 'adjust')
      assert.ok(adjustItem, '导出的 manifest 没有调整条目')
      assert.equal(adjustItem.adjust.changeCount >= 5, true, '调整条目改动数不对')
      assert.equal(adjustItem.adjust.sourceAvailable, true, '调试版调整条目没有源码位置')
      assert.ok(adjustItem.files.adjust && adjustItem.files.adjustMarkdown, 'manifest 缺少调整清单/说明文件')
      assert.ok(existsSync(path.join(unpacked, '01-调整前.png')), '缺少调整前截图')
      assert.ok(existsSync(path.join(unpacked, '01-调整后.png')), '缺少调整后截图')
      const adjustJson = JSON.parse(readFileSync(path.join(unpacked, '01-调整.json'), 'utf8'))
      assert.equal(adjustJson.version, 1)
      assert.equal(adjustJson.kind, 'adjust')
      assert.ok(adjustJson.route && adjustJson.theme === 'dark' && adjustJson.viewport.width > 0, '调整清单缺少环境字段')
      assert.ok(adjustJson.changes.length >= 5 && adjustJson.structure.length > 0, '调整清单缺少改动或结构快照')
      assert.ok(adjustJson.copy?.html?.includes('<'), '调整清单缺少副本 HTML 快照（无法继续调整）')
      for (const change of adjustJson.changes) {
        assert.ok(change.id && change.kind && change.at && change.target?.selector, '改动条目字段不完整')
      }
      const adjustMd = readFileSync(path.join(unpacked, '01-调整说明.md'), 'utf8')
      assert.match(adjustMd, /## 按顺序实现/)
      assert.match(adjustMd, /\*\*改尺寸\*\*/)
      assert.match(adjustMd, /尺寸 token：/)
      assert.match(adjustMd, /源码：`packages\/web\/src\//)
      assert.match(adjustMd, /\*\*换图标\*\*/)
      assert.match(adjustMd, /行为备注：点击后打开新建会话/)
      assert.match(adjustMd, /示意内容（草稿/)
      assert.match(adjustMd, /1\. ListRow：会话标题 — 备注：显示标题 \+ 项目名/)
      assert.match(adjustMd, /translate\(60px, 40px\)/)
      assert.match(adjustMd, /只用 \`packages\/web\/src\/components\/ui\/\*\` 现有组件与变体/)
      const feedbackMd = readFileSync(path.join(unpacked, 'feedback.md'), 'utf8')
      assert.match(feedbackMd, /调整说明：`01-调整说明\.md`/)
      assert.match(feedbackMd, /调整后截图：`01-调整后\.png`/)

      // 退出反馈模式后不残留调整界面。
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'), null, { timeout: 10000 })
      assert.equal(
        await page.locator('[data-adjust-toolbar], [data-adjust-stage], [data-adjust-hit-layer]').count(),
        0,
        '退出后仍有调整界面残留',
      )
    })

fbAdjust('调整说明：同元素连续改尺寸/移动合并为一条、选择器跳过 Radix/React 自动 id', async (page) => {
      // 先打开一个 Radix 菜单（冻结副本里才带 #radix-… 的运行时 id）。
      await openSession(page, 'long')
      await page.getByRole('button', { name: '筛选会话' }).click()
      await page.waitForTimeout(200)
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 8000 })
      await page.waitForTimeout(500)
      const bar = page.getByRole('region', { name: '反馈模式工具栏' })
      await bar.getByRole('button', { name: '调整', exact: true }).click()
      await page.locator('[data-adjust-toolbar]').waitFor({ timeout: 20000 })
      await page.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })

      const probe = '[data-testid="sidebar-new-session"]'
      assert.equal(await page.evaluate((sel) => window.__feedbackAdjust.select(sel), probe), true, '选不中新建会话按钮')
      const stageWidth = () =>
        page.evaluate(
          (sel) =>
            Math.round(
              document.querySelector(`[data-adjust-stage] ${sel}`).getBoundingClientRect().width,
            ),
          probe,
        )
      const dragE = async (dx) => {
        const handle = await page.locator('[data-adjust-handle="e"]').boundingBox()
        assert.ok(handle, '缺少 e 手柄')
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
        await page.mouse.down()
        await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2, { steps: 8 })
        await page.mouse.up()
        await page.waitForTimeout(220)
      }
      const before = await stageWidth()
      await dragE(20)
      await dragE(40)
      const after = await stageWidth()
      let changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      const resizes = changes.filter(
        (change) => change.kind === 'resize' && change.target.testId === 'sidebar-new-session',
      )
      assert.equal(resizes.length, 1, `同元素连续改尺寸没有合并：${resizes.length} 条`)
      assert.equal(resizes[0].before.width, before, `合并后改前值不是第一次拖动前：${resizes[0].before.width} / ${before}`)
      assert.equal(resizes[0].after.width, after, `合并后改后值不是最后一次：${resizes[0].after.width} / ${after}`)

      // 换一个元素再改：不会被合并进来。
      assert.equal(
        await page.evaluate(() => window.__feedbackAdjust.select('[aria-label^="收件箱"]')),
        true,
        '选不中收件箱按钮',
      )
      const handle2 = await page.locator('[data-adjust-handle="e"]').boundingBox()
      await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle2.x + handle2.width / 2 + 16, handle2.y + handle2.height / 2, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(220)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      assert.equal(
        changes.filter((change) => change.kind === 'resize').length,
        2,
        '不同元素的改尺寸被错误合并',
      )

      // 选择器：Radix/React 自动 id 不进选择器，生成的结构路径在副本里唯一命中。
      const auto = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        const el = [...stage.querySelectorAll('[id]')].find((node) =>
          /^(radix-|_r_|:r)/i.test(node.id),
        )
        if (!el) return null
        el.setAttribute('data-adjust-probe', 'auto-id')
        return { id: el.id, selected: window.__feedbackAdjust.select('[data-adjust-probe="auto-id"]') }
      })
      assert.ok(auto?.selected, '副本里没有可选的自动 id 元素')
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(120)
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(150)
      changes = await page.evaluate(() => window.__feedbackAdjust.changes())
      // 生成的选择器不包含自动 id，并能在副本里唯一解析。
      for (const change of changes) {
        assert.equal(
          /#radix-|#_r_[0-9a-z]+_|#:r[0-9a-z]+:/i.test(change.target.selector),
          false,
          `选择器里出现运行时自动 id：${change.target.selector}`,
        )
        assert.ok(change.target.selector, '改动目标缺少选择器')
      }
      const resolved = await page.evaluate(() => {
        const stage = document.querySelector('[data-adjust-stage]')
        return window.__feedbackAdjust.changes().map((change) => {
          try {
            return stage.querySelectorAll(change.target.selector).length
          } catch {
            return -1
          }
        })
      })
      assert.equal(resolved.some((count) => count < 0), false, '有选择器无法解析')
      assert.equal(resolved.some((count) => count === 0), false, '有选择器在副本里挂不上')
      const dir = '/tmp/fix-1603c'
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: `${dir}/adjust-merged-changes.png` })

      for (let i = 0; i < 5; i += 1) {
        if (!(await page.locator('html.feedback-mode').count())) break
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'), null, { timeout: 10000 })
    })

checks.push({
      name: '调整模式浮层互不遮挡：面板/预览/选中条/改动清单/提示（1440×900 与 390×844）',
      viewport: 'desktop',
      context: 'fb-adjust',
      fn: async (page) => {
        const state = await api(base, token, '/api/demo')
        if (!state.active) await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
        const chatId = (await api(base, token, '/api/demo')).scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
        const shotDir = '/tmp/fb-adjust-3'
        mkdirSync(shotDir, { recursive: true })

        const assertLayout = async (target, viewport, label) => {
          await openSession(target, chatId)
          await target.keyboard.press('Control+Shift+F')
          await target.waitForSelector('html.feedback-mode', { timeout: 8000 })
          await target.waitForTimeout(600)
          const feedbackBar = target.getByRole('region', { name: '反馈模式工具栏' })
          // 先制造一条提示条，进入调整后应被收起（toast 不再压住调整面板）。
          await feedbackBar.getByRole('button', { name: '导出', exact: true }).click()
          await target.locator('[data-toast-layer] [role="status"]').first().waitFor({ timeout: 5000 })
          await feedbackBar.getByRole('button', { name: '调整', exact: true }).click()
          await target.waitForFunction(() => window.__feedbackAdjust?.stats?.clonedNodes > 0, null, { timeout: 30000 })
          await target.waitForTimeout(300)

          const selected = await target.evaluate(() => {
            const stage = document.querySelector('[data-adjust-stage]')
            const el = [...stage.querySelectorAll('[data-testid], button')].find((node) => {
              const r = node.getBoundingClientRect()
              return r.width > 80 && r.height > 20 && r.top > 70 && r.bottom < innerHeight - 220
            })
            if (!el) return false
            el.setAttribute('data-adjust-probe', 'overlay')
            return window.__feedbackAdjust.select('[data-adjust-probe="overlay"]')
          })
          assert.equal(selected, true, `${label}：无法选中用于避让检查的元素`)
          await target.waitForTimeout(200)
          await target.keyboard.press('ArrowRight')
          await target.waitForTimeout(300)

          await target.locator('[data-adjust-toolbar]').getByRole('button', { name: '插入控件' }).click()
          await target.locator('[data-insert-option="button-primary"]').hover()
          await target.locator('[data-adjust-insert-preview="button-primary"]').waitFor({ timeout: 5000 })
          await target.waitForTimeout(700)

          const layout = await target.evaluate(() => {
            const read = (selector) => {
              const el = document.querySelector(selector)
              if (!el) return null
              const r = el.getBoundingClientRect()
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
            }
            return {
              toast: read('[data-toast-layer] [role="status"]'),
              toastLayer: document.querySelectorAll('[data-toast-layer]').length,
              panel: read('[data-adjust-insert-panel]'),
              preview: read('[data-adjust-insert-preview="button-primary"]'),
              bar: read('[data-adjust-selection-bar]'),
              changes: read('[data-adjust-changes]'),
              status: document.querySelector('[data-adjust-status]')?.textContent ?? '',
            }
          })
          // 调整期间不弹 toast：已有提示收起，新提示走工具条状态区。
          assert.equal(layout.toastLayer, 0, `${label}：调整期间仍有 toast 层`)
          assert.equal(layout.toast, null, `${label}：调整期间仍有 toast`)
          assert.ok(layout.status.trim().length > 0, `${label}：调整工具条状态区为空`)
          for (const key of ['panel', 'preview', 'bar', 'changes']) {
            const box = layout[key]
            assert.ok(box && box.width > 0 && box.height > 0, `${label}：缺少 ${key}`)
            assert.ok(
              box.left >= -0.5 &&
                box.top >= -0.5 &&
                box.right <= viewport.width + 0.5 &&
                box.bottom <= viewport.height + 0.5,
              `${label}：${key} 越出视口 ${JSON.stringify(box)}`,
            )
          }
          const pairs = [
            ['panel', 'preview'],
            ['panel', 'bar'],
            ['panel', 'changes'],
            ['preview', 'bar'],
            ['preview', 'changes'],
            ['bar', 'changes'],
          ]
          for (const [a, b] of pairs) {
            const one = layout[a]
            const two = layout[b]
            const overlap =
              one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom
            assert.equal(overlap, false, `${label}：${a} 与 ${b} 相交 ${JSON.stringify({ [a]: one, [b]: two })}`)
          }
          await target.screenshot({ path: path.join(shotDir, `regression-${label}.png`) })

          for (let i = 0; i < 5; i += 1) {
            if (!(await target.locator('html.feedback-mode').count())) break
            await target.keyboard.press('Escape')
            await target.waitForTimeout(150)
          }
          await target.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'), null, {
            timeout: 10000,
          })
        }

        await assertLayout(page, { width: 1440, height: 900 }, 'desktop')

        const mobileCtx = await browser.newContext({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        })
        await mobileCtx.addInitScript(() => {
          localStorage.setItem('tandem.theme.v1', 'dark')
        })
        const mobilePage = await newPage(mobileCtx, 'mobile')
        try {
          await assertLayout(mobilePage, { width: 390, height: 844 }, 'mobile')
          assert.equal(mobilePage.__errors.length, 0, `手机页面脚本错误：${mobilePage.__errors.join('；')}`)
        } finally {
          await mobilePage.close().catch(() => {})
          await mobileCtx.close().catch(() => {})
        }
      },
    })

desktop('反馈截图：长会话点选/框选/整页不卡且内容非空（R48）', async (page) => {
      await openSession(page, 'huge')
      // 滚到底部：截图应截当前可见的最后几轮，而不是会话开头。
      await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        if (el) el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(400)
      const perf = await page.evaluate(async () => {
        const api = window.__feedbackPerfCapture
        if (!api) return null
        const time = async (fn) => {
          const started = performance.now()
          const value = await fn()
          return { ms: Math.round(performance.now() - started), value }
        }
        const pageShot = await time(() => api.page())
        const element = await time(() => api.element('.chat-scroll'))
        const region = await time(() => api.region({ x: 700, y: 260, width: 700, height: 520, pageX: 700, pageY: 260 }))
        const records = api.records().slice(-3)
        const decode = (src) =>
          new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
            img.onerror = () => resolve(null)
            img.src = src
          })
        return {
          pageShot: { ...pageShot, size: await decode(pageShot.value?.dataURL ?? '') },
          element: { ...element, size: await decode(element.value ?? '') },
          region: { ...region, size: await decode(region.value ?? '') },
          records,
        }
      })
      assert.ok(perf, '缺少调试截图性能入口（__feedbackPerfCapture）')
      // 宽松阈值：只为防「整页 DOM 克隆」级退化，正常机器远低于此。
      assert.ok(perf.pageShot.ms < 2500, `整页截图过慢：${perf.pageShot.ms}ms`)
      assert.ok(perf.element.ms < 1500, `会话区元素截图过慢：${perf.element.ms}ms`)
      assert.ok(perf.region.ms < 1500, `区域截图过慢：${perf.region.ms}ms`)
      assert.ok(perf.pageShot.value?.dataURL?.length > 2000, '整页截图为空')
      assert.ok(perf.element.value?.length > 2000, '元素截图为空')
      assert.ok(perf.region.value?.length > 2000, '区域截图为空')
      assert.ok(perf.element.size?.width > 100 && perf.element.size?.height > 100, '元素截图尺寸异常')
      assert.ok(
        Math.abs((perf.region.size?.width ?? 0) - 700) <= 2 &&
          Math.abs((perf.region.size?.height ?? 0) - 520) <= 2,
        `区域截图尺寸不对：${perf.region.size?.width}×${perf.region.size?.height}`,
      )
      assert.ok(perf.pageShot.size?.width > 0 && perf.pageShot.size?.height > 0, '整页截图尺寸异常')
      const [pageRecord, elementRecord, regionRecord] = perf.records
      assert.equal(pageRecord?.kind, 'page', '整页截图缺少耗时记录')
      assert.ok((pageRecord?.pruned ?? 0) > 0, '长会话整页截图没有跳过视口外的行')
      assert.ok((elementRecord?.nodes ?? 9999) < 800, `会话区元素截图克隆了过多节点：${elementRecord?.nodes}`)
      assert.ok((regionRecord?.nodes ?? 9999) < 800, `区域截图克隆了过多节点：${regionRecord?.nodes}`)

      // 真实点击链路：点选会话区后输入浮窗要在可接受时间内可用。
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      const started = Date.now()
      await page.mouse.click(1276, 900)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      const clickMs = Date.now() - started
      assert.ok(clickMs < 1200, `点选到输入浮窗过慢：${clickMs}ms`)
      assert.ok((await editor.locator('img').count()) > 0, '输入浮窗缺少截图缩略图')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })
}
