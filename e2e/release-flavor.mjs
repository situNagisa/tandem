#!/usr/bin/env node
/**
 * 发布版回归：release 构建的 Web 页面不提供任何调试入口。
 * 覆盖：Ctrl+Shift+F 无反应、#/dev/ui 回首页、设置与关于无演示/体验清单/反馈模式、
 * 命令面板搜不到、/api/demo 路由不存在、关于页显示发布版。
 *
 * 前置：node scripts/build-flavor.mjs release
 * 使用临时 Host（TANDEM_HOME=/tmp/...），不碰 ~/.tandem。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startHost({ home, token, hostId }) {
  const configDir = path.join(home, '.tandem')
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      { hostId, token, idleTimeoutSec: 180, resumeOnRestart: 'auto', defaultDelegation: 'less' },
      null,
      2,
    ),
  )
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      TANDEM_HOME: configDir,
      TANDEM_FLAVOR: 'release',
      CODEX_HOME: path.join(home, '.codex'),
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
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${stdout}\n${stderr}`)), 20_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)\/\?token=/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Host 提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-release-'))
  const token = randomUUID()
  const hostId = randomUUID()
  const host = startHost({ home, token, hostId })
  let browser
  try {
    const port = await host.ready
    const base = `http://127.0.0.1:${port}`

    const demoRes = await fetch(`${base}/api/demo`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(demoRes.status, 404, '/api/demo 在发布版应返回 404')
    const replayRes = await fetch(`${base}/api/demo/scenarios/subagents/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(replayRes.status, 404, '/api/demo/scenarios/* 在发布版应返回 404')

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${base}/?token=${token}#/h/${hostId}`, { waitUntil: 'domcontentloaded' })
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 20_000 })

    const bodyText = () => page.locator('body').innerText()
    const assertNoDebugText = async (where) => {
      const text = await bodyText()
      for (const word of ['演示工作区', '体验清单', '反馈模式', '组件画廊', '调试版', '手机预览']) {
        assert.ok(!text.includes(word), `${where} 不应出现「${word}」`)
      }
    }

    await assertNoDebugText('首页')
    assert.equal(await page.locator('[data-feedback-ui]').count(), 0, '发布版不应挂载反馈界面')

    // Ctrl+Shift+F 不再绑定任何命令
    await page.keyboard.press('Control+Shift+F')
    await sleep(500)
    assert.equal(await page.locator('[data-feedback-ui]').count(), 0, 'Ctrl+Shift+F 在发布版不应生效')

    // 组件画廊路由回首页
    await page.evaluate(() => {
      window.location.hash = '#/dev/ui'
    })
    await sleep(400)
    await assertNoDebugText('组件画廊路由')
    assert.equal(await page.locator('textarea').first().isVisible(), true, '#/dev/ui 应回到首页')

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
    await page.goto(`${base}/?token=${token}&mobilePreview=1#/h/${hostId}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 20_000 })
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
