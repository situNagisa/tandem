// 工作站回归：程序即工作站。账号注册/登录、本机主机上下文、授权、账号级模型账号、
// /h/<hostId> 转发与浏览器登录；调试版自动添加本机与演示主机。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const CLI = path.join(ROOT, 'packages/server/dist/cli.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 递归读取目录下所有文本文件，用于断言主机本机文件里没有 Key 明文。 */
function assertNoTextInDir(dir, needles, label) {
  const files = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  for (const file of files) {
    let text = ''
    try {
      if (statSync(file).size > 5 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const needle of needles) {
      assert.equal(text.includes(needle), false, `${label}：${file} 不应包含 Key 明文`)
    }
  }
}

function mockProvider() {
  const seenKeys = []
  const balanceCalls = { count: 0 }
  const server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
    if (auth) seenKeys.push(auth.replace(/^Bearer\s+/i, ''))
    if (req.url.endsWith('/balance')) {
      balanceCalls.count += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ balance: 3.5, currency: 'USD' }))
      return
    }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'ws-model', object: 'model' }] }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* ignore */
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '标题' }, finish_reason: 'stop' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: '工作站流式' } }] })
    await sleep(40)
    send({ choices: [{ index: 0, delta: { content: '回复通过。' } }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  server.seenKeys = seenKeys
  server.balanceCalls = balanceCalls
  return server
}

function startWorkstation({ home, debug = false }) {
  mkdirSync(home, { recursive: true })
  const env = {
    ...process.env,
    TANDEM_HOME: home,
    HOME: home,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...(debug ? {} : { TANDEM_DEBUG_ACCOUNT: '0' }),
  }
  if (debug) delete env.TANDEM_DEBUG_ACCOUNT
  const child = spawn(process.execPath, [CLI, '--port', '0', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (output += chunk))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工作站启动超时：${output}`)), 20_000)
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

async function waitFor(fn, label, timeout = 30_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`超时：${label}${lastError ? `（${lastError.message}）` : ''}`)
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => part.text ?? '').join('')
}

/** 连接主机的明文 WS（工作站 /h/<hostId> 直接转发到进程内主机上下文）。 */
function sendOverHostSocket(wsBase, hostId, token, sessionId, text, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/h/${hostId}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => reject(new Error('会话未完成')), timeout)
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', sessionId }))
      setTimeout(() => {
        socket.send(JSON.stringify({ type: 'send', sessionId, content: [{ type: 'text', text }] }))
      }, 200)
    })
    socket.on('message', (data) => {
      if (typeof data.toString() !== 'string') return
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (message.type === 'message_end' && message.message?.role === 'assistant') {
        const reply = messageText(message.message)
        if (reply.includes('工作站流式回复通过')) {
          clearTimeout(timer)
          socket.close()
          resolve(reply)
        }
      }
      if (message.type === 'error') {
        clearTimeout(timer)
        reject(new Error(message.message))
      }
      if (message.type === 'turn_end' && message.reason === 'error') {
        clearTimeout(timer)
        reject(new Error(message.error))
      }
    })
    socket.on('error', () => reject(new Error('主机 WS 连接失败')))
  })
}

/** 调试版工作站：自动测试账号、本机 + 演示主机、演示工作区。 */
async function runDebugWorkstationCheck(base, home) {
  const proc = startWorkstation({ home: path.join(home, 'debug-ws'), debug: true })
  try {
    const port = await proc.ready
    const WS = `http://127.0.0.1:${port}`
    const status = await json(WS, '/api/workstation/status')
    assert.equal(status.initialized, true, '调试版工作站应已自动初始化')
    assert.equal(status.debug, true, '调试版工作站状态应带 debug 标记')
    const file = path.join(home, 'debug-ws', 'debug-account.json')
    assert.ok(existsSync(file), '调试版应生成测试账号密码文件')
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, '测试账号密码文件应为 0600')
    }
    const login = await json(WS, '/api/debug/auto-login', { method: 'POST' })
    assert.equal(login.account.username, 'debug', '免密登录应返回 debug 账号')
    assert.notEqual(login.account.role, 'admin', '测试账号不是管理员')
    const hosts = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, login.accessToken)
      return list.length === 2 && list.every((h) => h.online) ? list : null
    }, '本机与演示主机自动上线')
    const local = hosts.find((h) => h.local)
    const demo = hosts.find((h) => h.demo)
    assert.ok(local, '应自动添加本机主机')
    assert.ok(demo, '应自动添加演示主机')
    assert.equal(demo.name, '演示主机')
    const demoState = await json(WS, `/h/${demo.id}/api/demo`, {}, login.accessToken)
    assert.equal(demoState.active, true, '演示工作区已创建')
    assert.ok(demoState.scenarios.length > 0)
    const owner = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'dbg-owner', password: 'dbg-owner-pass' }),
    })
    assert.equal(owner.account.role, 'admin', '测试账号不算第一个用户，首个真实注册者应为管理员')
  } finally {
    proc.child.kill('SIGTERM')
  }
}

export async function runWorkstationCheck(home) {
  if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
  const base = path.join(home, 'workstation-reg')
  rmSync(base, { recursive: true, force: true })
  const mock = mockProvider()
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  const ws = startWorkstation({ home: path.join(base, 'ws') })
  try {
    const wsPort = await ws.ready
    const WS = `http://127.0.0.1:${wsPort}`
    const autoLogin = await fetch(`${WS}/api/debug/auto-login`, { method: 'POST' })
    assert.equal(autoLogin.status, 404, '关闭调试账号时不应注册 auto-login 路由')
    const alice = await json(WS, '/api/workstation/setup', {
      method: 'POST',
      body: JSON.stringify({ name: '回归工作站', username: 'ws-alice', password: 'alice-pass-123' }),
    })
    assert.equal(alice.account.role, 'admin', '首个注册账号应为管理员')
    assert.deepEqual(alice.hosts, [], '初始化后不应自动出现主机（本机也要显式添加）')
    const bob = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ws-bob', password: 'bob-pass-123' }),
    })
    assert.equal(bob.account.role, 'member', '后续注册应为普通成员')

    // 管理员可改为仅邀请注册；无邀请码注册被拒，带邀请码可注册。
    await json(WS, '/api/workstation/settings', {
      method: 'PATCH',
      body: JSON.stringify({ registration: 'invite' }),
    }, alice.accessToken)
    const deniedRegister = await fetch(`${WS}/api/workstation/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ws-charlie', password: 'charlie-pass-123' }),
    })
    assert.equal(deniedRegister.status, 403, '仅邀请模式下无邀请码注册应 403')
    const invite = await json(WS, '/api/workstation/invites', { method: 'POST' }, alice.accessToken)
    const charlie = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ws-charlie', password: 'charlie-pass-123', inviteCode: invite.code }),
    })
    assert.equal(charlie.account.role, 'member', '邀请注册应为普通成员')

    // 「添加这台机器」：把运行工作站的这台机器登记为 alice 的主机。
    const host = await json(WS, '/api/workstation/hosts/local', { method: 'POST' }, alice.accessToken)
    assert.equal(host.local, true, '本机主机应带 local 标记')
    assert.equal(host.online, true, '本机主机上下文应在线')
    assert.ok(host.fingerprint, '本机主机应有指纹')
    const listed = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, alice.accessToken)
      return list.length === 1 && list[0].online ? list : null
    }, '本机主机出现在列表并在线')
    assert.equal(listed[0].id, host.id)

    // 账号级模型账号：Key 只在工作站；本机主机上下文直接使用，不经签名代理。
    const aliceKey1 = `sk-ws-alice-${randomUUID()}`
    const profile = await json(WS, '/api/workstation/profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mock 账号',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: aliceKey1,
        models: ['ws-model'],
        defaultModel: 'ws-model',
      }),
    }, alice.accessToken)
    const snapshot = await json(WS, '/api/workstation/profiles', {}, alice.accessToken)
    assert.ok(snapshot.profiles.every((p) => p.apiKeyMasked.includes('****')), '账号设置只回掩码')
    assert.equal(JSON.stringify(snapshot).includes(aliceKey1), false, '账号设置不能回 Key 明文')

    const work = path.join(base, 'work')
    mkdirSync(work, { recursive: true })
    const sessionRes = await fetch(`${WS}/h/${host.id}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: work, title: '工作站回归会话', profileId: profile.id }),
    })
    const sessionText = await sessionRes.text()
    assert.equal(sessionRes.status, 201, `应能在本机主机新建会话：${sessionText}`)
    const session = JSON.parse(sessionText)
    const reply = await sendOverHostSocket(WS, host.id, alice.accessToken, session.id, '请回复')
    assert.ok(reply.includes('工作站流式回复通过'), '应经工作站收到流式回复')
    assert.ok(mock.seenKeys.includes(aliceKey1), '上游请求应使用工作站里的 alice Key')
    const usageRows = JSON.parse(readFileSync(path.join(base, 'ws', 'model-usage.json'), 'utf8')).rows ?? []
    assert.ok(
      usageRows.some((row) => row.accountId === alice.account.id && row.hostId === host.id && row.model === 'ws-model'),
      '工作站应按账号和主机记账',
    )
    // 本机主机上下文的数据目录里没有 Key 明文。
    assertNoTextInDir(path.join(base, 'ws', 'local-host'), [aliceKey1], '本机主机数据')

    // 共享主机：被授权人用自己的账号级模型账号（bob 的 Key）。
    const bobKey = `sk-ws-bob-${randomUUID()}`
    const bobProfile = await json(WS, '/api/workstation/profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bob 账号',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: bobKey,
        models: ['ws-model'],
        defaultModel: 'ws-model',
        balanceQuery: {
          platform: 'custom',
          url: `http://127.0.0.1:${mockPort}/balance`,
          path: 'balance',
          threshold: 5,
        },
      }),
    }, bob.accessToken)
    const bobSnapshot = await json(WS, '/api/workstation/profiles', {}, bob.accessToken)
    assert.equal(bobSnapshot.profiles.find((p) => p.id === bobProfile.id)?.balance?.amount, 3.5, '应显示 mock 平台余额')
    assert.equal(mock.balanceCalls.count, 1)
    await json(WS, '/api/workstation/profiles', {}, bob.accessToken)
    assert.equal(mock.balanceCalls.count, 1, '5 分钟内应复用缓存')
    await json(WS, '/api/workstation/profiles?refresh=1', {}, bob.accessToken)
    assert.equal(mock.balanceCalls.count, 2, '手动刷新应强制重查余额')
    assert.deepEqual(
      (await json(WS, '/api/workstation/profiles', {}, alice.accessToken)).profiles.some((p) => p.id === bobProfile.id),
      false,
      'alice 看不到 bob 的模型账号',
    )

    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bob.accessToken), [], '新用户默认看不到别人的主机')
    await json(WS, `/api/workstation/hosts/${host.id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ accountId: bob.account.id, role: 'collaborator' }),
    }, alice.accessToken)
    const bobHosts = await json(WS, '/api/workstation/hosts', {}, bob.accessToken)
    assert.deepEqual(bobHosts.map((h) => h.id), [host.id], '授权后只应看到被授权的主机')
    // 授权后刷新令牌：主机侧按新 perHost 声明放行。
    const bobAccess = await json(WS, '/api/workstation/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: bob.refreshToken }),
    })
    bob.accessToken = bobAccess.accessToken
    bob.refreshToken = bobAccess.refreshToken
    const bobSessionRes = await fetch(`${WS}/h/${host.id}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: work, title: '共享主机会话', profileId: bobProfile.id }),
    })
    const bobSessionText = await bobSessionRes.text()
    assert.equal(bobSessionRes.status, 201, `被授权人应能在共享主机建会话：${bobSessionText}`)
    const bobSession = JSON.parse(bobSessionText)
    const bobReply = await sendOverHostSocket(WS, host.id, bob.accessToken, bobSession.id, '请回复')
    assert.ok(bobReply.includes('工作站流式回复通过'), '被授权人应拿到回复')
    assert.ok(mock.seenKeys.includes(bobKey), '共享主机上的请求应使用 bob 自己的 Key')

    // 撤销授权：旧令牌立即失效（主机快照 invalidBefore），刷新后看到空列表。
    await json(WS, `/api/workstation/hosts/${host.id}/grants/${bob.account.id}`, { method: 'DELETE' }, alice.accessToken)
    const oldTokenRes = await fetch(`${WS}/api/workstation/hosts`, {
      headers: { authorization: `Bearer ${bob.accessToken}` },
    })
    assert.equal(oldTokenRes.status, 401, '撤销授权后旧令牌应立即失效')
    const bobTokens = await json(WS, '/api/workstation/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: bob.refreshToken }),
    })
    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bobTokens.accessToken), [], '刷新后不应再看到被撤销的主机')

    // 移除主机后可以重新添加；同一个账号再次添加应幂等返回。
    await json(WS, `/api/workstation/hosts/${host.id}`, { method: 'DELETE' }, alice.accessToken)
    const readded = await json(WS, '/api/workstation/hosts/local', { method: 'POST' }, alice.accessToken)
    assert.equal(readded.id, host.id)
    assert.equal(readded.ownerId, alice.account.id)

    await runDebugWorkstationCheck(base, home)
  } finally {
    ws.child.kill('SIGTERM')
    mock.close()
  }
}
