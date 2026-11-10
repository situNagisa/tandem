// 远端执行器端到端：工作站 → 一行命令安装 linux 执行器（假 HOME）→ 浏览器登录 → 主机在线
// → 远端会话让 agent 调 Write 写文件、Bash 读回 → 断言远端文件内容。
// 执行器与工作站都在本机回环；远端文件建在测试目录里，由执行器（而非工作站进程）读写。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { E2EChannel } from '../packages/protocol/dist/e2eClient.js'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const CLI = path.join(ROOT, 'packages/server/dist/cli.js')
const TRIGGER = '远端写入并读回'
const PAYLOAD = `hello from executor ${randomUUID().slice(0, 8)}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function json(base, pathname, init = {}, token) {
  const res = await fetch(base + pathname, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

async function waitFor(fn, label, timeout = 60_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`)
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => part.text ?? '').join('')
}

// 假模型（OpenAI 兼容）：触发语出现时依次调用 Write、Bash 读回，并校验 Bash 的结果里有写入的内容。
function mockProvider(target) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'exec-model', object: 'model' }] }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '远端执行' }, finish_reason: 'stop' }] }))
      return
    }
    const messages = body.messages ?? []
    const triggered = messages.some((m) => m.role === 'user' && messageText(m).includes(TRIGGER))
    const toolResults = messages.filter((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-exec', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    const call = (id, name, args) => ({
      index: 0,
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })
    if (!triggered) {
      send({ role: 'assistant', content: '收到。' })
      send({}, 'stop')
    } else if (toolResults.length === 0) {
      send({ role: 'assistant', content: '先写入远端文件。' })
      send({ tool_calls: [call('call_write', 'Write', { file_path: target, content: PAYLOAD })] })
      send({}, 'tool_calls')
    } else if (toolResults.length === 1) {
      send({ role: 'assistant', content: '再读回远端文件。' })
      send({ tool_calls: [call('call_read', 'Bash', { command: `cat '${target}'`, description: '读回文件' })] })
      send({}, 'tool_calls')
    } else {
      const readBack = messageText(toolResults[1]).includes(PAYLOAD)
      send({ role: 'assistant', content: readBack ? `远端读回完成：${PAYLOAD}` : '远端读回失败' })
      send({}, 'stop')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return server
}

function startWorkstation(home) {
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [CLI, 'workstation', '--port', '0', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TANDEM_HOME: home,
      TANDEM_DEBUG_ACCOUNT: '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (output += chunk))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工作站启动超时：${output}`)), 30_000)
    const check = () => {
      const match = output.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）：${output}`))
    })
  })
  return { child, ready, logs: () => output }
}

/** 结束安装脚本拉起的执行器（它在 sh 的进程组里）；只按假 HOME 前缀匹配，不碰别的进程。 */
export function killExecutorsUnder(home) {
  if (process.platform === 'win32') return
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (!pid || pid === process.pid) continue
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (!args[0]?.endsWith('tandem-exec')) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      if (env.some((item) => item === `HOME=${home}`)) process.kill(pid, 'SIGTERM')
    } catch {
      // 进程已退出或无权读取
    }
  }
}

export async function runExecutorCheck(home) {
  if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
  const base = path.join(home, 'executor-e2e')
  rmSync(base, { recursive: true, force: true })
  const project = path.join(base, 'project')
  const target = path.join(project, 'remote-hello.txt')
  const installHome = path.join(base, 'exec-home')
  mkdirSync(project, { recursive: true })
  mkdirSync(installHome, { recursive: true })

  const mock = mockProvider(target)
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  const ws = startWorkstation(path.join(base, 'ws'))
  let installer = null
  let browser = null
  try {
    const port = await ws.ready
    const WS = `http://127.0.0.1:${port}`
    const password = 'exec-pass-123'
    const alice = await json(WS, '/api/workstation/setup', {
      method: 'POST',
      body: JSON.stringify({ name: '执行器回归工作站', username: 'exec-alice', password }),
    })
    const profile = await json(
      WS,
      '/api/workstation/profiles',
      {
        method: 'POST',
        body: JSON.stringify({
          name: '执行器回归模型',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: `sk-exec-${randomUUID()}`,
          models: ['exec-model'],
          defaultModel: 'exec-model',
        }),
      },
      alice.accessToken,
    )

    // 一行命令：令牌在命令里，脚本从工作站下载 linux-amd64 执行器并校验 sha256。
    const bind = await json(WS, '/api/workstation/hosts/bind-code', { method: 'POST' }, alice.accessToken)
    assert.match(bind.code, /^ach_[A-Za-z0-9_-]+\.[0-9a-f]{16}$/, `绑定码格式不对：${bind.code}`)
    installer = spawn('sh', ['-c', `curl -fsSL ${WS}/install.sh | sh -s -- --token ${bind.code}`], {
      detached: true,
      env: {
        ...process.env,
        HOME: installHome,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let installOut = ''
    installer.stdout.setEncoding('utf8')
    installer.stdout.on('data', (chunk) => (installOut += chunk))
    installer.stderr.setEncoding('utf8')
    installer.stderr.on('data', (chunk) => (installOut += chunk))
    await waitFor(() => /已登记并连接工作站/.test(installOut) || installer.exitCode !== null, '安装脚本前台连接工作站', 120_000)
    assert.match(installOut, /已登记并连接工作站/, `安装脚本应完成登记并保持连接：${installOut}`)
    assert.ok(installOut.includes('ach_****'), `安装输出应脱敏令牌：${installOut}`)
    assert.ok(!installOut.includes(bind.code), '安装输出不能回显明文令牌')
    const binPath = path.join(installHome, '.tandem-executor', 'bin', 'tandem-exec')
    assert.ok(readFileSync(binPath).length > 1024 * 1024, '执行器应装到 ~/.tandem-executor/bin')
    assert.ok(readFileSync(path.join(installHome, '.tandem-executor', 'identity.json'), 'utf8').includes('execPriv'), '应写入身份文件')

    // 主机出现在列表里，且执行器在线。
    const host = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, alice.accessToken)
      return list.length === 1 && list[0].online ? list[0] : null
    }, '远端主机在线')
    assert.match(host.platform, /^linux\b/, `远端主机平台应为 linux：${host.platform}`)
    assert.ok(host.fingerprint, '远端主机应有指纹')

    // 浏览器登录：工作站已初始化，登录后主机列表里出现远端主机（新会话入口可用）。
    browser = await chromium.launch({ headless: true })
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    await page.goto(`${WS}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="login-username"]').waitFor({ state: 'visible', timeout: 60_000 })
    await page.locator('[data-testid="login-username"]').fill('exec-alice')
    await page.locator('[data-testid="login-password"]').fill(password)
    await page.locator('[data-testid="login-submit"]').click()
    await page.locator('[data-testid="no-hosts"]').waitFor({ state: 'detached', timeout: 60_000 })
    await waitFor(async () => !(await page.locator('[data-testid="sidebar-new-session"]').isDisabled()), '浏览器里新会话入口可用')

    // 会话经工作站上的远端主机上下文处理（E2E 与其他主机一致）；重新登录拿到包含该主机的访问令牌。
    const fresh = await json(WS, '/api/workstation/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'exec-alice', password }),
    })
    const channel = new E2EChannel({ baseUrl: `${WS}/h/${host.id}`, fingerprint: host.fingerprint })
    const auth = { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' }
    const sessionRes = await channel.fetch('/api/sessions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        cwd: project,
        title: '远端执行器回归',
        profileId: profile.id,
        model: 'exec-model',
        permissionMode: 'bypassPermissions',
      }),
    })
    assert.equal(sessionRes.status, 201, `应能在远端主机新建会话：${sessionRes.status}`)
    const session = await sessionRes.json()

    const reply = await new Promise((resolve, reject) => {
      const socket = channel.openWebSocket(`/ws?token=${encodeURIComponent(fresh.accessToken)}`)
      const timer = setTimeout(() => reject(new Error(`远端会话未完成（工作站日志）：\n${ws.logs()}`)), 90_000)
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'send', sessionId: session.id, content: [{ type: 'text', text: TRIGGER }] }))
        }, 200)
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data)
        if (message.type === 'message_end' && message.message?.role === 'assistant') {
          const text = messageText(message.message)
          if (text.includes('远端读回')) {
            clearTimeout(timer)
            socket.close()
            resolve(text)
          }
        }
        if (message.type === 'error') {
          clearTimeout(timer)
          reject(new Error(`发送失败：${message.message}`))
        }
        if (message.type === 'turn_end' && message.reason === 'error') {
          clearTimeout(timer)
          reject(new Error(`回合失败：${message.error}`))
        }
      }
      socket.onerror = () => reject(new Error('加密 WebSocket 连接失败'))
    })
    assert.equal(reply, `远端读回完成：${PAYLOAD}`, 'Bash 应读回 Write 写入的内容')
    assert.equal(readFileSync(target, 'utf8'), PAYLOAD, '远端文件内容应为 Write 写入的内容')
  } finally {
    await browser?.close().catch(() => undefined)
    if (installer?.pid) {
      try {
        process.kill(-installer.pid, 'SIGTERM')
      } catch {
        // 进程组已退出
      }
    }
    killExecutorsUnder(installHome)
    ws.child.kill('SIGTERM')
    await sleep(1500)
    if (ws.child.exitCode === null) ws.child.kill('SIGKILL')
    await new Promise((resolve) => mock.close(resolve))
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}
