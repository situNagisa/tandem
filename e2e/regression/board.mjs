#!/usr/bin/env node
/**
 * 任务看板。
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

export const feature = 'board'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [178, 179, 182, 183]

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

desktop('任务看板：侧栏入口、拖动放行、依赖等待、待评审打回与通过', async (page) => {
      const board = await boardCall('', {
        method: 'POST',
        body: { cwd: repo, name: '回归看板', maxParallel: 1, defaults: { profileId: 'p-main' } },
      })
      const mk = (body) => boardCall(`/${board.id}/cards`, { method: 'POST', body })
      const a = await mk({ title: '甲 准备数据', prompt: '回复“完成”即可', exec: { gate: true } })
      const b = await mk({ title: '乙 依赖甲', prompt: '回复“完成”即可', deps: [a.id] })
      const c = await mk({ title: '丙 独立任务', prompt: '回复“完成”即可' })

      // 侧栏入口进入；列表晚到时先是空态，随后自动跳到第一块看板
      await page.locator('aside').getByRole('button', { name: /^任务看板/ }).first().click()
      await page.getByTestId('board-columns').waitFor({ timeout: 15_000 })
      assert.match(page.url(), /#\/h\/[^/]+\/b\/[0-9a-f-]+$/, '进入看板后地址没有带看板 id')
      for (const label of ['待办', '排队', '运行中', '待审批', '待评审', '完成', '失败']) {
        assert.equal(await page.getByRole('region', { name: `${label}列`, exact: true }).count(), 1, `缺少「${label}」列`)
      }
      assert.equal(await boardColumn(page, 'todo').locator('[data-card-id]').count(), 3, '待办列应有 3 张卡')

      // 不允许的投放：待办 → 完成，卡片留在原列
      await boardCardIn(page, 'todo', '乙').dragTo(boardColumn(page, 'done'))
      await page.waitForTimeout(700)
      assert.equal(await boardCardIn(page, 'todo', '乙').count(), 1, '待办卡被拖进了完成列')
      assert.equal((await boardCall(`/${board.id}`)).cards.find((x) => x.id === b.id).status, 'todo')

      // 拖到「排队」= 放行；丙无依赖，直接跑完
      await boardCardIn(page, 'todo', '丙').dragTo(boardColumn(page, 'queued'))
      await page.locator(`[data-column="done"] [data-card-id="${c.id}"]`).waitFor({ timeout: 40_000 })

      // 点乙：详情抽屉里放行；依赖未完成，卡上写明在等谁
      await boardCardIn(page, 'todo', '乙').click()
      const drawer = page.getByTestId('board-drawer')
      await drawer.waitFor()
      assert.match((await drawer.textContent()) ?? '', /依赖.*甲 准备数据/)
      await drawer.getByRole('button', { name: '放行', exact: true }).click()
      await boardCardIn(page, 'queued', '乙').getByText('等待 甲 准备数据').waitFor({ timeout: 10_000 })

      // 放行甲：运行后停在待评审（审批门），乙继续等待
      await boardCardIn(page, 'todo', '甲').click()
      await drawer.getByRole('button', { name: '放行', exact: true }).click()
      await boardCardIn(page, 'review', '甲').waitFor({ timeout: 40_000 })
      assert.equal(await boardCardIn(page, 'queued', '乙').count(), 1, '审批门未放行时下游不应启动')
      await auditA11y(page, '任务看板（桌面）')

      // 打回并写意见：同一会话继续，再次进入待评审
      await boardCardIn(page, 'review', '甲').click()
      await drawer.getByRole('button', { name: '打回…', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '打回并写意见' })
      await dialog.waitFor()
      const note = '请补充边界情况的说明'
      await dialog.getByRole('textbox').fill(note)
      await dialog.getByRole('button', { name: '打回重做', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await waitUntil('打回后再次待评审', async () => {
        const card = (await boardCall(`/${board.id}`)).cards.find((x) => x.id === a.id)
        if (card.status !== 'review' || !card.sessionId) return false
        const session = await api(base, token, `/api/sessions/${card.sessionId}`)
        return JSON.stringify(session.messages ?? []).includes(note)
      })

      // 通过：甲完成，乙随即启动并跑完
      await boardCardIn(page, 'review', '甲').click()
      await drawer.getByRole('button', { name: '通过', exact: true }).click()
      await page.locator(`[data-column="done"] [data-card-id="${a.id}"]`).waitFor({ timeout: 10_000 })
      await page.locator(`[data-column="done"] [data-card-id="${b.id}"]`).waitFor({ timeout: 40_000 })
      assert.match((await page.getByTestId('board-progress').textContent()) ?? '', /3\/3 完成/)

      // 卡片会话不进侧栏，只能从卡详情进入
      assert.equal(await page.locator('[data-session-row]').filter({ hasText: '甲 准备数据' }).count(), 0, '卡片会话出现在侧栏')
      await page.locator(`[data-column="done"] [data-card-id="${a.id}"]`).click()
      await drawer.getByRole('button', { name: '打开会话', exact: true }).click()
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 10_000 })
      assert.match((await page.locator('header h1').first().textContent()) ?? '', /甲 准备数据/)
    })

mobile('手机任务看板：分组列表、待我处理行内通过与全屏详情', async (page) => {
      const board = await boardCall('', {
        method: 'POST',
        body: { cwd: repo, name: '手机看板', maxParallel: 2, defaults: { profileId: 'p-main' } },
      })
      const mk = (body) => boardCall(`/${board.id}/cards`, { method: 'POST', body })
      const gated = await mk({ title: '待评审卡', prompt: '回复“完成”即可', exec: { gate: true }, status: 'queued' })
      await mk({ title: '稍后再做', prompt: '回复“完成”即可' })
      await waitUntil('手机看板的卡进入待评审', async () => (await boardCall(`/${board.id}`)).cards.find((x) => x.id === gated.id).status === 'review')

      await openBoardPage(page, board.id)
      const list = page.getByTestId('board-list')
      await list.waitFor()
      const me = page.getByRole('region', { name: '需要我', exact: true })
      await me.getByText('待评审卡').waitFor()
      assertNoOverflow('手机看板', await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })))
      const approve = me.getByRole('button', { name: '通过', exact: true })
      const box = await approve.boundingBox()
      assert.ok(box && box.height >= 43.5, `手机上「通过」按钮高度不足 44px：${box?.height}`)

      // 点卡片：全屏详情
      await page.getByRole('region', { name: '待办', exact: true }).getByText('稍后再做').tap()
      const detail = page.getByRole('dialog', { name: '卡片详情' })
      await detail.waitFor()
      withinViewport(await detail.boundingBox(), MOBILE, '手机卡片详情')
      await detail.getByRole('button', { name: '放行', exact: true }).waitFor()
      await auditA11y(page, '任务看板（手机详情）')
      await page.keyboard.press('Escape')
      await detail.waitFor({ state: 'hidden' })

      // 行内通过：卡片移到「完成」
      await approve.tap()
      await page.getByRole('region', { name: '完成', exact: true }).getByText('待评审卡').waitFor({ timeout: 10_000 })
      assert.equal(await page.getByRole('region', { name: '需要我', exact: true }).count(), 0, '通过后「需要我」分组应消失')
    })

desktop('任务看板 v2：运行时提议、AI 评审修复、冲突解决、PR 聚合与分屏', async (page) => {
        const origin = path.join(home, 'board-origin.git')
        execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' })
        const gitRepo = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
        gitRepo('remote', 'add', 'origin', 'https://github.com/reg/board.git')
        gitRepo('config', `url.file://${origin}.insteadOf`, 'https://github.com/reg/board.git')
        gitRepo('push', '-q', 'origin', 'HEAD')

        const board = await boardCall('', {
          method: 'POST',
          body: {
            cwd: repo,
            name: 'v2 回归看板',
            maxParallel: 2,
            defaults: { profileId: 'p-main', permissionMode: 'bypassPermissions' },
          },
        })
        const bid = board.id
        const call = (p, init = {}) => boardCall(`/${bid}${p}`, init)
        const act = (cid, action, extra = {}) =>
          call(`/cards/${cid}/action`, { method: 'POST', body: { action, ...extra } })
        const cards = async () => (await call('')).cards
        const drawer = page.getByTestId('board-drawer')

        // AI 评审：blocker 停在待评审 → 抽屉里让卡片修复 → 仍然通过
        const reviewed = await call('/cards', {
          method: 'POST',
          body: {
            title: 'V2 评审卡',
            prompt: 'BOARD_WRITE src/hello.ts hello-2',
            exec: { aiReview: true, permissionMode: 'bypassPermissions' },
            status: 'queued',
          },
        })
        const reviewCard = await waitUntil('看板卡进入 AI 评审', async () => {
          const card = (await cards()).find((item) => item.id === reviewed.id)
          return card?.status === 'review' && card.review?.verdict === 'blocker' ? card : undefined
        })
        assert.equal(reviewCard.review.findings[0].file, 'src/hello.ts')
        assert.ok(reviewCard.review.findings[0].line >= 1)
        await openBoardPage(page, bid)
        await page.locator(`[data-column="review"] [data-card-id="${reviewed.id}"]`).click()
        await drawer.getByTestId('board-review').waitFor()
        assert.match(await drawer.getByTestId('board-review').innerText(), /阻塞/)
        await drawer.getByRole('button', { name: '让这张卡修复' }).click()
        await waitUntil('修复后再次待评审', async () => {
          const card = (await cards()).find((item) => item.id === reviewed.id)
          return card?.status === 'review' ? card : undefined
        })
        await drawer.getByRole('button', { name: '仍然通过' }).click({ timeout: 20_000 })
        await waitUntil('仍然通过后完成', async () => (await cards()).find((item) => item.id === reviewed.id)?.status === 'done')

        // 运行时提议：草稿在待办顶部，抽屉接受；看板设置自动接受
        const proposer = await call('/cards', {
          method: 'POST',
          body: {
            title: 'V2 提议源',
            prompt: 'BOARD_PROPOSE',
            exec: { permissionMode: 'bypassPermissions' },
            status: 'queued',
          },
        })
        await waitUntil('提议源完成并产生草稿', async () => {
          const list = await cards()
          return list.find((item) => item.id === proposer.id)?.status === 'done' &&
            list.filter((item) => item.proposedByCardId === proposer.id).length === 2
        })
        let list = await cards()
        const proposal = list.find((item) => item.proposedByCardId === proposer.id && item.title === '回归补测试')
        const proposalDoc = list.find((item) => item.proposedByCardId === proposer.id && item.title === '回归补文档')
        assert.equal(proposal.status, 'todo')
        assert.equal(proposal.proposedBy, 'V2 提议源')
        assert.deepEqual(proposalDoc.deps, [proposal.id])
        assert.ok(
          list.filter((item) => item.status === 'todo').sort((a, b) => a.order - b.order).slice(0, 2)
            .every((item) => item.proposedByCardId === proposer.id),
          '提议没有排在待办顶部',
        )
        await page.locator(`[data-column="todo"] [data-card-id="${proposal.id}"]`).click()
        assert.match(await drawer.innerText(), /由 V2 提议源 提议/)
        await drawer.getByRole('button', { name: '接受并排队' }).click()
        await waitUntil('提议接受后完成', async () => (await cards()).find((item) => item.id === proposal.id)?.status === 'done')

        await call('', { method: 'PUT', body: { autoAcceptProposals: 2 } })
        const proposer2 = await call('/cards', {
          method: 'POST',
          body: {
            title: 'V2 自动提议源',
            prompt: 'BOARD_PROPOSE',
            exec: { permissionMode: 'bypassPermissions' },
            status: 'queued',
          },
        })
        await waitUntil('自动接受提议', async () => {
          const items = (await cards()).filter((item) => item.proposedByCardId === proposer2.id)
          return items.length === 2 && items.every((item) => item.status !== 'todo') ? items : undefined
        })

        // 冲突：合并失败 → 抽屉列文件 → 让 agent 解决 → 再点合并
        const x = await call('/cards', {
          method: 'POST',
          body: {
            title: 'V2 冲突甲',
            prompt: 'BOARD_WRITE conflict.txt from-a',
            exec: { permissionMode: 'bypassPermissions' },
            status: 'queued',
          },
        })
        const y = await call('/cards', {
          method: 'POST',
          body: {
            title: 'V2 冲突乙',
            prompt: 'BOARD_WRITE conflict.txt from-b',
            exec: { permissionMode: 'bypassPermissions' },
            status: 'queued',
          },
        })
        await waitUntil('冲突卡完成', async () => {
          const items = await cards()
          return [x, y].every((item) => items.find((c) => c.id === item.id)?.status === 'done')
        })
        await act(x.id, 'merge')
        await page.locator(`[data-column="done"] [data-card-id="${y.id}"]`).click()
        await drawer.getByRole('button', { name: /合并到/ }).click()
        const mergeDialog = page.getByRole('dialog', { name: '合并这张卡' })
        await mergeDialog.waitFor()
        await mergeDialog.getByText(/conflict\.txt/).first().waitFor({ timeout: 10_000 })
        assert.match(await mergeDialog.innerText(), /conflict\.txt/, '合并确认框没有列出改动的文件')
        await mergeDialog.getByRole('button', { name: /合并到/ }).click()
        await drawer.getByTestId('board-conflicts').waitFor({ timeout: 20_000 })
        assert.match(await drawer.getByTestId('board-conflicts').innerText(), /conflict\.txt/)
        await drawer.getByRole('button', { name: '让 agent 解决冲突' }).click()
        await waitUntil('解决冲突后完成', async () => (await cards()).find((item) => item.id === y.id)?.status === 'done')
        await drawer.getByRole('button', { name: /合并到/ }).click()
        await mergeDialog.waitFor()
        await mergeDialog.getByRole('button', { name: /合并到/ }).click()
        await waitUntil('冲突卡再次合并成功', async () => (await cards()).find((item) => item.id === y.id)?.result?.mergedAt)

        // 分屏：看板作为窗格 + 卡片会话
        await page.locator(`[data-column="done"] [data-card-id="${reviewed.id}"]`).click()
        await drawer.getByRole('button', { name: '在分屏中打开' }).click()
        await page.waitForFunction(() => document.querySelectorAll('[data-split-pane]').length >= 2, null, { timeout: 15_000 })
        await page.locator('[data-split-pane*=":board:"]').waitFor({ timeout: 15_000 })
        assert.match(await page.evaluate(() => localStorage.getItem('tandem.split.v1') ?? ''), /board:/)

        // PR：开 PR 弹窗 → 集成分支 → 假 gh → 顶部 CI 状态
        await openBoardPage(page, bid)
        await page.getByRole('button', { name: '开 PR', exact: true }).click()
        const prDialog = page.getByRole('dialog', { name: '开 PR' })
        await prDialog.waitFor()
        await prDialog.getByTestId('board-pr-cards').waitFor()
        await prDialog.getByRole('button', { name: /创建 PR/ }).click()
        await prDialog.getByText(/PR 已创建在集成分支/).waitFor({ timeout: 60_000 })
        await prDialog.getByRole('button', { name: '完成', exact: true }).click()
        const prBoard = await call('')
        assert.ok(prBoard.pr?.url?.includes('/pull/9'))
        assert.ok(prBoard.pr.branch.startsWith('tandem/board-'))
        const ghState = JSON.parse(readFileSync(path.join(home, 'gh-state.json'), 'utf8'))
        assert.match(ghState.body, /V2 评审卡/)
        assert.match(ghState.body, /合计花费/)
        assert.ok(execFileSync('git', ['-C', origin, 'branch', '--list', 'tandem/board-*'], { stdio: 'pipe' }).toString().includes(prBoard.pr.branch))
        const refreshed = await waitUntil('看板 PR CI 回显', async () => {
          const res = await call('/pr')
          return res.pr?.checksState === 'success' ? res.pr : undefined
        })
        assert.equal(refreshed.state, 'OPEN')
        await page.getByTestId('board-pr-status').waitFor({ timeout: 15_000 })
        assert.match(await page.getByTestId('board-pr-status').innerText(), /CI 通过/)
      })

desktop('看板合并确认、完成态后续操作与手动压缩确认（R11/R12）', async (page) => {
      const board = await boardCall('', {
        method: 'POST',
        body: {
          cwd: repo,
          name: '确认回归看板',
          maxParallel: 1,
          defaults: { profileId: 'p-main', permissionMode: 'bypassPermissions' },
        },
      })
      const card = await boardCall(`/${board.id}/cards`, {
        method: 'POST',
        body: {
          title: '确认卡 改文件',
          prompt: 'BOARD_WRITE src/confirm.ts hello-check',
          exec: { permissionMode: 'bypassPermissions' },
          status: 'queued',
        },
      })
      await waitUntil('确认卡完成', async () => {
        const found = (await boardCall(`/${board.id}`)).cards.find((item) => item.id === card.id)
        return found?.status === 'done' && found.result?.branch ? found : undefined
      })

      // R13：看板卡片的回合结束也要进入收件箱聚合组，不能长期停在「回合进行中」。
      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      const inbox = page.getByRole('dialog', { name: '收件箱' })
      await inbox.waitFor({ state: 'visible', timeout: 10_000 })
      const cardGroup = inbox
        .getByTestId('inbox-history-group')
        .filter({ hasText: '确认卡 改文件' })
        .filter({ hasText: '回合完成' })
        .first()
      await cardGroup.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await inbox
          .getByTestId('inbox-history-group')
          .filter({ hasText: '确认卡 改文件' })
          .filter({ hasText: '回合进行中' })
          .count(),
        0,
        '看板完成卡仍显示回合进行中',
      )
      await cardGroup.getByTestId('aggregate-open').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, {
        timeout: 15_000,
      })

      await openBoardPage(page, board.id)
      const drawer = page.getByTestId('board-drawer')
      await page.locator(`[data-column="done"] [data-card-id="${card.id}"]`).click()
      await drawer.waitFor()

      // R12：完成态按映射表给出后续操作，而不是只剩删除
      await drawer.getByRole('button', { name: '打开会话', exact: true }).waitFor()
      await drawer.getByRole('button', { name: '查看改动', exact: true }).waitFor()
      await drawer.getByRole('button', { name: '查看测试/检查结果', exact: true }).waitFor()
      await drawer.getByRole('button', { name: '重新运行', exact: true }).waitFor()

      // 查看改动：列出卡片分支改过的文件与 diff
      await drawer.getByRole('button', { name: '查看改动', exact: true }).click()
      const diffDialog = page.getByRole('dialog', { name: /^改动：/ })
      await diffDialog.waitFor()
      await diffDialog.getByTestId('card-diff-file').filter({ hasText: 'src/confirm.ts' }).waitFor()
      await diffDialog.getByText(/hello-check/).first().waitFor({ timeout: 10_000 })
      assert.match(await diffDialog.innerText(), /hello-check/)
      await page.keyboard.press('Escape')
      await diffDialog.waitFor({ state: 'hidden' })

      // 单卡合并：先确认，列出目标分支与将改动的文件，默认焦点在取消
      await drawer.getByRole('button', { name: /合并到/ }).click()
      const mergeDialog = page.getByRole('dialog', { name: '合并这张卡' })
      await mergeDialog.waitFor()
      await mergeDialog.getByTestId('board-merge-cards').waitFor()
      const mergeText = await mergeDialog.innerText()
      assert.match(mergeText, /main/, '合并确认框没有写明目标分支')
      assert.match(mergeText, /src\/confirm\.ts/, '合并确认框没有列出将改动的文件')
      assert.match(mergeText, /\+\d/, '合并确认框没有列出 +/− 统计')
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        '取消',
        '合并确认默认焦点不在取消',
      )
      // 确认框里可点开完整 diff（复用 DiffView）
      await mergeDialog.getByRole('button', { name: '查看 diff' }).click()
      const nestedDiff = page.getByRole('dialog', { name: /^改动：/ })
      await nestedDiff.waitFor()
      await nestedDiff.getByTestId('card-diff-file').filter({ hasText: 'src/confirm.ts' }).waitFor()
      await nestedDiff.getByText(/hello-check/).first().waitFor({ timeout: 10_000 })
      await page.keyboard.press('Escape')
      await nestedDiff.waitFor({ state: 'hidden' })
      await mergeDialog.getByRole('button', { name: '取消' }).click()
      await mergeDialog.waitFor({ state: 'hidden' })
      assert.equal(
        (await boardCall(`/${board.id}`)).cards.find((item) => item.id === card.id)?.result?.mergedAt,
        undefined,
        '取消后卡片不应被合并',
      )

      // 合并全部：同样先出现确认并列出文件
      await page.getByTestId('board-merge-all').click()
      const mergeAllDialog = page.getByRole('dialog', { name: '合并全部已完成卡' })
      await mergeAllDialog.waitFor()
      await mergeAllDialog.getByTestId('board-merge-cards').waitFor()
      assert.match(await mergeAllDialog.innerText(), /src\/confirm\.ts/)
      await mergeAllDialog.getByRole('button', { name: '取消' }).click()
      await mergeAllDialog.waitFor({ state: 'hidden' })

      // 手动压缩：先确认，说明原文可查看与撤销
      await drawer.getByRole('button', { name: '打开会话', exact: true }).click()
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 15_000 })
      const meter = page
        .locator('button[aria-label^="上下文"], button[aria-label="暂无上下文数据"]')
        .first()
      await meter.waitFor({ timeout: 15_000 })
      await meter.click()
      await page.getByRole('button', { name: '压缩上下文（/compact）' }).click()
      const compactDialog = page.getByRole('dialog', { name: '压缩上下文' })
      await compactDialog.waitFor()
      const compactText = await compactDialog.innerText()
      assert.match(compactText, /摘要/, '压缩确认没有说明会压成摘要')
      assert.match(compactText, /原文/, '压缩确认没有说明原文可查看')
      assert.match(compactText, /撤销/, '压缩确认没有说明可撤销')
      await compactDialog.getByRole('button', { name: '取消' }).click()
      await compactDialog.waitFor({ state: 'hidden' })
      assert.equal(
        await page.locator('[data-compaction-notice]').count(),
        0,
        '取消后不应真的压缩',
      )

      // 真正压缩后：提示默认显示摘要前两行，可查看原文并撤销
      await meter.click()
      await page.getByRole('button', { name: '压缩上下文（/compact）' }).click()
      const compactDialog2 = page.getByRole('dialog', { name: '压缩上下文' })
      await compactDialog2.waitFor()
      await compactDialog2.getByRole('button', { name: '压缩上下文', exact: true }).click()
      const notice = page.locator('[data-compaction-notice]').first()
      await notice.waitFor({ timeout: 60_000 })
      const noticeText = (await notice.textContent()) ?? ''
      assert.ok(noticeText.includes('已压缩上下文'), `压缩后没有出现提示行：${JSON.stringify(noticeText)}`)
      await notice.getByTestId('compaction-original').click()
      const originalDialog = page.getByRole('dialog', { name: /压缩前的原文/ })
      await originalDialog.waitFor({ timeout: 15_000 })
      await originalDialog.getByTestId('compaction-original-list').waitFor()
      await page.keyboard.press('Escape')
      await originalDialog.waitFor({ state: 'hidden' })

      // 撤销：确认后恢复压缩前上下文，提示行消失
      await notice.getByTestId('compaction-undo').click()
      const undoDialog = page.getByRole('dialog', { name: '撤销压缩' })
      await undoDialog.waitFor()
      await undoDialog.getByRole('button', { name: '撤销压缩', exact: true }).click()
      await page.locator('[data-compaction-notice]').first().waitFor({ state: 'detached', timeout: 20_000 })
      assert.equal(await page.locator('[data-compaction-notice]').count(), 0, '撤销后压缩提示应消失')
    })
}
