#!/usr/bin/env node
/**
 * 端到端冒烟：临时工作站 + 假 OpenAI 兼容端点 + Playwright。
 * 覆盖：调试账号自动登录 → 本机主机自动加入 → 新建会话 → 流式回复 → Bash 工具审批 → 设置全部页签无 console error。
 * 不读真实 Key、不碰 ~/.tandem：HOME 与 TANDEM_HOME 都指向 /tmp 临时目录。
 *
 * 前置：npm run build（check.mjs 会先构建）。
 * 用法：npm run smoke
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const SETTINGS_PAGES = [
  'general', 'hosts', 'profiles', 'routing', 'usage-budgets', 'permissions', 'secrets',
  'agent', 'schedules', 'memory', 'team-shares', 'appearance', 'notifications', 'voice',
  'browser', 'extensions', 'evals', 'gateway', 'sync',
]
const ADVANCED_PAGES = new Set(['extensions', 'evals', 'gateway', 'sync'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** 假 OpenAI 兼容端点：首次请求流式返回 Bash 工具调用，工具结果回来后返回最终文本。 */
function createMockProvider() {
  const seen = []
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'smoke-model', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad json' } }))
      return
    }
    seen.push(body)

    // 自动标题等非流式小请求
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-title',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '冒烟会话' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      )
      return
    }

    const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const chunk = (delta, finish = null) =>
      send({
        id: 'chatcmpl-smoke',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })

    if (!hasToolResult) {
      chunk({ role: 'assistant', content: '我先检查一下。' })
      await sleep(40)
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_smoke',
            type: 'function',
            function: {
              name: 'Bash',
              arguments: JSON.stringify({ command: 'echo smoke-ok', description: '冒烟测试命令' }),
            },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: '工具执行完成，' })
      await sleep(40)
      chunk({ content: '冒烟通过。' })
      chunk({}, 'stop')
    }
    send({
      id: 'chatcmpl-smoke',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return { server, seen }
}

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

async function api(base, token, pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-smoke-'))
  const { server: mockServer, seen } = createMockProvider()
  const mockPort = await listen(mockServer)
  const host = startWorkstation({ home })
  let browser
  let page

  try {
    const hostPort = await host.ready
    const base = `http://127.0.0.1:${hostPort}`
    // 调试版：免密登录调试账号，本机主机在启动时已自动加入。
    const login = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' }).then((res) => res.json())
    // 调试账号自带的演示模型账号会让新会话默认选它；冒烟只用自己的假 provider。
    for (const item of (await api(base, login.accessToken, '/api/workstation/profiles')).profiles) {
      if (item.kind === 'demo') {
        await api(base, login.accessToken, `/api/workstation/profiles/${item.id}`, { method: 'DELETE' })
      }
    }

    const profile = await api(base, login.accessToken, '/api/workstation/profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: '冒烟账号',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'smoke-key',
        models: ['smoke-model'],
        defaultModel: 'smoke-model',
      }),
    })

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const loc = message.location()
        consoleErrors.push(`${message.text()} @ ${loc.url}`)
      }
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    const composer = page.locator('[aria-label="消息输入框"]').first()
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    // 等 profiles 通过 WS 到达，新会话页自动选中第一个账号/模型（模型按钮出现内容）
    await page.getByRole('button', { name: /Smoke Model/ }).first().waitFor({ timeout: 15_000 }).catch(() => {})

    await composer.fill('冒烟测试：请执行一条命令')
    const send = page.getByRole('button', { name: '发送消息' })
    await send.waitFor({ state: 'visible', timeout: 10_000 })
    await send.click()

    await page.getByText('我先检查一下。').waitFor({ state: 'visible', timeout: 20_000 })
    // 审批是对话流里的一条消息（反馈14#07）：等「允许一次」按钮出现后点它。
    await page.locator('[data-permission-allow]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('[data-permission-allow]').first().click()

    await page.getByText('工具执行完成，冒烟通过。').waitFor({ state: 'visible', timeout: 30_000 })

    // 设置全部页签：只切换，不点危险操作
    await page.getByRole('button', { name: '设置', exact: true }).last().click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible', timeout: 10_000 })
    for (const id of SETTINGS_PAGES) {
      if (ADVANCED_PAGES.has(id)) {
        const group = settings.locator('[data-settings-group="advanced"] > button').first()
        if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
      }
      await settings.locator(`[data-settings-page="${id}"]`).click()
      await sleep(180)
      const subtabs = settings.locator(`[data-settings-subtabs] button`)
      for (let i = 0; i < (await subtabs.count()); i++) {
        await subtabs.nth(i).click()
        await sleep(120)
      }
    }

    if (consoleErrors.length > 0) {
      throw new Error(`控制台出现 ${consoleErrors.length} 条错误：\n${consoleErrors.join('\n')}`)
    }
    if (seen.length < 2) throw new Error(`假 provider 只收到 ${seen.length} 次请求`)
    if (profile.id == null) throw new Error('创建账号失败')

    console.log(
      `smoke: 通过（新建会话 → 流式回复 → 工具审批 → 设置 ${SETTINGS_PAGES.length} 页；` +
        `provider 请求 ${seen.length} 次）`,
    )
  } catch (error) {
    console.error(`smoke: 失败\n${error instanceof Error ? error.stack : error}`)
    if (browser) {
      await page?.screenshot({ path: path.join(home, 'smoke-failure.png') }).catch(() => {})
    }
    console.error(`smoke: 临时目录 ${home}（失败截图可能在其中）`)
    console.error(host.logs())
    process.exitCode = 1
    return
  } finally {
    await browser?.close().catch(() => {})
    if (!host.child.killed) host.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => host.child.once('exit', resolve)),
      sleep(3000).then(() => host.child.kill('SIGKILL')),
    ])
    await new Promise((resolve) => mockServer.close(resolve))
    if (process.exitCode !== 1) rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
