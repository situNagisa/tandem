#!/usr/bin/env node
/**
 * 输入框与环境条（token 估算、Markdown 预览、附件、菜单、文件夹）。
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

export const feature = 'composer'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 55, 68, 70, 71, 72, 73, 76, 77, 83, 105, 107]

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

desktop('输入框：token 估算、切换确认与分工取向合并（反馈8#01 #03 #05 #08 #09 #11 / 10#02 / 2009#01）', async (page) => {
      mkdirSync('/tmp/fb8-after', { recursive: true })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g2',
          model: 'o3',
          permissionMode: 'default',
          title: '输入框回归',
        }),
      })
      await gotoSession(page, session.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()

      // 1601#04：分工与取向并入模型菜单；原生开关在最上面，没有再「记住为会话偏好」，芯片只显示模型名。
      const routeChip = page.locator('button[aria-label^="选择模型："]').first()
      assert.doesNotMatch(
        (await routeChip.getAttribute('aria-label')) ?? '',
        /分工|取向/,
        '模型芯片上不应额外显示分工/取向',
      )
      const openModel = async () => {
        await routeChip.click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        return menu
      }
      const modelMenu = await openModel()
      const modelMenuText = await modelMenu.innerText()
      await page.screenshot({ path: '/tmp/fb8-after/03.png' })
      for (const label of ['原生', '分工', '取向']) {
        assert.ok(modelMenuText.includes(label), `模型菜单缺少「${label}」：${modelMenuText}`)
      }
      assert.ok(!modelMenuText.includes('记住为会话偏好'), '模型菜单不应再有「记住为会话偏好」')
      await modelMenu.getByRole('menuitem', { name: /^分工/ }).hover()
      const delegationMenu = page.locator('[role="menu"][aria-label="分工"]').first()
      await delegationMenu.waitFor({ state: 'visible', timeout: 5_000 })
      const delegationText = await delegationMenu.innerText()
      for (const label of ['关闭', '适度', '积极']) {
        assert.ok(delegationText.includes(label), `分工缺少「${label}」：${delegationText}`)
      }
      await page.screenshot({ path: '/tmp/fb8-after/09.png' })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      const biasRoute = await openModel()
      await biasRoute.getByRole('menuitem', { name: /^取向/ }).hover()
      const biasMenu = page.locator('[role="menu"][aria-label="取向"]').first()
      await biasMenu.waitFor({ state: 'visible', timeout: 5_000 })
      const biasText = await biasMenu.innerText()
      for (const label of ['省钱', '均衡', '质量优先']) {
        assert.ok(biasText.includes(label), `取向缺少「${label}」：${biasText}`)
      }
      await page.screenshot({ path: '/tmp/fb8-after/01.png' })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // #05：输入时显示估算 token；发送后（已有上下文）显示预计占用百分比。
      await input.fill('请检查一下输入框的 token 估算')
      const tokenChip = page.locator('[data-composer-tokens]').first()
      await tokenChip.waitFor()
      assert.match(await tokenChip.innerText(), /~[\d.]+k? tok/, '输入框没有估算 token')
      const before = (await api(base, token, `/api/sessions/${session.id}`)).messages.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await api(base, token, `/api/sessions/${session.id}`)
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      await input.fill('继续')
      await page.waitForFunction(
        () => (document.querySelector('[data-composer-tokens]')?.textContent ?? '').includes('发送后'),
        null,
        { timeout: 10_000 },
      )
      const tokenText = await tokenChip.innerText()
      assert.match(tokenText, /发送后 ~\d+%|发送后 ~<1%/, `发送后上下文百分比缺失：${tokenText}`)
      await page.screenshot({ path: '/tmp/fb8-after/05.png' })

      // 反馈10#02：模型菜单不显示常驻缓存提示；真正切换模型/账号/分组时弹确认框；取消不改变当前模型。
      await api(base, token, `/api/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ effort: 'low' }),
      })
      const switchToMock2 = async () => {
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        await menu.getByRole('menuitem', { name: /切换账号|切换分组|全部模型/ }).first().hover()
        const accounts = page.locator('[role="menu"][aria-label="切换账号"]').first()
        await accounts.waitFor({ timeout: 5_000 })
        await accounts.getByRole('menuitem', { name: /主力账号/ }).first().hover()
        const groups = page.locator('[role="menu"][aria-label="主力账号"]').first()
        await groups.waitFor({ timeout: 5_000 })
        await groups.getByRole('menuitem', { name: /生产/ }).first().hover()
        const models = page.locator('[role="menu"][aria-label*="生产"]').first()
        await models.waitFor({ timeout: 5_000 })
        await models.getByRole('menuitem', { name: 'mock-2' }).first().click()
      }
      await switchToMock2()
      const switchDialog = page.getByRole('dialog').filter({ hasText: '切换后提示缓存将失效' })
      await switchDialog.waitFor({ timeout: 5_000 })
      const switchText = await switchDialog.innerText()
      const beforeModel = (await api(base, token, `/api/sessions/${session.id}`)).model
      assert.match(switchText, /下一轮按完整上下文计费/, `切换确认缺少计费说明：${switchText}`)
      assert.match(switchText, /约 ~[\d.]+k? tok/, `切换确认缺少 token 估算：${switchText}`)
      assert.doesNotMatch(switchText, /不再提示/, '切换确认仍有「不再提示」')
      await page.screenshot({ path: '/tmp/fb10-after/02.png' })
      await switchDialog.getByRole('button', { name: '取消' }).click()
      await page.waitForTimeout(200)
      await waitModelReady(page)
      assert.equal(
        (await api(base, token, `/api/sessions/${session.id}`)).model,
        beforeModel,
        '取消切换后模型被改掉',
      )
      await switchToMock2()
      await switchDialog.waitFor({ timeout: 5_000 })
      await switchDialog.getByRole('button', { name: '切换' }).click()
      await page.waitForTimeout(500)
      assert.match(
        await page.locator('button[aria-label^="选择模型"]').first().getAttribute('aria-label'),
        /Mock 2|mock-2/i,
        '确认后没有切换模型',
      )
      // 回到支持思考档位的 o3，继续验证芯片的小点与 tooltip。
      await api(base, token, `/api/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: 'o3', groupId: 'g2', effort: 'low' }),
      })
      await page.waitForTimeout(400)

      // #11：模型芯片只显示模型名，思考强度只在 tooltip / aria-label。
      await waitModelReady(page)
      const chip = page.locator('button[aria-label^="选择模型"]').first()
      const chipText = await chip.innerText()
      assert.ok(!/(极低|最高|关闭)/.test(chipText) && !/\s(低|中|高)$/.test(chipText), `模型芯片仍显示思考强度：${chipText}`)
      assert.match((await chip.getAttribute('aria-label')) ?? '', /思考强度：低/, '模型芯片 aria-label 缺少思考强度')
      await chip.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /思考强度 低/, '模型芯片 tooltip 缺少思考强度档位')
      await page.screenshot({ path: '/tmp/fb8-after/11-chip.png' })
    })

desktop('输入框 Markdown 实时预览：光标外隐藏标记、代码块整块渲染、Enter 续号与原始内容发送（反馈8#02 / 1323#05）', async (page) => {
      mkdirSync('/tmp/md-cm', { recursive: true })
      const mdSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: 'Markdown 回归',
        }),
      })
      await gotoSession(page, mdSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()
      const value = () => input.getAttribute('data-value')
      const lineTexts = () =>
        input.evaluate((root) => [...root.querySelectorAll('.cm-line')].map((line) => line.textContent ?? ''))
      const sessionOf = () => api(base, token, `/api/sessions/${mdSession.id}`)
      const messageCount = async () => (await sessionOf()).messages.length

      // 代码围栏：开围栏行回车自动补闭合围栏，光标停在中间。
      const beforeCode = await messageCount()
      await input.fill('```ts')
      await input.press('Enter')
      assert.equal(await value(), '```ts\n\n```\n', '代码围栏没有自动成对')
      await input.type('const a = 1')
      await input.press('Tab')
      assert.match(await value(), /const a = 1 {2}\n```/, '代码块内 Tab 没有缩进两格')
      await input.press('Enter')
      assert.equal(await messageCount(), beforeCode, '代码块内回车触发了发送')
      // 光标在块内：源码态代码块仍是等宽字体与浅色底。
      const codeStyle = await input.evaluate((root) => {
        const line = root.querySelector('.md-code-line')
        if (!line) return null
        const style = getComputedStyle(line)
        return {
          mono: /mono/i.test(style.fontFamily) || style.fontFamily.includes('Consolas'),
          background: style.backgroundColor,
        }
      })
      assert.ok(codeStyle, '光标在块内时没有源码态代码块')
      assert.ok(codeStyle.mono, `代码块不是等宽字体：${codeStyle && codeStyle.background}`)
      assert.notEqual(codeStyle.background, 'rgba(0, 0, 0, 0)', '代码块没有浅色底')
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const session = await sessionOf()
        if (session.status === 'idle' && session.messages.length > beforeCode) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('```ts') && text.includes('const a = 1')),
        '发送内容没有保留原始代码块',
      )

      // 行内 Markdown：粗体、斜体、行内代码同步呈现，源码不变。
      await input.fill('**粗体** *斜体* `code`')
      const inline = await input.evaluate((root) => ({
        strong: root.querySelector('.md-strong')?.textContent ?? '',
        em: root.querySelector('.md-em')?.textContent ?? '',
        code: root.querySelector('.md-inline-code')?.textContent ?? '',
        strongWeight: (() => {
          const el = root.querySelector('.md-strong')
          return el ? getComputedStyle(el).fontWeight : ''
        })(),
        emStyle: (() => {
          const el = root.querySelector('.md-em')
          return el ? getComputedStyle(el).fontStyle : ''
        })(),
        codeMono: (() => {
          const el = root.querySelector('.md-inline-code')
          return el ? getComputedStyle(el).fontFamily : ''
        })(),
      }))
      assert.equal(inline.strong, '粗体', '粗体没有就地渲染')
      assert.equal(inline.em, '斜体', '斜体没有就地渲染')
      assert.equal(inline.code, 'code', '行内代码没有就地渲染')
      assert.ok(Number(inline.strongWeight) >= 600, '粗体字重没有生效')
      assert.equal(inline.emStyle, 'italic', '斜体没有生效')
      assert.match(inline.codeMono, /mono|Consolas/i, '行内代码不是等宽字体')
      assert.equal(await value(), '**粗体** *斜体* `code`', '渲染改变了原始 Markdown')

      // 有序列表自动续号、空列表项回车结束列表；回车不发送。
      const beforeList = await messageCount()
      await input.fill('1. 第一项')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. ', '有序列表没有续号')
      await input.type('第二项')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. 第二项\n3. ', '有序列表第二次没有续号')
      assert.equal(await messageCount(), beforeList, '列表回车触发了发送')
      const listStyle = await input.evaluate((root) => {
        const lines = [...root.querySelectorAll('.md-list-line')]
        return {
          count: lines.length,
          padding: lines[0] ? parseFloat(getComputedStyle(lines[0]).paddingLeft) : 0,
          marks: root.querySelectorAll('.md-bullet, .md-list-mark').length,
        }
      })
      assert.ok(listStyle.count >= 2, '列表项没有独立行样式')
      assert.ok(listStyle.marks >= 2, '列表序号没有样式')
      assert.ok(listStyle.padding > 0, '列表项没有缩进')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. 第二项\n', '空列表项回车没有结束列表')
      assert.equal(await messageCount(), beforeList, '结束列表时触发了发送')
      const seenBeforeOrdered = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > beforeList) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts
          .slice(seenBeforeOrdered)
          .some((text) => text.includes('1. 第一项') && text.includes('2. 第二项')),
        '有序列表没有按原文发送',
      )

      // 无序列表自动续项；非光标行显示为圆点。
      const beforeUnordered = await messageCount()
      await input.fill('- 项目一')
      await input.press('Enter')
      assert.equal(await value(), '- 项目一\n- ', '无序列表没有续项')
      await input.type('项目二')
      await input.press('Enter')
      assert.equal(await value(), '- 项目一\n- 项目二\n- ', '无序列表第二次没有续项')
      assert.ok((await input.locator('.md-bullet').count()) >= 1, '非光标行的无序列表没有显示圆点')
      const seenBeforeUnordered = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > beforeUnordered) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts
          .slice(seenBeforeUnordered)
          .some((text) => text.includes('- 项目一') && text.includes('- 项目二')),
        '无序列表没有按原文发送',
      )

      // 标题 / 分割线：非光标行不显示源码标记。
      await input.fill('# 标题\n\n---\n\n正文')
      assert.ok((await input.locator('.md-heading').count()) >= 1, '标题没有进入样式层')
      assert.equal(await value(), '# 标题\n\n---\n\n正文', '标题行改变了原文')

      // 实时预览：光标不在的行隐藏 ** 与 #，移入后显示源码。
      await input.fill('# 标题\n\n正文 **粗体**')
      let texts = await lineTexts()
      assert.ok(!texts[0].includes('#'), `非光标行仍显示标题标记：${texts[0]}`)
      assert.ok(texts[0].includes('标题'), `标题内容没有渲染：${texts[0]}`)
      // 光标所在行显示源码（粗体标记可见）。
      assert.ok(texts[texts.length - 1].includes('**'), '光标所在行没有显示源码')
      await input.press('ArrowUp')
      await input.press('ArrowUp')
      await input.press('Home')
      texts = await lineTexts()
      assert.ok(texts[0].includes('#'), `光标移入标题行后没有显示源码：${texts[0]}`)
      assert.ok(!texts[texts.length - 1].includes('**'), '移出后正文仍显示粗体标记')
      assert.ok(texts[texts.length - 1].includes('粗体'), '移出后粗体内容没有渲染')
      await input.press('Control+End')
      texts = await lineTexts()
      assert.ok(!texts[0].includes('#'), '光标移出后标题仍显示标记')

      // 代码块整块渲染：光标在块外时为消息区样式的卡片，没有头部工具条；点击回到源码。
      await input.fill('正文\n\n```ts\nconst a = 1\n```\n\n尾部')
      assert.equal(await input.locator('.md-code-widget').count(), 1, '光标在块外时代码块没有整块渲染')
      assert.equal(await page.locator('.composer-editor .chat-code-tools').count(), 0, '输入框代码块出现了头部工具条')
      const widgetStyle = await input.evaluate((root) => {
        const card = root.querySelector('.md-code-widget')
        const pre = card?.querySelector('pre')
        if (!card || !pre) return null
        return {
          text: pre.textContent ?? '',
          mono: /mono/i.test(getComputedStyle(pre).fontFamily),
          background: getComputedStyle(card).backgroundColor,
        }
      })
      assert.ok(widgetStyle, '找不到代码块卡片')
      assert.equal(widgetStyle.text, 'const a = 1', '代码块卡片内容不对')
      assert.ok(widgetStyle.mono, '代码块卡片不是等宽字体')
      assert.notEqual(widgetStyle.background, 'rgba(0, 0, 0, 0)', '代码块卡片没有底色')
      await input.locator('.md-code-widget').click()
      assert.equal(await input.locator('.md-code-widget').count(), 0, '点击代码块后没有回到源码')
      assert.ok((await input.locator('.md-code-line').count()) >= 3, '光标进入代码块后没有显示源码')
      await input.press('Control+End')

      // 输入法组合期间 Enter 不发送。
      const beforeIme = await messageCount()
      await input.fill('你好')
      await input.evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
      await input.press('Enter')
      await sleep(120)
      assert.equal(await messageCount(), beforeIme, '输入法组合期间回车触发了发送')
      await input.evaluate((el) =>
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' })),
      )
      await sleep(120)
      assert.equal(await messageCount(), beforeIme, '输入法结束后误发送了消息')

      // 深/浅主题截图：标题/列表渲染、代码块卡片与光标行源码。
      await input.fill('# 标题\n\n- 列表项\n\n```ts\nconst x = 1\n```\n\n正文 **粗体**')
      await page.screenshot({ path: '/tmp/md-cm/composer-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/composer-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await input.fill('')
    })

desktop('用户气泡完整渲染 Markdown：标题降级、列表、代码块与源码编辑（Markdown 实时预览）', async (page) => {
      mkdirSync('/tmp/md-cm', { recursive: true })
      const bubbleSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '用户气泡 Markdown',
        }),
      })
      await gotoSession(page, bubbleSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()
      // 会话切换后草稿恢复会覆盖输入，等输入框稳定再写入。
      await page.waitForTimeout(400)
      const source = '## 小标题\n\n- 列表项\n\n```ts\nconst a = 1\n```\n\n**粗体**'
      for (let attempt = 0; attempt < 3; attempt++) {
        await input.fill(source)
        try {
          await page.waitForFunction(
            (want) =>
              document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-value') === want,
            source,
            { timeout: 1200 },
          )
          break
        } catch {
          await page.waitForTimeout(300)
        }
      }
      assert.equal(await input.getAttribute('data-value'), source, '输入框没有接受 Markdown 文本')
      const sessionOf = () => api(base, token, `/api/sessions/${bubbleSession.id}`)
      const before = (await sessionOf()).messages.length
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('## 小标题') && text.includes('```ts')),
        '用户消息没有按 Markdown 源码发送',
      )
      const bubble = page.locator('[data-msg-bubble]').last()
      await bubble.locator('h2').waitFor({ timeout: 10_000 })
      const rendered = await bubble.evaluate((el) => ({
        text: el.innerText,
        h2: el.querySelector('h2')?.textContent ?? '',
        h2Weight: (() => {
          const h2 = el.querySelector('h2')
          return h2 ? getComputedStyle(h2).fontWeight : ''
        })(),
        li: el.querySelector('li')?.textContent ?? '',
        code: el.querySelector('.chat-code pre')?.textContent ?? '',
        strong: el.querySelector('strong')?.textContent ?? '',
        inlineMarkers: el.innerText.includes('**') || el.innerText.includes('##') || el.innerText.includes('```'),
      }))
      assert.equal(rendered.h2, '小标题', '用户气泡标题没有渲染')
      assert.ok(Number(rendered.h2Weight) >= 600, '用户气泡标题没有加粗')
      assert.equal(rendered.li, '列表项', '用户气泡列表没有渲染')
      assert.equal(rendered.code, 'const a = 1', '用户气泡代码块没有渲染')
      assert.equal(rendered.strong, '粗体', '用户气泡粗体没有渲染')
      assert.ok(!rendered.inlineMarkers, `用户气泡仍显示 Markdown 标记：${rendered.text}`)
      // 复制消息仍复制源码；编辑时回到源码。
      const row = page.locator('.msg-row[data-turn-id]').filter({ has: bubble }).first()
      await row.hover()
      await row.getByRole('button', { name: '编辑并重发' }).click()
      const editor = page.locator('textarea[aria-label="编辑并重发"]')
      await editor.waitFor({ timeout: 5_000 })
      assert.equal(await editor.inputValue(), source, '编辑用户消息时没有回到 Markdown 源码')
      await page.getByRole('button', { name: '取消', exact: true }).last().click()
      await page.screenshot({ path: '/tmp/md-cm/user-bubble-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/user-bubble-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))

      // 助手正文对照：同一套 Markdown 排版。
      await openSession(page, 'codeblock')
      await page.waitForTimeout(400)
      await page.screenshot({ path: '/tmp/md-cm/assistant-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/assistant-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    })

desktop('输入框 @ 选文件与文件夹：文件夹可进入、路径标记只显示名字、发送仍是完整路径（反馈2102#07）', async (page) => {
      mkdirSync('/tmp/fix-1323b', { recursive: true })
      const atSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '@ 补全回归',
        }),
      })
      await gotoSession(page, atSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      const value = () => input.getAttribute('data-value')
      const waitCaret = (pos) =>
        page.waitForFunction(
          (want) =>
            Number(
              document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-caret'),
            ) === want,
          pos,
          { timeout: 5_000 },
        )
      const menu = page.locator('.completion-panel').first()
      const sessionOf = () => api(base, token, `/api/sessions/${atSession.id}`)
      const messageCount = async () => (await sessionOf()).messages.length

      // 列表里同时有文件夹与文件；文件夹带图标。
      await input.fill('@sr')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('src/', { exact: false }).first().waitFor({ timeout: 5_000 })
      assert.ok((await menu.locator('.lucide-folder').count()) >= 1, '@ 列表里文件夹没有图标')
      assert.ok((await menu.innerText()).includes('hello.ts'), '@ 列表里没有文件')

      // 进入文件夹继续浏览，不关闭补全。
      await input.press('ArrowRight')
      assert.equal(await value(), '@src/', '进入文件夹后查询没有变成目录前缀')
      await menu.getByText('hello.ts', { exact: false }).first().waitFor({ timeout: 5_000 })
      assert.ok((await menu.innerText()).includes('src/'), '进入文件夹后没有列出目录内容')
      await input.press('Escape')

      // 直接选中文件夹：输入框只显示文件夹名，悬停给完整路径。
      await input.fill('@sr')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('src/', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(5)
      assert.equal(await value(), 'src/ ', '选中文件夹后原文不是完整路径')
      const folderToken = input.locator('.ce-path').first()
      assert.equal((await folderToken.innerText()).trim(), 'src/', '文件夹标记没有只显示名字')
      assert.equal(await folderToken.getAttribute('title'), 'src/', '文件夹标记悬停没有完整路径')

      // 选中文件：标记只显示文件名，发送内容包含完整相对路径。
      await input.fill('@hello')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('hello.ts', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(13)
      assert.equal(await value(), 'src/hello.ts ', '选中文件后原文不是完整路径')
      const fileToken = input.locator('.ce-path').first()
      assert.equal((await fileToken.innerText()).trim(), 'hello.ts', '文件标记没有只显示文件名')
      assert.equal(await fileToken.getAttribute('title'), 'src/hello.ts', '文件标记悬停没有完整路径')
      // 退格整块删除：先删尾随空格，标记仍是整块，再退格才移除。
      const waitValue = (expected) =>
        page.waitForFunction(
          (want) =>
            document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-value') ===
            want,
          expected,
          { timeout: 5_000 },
        )
      await input.press('Backspace')
      await waitValue('src/hello.ts')
      assert.equal(await input.locator('.ce-path').count(), 1, '删掉尾随空格后标记被拆成纯文本')
      await input.press('Backspace')
      await waitValue('')
      assert.equal((await value()).trim(), '', '退格没有整块删除路径标记')
      assert.equal(await input.locator('.ce-path').count(), 0, '路径标记没有被移除')
      // 清掉残留的空白，再重新选文件（fill 直接覆盖带标记的 DOM 不可靠）。
      await page.keyboard.press('Control+a')
      await input.press('Backspace')
      await waitValue('')
      assert.equal(await value(), '', '全选删除后输入框没有清空')
      await input.fill('@hello')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('hello.ts', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(13)
      await page.screenshot({ path: '/tmp/fix-1323b/2102-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/fix-1323b/2102-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))

      const before = await messageCount()
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('src/hello.ts')),
        '发送内容没有包含完整路径',
      )
      await input.fill('')
    })

desktop('模型菜单顶部显示最近使用模型（跨账号分组）并可直接选中（#7-04）', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => {
        localStorage.setItem(
          'tandem.recentModels.v1',
          JSON.stringify([
            { profileId: 'p-main', groupId: 'g1', model: 'mock-2', count: 9, lastUsedAt: Date.now() },
            { profileId: 'p-main', groupId: 'g2', model: 'o3', count: 5, lastUsedAt: Date.now() - 1000 },
            { profileId: 'p-main', groupId: 'g1', model: 'mock-1', count: 2, lastUsedAt: Date.now() - 2000 },
          ]),
        )
      })
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const labels = await menu.getByRole('menuitem').allInnerTexts()
      const topIndex = labels.findIndex((text) => /mock[\s-]?2/i.test(text))
      const o3Index = labels.findIndex((text) => /O3/i.test(text))
      const mockIndex = labels.findIndex((text) => /mock[\s-]?1/i.test(text))
      assert.ok(topIndex >= 0, '最近使用列表缺少常用模型 mock-2')
      assert.ok(o3Index >= 0, '最近使用列表缺少跨分组模型 O3')
      assert.ok(mockIndex >= 0, '最近使用列表缺少 mock-1')
      assert.ok(topIndex < o3Index && o3Index < mockIndex, `最近使用没有按次数排序：${labels.join(' | ')}`)
      assert.match(labels[topIndex], /生产/, '最近使用模型没有标注分组')
      assert.match(labels[o3Index], /备用/, '最近使用模型没有标注分组')
      const response = page.waitForResponse(
        (res) => res.url().includes('/api/sessions/long') && res.request().method() === 'PATCH',
        { timeout: 10_000 },
      )
      await menu.getByRole('menuitem').filter({ hasText: /mock[\s-]?2/i }).first().click()
      await response
      const stored = await api(base, token, '/api/sessions/long')
      assert.equal(stored.model, 'mock-2', '最近使用模型没有生效')
      assert.equal(stored.groupId, 'g1', '最近使用模型没有切换分组')
    })

desktop('环境条容器透明、触发器可见且不越界', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => b.getAttribute('data-tip') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        const bar = document.querySelector('[data-env-bar]')
        if (!wrap || !bar) return null
        const bg = getComputedStyle(wrap).backgroundColor
        // 反馈1323#06：行内除触发器自身外不应有任何底色；直接子项的底色都必须透明。
        const stray = [...wrap.children]
          .map((child) => ({
            tag: child.tagName,
            text: (child.textContent ?? '').trim().slice(0, 12),
            bg: getComputedStyle(child).backgroundColor,
          }))
          .filter((child) => !/rgba?\(0, 0, 0, 0\)|transparent/.test(child.bg))
        const buttons = [...wrap.querySelectorAll(':scope button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { text: b.textContent.trim(), x: r.x, right: r.right, height: r.height, font: getComputedStyle(b).fontSize }
        })
        return {
          bg,
          barBg: getComputedStyle(bar).backgroundColor,
          parentBg: getComputedStyle(bar.parentElement).backgroundColor,
          stray,
          width: wrap.getBoundingClientRect().width,
          buttons,
        }
      }, repo)
      assert.ok(info, '找不到环境条容器')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条容器不透明：${info.bg}`)
      assert.match(info.barBg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条根节点不透明：${info.barBg}`)
      assert.match(info.parentBg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条外层不透明：${info.parentBg}`)
      assert.equal(
        info.stray.length,
        0,
        `环境条行内仍有背景：${info.stray.map((item) => `${item.text || item.tag}=${item.bg}`).join(' | ')}`,
      )
      assert.ok(info.buttons.length >= 3, `环境条只有 ${info.buttons.length} 个触发器`)
      for (const button of info.buttons) {
        assert.ok(button.right <= DESKTOP.width + 1, `环境条「${button.text}」右缘越界 ${button.right}`)
        assert.ok(button.height >= 20, `环境条「${button.text}」高度异常 ${button.height}`)
        assert.ok(parseFloat(button.font) >= 12.5, `环境条「${button.text}」字号 ${button.font}`)
      }
    })

desktop('环境条文件夹弹层向上弹出且完整可见', async (page) => {
      await openSession(page, 'long')
      const trigger = page.locator(`button[data-tip="${repo}"]`).first()
      await trigger.click()
      const panel = page.locator('[role="menu"]:has(> .popover-panel)').first()
      await panel.waitFor()
      assert.equal(await panel.getAttribute('data-side'), 'top', '文件夹弹层没有向上弹出')
      withinViewport(await panel.boundingBox(), DESKTOP, '文件夹弹层')
      const openFolder = panel.getByRole('menuitem', { name: '打开文件夹…' })
      assert.equal(await openFolder.count(), 1, '文件夹弹层缺少「打开文件夹…」')
      await openFolder.click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      withinViewport(await dialog.boundingBox(), DESKTOP, '文件夹浏览对话框')
      assert.equal(
        await dialog.locator('[aria-label="使用此目录"]').count(),
        1,
        '文件夹浏览对话框内容未加载',
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' }).catch(() => {})
    })

desktop('环境条文件夹弹层只列最近文件夹与「打开文件夹…」（反馈1323#09）', async (page) => {
      await openSession(page, 'long')
      const hostKey = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? 'local',
      )
      await page.evaluate(
        ({ hostKey, dirs }) => localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [hostKey]: dirs })),
        { hostKey, dirs: [repo, path.dirname(repo)] },
      )
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const panel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await panel.waitFor({ state: 'visible' })
      const items = (await panel.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.ok(items[0].includes(path.basename(repo)), `最近文件夹没有排在最前：${items.join(' | ')}`)
      assert.ok(!items.includes('..'), `文件夹弹层不应再直接列目录：${items.join(' | ')}`)
      assert.equal(items[items.length - 1], '打开文件夹…', `文件夹弹层底部不是「打开文件夹…」：${items.join(' | ')}`)
      assert.equal(
        await panel.locator('input[aria-label="筛选文件夹或输入路径"]').count(),
        0,
        '文件夹弹层里不应常驻目录浏览器',
      )
      // 无最近记录时只显示「打开文件夹…」。
      await page.evaluate((key) => localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [key]: [] })), hostKey)
      await page.keyboard.press('Escape')
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const emptyPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await emptyPanel.waitFor({ state: 'visible' })
      const emptyItems = (await emptyPanel.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.deepEqual(emptyItems, ['打开文件夹…'], `无最近记录时弹层应只有「打开文件夹…」：${emptyItems.join(' | ')}`)
      await page.keyboard.press('Escape')
    })

desktop('非 Git 仓库时不显示 Worktree 开关（反馈1323#07）', async (page) => {
      await withNonGitSession(page, async () => {
        const bar = page.locator('[data-env-bar]').first()
        assert.equal(await bar.getByText('Worktree', { exact: true }).count(), 0, '非 Git 时仍显示 Worktree')
        assert.equal(await bar.getByRole('switch', { name: 'Worktree' }).count(), 0, '非 Git 时仍有 Worktree 开关')
        assert.equal(
          await bar.locator('button[aria-haspopup="menu"]').count(),
          2,
          '非 Git 时环境条应只剩主机与文件夹',
        )
      })
      // git 仓库保持原样。
      await openSession(page, 'long')
      const gitBar = page.locator('[data-env-bar]').first()
      assert.equal(await gitBar.getByRole('switch', { name: 'Worktree' }).count(), 1, 'git 仓库缺少 Worktree 开关')
    })

desktop('非 Git 仓库时不显示分支触发器（反馈1323#08）', async (page) => {
      await withNonGitSession(page, async () => {
        const bar = page.locator('[data-env-bar]').first()
        assert.equal(await bar.getByText('非 Git 仓库', { exact: true }).count(), 0, '非 Git 时仍显示「非 Git 仓库」')
        assert.equal(await bar.locator('svg.lucide-git-branch').count(), 0, '非 Git 时仍有分支触发器')
      })
      // git 仓库保持原样：分支触发器在。
      await openSession(page, 'long')
      const gitBar = page.locator('[data-env-bar]').first()
      assert.equal(await gitBar.getByText('main', { exact: true }).count() >= 1, true, 'git 仓库缺少分支名')
    })

fb2102('反馈2102#06：新会话发送后直接进入会话并显示用户消息，发送请求未返回前不停留在空的新会话页', async (page) => {
      // 放慢创建会话请求，使「请求未返回」的时间窗口足够长，便于逐帧观察。
      await page.route('**/api/sessions', async (route) => {
        if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 900))
        await route.continue()
      })
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('FB2102_NEW 发送即进入会话')
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        return button && !button.disabled
      })
      await page.evaluate(() => {
        window.__fb06 = { sent: false, frames: [], on: true }
        const greeting = () => [...document.querySelectorAll('h1')].some((h) => h.textContent.includes('今天想做点什么'))
        const message = () => (document.querySelector('.chat-scroll')?.textContent ?? '').includes('FB2102_NEW')
        const sample = () => {
          const state = window.__fb06
          if (!state.on) return
          if (state.sent) state.frames.push({ greeting: greeting(), message: message(), at: performance.now() })
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        // 只统计点击发送之后的帧（捕获阶段，早于 React 处理点击）。
        window.addEventListener(
          'click',
          (event) => {
            if (event.target instanceof Element && event.target.closest('button[aria-label="发送消息"]')) {
              window.__fb06.sent = true
            }
          },
          { capture: true },
        )
      })
      await page.locator('button[aria-label="发送消息"]').click()
      await page.waitForTimeout(300)
      // 创建请求仍在途（已放慢）：此时应已显示占位会话与用户消息。
      await page.screenshot({ path: '/tmp/fix-2102a/after-06.png' })
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 10_000 })
      await page.waitForTimeout(300)
      const result = await page.evaluate(() => {
        window.__fb06.on = false
        return window.__fb06.frames
      })
      await page.unroute('**/api/sessions')
      const stuck = result.filter((frame) => frame.greeting && !frame.message)
      assert.ok(result.length > 0, '没有采样到发送后的帧')
      assert.equal(
        stuck.length,
        0,
        `发送后有 ${stuck.length} 帧仍停在空的新会话页，用户消息尚未显示`,
      )
      assert.ok(
        result.some((frame) => frame.message),
        '发送后用户消息始终没有显示在会话里',
      )
    })

desktop('文件夹弹层列出最近目录；浏览对话框首项为上一级，超长名称单行省略（R15 / 反馈1323#09）', async (page) => {
      const longName = 'a-very-long-folder-name-for-truncation-check-0123456789'
      const longDir = path.join(repo, longName)
      mkdirSync(longDir, { recursive: true })
      try {
        await openSession(page, 'long')
        await page.evaluate((dir) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          const hostId = hosts[0]?.id ?? 'local'
          localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [hostId]: [dir] }))
        }, longDir)
        const trigger = page.locator(`button[data-tip="${repo}"]`).first()
        await trigger.click()
        const panel = page
          .locator('[data-portal-layer]')
          .filter({ has: page.locator('[data-folder-picker]') })
          .first()
        await panel.waitFor()
        assert.equal(
          await panel.getByText(longName, { exact: false }).count(),
          1,
          '文件夹弹层没有列出最近目录',
        )
        // 反馈1601#01：分组标题/分隔线/行都走 ui/Menu 原语，与其他下拉同一边距，
        // 不再出现手写 border-t 分隔造成的「内部边更厚」。
        assert.equal(await panel.getAttribute('data-portal-layer'), 'menu', '文件夹弹层没有改用 ui/Menu')
        const chrome = await panel.evaluate((el) => {
          const body = el.querySelector('[data-menu-body]')
          const rows = [...el.querySelectorAll('[role="menuitem"]')]
          const label = [...el.querySelectorAll('[role="menu"] div, [role="menu"] > div')].find((n) =>
            (n.textContent ?? '').trim() === '最近',
          )
          return {
            padding: body ? getComputedStyle(body.parentElement).paddingTop : '',
            borderTop: el.querySelectorAll('.border-t').length,
            rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
            labelSize: label ? getComputedStyle(label).fontSize : '',
          }
        })
        assert.equal(chrome.borderTop, 0, '文件夹弹层里仍有手写 border-t 分隔线')
        assert.equal(chrome.padding, '4px', `文件夹弹层内边距不是菜单统一值：${chrome.padding}`)
        assert.equal(chrome.labelSize, '12px', `分组标题字号不是菜单统一值：${chrome.labelSize}`)
        assert.ok(
          chrome.rowHeights.every((height) => height === 26),
          `文件夹弹层的行高不是菜单统一值：${chrome.rowHeights.join('/')}`,
        )
        await panel.getByRole('menuitem', { name: '打开文件夹…' }).click()
        const dialog = page.getByRole('dialog', { name: '打开文件夹' })
        await dialog.waitFor()
        const firstItem = dialog.getByRole('menuitem').first()
        assert.equal((await firstItem.innerText()).trim(), '..', '浏览对话框首项不是上一级目录')
        // 反馈 #7-06：行保持单行省略，只有溢出时才挂全文 title。
        const longRow = dialog.getByRole('menuitem').filter({ hasText: longName.slice(0, 20) }).first()
        await longRow.waitFor({ timeout: 10_000 })
        const label = longRow.locator('span.truncate').first()
        const info = await label.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          title: el.getAttribute('data-tip') ?? el.getAttribute('title'),
          whiteSpace: getComputedStyle(el).whiteSpace,
        }))
        assert.ok(info.scrollWidth > info.clientWidth, '超长文件夹名没有被单行截断')
        assert.equal(info.title, longName, `超长文件夹名缺少全名入口：${info.title}`)
        assert.notEqual(info.whiteSpace, 'normal', '文件夹行发生了换行')
        await page.keyboard.press('Escape')
      } finally {
        rmSync(longDir, { recursive: true, force: true })
      }
    })

desktop('菜单项只有单行标题，多模型分组下列表可滚动且底部操作可见（#15/#16/#17 R01/R15）', async (page) => {
      await openSession(page, 'many')
      await waitModelReady(page)
      // 主菜单优先显示最近模型；清掉记录让当前分组的全部模型回退显示（滚动与长标签用例）。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), DESKTOP, '多模型菜单')
      const model = await menu.evaluate((el) => {
        const footer = el.querySelector('[data-menu-footer]')
        const body = el.querySelector('[data-menu-body]')
        const rows = [...el.querySelectorAll('[role="menuitem"]')]
        const stacked = rows.some((row) =>
          [...row.querySelectorAll('span')].some((span) => {
            const cs = getComputedStyle(span)
            return cs.display === 'flex' && cs.flexDirection === 'column' && cs.display !== 'none'
          }),
        )
        return {
          footerText: footer?.textContent ?? '',
          footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
          bodyScroll: body?.scrollHeight ?? 0,
          bodyClient: body?.clientHeight ?? 0,
          heights: rows.map((row) => row.getBoundingClientRect().height),
          stacked,
        }
      })
      assert.ok(model.heights.every((height) => height <= 32), `菜单项高度 ${model.heights.join(',')}，出现第二行`)
      assert.equal(model.stacked, false, '菜单项里仍有纵向堆叠的说明文字')
      assert.match(model.footerText, /切换账号/, '底部操作缺少「切换账号」')
      assert.match(model.footerText, /管理账号/, '底部操作缺少「管理账号」')
      assert.ok(model.footerBottom <= DESKTOP.height, `底部操作被挤出视口：${model.footerBottom}`)
      assert.ok(model.bodyScroll > model.bodyClient, `模型列表没有独立滚动：${model.bodyScroll}/${model.bodyClient}`)
      // 超长模型名放进 tooltip：宽度按内容自适应、不会每行一个字。
      const longRow = menu.locator('[role="menuitem"]').filter({ hasText: /Many Extra Long/ }).first()
      await longRow.scrollIntoViewIfNeeded()
      await longRow.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ state: 'visible', timeout: 5_000 })
      const tipInfo = await tip.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        return { width: rect.width, text: el.textContent ?? '' }
      })
      assert.ok(tipInfo.width >= 72, `长标签 tooltip 宽度只有 ${tipInfo.width}px`)
      assert.match(tipInfo.text, /many-extra-long-model-name/, 'tooltip 没有显示完整模型 ID')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)

      for (const group of ['分工', '取向']) {
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const routeMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await routeMenu.waitFor()
        assert.match(
          (await routeMenu.locator('[data-menu-footer]').innerText()),
          /原生[\s\S]*分工[\s\S]*取向/,
          '模型菜单底部缺少原生/分工/取向',
        )
        await routeMenu.getByRole('menuitem', { name: new RegExp(`^${group}`) }).hover()
        const sub = page.locator(`[role="menu"][aria-label="${group}"]`).first()
        await sub.waitFor({ state: 'visible', timeout: 5_000 })
        const info = await sub.evaluate((el) => {
          const rows = [...el.querySelectorAll('[role="menuitemradio"]')]
          return {
            heights: rows.map((row) => row.getBoundingClientRect().height),
            stacked: rows.some((row) =>
              [...row.querySelectorAll('span')].some((span) => {
                const cs = getComputedStyle(span)
                return cs.display === 'flex' && cs.flexDirection === 'column' && cs.display !== 'none'
              }),
            ),
          }
        })
        assert.ok(info.heights.every((height) => height <= 32), `${group}菜单项高度 ${info.heights.join(',')}`)
        assert.equal(info.stacked, false, `${group}菜单仍有第二行说明`)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      await page.keyboard.press('Escape')
    })

desktop('环境条下拉连续切换保持打开（#04 P0）', async (page) => {
      await openSession(page, 'long')
      const host = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      const folder = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      const branch = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-git-branch') }).first()
      const branchPanel = page.locator('[data-portal-layer]').filter({ hasText: '新建分支' }).first()
      const folderPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()

      await branch.click()
      await branchPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await folder.click()
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(
        await folderPanel.isVisible(),
        true,
        '从一个下拉直接切到另一个下拉后，新下拉被旧下拉的关闭事件收起',
      )
      assert.equal(await branchPanel.isVisible().catch(() => false), false, '旧的落点下拉没有关闭')

      await host.click()
      const hostMenu = page.locator('[role="menu"][aria-label="切换主机"]').first()
      await hostMenu.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(await hostMenu.isVisible(), true, '切到主机下拉后弹层又被收起')
      assert.equal(await folderPanel.isVisible().catch(() => false), false, '旧的文件夹下拉没有关闭')

      await branch.click()
      await branchPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(await branchPanel.isVisible(), true, '连续切换三个下拉后分支列表没有保持打开')
      await page.keyboard.press('Escape')
    })

desktop('环境条「选择主机」可打开（#11 P0）', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      const host = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      await host.click()
      const menu = page.locator('[role="menu"][aria-label="选择主机"]').first()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(300)
      withinViewport(await menu.boundingBox(), DESKTOP, '选择主机菜单')
      assert.ok((await menu.locator('[role="menuitem"]').count()) >= 1, '选择主机菜单内容异常')
      await page.keyboard.press('Escape')
    })

desktop('环境条换主机先选文件夹：待定状态、输入禁用、可取消（反馈13#02）', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        if (hosts.some((item) => item.id === 'host-second')) return
        const first = hosts[0]
        localStorage.setItem(
          'tandem.hosts.v1',
          JSON.stringify([first, { ...first, id: 'host-second', name: '第二台主机', addedAt: Date.now() + 1 }]),
        )
      })
      const hostsNow = await page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]'))
      if (hostsNow.length < 2) {
        throw new Error('没有造出第二台主机')
      }
      // 注入 localStorage 后必须重载，应用启动时才会把第二台主机连进 runtime。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => {
        try {
          return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length >= 2
        } catch {
          return false
        }
      }, null, { timeout: 20_000 })
      await openSession(page, 'long')
      const hostPill = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      const folderPill = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      const textarea = page.locator('[aria-label="消息输入框"]').first()
      const folderPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()

      await hostPill.click()
      const menu = page.locator('[role="menu"][aria-label="切换主机"]').first()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      // 反馈14#04：当前主机行尾标「当前」，不要箭头。
      assert.match(
        await menu.locator('[data-host-tag="current"]').innerText(),
        /当前/,
        '当前主机没有「当前」标签',
      )
      await menu.getByRole('menuitem', { name: /第二台主机/ }).click()
      // 不立即切换：文件夹选择自动打开，输入框禁用并提示。
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(300)
      assert.equal(await textarea.getAttribute('aria-disabled'), 'true', '待选文件夹期间输入框没有禁用')
      assert.equal(
        await page.locator('.composer-card').first().getAttribute('data-disabled'),
        'true',
        '待选期间输入框外观没有变暗',
      )
      assert.equal(
        await textarea.getAttribute('data-placeholder'),
        '选择 第二台主机 上的文件夹后继续',
        '输入框占位提示文案不对',
      )
      assert.equal(
        (await hostPill.innerText()).trim(),
        '第二台主机',
        '主机胶囊应只显示目标主机，不要「原主机 → 目标主机」',
      )
      assert.match((await folderPill.innerText()).trim(), /^待选$/, '文件夹胶囊没有精简为「待选」')
      // 打开主机菜单确认当前/待切换两个标签。
      await page.keyboard.press('Escape')
      await hostPill.click()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(
        await menu.locator('[data-host-tag="current"]').innerText(),
        /当前/,
        '待切换时当前主机没有「当前」标签',
      )
      assert.match(
        await menu.locator('[data-host-tag="pending"]').innerText(),
        /待切换/,
        '目标主机没有「待切换」标签',
      )
      await page.keyboard.press('Escape')
      // 取消回到原主机。
      await page.locator('[data-env-pending-cancel="true"]').click()
      await page.waitForTimeout(300)
      assert.equal(await textarea.getAttribute('aria-disabled'), null, '取消后输入框仍然禁用')
      assert.doesNotMatch(await hostPill.innerText(), /第二台主机/, '取消后主机胶囊仍显示新主机')

      // 再选一次，选好文件夹才真正迁移。
      await hostPill.click()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: /第二台主机/ }).click()
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await folderPanel.getByRole('menuitem', { name: '打开文件夹…' }).click()
      const folderDialog = page.getByRole('dialog', { name: '打开文件夹' })
      await folderDialog.waitFor()
      await folderDialog.getByRole('button', { name: '使用并迁移' }).click()
      await page.getByText(/会话已迁移到 第二台主机/).first().waitFor({ timeout: 20_000 })
      await page.waitForFunction(() => window.location.hash.includes('/h/host-second/'), null, { timeout: 20_000 })
      await page.locator('[aria-label="消息输入框"]').first().waitFor({ timeout: 20_000 })
      assert.equal(
        (await page.locator('[aria-label="消息输入框"]').first().getAttribute('aria-disabled')) === 'true',
        false,
        '迁移完成后输入框仍禁用',
      )
      // 还原宿主列表，避免影响后续用例的分组断言。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.id !== 'host-second')))
      })
    })

desktop('焦点环只在键盘导航时出现（自动聚焦的输入框没有橙色描边）', async (page) => {
      await openSession(page, 'long')
      const trigger = page.locator(`button[data-tip="${repo}"]`).first()
      await trigger.click()
      const panel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await panel.waitFor()
      await panel.getByRole('menuitem', { name: '打开文件夹…' }).click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      const input = dialog.locator('input[aria-label="筛选文件夹或输入路径"]')
      await input.waitFor()
      assert.equal(
        await input.evaluate((el) => el === document.activeElement),
        true,
        '文件夹路径输入框没有自动聚焦',
      )
      const pickerRing = await input.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { style: cs.outlineStyle, color: cs.outlineColor }
      })
      assert.equal(
        pickerRing.style,
        'none',
        `鼠标打开文件夹选择器后仍有焦点描边：${JSON.stringify(pickerRing)}`,
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' }).catch(() => {})

      // 命令面板同样由鼠标点开、程序化聚焦：不应出现橙色框。
      await page.locator('aside').getByRole('button', { name: /^搜索/ }).first().click()
      const paletteInput = page.locator('input[aria-label="搜索会话、命令与设置"]')
      await paletteInput.waitFor()
      const paletteRing = await paletteInput.evaluate((el) => getComputedStyle(el).outlineStyle)
      assert.equal(paletteRing, 'none', '命令面板搜索框出现了焦点描边')
      await page.keyboard.press('Escape')

      // 键盘 Tab 导航时焦点环必须仍然可见，且是中性色而不是强调橙。
      await page.locator('aside').getByRole('button', { name: '设置', exact: true }).focus()
      await page.keyboard.press('Tab')
      const keyboardRing = await page.evaluate(() => {
        const el = document.activeElement
        if (!el) return null
        const cs = getComputedStyle(el)
        return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, tag: el.tagName }
      })
      assert.ok(keyboardRing, '没有可聚焦元素')
      assert.equal(keyboardRing.style, 'solid', `键盘焦点环未显示：${JSON.stringify(keyboardRing)}`)
      assert.equal(keyboardRing.width, '2px', `键盘焦点环宽度异常：${JSON.stringify(keyboardRing)}`)
      const rgb = keyboardRing.color.match(/(\d+),\s*(\d+),\s*(\d+)/)
      assert.ok(rgb, `无法解析焦点环颜色：${keyboardRing.color}`)
      const [r, g, b] = rgb.slice(1, 4).map(Number)
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 30, `焦点环不是中性色：${keyboardRing.color}`)
    })

desktop('粘贴一次同一张图片只生成一个附件', async (page) => {
      await openSession(page, 'long')
      const textarea = page.locator('[aria-label="消息输入框"]')
      await textarea.evaluate((el) => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1])
        const data = new DataTransfer()
        for (let i = 0; i < 2; i++) data.items.add(new File([bytes], 'same.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await page.waitForTimeout(900)
      assert.equal(await page.getByRole('button', { name: '移除图片' }).count(), 1, '同一张图片被重复添加')
    })

desktop('新会话页环境条显示当前分支名而不是「分支」占位词', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      await page.locator('button:has(svg.lucide-folder-open)').first().click()
      await page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
        .getByRole('menuitem', { name: '打开文件夹…' })
        .click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      const input = dialog.getByRole('textbox', { name: '筛选文件夹或输入路径' })
      await input.waitFor()
      await input.fill(repo)
      await input.press('Enter')
      const branchButton = page.locator('button[data-tip="创建会话后可切换分支"]').first()
      await branchButton.waitFor()
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('button[data-tip="创建会话后可切换分支"]')].some(
            (b) => (b.textContent ?? '').trim() === 'main',
          ),
        null,
        { timeout: 10_000 },
      )
      const label = ((await branchButton.textContent()) ?? '').trim()
      assert.equal(label, 'main', `环境条分支显示为「${label}」`)
    })

desktop('反馈2102#05：新会话页选的账号/模型按主机记住，开会话后与刷新后仍保留，已不存在的模型回落默认', async (page) => {
      const chipLabel = () =>
        page.evaluate(() => document.querySelector('button[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? '')
      const expectChip = async (pattern, message) => {
        const ok = await page
          .waitForFunction(
            (source) => new RegExp(source, 'i').test(document.querySelector('button[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? ''),
            pattern,
            { timeout: 5_000 },
          )
          .then(() => true, () => false)
        assert.ok(ok, `${message}（当前芯片：${await chipLabel()}）`)
      }
      const theme = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      await page.evaluate(() => localStorage.removeItem('tandem.newSessionPick.v1'))
      try {
        await page.evaluate(() => (window.location.hash = '#/'))
        await waitModelReady(page)
        const defaultLabel = await chipLabel()
        await page.locator('button[aria-label^="选择模型"]').first().click()
        await page.getByRole('menuitem', { name: /^切换账号/ }).hover()
        await page.getByRole('menuitem', { name: /^主力账号/ }).first().hover()
        await page.getByRole('menuitem', { name: /^生产/ }).first().hover()
        await page.getByRole('menuitem', { name: /^mock-2/ }).first().click()
        await expectChip('mock[ -]2', '选择模型后芯片没有更新')
        await page.locator('[aria-label="消息输入框"]').fill('反馈2102#05 模型记忆回归')
        await page.waitForFunction(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送消息')
          return !!b && !b.disabled
        })
        await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/sessions')),
          page.getByRole('button', { name: '发送消息' }).click(),
        ])
        await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 15_000 })
        await page.evaluate(() => (window.location.hash = '#/'))
        await waitModelReady(page)

        await withViewport(page, async () => {
          for (const next of ['dark', 'light']) {
            await setTheme(page, next)
            await waitModelReady(page)
            await page.screenshot({ path: path.join(shotDir, `05-新会话芯片-${next}.png`) })
          }
        })
        await expectChip('mock[ -]2', '开会话后回到新会话页，模型没有记住')

        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        await expectChip('mock[ -]2', '刷新后新会话页的模型没有记住')

        const hostId = await clientHostIdOf(page)
        await page.evaluate(
          (id) =>
            localStorage.setItem(
              'tandem.newSessionPick.v1',
              JSON.stringify({ [id]: { profileId: 'p-main', groupId: 'g1', model: '已删除的模型' } }),
            ),
          hostId,
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        await page.waitForTimeout(300)
        assert.equal(await chipLabel(), defaultLabel, '记住的模型已不存在时没有回落到默认模型')
        assert.equal(await page.getByText('先选择账号与模型').count(), 0, '回落默认时不应报错')
      } finally {
        await page.evaluate((prev) => {
          if (prev) localStorage.setItem('tandem.theme.v1', prev)
          else localStorage.removeItem('tandem.theme.v1')
          localStorage.removeItem('tandem.newSessionPick.v1')
        }, theme)
      }
    })

desktop('反馈2102#08：环境条主机触发器用显示器图标，与文件夹触发器区分开', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      await withViewport(page, async () => {
        for (const next of ['dark', 'light']) {
          await setTheme(page, next)
          await page.locator('[data-env-bar] button').first().waitFor({ timeout: 10_000 })
          await page.screenshot({ path: path.join(shotDir, `08-环境条-${next}.png`) })
        }
      })
      const hostTrigger = page.locator('[data-env-bar] button').first()
      assert.equal(await hostTrigger.locator('svg.lucide-monitor').count(), 1, '主机触发器不是显示器图标')
      assert.equal(await hostTrigger.locator('svg.lucide-folder, svg.lucide-folder-open').count(), 0, '主机触发器仍是文件夹图标')
      assert.equal(await page.locator('[data-env-bar] button:has(svg.lucide-folder-open)').count(), 1, '文件夹触发器缺少文件夹图标')
    })
}
