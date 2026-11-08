// 工作站客户端-服务模式回归：只跑工作站 + 两台主机，账号只填工作站地址，
// 主机出站隧道 + E2E 转发，用户 2 默认不可见、授权后才可见。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { E2EChannel } from '@tandem/relay/client'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const CLI = path.join(ROOT, 'packages/server/dist/cli.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function mockProvider() {
  const server = http.createServer(async (req, res) => {
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
  return server
}

function startProcess({ home, mode, port = 0, extraEnv = {} }) {
  const dataDir = mode === 'host' ? path.join(home, '.tandem') : home
  mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })
  const token = randomUUID()
  const hostId = randomUUID()
  if (mode === 'host') {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ hostId, token, idleTimeoutSec: 300 }))
  }
  const args = mode === 'host' ? [CLI, '--port', String(port)] : [CLI, 'workstation', '--port', String(port), '--host', '127.0.0.1']
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, TANDEM_HOME: dataDir, HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (output += chunk))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`进程启动超时：${output}`)), 20_000)
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
      reject(new Error(`进程提前退出（${code}）：${output}`))
    })
  })
  return { child, ready, token, hostId, logs: () => output }
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

async function waitFor(fn, label, timeout = 25_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error(`超时：${label}`)
}

export async function runWorkstationCheck(home) {
  if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
  const base = path.join(home, 'workstation-reg')
  rmSync(base, { recursive: true, force: true })
  const mock = mockProvider()
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  const ws = startProcess({ home: path.join(base, 'ws'), mode: 'workstation' })
  const h1 = startProcess({ home: path.join(base, 'h1'), mode: 'host' })
  const h2 = startProcess({ home: path.join(base, 'h2'), mode: 'host' })
  try {
    const wsPort = await ws.ready
    const h1Port = await h1.ready
    const h2Port = await h2.ready
    const WS = `http://127.0.0.1:${wsPort}`
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

    const hosts = [
      { proc: h1, port: h1Port },
      { proc: h2, port: h2Port },
    ]
    for (const { proc } of hosts) {
      await json(`http://127.0.0.1:${proc === h1 ? h1Port : h2Port}`, '/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Mock 账号',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'mock',
          models: ['ws-model'],
          defaultModel: 'ws-model',
        }),
      }, proc.token)
      const bind = await json(WS, '/api/workstation/hosts/bind-code', { method: 'POST' }, alice.accessToken)
      const port = proc === h1 ? h1Port : h2Port
      await json(`http://127.0.0.1:${port}`, '/api/workstation/join', {
        method: 'POST',
        body: JSON.stringify({ workstationUrl: WS, code: bind.code }),
      }, proc.token)
    }
    const visible = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, alice.accessToken)
      return list.length === 2 && list.every((h) => h.online) ? list : null
    }, '两台主机经出站隧道上线')

    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bob.accessToken), [], '新用户默认看不到别人的主机')
    const target = visible.find((h) => h.id === h2.hostId)
    await json(WS, `/api/workstation/hosts/${target.id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ accountId: bob.account.id, role: 'observer' }),
    }, alice.accessToken)
    const bobHosts = await json(WS, '/api/workstation/hosts', {}, bob.accessToken)
    assert.deepEqual(bobHosts.map((h) => h.id), [target.id], '授权后只应看到被授权的主机')

    // 只连工作站端口：E2E 经工作站转发到 h1。
    const channel = new E2EChannel({
      baseUrl: `${WS}/h/${h1.hostId}`,
      fingerprint: visible.find((h) => h.id === h1.hostId).fingerprint,
    })
    const info = await channel.fetch('/api/host', { headers: { Authorization: `Bearer ${alice.accessToken}` } })
    assert.ok(info.ok, `经工作站 E2E 访问主机失败：${info.status}`)

    const work = path.join(base, 'work')
    mkdirSync(work, { recursive: true })
    const sessionRes = await channel.fetch('/api/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: work,
        title: '工作站回归会话',
        profileId: (await json(`http://127.0.0.1:${h1Port}`, '/api/profiles', {}, h1.token))[0].id,
      }),
    })
    assert.equal(sessionRes.status, 201, '应能在 h1 新建会话')
    const session = await sessionRes.json()
    const reply = await new Promise((resolve, reject) => {
      const socket = channel.openWebSocket(`/ws?token=${encodeURIComponent(alice.accessToken)}`)
      const timer = setTimeout(() => reject(new Error('未收到流式回复')), 30_000)
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'send', sessionId: session.id, content: [{ type: 'text', text: '请回复' }] }))
        }, 200)
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data)
        if (message.type === 'message_end' && message.message?.role === 'assistant') {
          const text = (message.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text.includes('工作站流式回复通过')) {
            clearTimeout(timer)
            socket.close()
            resolve(text)
          }
        }
        if (message.type === 'turn_end' && message.reason === 'error') {
          clearTimeout(timer)
          reject(new Error(`回合失败：${message.error}`))
        }
      }
      socket.onerror = () => reject(new Error('加密 WebSocket 连接失败'))
    })
    assert.ok(reply.includes('工作站流式回复通过'), '应经工作站收到流式回复')

    // 撤销授权后用户 2 立即看不到；主机端口未被客户端使用（只访问工作站端口）。
    await json(WS, `/api/workstation/hosts/${target.id}/grants/${bob.account.id}`, { method: 'DELETE' }, alice.accessToken)
    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bob.accessToken), [], '撤销授权后应立即不可见')
  } finally {
    ws.child.kill('SIGTERM')
    h1.child.kill('SIGTERM')
    h2.child.kill('SIGTERM')
    mock.close()
  }
}
