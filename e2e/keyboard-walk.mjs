#!/usr/bin/env node
/**
 * 纯键盘走查：全程不使用鼠标。
 *
 * 新建会话 → 选目录 → 选模型与思考强度 → 发送 → 依次用 1/2/3 处理三次审批
 * → 打开改动审阅并评论一行 → 打开设置改一项 → Esc 关闭。
 *
 * 同时断言：焦点始终可见（focus-visible 外环）、弹层打开后焦点进入、
 * Esc 关闭并把焦点还给触发按钮、Tab 不会落到 body、弹层内焦点不逃逸。
 *
 * 前置：npm run build。用法：node e2e/keyboard-walk.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const HOME = process.env.KBD_HOME ?? '/tmp/tandem-kbd'
const PORT = Number(process.env.KBD_PORT ?? 8271)
const HOST_ID = 'kbd-host'
const TOKEN = 'kbd-token-local'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function seedRepo(repo) {
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'kbd@example.com')
  git('config', 'user.name', 'kbd')
  writeFileSync(path.join(repo, 'README.md'), '# keyboard repo\n')
  writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  // 未提交改动，供改动审阅面板使用。
  writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 2\nexport const b = 3\n')
  writeFileSync(path.join(repo, 'src/new.ts'), 'export const c = 4\n')
}

function createMockProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-kbd',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '键盘走查' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      )
      return
    }
    const toolCount = (body.messages ?? []).filter((m) => m.role === 'tool').length
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const chunk = (delta, finish = null) =>
      send({ id: 'chatcmpl-kbd', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })

    const calls = [
      { name: 'Bash', args: { command: 'echo keyboard-ok', description: '键盘走查命令' } },
      { name: 'Write', args: { file_path: 'src/from-keyboard.ts', content: 'export const keyboard = true\n' } },
      { name: 'Edit', args: { file_path: 'src/from-keyboard.ts', old_string: 'true', new_string: 'false' } },
    ]
    if (toolCount < calls.length) {
      const call = calls[toolCount]
      chunk({ role: 'assistant', content: `第 ${toolCount + 1} 步。` })
      await sleep(30)
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_kbd_${toolCount}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: '键盘走查完成。' })
      chunk({}, 'stop')
    }
    send({
      id: 'chatcmpl-kbd',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return server
}

function seed(configDir, repo, mockPort) {
  const now = Date.now()
  const capabilities = { 'mock-1': { efforts: ['low', 'medium', 'high'] } }
  writeJson(path.join(configDir, 'profiles.json'), {
    profiles: [
      {
        id: 'p-main',
        name: '键盘账号',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'kbd-fake-key',
        models: ['mock-1', 'mock-2'],
        defaultModel: 'mock-1',
        modelCapabilities: capabilities,
        createdAt: now,
      },
    ],
  })
  writeJson(path.join(configDir, 'permissions.json'), [])
  writeJson(path.join(configDir, 'config.json'), {
    hostId: HOST_ID,
    token: TOKEN,
    idleTimeoutSec: 600,
    resumeOnRestart: 'auto',
    defaultDelegation: 'less',
  })
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  void repo
}

function startHost(configDir) {
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(HOME, 'home'),
      TANDEM_HOME: configDir,
      CODEX_HOME: path.join(HOME, 'home', '.codex'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => (stdout += c))
  child.stderr.on('data', (c) => (stderr += c))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${stdout}\n${stderr}`)), 30000)
    const check = () => {
      if (stdout.includes(`127.0.0.1:${PORT}/?token=`)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => reject(new Error(`Host 提前退出（${code}）\n${stdout}\n${stderr}`)))
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement)) return { tag: 'none' }
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder'),
      inDialog: !!el.closest('[role="dialog"]'),
      inMenu: !!el.closest('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]'),
      focusVisible: el.matches(':focus-visible'),
      outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
      cls: el.className?.toString().slice(0, 120),
    }
  })

async function expectFocusVisible(page, step) {
  const info = await active(page)
  assert.notEqual(info.tag, 'body', `${step}: 焦点落到了 body`)
  assert.ok(info.focusVisible, `${step}: 焦点不可见（:focus-visible=false）${JSON.stringify(info)}`)
  assert.ok(info.outline !== 'none 0px', `${step}: 没有焦点外环 ${info.outline} ${JSON.stringify(info)}`)
  console.log(`  ✓ ${step}：焦点 ${info.tag}「${info.label || info.text}」，外环 ${info.outline}`)
  return info
}

async function keyUntil(page, predicate, { shift = false, max = 90, step = 'Tab' } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
    await page.waitForTimeout(40)
    const info = await active(page)
    if (process.env.DEBUG_KEY) console.log(`    [${step}] ${i + 1}. ${info.tag} label=${info.label} text=${info.text} title=${info.title}`)
    assert.notEqual(info.tag, 'body', `${step}: 第 ${i + 1} 次 Tab 后焦点落到 body`)
    if (predicate(info)) return info
  }
  throw new Error(`${step}: ${max} 次 Tab 内没找到目标，最后焦点 ${JSON.stringify(await active(page))}`)
}

async function main() {
  const mock = createMockProvider()
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  rmSync(HOME, { recursive: true, force: true })
  const configDir = path.join(HOME, 'tandem')
  const repo = path.join(HOME, 'repo')
  mkdirSync(path.join(HOME, 'home'), { recursive: true })
  seedRepo(repo)
  seed(configDir, repo, mockPort)
  const host = startHost(configDir)
  await host.ready
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (err) => console.log('  pageerror:', err.message))
  const log = []
  const note = (message) => {
    log.push(message)
    console.log(message)
  }

  try {
    await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`)
    await page.getByRole('button', { name: /^新会话/ }).waitFor({ timeout: 20000 })
    await sleep(800)

    note('\n[1] 键盘新建会话（Ctrl+N）')
    await page.keyboard.press('Control+n')
    const composer = page.getByLabel('消息输入框')
    await composer.waitFor()
    await composer.fill('请运行测试并修改文件')
    note('  ✓ 输入框已聚焦并输入提示词')

    note('\n[2] Shift+Tab 到文件夹按钮，Enter 打开目录选择')
    const folder = await keyUntil(
      page,
      (info) => info.tag === 'button' && info.title === path.join(HOME, 'home'),
      { shift: true, step: '目录触发按钮' },
    )
    assert.equal(await page.getByLabel('筛选文件夹或输入路径').count(), 0)
    await page.keyboard.press('Enter')
    const pathInput = page.getByLabel('筛选文件夹或输入路径')
    await pathInput.waitFor()
    const focusInPopover = await active(page)
    assert.equal(focusInPopover.label, '筛选文件夹或输入路径', `弹层打开后焦点未进入：${JSON.stringify(focusInPopover)}`)
    await expectFocusVisible(page, '目录弹层焦点进入')
    await pathInput.fill(repo)
    await page.keyboard.press('Enter')
    await pathInput.waitFor({ state: 'hidden' })
    await sleep(300)
    const back = await active(page)
    assert.equal(back.tag, 'button', `目录关闭后焦点没有回到触发按钮：${JSON.stringify(back)}`)
    assert.equal(back.title, repo, `目录关闭后焦点所在按钮不是文件夹触发器：${JSON.stringify(back)}`)
    assert.equal(back.focusVisible, true, '目录关闭后触发按钮没有 focus-visible 外环')
    note('  ✓ 选择目录后焦点回到文件夹按钮')
    void folder

    note('\n[3] 键盘选择模型与思考强度')
    await keyUntil(page, (info) => info.tag === 'button' && (info.label ?? '').startsWith('选择模型'), {
      step: '模型按钮',
    })
    // 先验证 Esc 关闭菜单并归还焦点。
    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor()
    await sleep(150)
    const inMenu = await active(page)
    assert.ok(inMenu.inMenu, `菜单打开后焦点未进入：${JSON.stringify(inMenu)}`)
    await page.keyboard.press('Escape')
    await sleep(200)
    const menuBack = await active(page)
    assert.ok((menuBack.label ?? '').startsWith('选择模型'), `菜单 Esc 后焦点未归还：${JSON.stringify(menuBack)}`)
    note('  ✓ 菜单 Esc 关闭，焦点回到模型按钮')

    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor()
    await sleep(150)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(80)
    await page.keyboard.press('Enter')
    await sleep(300)
    const chosen = await active(page)
    assert.ok((chosen.label ?? '').includes('Mock 2'), `模型未切换：${JSON.stringify(chosen)}`)
    note(`  ✓ 已切换模型：${chosen.label}`)

    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor()
    let sub = null
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(60)
      sub = await active(page)
      if ((sub.text ?? '').includes('思考强度')) break
    }
    assert.ok((sub?.text ?? '').includes('思考强度'), '没找到思考强度子菜单')
    // 子菜单触发器用 Enter 打开（Radix 在 Portal 里的 ArrowRight 不稳定）。
    await page.keyboard.press('Enter')
    await page.getByRole('menu', { name: '思考强度' }).waitFor({ timeout: 5000 })
    let effort = null
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(60)
      effort = await active(page)
      if ((effort.text ?? '').startsWith('高')) break
    }
    assert.ok((effort?.text ?? '').startsWith('高'), `思考强度子菜单没找到「高」：${JSON.stringify(effort)}`)
    await page.keyboard.press('Enter')
    await sleep(300)
    const withEffort = await active(page)
    assert.ok((withEffort.label ?? '').includes('高'), `思考强度未生效：${JSON.stringify(withEffort)}`)
    note(`  ✓ 已选思考强度：${withEffort.label}`)

    note('\n[4] Tab 到发送按钮，Enter 发送')
    await keyUntil(page, (info) => info.tag === 'button' && (info.label ?? '') === '发送消息', {
      step: '发送按钮',
    })
    await expectFocusVisible(page, '发送按钮')
    await page.keyboard.press('Enter')
    await page.locator('.permission-card').first().waitFor({ timeout: 20000 })
    note('  ✓ 已发送，出现审批卡')

    note('\n[5] 1/2/3 处理三次审批')
    const keys = ['1', '2', '3']
    for (let i = 0; i < keys.length; i++) {
      await page.locator('.permission-card').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(250)
      const before = await active(page)
      assert.ok(!['input', 'textarea'].includes(before.tag), `审批快捷键前焦点在输入框：${JSON.stringify(before)}`)
      await page.keyboard.press(keys[i])
      note(`  ✓ 第 ${i + 1} 次审批按了 ${keys[i]}`)
      await sleep(600)
    }
    await page.getByText('键盘走查完成。').waitFor({ timeout: 30000 })
    note('  ✓ 三次审批处理完毕，回合结束')

    note('\n[6] 键盘打开改动审阅并评论一行')
    const changes = await keyUntil(
      page,
      (info) => info.tag === 'button' && (info.label ?? '') === '改动审阅',
      { shift: true, step: '改动审阅按钮', max: 120 },
    )
    void changes
    await page.keyboard.press('Enter')
    await sleep(700)
    const row = await keyUntil(page, (info) => (info.label ?? '').includes('行：'), {
      step: '差异行',
      max: 160,
    })
    note(`  ✓ 差异行可聚焦：${row.label}`)
    await expectFocusVisible(page, '差异行')
    await page.keyboard.press('Enter')
    const commentInput = page.getByLabel('行内评论')
    await commentInput.waitFor({ timeout: 5000 })
    const inComment = await active(page)
    assert.equal(inComment.label, '行内评论', `评论浮层未聚焦输入框：${JSON.stringify(inComment)}`)
    await page.keyboard.insertText('键盘走查评论')
    await page.keyboard.press('Enter')
    await page.getByText('1 条评论').waitFor({ timeout: 5000 })
    note('  ✓ 键盘提交了 1 条行评论')
    if (await commentInput.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await sleep(250)
    }

    note('\n[7] 键盘打开设置并改一项')
    await keyUntil(page, (info) => info.tag === 'button' && (info.text ?? '') === '设置', {
      shift: true,
      step: '设置按钮',
      max: 200,
    })
    const settingsTrigger = await active(page)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor()
    await sleep(300)
    const inSettings = await active(page)
    assert.ok(inSettings.inDialog, `设置打开后焦点未进入弹层：${JSON.stringify(inSettings)}`)
    note(`  ✓ 设置打开后焦点进入：${inSettings.tag}「${inSettings.label || inSettings.text}」`)

    // 焦点陷阱：Shift+Tab 循环不应离开 dialog。
    await page.keyboard.press('Shift+Tab')
    const trap = await active(page)
    assert.ok(trap.inDialog, `Shift+Tab 逃出设置弹层：${JSON.stringify(trap)}`)
    note('  ✓ 设置弹层焦点未逃逸')

    // 切到「通用」页签，再 Tab 到会话恢复方式分段控件。
    await keyUntil(page, (info) => info.tag === 'button' && info.text === '通用', {
      step: '通用页签',
      max: 60,
    })
    await page.keyboard.press('Enter')
    await sleep(300)
    const option = await keyUntil(
      page,
      (info) => info.tag === 'button' && (info.text === '自动继续' || info.text === '恢复为暂停'),
      { step: '会话恢复方式选项', max: 80 },
    )
    await expectFocusVisible(page, '通用设置分段控件')
    void option
    const beforeValue = await page.evaluate(() => {
      const group = document.querySelector('[aria-label="Host 重启后的会话恢复方式"]')
      const pressed = group?.querySelector('[aria-pressed="true"]')
      return pressed?.textContent?.trim() ?? ''
    })
    await page.keyboard.press('Tab')
    await page.keyboard.press('Space')
    await sleep(600)
    const afterValue = await page.evaluate(() => {
      const group = document.querySelector('[aria-label="Host 重启后的会话恢复方式"]')
      const pressed = group?.querySelector('[aria-pressed="true"]')
      return pressed?.textContent?.trim() ?? ''
    })
    assert.notEqual(afterValue, beforeValue, `设置项未改变：${beforeValue}`)
    note(`  ✓ 设置项 ${beforeValue} → ${afterValue}`)

    note('\n[8] Esc 关闭设置，焦点回到触发按钮')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await sleep(350)
    const returned = await active(page)
    assert.equal(returned.tag, 'button', `Esc 后焦点不在按钮：${JSON.stringify(returned)}`)
    assert.equal(returned.text, '设置', `Esc 后焦点未回到设置按钮：${JSON.stringify(returned)}`)
    assert.equal(returned.focusVisible, true, '返回后的触发按钮没有 focus-visible 外环')
    note('  ✓ Esc 关闭并归还焦点（带 focus-visible 外环）')

    note('\n键盘走查全部通过。')
  } finally {
    await browser.close()
    host.child.kill('SIGTERM')
    await sleep(300)
    if (!host.child.killed) host.child.kill('SIGKILL')
    mock.close()
  }
}

main().catch(async (err) => {
  console.error('\n键盘走查失败：', err.message)
  process.exitCode = 1
})
