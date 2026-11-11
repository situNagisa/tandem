#!/usr/bin/env node
/**
 * 发布版回归：release 构建的 Web 页面不提供任何调试入口。
 * 覆盖：Ctrl+Shift+F 无反应、#/dev/ui 回首页、设置与关于无演示/体验清单/反馈模式、
 * 命令面板搜不到、/api/demo 路由不存在、关于页显示发布版。
 *
 * 前置：node scripts/build-flavor.mjs release
 * 使用临时工作站（TANDEM_HOME=/tmp/...），不碰 ~/.tandem。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startWorkstation({ home }) {
  const configDir = path.join(home, '.tandem')
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      TANDEM_HOME: configDir,
      CODEX_HOME: path.join(home, '.codex'),
      TANDEM_DEBUG_ACCOUNT: '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工作站启动超时\n${stdout}\n${stderr}`)), 20_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-release-'))
  const host = startWorkstation({ home })
  let browser
  try {
    const port = await host.ready
    const base = `http://127.0.0.1:${port}`

    const demoRes = await fetch(`${base}/api/demo`)
    assert.ok([404, 401].includes(demoRes.status), '/api/demo 在发布版应不可用')
    const replayRes = await fetch(`${base}/api/demo/scenarios/subagents/replay`, { method: 'POST' })
    assert.ok([404, 401].includes(replayRes.status), '/api/demo/scenarios/* 在发布版应不可用')

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })

    // 登录门：发布版打开先看到登录/注册页，没有任何调试登录入口，也不会自动登录。
    await page.locator('[data-testid="login-gate"]').waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await page.locator('[data-testid="login-debug"]').count(), 0, '发布版登录页不应有调试登录入口')
    assert.equal(await page.locator('[data-testid="login-debug-button"]').count(), 0, '发布版登录页不应有调试账号按钮')
    // 本机回环地址：登录页会启动这台电脑的工作站，首次使用是「创建工作站」。
    const setupName = page.locator('[data-testid="login-workspace-name"]')
    await setupName.waitFor({ state: 'visible', timeout: 90_000 })
    await setupName.fill('发布版回归工作站')
    await page.locator('[data-testid="login-username"]').fill('release-admin')
    await page.locator('[data-testid="login-password"]').fill('release-pass-1')
    await page.locator('[data-testid="login-submit"]').click()

    // 登录后账号下没有主机：空状态引导添加主机，新会话入口禁用并说明原因。
    await page.locator('[data-testid="no-hosts"]').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await page.locator('[data-testid="sidebar-new-session"]').isDisabled(), true, '没有主机时新会话入口应禁用')
    await page.locator('[data-testid="no-hosts-add-local"]').click()
    await page.locator('[aria-label="消息输入框"]').first().waitFor({ state: 'visible', timeout: 60_000 })

    const bodyText = () => page.locator('body').innerText()
    const assertNoDebugText = async (where) => {
      const text = await bodyText()
      for (const word of ['演示工作区', '体验清单', '反馈模式', '组件画廊', '调试版', '手机预览']) {
        assert.ok(!text.includes(word), `${where} 不应出现「${word}」`)
      }
    }

    await assertNoDebugText('登录后的首页')
    // 提示条本身也带 data-feedback-ui；只认反馈抽屉/标注层。
    const feedbackUi = '[aria-label="反馈条目"], [aria-label="标注截图"]'
    assert.equal(await page.locator(feedbackUi).count(), 0, '发布版不应挂载反馈界面')

    // Ctrl+Shift+F 不再绑定任何命令
    await page.keyboard.press('Control+Shift+F')
    await sleep(500)
    assert.equal(await page.locator(feedbackUi).count(), 0, 'Ctrl+Shift+F 在发布版不应生效')

    // 组件画廊路由回首页
    await page.evaluate(() => {
      window.location.hash = '#/dev/ui'
    })
    await sleep(400)
    await assertNoDebugText('组件画廊路由')
    assert.equal(await page.locator('[aria-label="消息输入框"]').first().isVisible(), true, '#/dev/ui 应回到首页')

    // 设置 → 外观：没有组件画廊与反馈入口
    await page.keyboard.press('Control+Alt+S')
    await page.getByRole('button', { name: '外观', exact: true }).first().click({ timeout: 10_000 })
    await sleep(400)
    await assertNoDebugText('设置-外观')

    // 设置搜索与命令面板都搜不到调试入口
    const settingsSearch = page.getByPlaceholder(/搜索设置|搜索/).first()
    if (await settingsSearch.count()) {
      for (const word of ['演示', '体验清单', '反馈', '组件画廊']) {
        await settingsSearch.fill(word)
        await sleep(250)
        const text = await bodyText()
        for (const label of ['演示工作区', '体验清单', '反馈模式', '组件画廊']) {
          assert.ok(!text.includes(label), `设置搜索「${word}」不应出现「${label}」`)
        }
      }
      await settingsSearch.fill('')
    }

    // 关于页：显示发布版，且没有演示/体验清单按钮
    await page.getByRole('button', { name: /关于 Tandem/ }).first().click({ timeout: 10_000 })
    await sleep(300)
    const aboutText = await bodyText()
    assert.ok(aboutText.includes('发布版'), '关于页应显示发布版')
    for (const label of ['演示工作区', '体验清单', '反馈模式', '调试版']) {
      assert.ok(!aboutText.includes(label), `关于页不应出现「${label}」`)
    }
    await page.keyboard.press('Escape')
    await sleep(200)

    // 命令面板
    await page.keyboard.press('Control+K')
    await sleep(300)
    const commandInput = page.getByPlaceholder(/命令|搜索/).first()
    if (await commandInput.count()) {
      for (const word of ['演示', '体验清单', '反馈', '组件画廊', '手机预览']) {
        await commandInput.fill(word)
        await sleep(250)
        const text = await bodyText()
        for (const label of ['打开演示工作区', '打开体验清单', '进入反馈模式', '组件画廊', '打开手机预览']) {
          assert.ok(!text.includes(label), `命令面板「${word}」不应出现「${label}」`)
        }
      }
      await commandInput.fill('')
    }
    await page.keyboard.press('Escape')
    await sleep(200)

    // 手机预览查询参数在发布版不生效（不渲染模拟顶栏）。
    await page.goto(`${base}/?mobilePreview=1`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('[aria-label="消息输入框"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await page.locator('[data-mobile-preview-bar]').count(),
      0,
      '发布版不应渲染手机预览顶栏',
    )

    console.log('[release-flavor] 通过：发布版没有反馈、演示、体验清单、组件画廊与手机预览入口')
  } finally {
    if (browser) await browser.close().catch(() => {})
    host.child.kill()
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\n[release-flavor] 失败：${err.message}`)
  process.exit(1)
})
