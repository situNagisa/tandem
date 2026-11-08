#!/usr/bin/env node
/**
 * 回归走查：把 docs/qa-v6.md、bugs-v6.md、review-v4/v5/v7a/v7b/v7c.md 中标记「已修」的
 * P0/P1 交互整理成可重复执行的断言。
 *
 * 全程使用临时 Host（TANDEM_HOME=/tmp/tandem-reg-<随机>、随机端口）与假 OpenAI 兼容端点；
 * 不读真实 Key、不碰 ~/.tandem。成功退出码 0，任一断言失败退出码 1 并保留临时目录与截图。
 *
 * 前置：npm run build（check.mjs 会先构建）。
 * 用法：
 *   npm run regression
 *   node e2e/regression.mjs --only "更多菜单"   只跑名称包含该片段的用例
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import WebSocket from 'ws'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const DESKTOP = { width: 2552, height: 1274 }
const MOBILE = { width: 390, height: 844 }
const SMALL = { width: 360, height: 780 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const onlyIndex = process.argv.indexOf('--only')
const ONLY = onlyIndex >= 0 ? (process.argv[onlyIndex + 1] ?? '') : ''

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function createMockProvider() {
  // 配额交接用例：主分组第一次成功、之后 429；备用分组始终可用。
  let quotaHits = 0
  // 应用预览用例：记录模型实际收到的用户文本，用于断言元素上下文已附带。
  const seenUserTexts = []
  // 自动路由用例：记录每次请求实际使用的模型，便于断言升级/回落。
  const routeSeen = []
  const rateLimitHeaders = {
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-remaining-requests': '90',
    'x-ratelimit-limit-tokens': '100000',
    'x-ratelimit-remaining-tokens': '90000',
    'x-ratelimit-reset-requests': '30s',
    'x-ratelimit-reset-tokens': '30s',
  }
  const quotaStream = (res, text) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...rateLimitHeaders,
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({
      id: 'chatcmpl-quota',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text } }],
    })
    send({
      id: 'chatcmpl-quota',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    send({
      id: 'chatcmpl-quota',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  }
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
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad json' } }))
      return
    }
    // 配额交接：主分组第一次成功，之后返回 429 与限流头；备用分组始终成功。
    if (typeof body.model === 'string' && body.model.startsWith('route-')) {
      routeSeen.push({ model: body.model, stream: body.stream === true })
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-route',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '自动路由' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
        )
        return
      }
      const messages = body.messages ?? []
      const userText = messages
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n')
      const hasToolResult = messages.some((message) => message.role === 'tool')
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish = null) =>
        send({
          id: 'chatcmpl-route',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      if (body.model === 'route-mini' && userText.includes('触发失败') && !hasToolResult) {
        chunk({ role: 'assistant', content: '执行两个会失败的命令。' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_route_fail_1',
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'exit 1', description: '失败命令 1' }) },
            },
            {
              index: 1,
              id: 'call_route_fail_2',
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'exit 2', description: '失败命令 2' }) },
            },
          ],
        })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: `路由模型 ${body.model} 已回复。` })
        chunk({}, 'stop')
      }
      send({
        id: 'chatcmpl-route',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (body.model === 'quota-model') {
      quotaHits += 1
      if (quotaHits > 1) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '3',
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '3s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '3s',
        })
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
        return
      }
      quotaStream(res, '配额主分组回复：第二次请求完成。')
      return
    }
    if (body.model === 'quota-backup-model') {
      if (body.stream === true) {
        quotaStream(res, '配额备用分组回复：已继续。')
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...rateLimitHeaders })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-quota',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '配额备用分组' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
        )
      }
      return
    }
    // 提交前 AI 评审：返回固定 JSON（一条 blocker、一条 nit、一条指向不存在行的错误项）
    if (
      body.stream === true &&
      JSON.stringify(body.messages ?? []).includes('你是提交前的代码评审员')
    ) {
      const review = JSON.stringify({
        verdict: 'blocker',
        summary: '发现一处阻塞问题，另有未使用常量',
        items: [
          {
            file: 'src/hello.ts',
            line: 1,
            severity: 'blocker',
            title: '导出的常量值被改小',
            detail: 'hello 从 1 改成 2，可能影响依赖该值的调用方。',
            suggestion: '确认下游是否需要同步调整。',
          },
          {
            file: 'src/hello.ts',
            line: 2,
            severity: 'nit',
            title: '新增常量未被使用',
            detail: 'world 没有被任何地方引用。',
          },
          {
            file: 'src/hello.ts',
            line: 9999,
            severity: 'warn',
            title: '指向不存在的行',
            detail: '这一行在 diff 里不存在，应被 Host 忽略。',
          },
        ],
      })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      send({
        id: 'chatcmpl-review',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: review }, finish_reason: null }],
      })
      send({
        id: 'chatcmpl-review',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      send({
        id: 'chatcmpl-review',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    // ---------- 看板 v2：卡片会话里的工具调用 ----------
    const lastRole = body.messages?.at(-1)?.role
    const userTexts = (body.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? []).map((part) => part.text ?? '').join('\n'),
      )
    const latest = userTexts.at(-1) ?? ''
    const allUser = userTexts.join('\n')
    seenUserTexts.push(latest)

    // 工作站设备：一轮里依次调用 7 个设备工具，覆盖跨 Host 代理、审批与后台 logcat。
    if (body.stream === true && allUser.includes('DEVICE_E2E')) {
      const toolMessages = (body.messages ?? []).filter((m) => m.role === 'tool')
      const n = toolMessages.length
      const lastTool = JSON.stringify(toolMessages.at(-1) ?? {})
      const logStream = (lastTool.match(/bash_[a-f0-9]{8}/) ?? [])[0]
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish = null) =>
        send({
          id: 'chatcmpl-device',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      const tool = (name, input) => {
        chunk({ role: 'assistant', content: `设备步骤 ${n}` })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_device_${n}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        })
        chunk({}, 'tool_calls')
      }
      if (n === 0) tool('DeviceList', {})
      else if (n === 1) tool('AdbShell', { device: 'adb:REG_A_01', command: 'getprop ro.product.model' })
      else if (n === 2) tool('AdbLogcat', { device: 'adb:REG_A_01' })
      else if (n === 3) tool('AdbLogcat', { device: 'adb:REG_A_01', stream_id: logStream })
      else if (n === 4) tool('SerialOpen', { device: 'serial:mock://ttyUSB0', baud: 115200 })
      else if (n === 5) tool('SerialRead', { device: 'serial:mock://ttyUSB0', window_ms: 60000 })
      else if (n === 6) tool('SerialWrite', { device: 'serial:mock://ttyUSB0', data: 'reset\n' })
      else chunk({ role: 'assistant', content: '设备回归完成。' })
      if (n >= 7) chunk({}, 'stop')
      send({
        id: 'chatcmpl-device',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (body.stream === true && lastRole !== 'tool') {
      const previewEdit = latest.match(/^PREVIEW_EDIT (.+)$/m)
      if (previewEdit) {
        // 应用预览：先回复选中的元素，再发一次 Edit，驱动改完自动刷新。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        send({
          id: 'chatcmpl-preview',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '收到选中的元素，修改预览页面。' } }],
        })
        send({
          id: 'chatcmpl-preview',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call_preview_${Date.now()}`,
                    type: 'function',
                    function: {
                      name: 'Edit',
                      arguments: JSON.stringify({
                        file_path: previewEdit[1].trim(),
                        old_string: 'PREVIEW_MARKER',
                        new_string: 'PREVIEW_MARKER_EDITED',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
        send({
          id: 'chatcmpl-preview',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        send({
          id: 'chatcmpl-preview',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const respondTool = (name, input) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        send({
          id: 'chatcmpl-board-tool',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(input) },
                  },
                ],
              },
            },
          ],
        })
        send({
          id: 'chatcmpl-board-tool',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        send({
          id: 'chatcmpl-board-tool',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        })
        res.write('data: [DONE]\n\n')
        res.end()
      }
      const respondToolCalls = (calls) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        send({
          id: 'chatcmpl-inbox-multi',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: calls.map((call, index) => ({
                  index,
                  id: `call_inbox_${Date.now()}_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              },
            },
          ],
        })
        send({
          id: 'chatcmpl-inbox-multi',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        send({
          id: 'chatcmpl-inbox-multi',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        })
        res.write('data: [DONE]\n\n')
        res.end()
      }
      // 收件箱聚合：一轮里两次 Bash 审批，回合结束后应只占一条「最近」记录。
      if (latest.includes('INBOX_MULTI')) {
        respondToolCalls([
          { name: 'Bash', input: { command: 'echo inbox-one', description: '收件箱用例一' } },
          { name: 'Bash', input: { command: 'echo inbox-two', description: '收件箱用例二' } },
        ])
        return
      }
      if (latest.includes('合并到 main 时发生冲突')) {
        respondTool('Bash', {
          command:
            "git merge main --no-edit || { printf 'resolved-by-agent\\n' > conflict.txt && git add conflict.txt && git commit -m 'resolve conflict'; }",
          description: '解决冲突',
        })
        return
      }
      if (allUser.includes('BOARD_PROPOSE')) {
        respondTool('ProposeCards', {
          cards: [
            { title: '回归补测试', prompt: '回复“补测试完成”即可' },
            { title: '回归补文档', prompt: '回复“补文档完成”即可', dependsOn: ['回归补测试'] },
          ],
        })
        return
      }
      const boardWrite = latest.match(/^BOARD_WRITE (.+)$/m)
      if (boardWrite) {
        const [file, ...rest] = boardWrite[1].split(' ')
        respondTool('Write', { file_path: file, content: `${rest.join(' ')}\n` })
        return
      }
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-reg',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '回归会话' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const chunk = (delta, finish = null) =>
      send({
        id: 'chatcmpl-reg',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
    chunk({ role: 'assistant', content: '回归回复。' })
    await sleep(30)
    chunk({}, 'stop')
    send({
      id: 'chatcmpl-reg',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return Object.assign(server, { routeSeen, seenUserTexts })
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 假 SSH：用同样的脚本在本地临时 HOME 里模拟远端，不依赖本机 sshd。 */
function seedFakeSsh(home) {
  const dir = path.join(home, 'fake-ssh')
  const remoteHome = path.join(home, 'fake-remote')
  mkdirSync(dir, { recursive: true })
  mkdirSync(path.join(remoteHome, '.local/bin'), { recursive: true })
  const write = (name, body) => {
    const file = path.join(dir, name)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }
  write(
    'ssh',
    `#!/usr/bin/env node
const net = require('node:net')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const remoteHome = ${JSON.stringify(remoteHome)}
const targetIdx = args.findIndex((a) => /^[^@\\s]+@[^@\\s]+$/.test(a) && !a.startsWith('-'))
if (args.includes('-N')) {
  const i = args.indexOf('-L')
  const parts = String(args[i + 1] || '').split(':')
  const localPort = Number(parts[1])
  const remotePort = Number(parts[3])
  const server = net.createServer((sock) => {
    const up = net.connect(remotePort, '127.0.0.1')
    sock.pipe(up)
    up.pipe(sock)
    sock.on('error', () => up.destroy())
    up.on('error', () => sock.destroy())
  })
  server.listen(localPort, '127.0.0.1')
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  setInterval(() => {}, 1 << 30)
} else {
  if (targetIdx < 0) process.exit(2)
  const env = { ...process.env, HOME: remoteHome }
  delete env.TANDEM_HOME
  delete env.TANDEM_SSH_BIN
  const child = spawn('/bin/sh', ['-s'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  child.on('exit', (code) => process.exit(code ?? 1))
}
`,
  )
  write(
    'scp',
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const remoteHome = ${JSON.stringify(remoteHome)}
const last = args[args.length - 1] || ''
const destRaw = last.slice(last.indexOf(':') + 1)
const dest = destRaw.startsWith('~/')
  ? path.join(remoteHome, destRaw.slice(2))
  : destRaw.startsWith('/')
    ? destRaw
    : path.join(remoteHome, destRaw)
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(args[args.length - 2], dest)
`,
  )
  write(
    'ssh-keyscan',
    `#!/usr/bin/env node
console.log('[127.0.0.1]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeRegressionKey0000000000000000000000')
`,
  )
  write(
    'ssh-keygen',
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('-F')) process.exit(1)
let data = ''
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => console.log('256 SHA256:cmVndGVzdA== fake (ED25519)'))
`,
  )
  writeFileSync(path.join(remoteHome, '.local/bin/systemctl'), '#!/bin/sh\nexit 1\n')
  chmodSync(path.join(remoteHome, '.local/bin/systemctl'), 0o755)
  return dir
}

function startHost({ home, token, hostId, extraEnv = {} }) {
  const configDir = path.join(home, 'tandem')
  const fakeSshDir = seedFakeSsh(home)
  // 假 adb：工作站用例模拟一台手机；序列号可由 FAKE_ADB_SERIAL 覆盖。
  const fakeAdb = path.join(home, 'fake-adb.sh')
  writeFileSync(
    fakeAdb,
    `#!/usr/bin/env bash
set -u
SERIAL="\${FAKE_ADB_SERIAL:-R58M1234}"
MODEL="\${FAKE_ADB_DEVICE:-SM_G950F}"
case "$1" in
  devices)
    echo "List of devices attached"
    echo "\${SERIAL}           device product:reg model:\${MODEL} device:reg transport_id:1"
    ;;
  -s)
    shift; serial="$1"; shift; cmd="\${1:-}"; shift || true
    case "$cmd" in
      shell)
        remote="\${*:-}"
        case "$remote" in
          "getprop ro.product.model") echo "\${MODEL}" ;;
          "getprop ro.build.version.release") echo "14" ;;
          *) echo "[fake-adb \${serial}] shell: \${remote}" ;;
        esac
        ;;
      logcat)
        n=0
        while true; do
          n=$((n+1))
          echo "11-08 12:00:00.000  1234  1234 I FakeApp: device log \${n}"
          sleep 0.3
        done
        ;;
      *) echo "[fake-adb \${serial}] \${cmd} \${*:-}" ;;
    esac
    ;;
  *) echo "[fake-adb] $*" ;;
esac
`,
  )
  chmodSync(fakeAdb, 0o755)
  // 假 gh：PR 聚合用例只打本地 bare 仓库，不连公网。其它用例不会调用它。
  const fakeGh = path.join(home, 'fake-gh')
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const args = process.argv.slice(2)
const state = ${JSON.stringify(path.join(home, 'gh-state.json'))}
const log = ${JSON.stringify(path.join(home, 'gh.log'))}
if (args[0] === '--version') { console.log('gh version 2.60.0 (fake)'); process.exit(0) }
if (args[0] === 'auth') { console.log('github.com\\n  ✓ Logged in to github.com account reg-tester (keyring)'); process.exit(0) }
if (args[0] === 'pr' && args[1] === 'create') {
  const title = args[args.indexOf('--title') + 1] || 'PR'
  const body = args[args.indexOf('--body') + 1] || ''
  const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()
  const info = {
    number: 9,
    url: 'https://github.com/reg/board/pull/9',
    title,
    body,
    branch,
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/reg/board/actions/runs/1' },
    ],
  }
  fs.writeFileSync(state, JSON.stringify(info, null, 2))
  fs.appendFileSync(log, JSON.stringify({ args, branch }) + '\\n')
  console.log(info.url)
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  let info = { number: 9, url: 'https://github.com/reg/board/pull/9', title: '看板 PR', state: 'OPEN', isDraft: false, statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/reg/board/actions/runs/1' },
  ], mergeable: 'MERGEABLE', baseRefName: 'main' }
  try { info = { ...info, ...JSON.parse(fs.readFileSync(state, 'utf8')) } } catch {}
  fs.appendFileSync(log, JSON.stringify({ args }) + '\\n')
  console.log(JSON.stringify(info))
  process.exit(0)
}
console.error('fake gh: unsupported ' + args.join(' '))
process.exit(1)
`,
  )
  chmodSync(fakeGh, 0o755)
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        hostId,
        token,
        idleTimeoutSec: 180,
        resumeOnRestart: 'auto',
        defaultDelegation: 'less',
      },
      null,
      2,
    ),
  )

  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(home, 'home'),
      TANDEM_HOME: configDir,
      TANDEM_SSH_BIN: fakeSshDir,
      TANDEM_FAKE_REMOTE_HOME: path.join(home, 'fake-remote'),
      TANDEM_ADB_BIN: fakeAdb,
      TANDEM_MOCK_SERIAL: '1',
      ...extraEnv,
      TANDEM_GH_PATH: fakeGh,
      CODEX_HOME: path.join(home, 'home', '.codex'),
      // HOME 被替换成临时目录，Playwright 需要显式指向本机已安装的浏览器缓存。
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache', 'ms-playwright'),
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
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${stdout}\n${stderr}`)), 25_000)
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

  return { child, ready, logs: () => `${stdout}\n${stderr}`, configDir }
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
  return res.json()
}

/** 订阅会话并取第一份快照（用于验证首屏下发字节/条数）。 */
function wsSessionSnapshot(base, token, sessionId, tail) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('WS 快照超时'))
    }, 20_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId, ...(tail ? { tail } : {}) }))
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type === 'session_snapshot') {
        clearTimeout(timer)
        ws.close()
        resolve({ msg, bytes: Buffer.byteLength(String(raw)) })
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 造一份带 M/A/D/U、未跟踪目录、Windows 盘符路径的 git 仓库。 */
function seedRepo(repo) {
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'reg@example.com')
  git('config', 'user.name', 'reg')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(path.join(repo, 'docs'), { recursive: true })
  writeFileSync(path.join(repo, 'src/hello.ts'), 'export const hello = 1\n')
  writeFileSync(path.join(repo, 'docs/old.md'), '# old\n')
  writeFileSync(path.join(repo, 'README.md'), '# regrepo\n')
  git('add', '.')
  git('commit', '-qm', 'init')

  writeFileSync(path.join(repo, 'src/hello.ts'), 'export const hello = 2\nexport const world = 3\n')
  writeFileSync(path.join(repo, 'src/staged.ts'), 'export const staged = true\n')
  git('add', 'src/staged.ts')
  rmSync(path.join(repo, 'docs/old.md'))

  mkdirSync(path.join(repo, 'untracked-dir/nested'), { recursive: true })
  writeFileSync(path.join(repo, 'untracked-dir/one.ts'), 'export const one = 1\n')
  writeFileSync(path.join(repo, 'untracked-dir/nested/two.ts'), 'export const two = 2\n')

  // Windows 盘符路径：前端把 /D:/repo/demo.ts 归一化为 D:/repo/demo.ts，
  // Host 在 Linux 上解析为 <repo>/D:/repo/demo.ts。
  mkdirSync(path.join(repo, 'D:/repo'), { recursive: true })
  writeFileSync(path.join(repo, 'D:/repo/demo.ts'), 'const windows = true\n// windows drive file\n')

  // 有未提交改动的 worktree 目录：删除 409 时应能列出文件名与分支。
  const dirty = path.join(path.dirname(repo), 'dirty-wt')
  mkdirSync(dirty, { recursive: true })
  const gitDirty = (...args) => execFileSync('git', args, { cwd: dirty, stdio: 'pipe' })
  gitDirty('init', '-q')
  gitDirty('config', 'user.email', 'reg@example.com')
  gitDirty('config', 'user.name', 'reg')
  writeFileSync(path.join(dirty, 'dirty.txt'), 'clean\n')
  gitDirty('add', '.')
  gitDirty('commit', '-qm', 'init')
  writeFileSync(path.join(dirty, 'dirty.txt'), 'changed\n')
}

/** 应用预览用例的本地 Vite 页面：真实 React 组件 + 可变内容，供自动刷新/对比断言。 */
async function seedPreviewApp(root) {
  mkdirSync(path.join(root, 'src'), { recursive: true })
  try {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  } catch {
    /* 已存在（重复运行）时忽略 */
  }
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  const requests = []
  const blocked = http.createServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host })
    res.writeHead(403)
    res.end('blocked')
  })
  // 探测端口刚释放时可能被 blocked 服务复用，导致 Vite 起不来、预览打开 blocked 页面。
  let blockedPort = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => blocked.listen(0, '0.0.0.0', resolve))
    blockedPort = blocked.address().port
    if (blockedPort !== port) break
    await new Promise((resolve) => blocked.close(resolve))
  }
  assert.notEqual(blockedPort, port, 'blocked 测试服务误占 Vite 端口')

  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'preview-reg-app',
        private: true,
        scripts: { dev: `vite --port ${port}` },
        devDependencies: { vite: '^8.0.0' },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    path.join(root, 'index.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>预览回归页</title>
<style>
  html, body { margin: 0; height: 100%; background: #f6f7fb; font-family: system-ui, sans-serif; }
  main { padding: 24px; }
  h1 { margin: 0 0 72px; font-size: 28px; color: #223; }
  #login { position: fixed; left: 32px; top: 140px; width: 220px; height: 64px; border-radius: 12px; border: 1px solid #9aa; background: #fff; font-size: 20px; }
</style></head>
<body><div id="root"></div><script src="/content.js"></script><script type="module" src="/src/App.tsx"></script></body></html>
`,
  )
  writeFileSync(path.join(root, 'content.js'), 'window.__PREVIEW_TEXT__ = "PREVIEW_MARKER";\n')
  writeFileSync(
    path.join(root, 'src/App.tsx'),
    `import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

function LoginButton({ label }: { label: string }) {
  return (
    <button id="login" aria-label="登录按钮">
      {label}
    </button>
  )
}

function App() {
  const [text] = useState(() => (window as unknown as { __PREVIEW_TEXT__?: string }).__PREVIEW_TEXT__ ?? 'PREVIEW_MARKER')
  useEffect(() => {
    document.title = \`预览回归页 \${text}\`
  }, [text])
  return (
    <main>
      <h1 id="title">{text}</h1>
      <LoginButton label="登录" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
`,
  )
  const child = spawn(path.join(ROOT, 'node_modules/.bin/vite'), [
    '--port',
    String(port),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ], {
    cwd: root,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    logs += chunk
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  const ready = async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const status = await new Promise((resolve) => {
        const req = http.get(
          { hostname: '127.0.0.1', port, path: '/', timeout: 500 },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('timeout', () => {
          req.destroy()
          resolve(0)
        })
        req.on('error', () => resolve(0))
      })
      if (status === 200) return
      await sleep(200)
    }
    throw new Error(`Vite 预览页启动超时\n${logs}`)
  }
  await ready()
  return {
    root,
    port,
    blockedPort,
    requests,
    logs: () => logs,
    close: async () => {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000).then(() => child.kill('SIGKILL')),
      ])
      await new Promise((resolve) => blocked.close(resolve))
    },
  }
}

/** 预置一份 Wiki：页面/手写段落/commit 都可控，UI 用例无需真实模型。 */
function seedWiki(configDir, repo) {
  const hash = createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16)
  const dir = path.join(configDir, 'wiki', hash)
  mkdirSync(path.join(dir, 'pages'), { recursive: true })
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const pages = [
    {
      id: 'overview',
      title: '项目概览',
      kind: 'overview',
      files: ['README.md'],
      auto: '# regrepo 项目概览\n\nMock 概览：回归仓库。\n\n## 如何运行\n\n`npm run build`\n\n## 目录地图\n\n- `src/`\n- `docs/`',
    },
    {
      id: 'm-src',
      title: 'src',
      kind: 'module',
      module: 'src',
      files: ['src/hello.ts'],
      auto: '# src\n\nMock 职责：示例源码。\n\n## 关键文件\n\n- `src/hello.ts`\n\n## 常见改动入口\n\n修改 `src/hello.ts`。',
    },
    {
      id: 'glossary',
      title: '术语表',
      kind: 'glossary',
      files: ['README.md'],
      auto: '# 术语表\n\n- regrepo：回归仓库。',
    },
  ]
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        version: 1,
        project: path.resolve(repo),
        name: 'repo',
        createdAt: Date.now() - 4 * 86_400_000,
        updatedAt: Date.now() - 3 * 86_400_000,
        commit,
        model: 'mock-1',
        pages: pages.map((page) => ({
          id: page.id,
          title: page.title,
          kind: page.kind,
          ...(page.module ? { module: page.module } : {}),
          files: page.files,
          commit,
          updatedAt: Date.now() - 3 * 86_400_000,
          chars: page.auto.length,
        })),
      },
      null,
      2,
    ),
  )
  for (const page of pages) {
    writeFileSync(
      path.join(dir, 'pages', `${page.id}.md`),
      [
        '<!-- tandem-wiki:auto:start -->',
        page.auto,
        '<!-- tandem-wiki:auto:end -->',
        '',
        '<!-- tandem-wiki:manual:start -->',
        page.id === 'm-src' ? '手写：保留这条说明。' : '',
        '<!-- tandem-wiki:manual:end -->',
        '',
      ].join('\n'),
    )
  }
}

function seedData({ configDir, repo, hostId, mockPort, previewCwd, today, day }) {
  const baseUrl = `http://127.0.0.1:${mockPort}/v1`
  const profiles = [
    {
      id: 'p-main',
      name: '主力账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-main',
      models: ['mock-1', 'mock-2'],
      defaultModel: 'mock-1',
      createdAt: Date.now() - 10_000,
      groups: [
        {
          id: 'g1',
          name: '生产',
          apiKey: 'reg-key-g1',
          models: ['mock-1', 'mock-2'],
          defaultModel: 'mock-1',
        },
        {
          id: 'g2',
          name: '备用',
          apiKey: 'reg-key-g2',
          models: ['o3', 'o4-mini'],
          defaultModel: 'o3',
        },
      ],
    },
    {
      id: 'p-custom',
      name: '自建端点',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4321/v1',
      apiKey: 'reg-key-custom',
      models: ['custom-1'],
      defaultModel: 'custom-1',
      createdAt: Date.now() - 20_000,
    },
    {
      id: 'p-quota',
      name: '限流账号',
      kind: 'openai-compatible',
      baseUrl,
      models: ['quota-model'],
      defaultModel: 'quota-model',
      createdAt: Date.now() - 30_000,
      groups: [
        {
          id: 'g-quota-main',
          name: '主分组',
          keys: [{ id: 'k-quota-main', label: '主', apiKey: 'reg-key-quota-main' }],
          models: ['quota-model'],
          defaultModel: 'quota-model',
          fallbackGroupIds: ['g-quota-backup'],
        },
        {
          id: 'g-quota-backup',
          name: '备用分组',
          keys: [{ id: 'k-quota-backup', label: '备', apiKey: 'reg-key-quota-backup' }],
          models: ['quota-backup-model'],
          defaultModel: 'quota-backup-model',
        },
      ],
    },
    {
      id: 'p-route',
      name: '自动路由账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-route',
      models: ['route-mini', 'route-mid', 'route-power'],
      defaultModel: 'route-mini',
      price: {
        'route-mini': { input: 0.1, output: 0.2 },
        'route-mid': { input: 1, output: 2 },
        'route-power': { input: 10, output: 20 },
      },
      createdAt: Date.now() - 28_000,
    },
  ]
  writeJson(path.join(configDir, 'profiles.json'), { profiles })

  const common = {
    cwd: repo,
    profileId: 'p-main',
    groupId: 'g1',
    model: 'mock-1',
    permissionMode: 'default',
    delegation: 'less',
    todos: [],
    allowedTools: [],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.12 },
    env: { repoRoot: repo, repoName: path.basename(repo), branch: 'main' },
    depth: 0,
  }
  const createdAt = Date.now() - 3_600_000
  const message = (id, role, text, extra = {}) => ({
    id,
    role,
    content: [{ type: 'text', text }],
    createdAt: createdAt + Number(id.replace(/\D/g, '') || 0) * 1000,
    ...extra,
  })

  const longMessages = []
  for (let n = 1; n <= 40; n++) {
    longMessages.push(message(`u${n}`, 'user', `第 ${n} 轮：检查文件`))
    longMessages.push(
      message(`a${n}`, 'assistant', `第 ${n} 轮的结果：一切正常。`, {
        model: 'mock-1',
        usage: { inputTokens: 100 + n, outputTokens: 20 + n, costUsd: 0.001 * n },
      }),
    )
  }

  // 分页回归：320 轮 / 640 条消息，首屏应只下发最近 200 条。
  const hugeMessages = []
  for (let n = 1; n <= 320; n++) {
    hugeMessages.push(message(`hu${n}`, 'user', `大会话第 ${n} 轮：检查分页加载`))
    hugeMessages.push(
      message(`ha${n}`, 'assistant', `第 ${n} 轮结果：分页正常。`, { model: 'mock-1' }),
    )
  }

  const linksMessages = [
    message('l1', 'user', '帮我看这两个文件'),
    message(
      'l2',
      'assistant',
      'Windows 盘符链接：[D 盘文件](/D:/repo/demo.ts:2)\n\n行内路径：`D:\\repo\\demo.ts`\n\n相对路径：`src/hello.ts`',
      { model: 'mock-1' },
    ),
  ]

  const mk = (id, title, messages, extra = {}) => ({
    ...common,
    id,
    title,
    messages,
    createdAt,
    updatedAt: Date.now() - (id === 'long' ? 1000 : 2000),
    ...extra,
  })

  const sessions = [
    mk('long', '回归长会话', longMessages),
    mk('huge', '超大会话 · 320 轮', hugeMessages, { updatedAt: Date.now() - 900 }),
    mk('links', '文件链接会话', linksMessages, { updatedAt: Date.now() - 1500 }),
    // 配额交接：主分组第一次请求成功后下一次 429，备用分组接住。
    mk('quota', '配额交接会话', [
      message('q1', 'user', '第一轮：介绍一下项目'),
      message('q2', 'assistant', '配额主分组回复：第一轮完成。', {
        model: 'quota-model',
        usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.001 },
      }),
    ], {
      profileId: 'p-quota',
      groupId: 'g-quota-main',
      model: 'quota-model',
      updatedAt: Date.now() - 1550,
    }),
    mk('nockpt', '无检查点会话', [
      message('n1', 'user', '先看看目录'),
      message('n2', 'assistant', '目录结构如下。', { model: 'mock-1' }),
      message('n3', 'user', '再列一下文件'),
    ]),
    // 状态筛选用：专用未读会话（其他用例不打开它，避免提前清除未读）
    mk('unreadonly', '未读筛选专用会话', [
      message('uo1', 'user', '这个会话只用于未读筛选。'),
      message('uo2', 'assistant', '完成后保持未读。', { model: 'mock-1' }),
    ], { unread: true, updatedAt: Date.now() - 1700 }),
    // 全文搜索：中文短语只出现在 s2，用于断言命中片段与跳转高亮
    mk('search', '全文检索会话', [
      message('s1', 'user', '帮我确认离线索引是否覆盖中文词句。'),
      message('s2', 'assistant', 'Elasticsearch 索引已重建，中文短语检索正常。', {
        model: 'mock-1',
      }),
      message('s3', 'user', '再看一下工具命令。'),
      message('s4', 'assistant', '执行 npm run build 并检查 src/hello.ts。', {
        model: 'mock-1',
      }),
    ], { updatedAt: Date.now() - 1800 }),
    mk('retry', '网络重试会话', [
      message('r1', 'user', '继续'),
      message('r2', 'assistant', '网络不好，稍后重试。'),
    ], {
      retryInfo: { attempt: 2, nextAt: Date.now() + 60_000, lastError: 'ECONNREFUSED' },
      updatedAt: Date.now() - 500,
    }),
    mk(
      'wt',
      '重构 worktree 缓存',
      [message('w1', 'user', '改缓存层'), message('w2', 'assistant', '好的。')],
      {
        cwd: path.join(configDir, '..', 'cache-worktree'),
        worktreeRepoRoot: repo,
        worktree: {
          path: path.join(configDir, '..', 'cache-worktree'),
          branch: 'tandem/cache',
          baseBranch: 'main',
        },
        updatedAt: Date.now() - 2500,
      },
    ),
    mk('secrets', 'Secrets 打码会话', [
      message('s1', 'user', '读一下数据库密码'),
      {
        id: 's2',
        role: 'assistant',
        createdAt,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我运行命令看看。' },
          {
            type: 'tool_use',
            id: 'tu-secret',
            name: 'Bash',
            input: { command: 'echo $DB_PASSWORD; env | grep DB_; printf %s "$DB_PASSWORD" | base64' },
          },
        ],
      },
      {
        id: 's3',
        role: 'user',
        createdAt: createdAt + 2000,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-secret',
            content:
              'DB_PASSWORD=[secret:DB_PASSWORD]\n[secret:DB_PASSWORD]\n[secret:DB_PASSWORD]',
          },
        ],
      },
    ], { updatedAt: Date.now() - 1700 }),
    // 分屏：两个独立会话，待办用于验证右栏跟随聚焦窗格。
    mk('split-a', '分屏会话 A', [
      message('spa1', 'user', '分屏 A 的第一条消息'),
      message('spa2', 'assistant', '分屏 A 已有回复。', { model: 'mock-1' }),
    ], {
      todos: [{ content: '分屏 A 的待办', status: 'pending' }],
      updatedAt: Date.now() - 1600,
    }),
    mk('inboxmulti', '收件箱聚合用例', [
      message('im1', 'user', '跑两条命令看看。'),
      message('im2', 'assistant', '收到。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 100 }),
    mk('split-b', '分屏会话 B', [
      message('spb1', 'user', '分屏 B 的第一条消息'),
      message('spb2', 'assistant', '分屏 B 已有回复。', { model: 'mock-1' }),
    ], {
      todos: [{ content: '分屏 B 的待办', status: 'pending' }],
      updatedAt: Date.now() - 1650,
    }),
  ]
  // 待审批会话：Host 启动时按 resumeState 恢复并重新广播权限请求，供手机审批卡走查。
  const approveAt = Date.now() - 1200
  sessions.push({
    ...common,
    id: 'approve',
    title: '等待审批的会话',
    messages: [
      {
        id: 'ap1',
        role: 'user',
        content: [{ type: 'text', text: '跑一下测试，然后再提交。' }],
        createdAt: approveAt - 5000,
      },
      {
        id: 'ap2',
        role: 'assistant',
        content: [
          { type: 'text', text: '我先运行测试。' },
          { type: 'tool_use', id: 'tu-ap', name: 'Bash', input: { command: 'npm test' } },
        ],
        createdAt: approveAt - 4000,
        model: 'mock-1',
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: ['ap1', 'ap2'],
      queue: [],
      inFlightTools: [{ id: 'tu-ap', name: 'Bash', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: 'perm-ap',
          sessionId: 'approve',
          toolUseId: 'tu-ap',
          toolName: 'Bash',
          input: { command: 'npm test' },
          description: '运行命令: npm test',
        },
      ],
      phase: 'tools',
      permissionMode: 'default',
      assistantMessageId: 'ap2',
    },
  })
  // 审批策略学习：同类请求已批准多次的会话（快捷选项）与危险命令会话（不应出现快捷选项）。
  const pendingSession = (id, title, command, toolUseId) => ({
    ...common,
    id,
    title,
    messages: [
      message(`${id}1`, 'user', '继续'),
      {
        id: `${id}2`,
        role: 'assistant',
        createdAt: approveAt - 4000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先跑一下。' },
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } },
        ],
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: [`${id}1`, `${id}2`],
      queue: [],
      inFlightTools: [{ id: toolUseId, name: 'Bash', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: `perm-${id}`,
          sessionId: id,
          toolUseId,
          toolName: 'Bash',
          input: { command },
          description: `运行命令: ${command}`,
        },
      ],
      phase: 'tools',
      permissionMode: 'default',
      assistantMessageId: `${id}2`,
    },
  })
  sessions.push(pendingSession('learn', '学习审批的会话', 'vitest run', 'tu-learn'))
  sessions.push(pendingSession('danger', '危险命令审批会话', 'rm -rf build', 'tu-danger'))

  // 命令沙箱：acceptEdits 下写工作目录之外仍必须出现审批卡（沙箱说明由 Host 恢复时重算）。
  const outsideWrite = path.join(os.homedir(), 'tandem-reg-outside.txt')
  sessions.push({
    ...common,
    id: 'outside',
    title: '越界写入审批会话',
    permissionMode: 'acceptEdits',
    messages: [
      message('o1', 'user', '把结果写到工作目录外。'),
      {
        id: 'o2',
        role: 'assistant',
        createdAt: approveAt - 4000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我写一个文件。' },
          { type: 'tool_use', id: 'tu-outside', name: 'Write', input: { file_path: outsideWrite, content: 'x' } },
        ],
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: ['o1', 'o2'],
      queue: [],
      inFlightTools: [{ id: 'tu-outside', name: 'Write', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: 'perm-outside',
          sessionId: 'outside',
          toolUseId: 'tu-outside',
          toolName: 'Write',
          input: { file_path: outsideWrite, content: 'x' },
          description: `写入文件: ${outsideWrite}`,
        },
      ],
      phase: 'tools',
      permissionMode: 'acceptEdits',
      assistantMessageId: 'o2',
    },
  })

  // 审批历史：vitest run 批准 4 次；rm -rf 也批准过 4 次（危险命令只能建议「询问」）。
  const approvalAt = Date.now()
  const approvalRows = []
  for (let i = 0; i < 4; i++) {
    approvalRows.push({
      at: approvalAt - (10 + i) * 60_000,
      project: repo,
      tool: 'Bash',
      key: 'vitest run',
      decision: 'allow',
    })
  }
  for (let i = 0; i < 4; i++) {
    approvalRows.push({
      at: approvalAt - (20 + i) * 60_000,
      project: repo,
      tool: 'Bash',
      key: 'rm',
      decision: 'allow',
      danger: '删除命令 rm',
    })
  }
  approvalRows.push({
    at: approvalAt - 30 * 60_000,
    project: repo,
    tool: 'Bash',
    key: 'git push',
    decision: 'deny',
    danger: 'git push',
  })
  writeFileSync(
    path.join(configDir, 'approvals.jsonl'),
    approvalRows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  writeFileSync(
    path.join(configDir, 'approval-stats.jsonl'),
    [
      { at: approvalAt - 40 * 60_000, project: repo, tool: 'Read', action: 'allow' },
      { at: approvalAt - 35 * 60_000, project: repo, tool: 'Bash', action: 'allow' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )

  mkdirSync(path.join(configDir, '..', 'cache-worktree'), { recursive: true })
  const wtSession = sessions.find((s) => s.id === 'wt')
  if (wtSession) wtSession.cwd = path.join(configDir, '..', 'cache-worktree')
  const dirtyWt = path.join(configDir, '..', 'dirty-wt')
  sessions.push(
    mk(
      'wtdirty',
      '未提交改动的 worktree',
      [message('d1', 'user', '改一下文件'), message('d2', 'assistant', '已修改。', { model: 'mock-1' })],
      {
        cwd: dirtyWt,
        worktreeRepoRoot: repo,
        worktree: { path: dirtyWt, branch: 'tandem/dirty', baseBranch: 'main' },
      },
    ),
  )
  // 浏览器工具调用过的会话：工具卡 + 截图 image block。
  sessions.push({
    ...common,
    id: 'browser',
    title: '浏览器走查会话',
    messages: [
      message('b1', 'user', '打开本地页面并截图。'),
      {
        id: 'b2',
        role: 'assistant',
        createdAt: createdAt + 20_000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先打开页面。' },
          { type: 'tool_use', id: 'bu-n', name: 'browser_navigate', input: { url: 'http://127.0.0.1:9/' } },
          { type: 'tool_use', id: 'bu-s', name: 'browser_screenshot', input: {} },
        ],
      },
      {
        id: 'b3',
        role: 'user',
        createdAt: createdAt + 30_000,
        content: [
          { type: 'tool_result', toolUseId: 'bu-n', content: '已打开 http://127.0.0.1:9/\n标题：走查页面' },
          {
            type: 'tool_result',
            toolUseId: 'bu-s',
            content: '截图 screenshotId=shot_reg（800×600）\n页面：http://127.0.0.1:9/\n标题：走查页面',
          },
          {
            type: 'image',
            mediaType: 'image/png',
            dataBase64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        ],
      },
    ],
    createdAt: createdAt + 15_000,
    updatedAt: createdAt + 35_000,
  })
  if (previewCwd) {
    sessions.push(
      mk(
        'preview',
        '应用预览回归会话',
        [
          message('pv1', 'user', '打开应用预览看看。'),
          message('pv2', 'assistant', '已准备好预览。', { model: 'mock-1' }),
        ],
        { cwd: previewCwd, permissionMode: 'acceptEdits' },
      ),
    )
  }
  for (const session of sessions) writeJson(path.join(configDir, 'sessions', `${session.id}.json`), session)

  writeJson(path.join(configDir, 'usage.json'), {
    rows: [
      { day: today, hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 12000, outputTokens: 3000, costUsd: 0.84, turns: 4 },
      { day: day(1), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 9000, outputTokens: 2200, costUsd: 0.61, turns: 3 },
      { day: day(2), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 5000, outputTokens: 1000, costUsd: 0.32, turns: 2 },
      { day: day(3), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 3000, outputTokens: 700, costUsd: 0.18, turns: 1 },
    ],
  })

  writeJson(path.join(configDir, 'permissions.json'), [
    { tool: 'Bash', pattern: 'npm test*', action: 'ask' },
  ])

  writeJson(path.join(configDir, 'mcp.json'), {
    servers: [{ name: 'reg-fs', command: '/nonexistent/mcp-reg', args: [], enabled: true }],
  })

  mkdirSync(path.join(configDir, 'memory'), { recursive: true })
  writeFileSync(
    path.join(configDir, 'memory', '_global.md'),
    `<!-- tandem-memory ${JSON.stringify({ project: 'reg' })} -->\n- 用户喜欢深色主题\n- 默认使用中文\n`,
  )

  seedEvals(configDir, repo)
}

/** 评测页走查数据：两个用例 × 两个配置，带完整轨迹。 */
function seedEvals(configDir, repo) {
  const now = Date.now()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  const mkCase = (name, title) => ({
    suite: 'default',
    name,
    title,
    initialPrompt: title,
    snapshot: { mode: 'git', cwd: repo, repoPath: repo, commit },
    checkCommand: 'test -f README.md',
    createdAt: now - 700_000,
  })
  const cases = [mkCase('reg-case-a', '回归用例 A'), mkCase('reg-case-b', '回归用例 B')]
  for (const item of cases) writeJson(path.join(configDir, 'evals/default', `${item.name}.json`), item)
  const configs = [
    { id: 'cfg-a', name: '配置 1', profileId: 'p-main', groupId: 'g1', model: 'mock-1' },
    { id: 'cfg-b', name: '配置 2', profileId: 'p-main', groupId: 'g2', model: 'o3' },
  ]
  const results = []
  for (const item of cases) {
    for (const config of configs) {
      const passed = config.id === 'cfg-a'
      results.push({
        caseName: item.name,
        caseTitle: item.title,
        configId: config.id,
        configName: config.name,
        status: 'done',
        completed: true,
        passed,
        check: { command: 'test -f README.md', exitCode: passed ? 0 : 1, ok: passed, output: '', durationMs: 8 },
        turns: 2,
        toolCalls: 3,
        usage: { inputTokens: 900, outputTokens: 120 },
        costUsd: 0.01,
        durationMs: 40_000,
        messages: [
          { id: `u-${item.name}-${config.id}`, role: 'user', createdAt: now - 50_000, content: [{ type: 'text', text: item.title }] },
          { id: `a-${item.name}-${config.id}`, role: 'assistant', createdAt: now - 40_000, model: config.model, content: [{ type: 'text', text: passed ? '完成。' : '未完成。' }] },
        ],
      })
    }
  }
  writeJson(path.join(configDir, 'evals/runs/run_reg.json'), {
    id: 'run_reg',
    suite: 'default',
    status: 'done',
    startedAt: now - 3_600_000,
    finishedAt: now - 3_500_000,
    configs,
    concurrency: 2,
    total: results.length,
    finished: results.length,
    results,
  })
}

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const A11Y_SEVERE = new Set(['serious', 'critical'])

/** axe 扫描：严重（serious）与关键（critical）违规必须为 0，否则本步失败。 */
async function auditA11y(page, label) {
  // 等侧栏/消息的入场动画结束，避免把动画中的半透明文字算成对比度违规。
  await page.waitForTimeout(350)
  const analysis = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze()
  const severe = analysis.violations.filter((v) => A11Y_SEVERE.has(v.impact))
  const detail = severe
    .map((v) => `${v.id}(${v.nodes.length} 节点)`)
    .join('、')
  console.log(`  a11y ${label}: 严重/关键 ${severe.length} 条规则${detail ? ` — ${detail}` : ''}`)
  for (const violation of severe) {
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(
        `    - ${violation.id} ${node.target.join(' ')}\n      ${(node.html ?? '').slice(0, 220)}\n      ${(node.failureSummary ?? '').split('\n').slice(1, 2).join(' ')}`,
      )
    }
  }
  assert.equal(severe.length, 0, `${label} 存在严重/关键无障碍违规：${detail}`)
  return analysis
}

function assertNoOverflow(name, info) {
  assert.ok(info.scrollWidth <= info.clientWidth + 1, `${name}: scrollWidth ${info.scrollWidth} > clientWidth ${info.clientWidth}`)
}

function withinViewport(box, viewport, label) {
  assert.ok(box, `${label}: 没有可测量的盒子`)
  assert.ok(box.x >= -1, `${label}: 左缘越界 x=${box.x}`)
  assert.ok(box.y >= -1, `${label}: 上缘越界 y=${box.y}`)
  assert.ok(box.x + box.width <= viewport.width + 1, `${label}: 右缘越界 ${box.x + box.width} > ${viewport.width}`)
  assert.ok(box.y + box.height <= viewport.height + 1, `${label}: 下缘越界 ${box.y + box.height} > ${viewport.height}`)
}

/**
 * 等元素上的入场动画结束再测量：弹层带 scale(0.97) 的 chat-pop-in，
 * 动画途中测得的高度/位置都是缩小的中间态（44px 会读成 43px）。
 */
async function waitAnimations(locator) {
  await locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})))
  })
}

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-reg-'))
  const configDir = path.join(home, 'tandem')
  const repo = path.join(home, 'repo')
  const shots = path.join(home, 'shots')
  mkdirSync(shots, { recursive: true })
  const token = randomUUID()
  const hostId = randomUUID()

  const provider = createMockProvider()
  const mockPort = await listen(provider)
  // 预览页先启动，避免 Host 在会话文件写入前完成加载；Host 仍只监听本机。
  const previewApp = await seedPreviewApp(path.join(home, 'preview-app'))
  const host = startHost({ home, token, hostId })
  // 造数用的「今天」固定为脚本启动时刻；页面里也用 page.clock 固定到同一时刻，
  // 否则跨零点运行时界面已经进入新的一天，与造好的用量行错位。
  const today = new Date()
  const dayString = (offset) => {
    const d = new Date(today)
    d.setDate(d.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  let browser
  const failures = []
  let passed = 0

  try {
    seedRepo(repo)
    seedWiki(configDir, repo)
    seedData({
      configDir,
      repo,
      hostId,
      mockPort,
      previewCwd: previewApp.root,
      today: dayString(0),
      day: dayString,
    })

    const hostPort = await host.ready
    const base = `http://127.0.0.1:${hostPort}`
    const appUrl = `${base}/?token=${token}#/h/${hostId}`

    // 全文搜索 API：中英文短语都能命中同一条消息，并返回片段/消息 id。
    const zhSearch = await api(
      base,
      token,
      `/api/search?q=${encodeURIComponent('中文短语')}`,
    )
    assert.ok(
      zhSearch.hits.some(
        (hit) =>
          hit.sessionId === 'search' &&
          hit.messageId === 's2' &&
          hit.snippet.includes('中文短语'),
      ),
      `中文全文搜索未命中：${JSON.stringify(zhSearch.hits.slice(0, 2))}`,
    )
    const enSearch = await api(
      base,
      token,
      `/api/search?q=${encodeURIComponent('Elasticsearch 索引')}`,
    )
    assert.ok(
      enSearch.hits.some((hit) => hit.sessionId === 'search' && hit.messageId === 's2'),
      `英文全文搜索未命中：${JSON.stringify(enSearch.hits.slice(0, 2))}`,
    )

    // 项目 Wiki：元数据、检索与手写段落。
    const wikiMeta = await api(base, token, `/api/wiki?project=${encodeURIComponent(repo)}`)
    assert.ok(wikiMeta.exists && wikiMeta.pages.length === 3, `Wiki 元数据异常：${JSON.stringify(wikiMeta)}`)
    assert.equal(wikiMeta.commit.length, 7, 'Wiki 记录 7 位 commit')
    const wikiSearch = await api(
      base,
      token,
      `/api/wiki/search?project=${encodeURIComponent(repo)}&q=${encodeURIComponent('Mock 职责')}`,
    )
    assert.ok(wikiSearch.hits.some((hit) => hit.pageId === 'm-src'), `Wiki 检索未命中：${JSON.stringify(wikiSearch)}`)

    // 团队：一次真实邀请 + 接受，供成员页/审计断言。
    const invite = await api(base, token, '/api/team/invites', {
      method: 'POST',
      body: JSON.stringify({ role: 'approver', projectDirs: [repo] }),
    })
    const accepted = await fetch(`${base}/api/team/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code, name: '王敏' }),
    })
    assert.ok(accepted.ok, `接受邀请失败：${accepted.status}`)

    // 账号制工作区：中心 + 第二台 Host 加入；账号登录、范围限制、吊销立即生效、刷新轮换。
    {
      const accountsHome = path.join(home, 'accounts-host')
      const accountsToken = randomUUID()
      const accountsHostId = randomUUID()
      const accountsHost = startHost({ home: accountsHome, token: accountsToken, hostId: accountsHostId })
      try {
        const accountsPort = await accountsHost.ready
        const accountsBase = `http://127.0.0.1:${accountsPort}`
        const setup = await api(base, token, '/api/accounts/setup', {
          method: 'POST',
          body: JSON.stringify({ name: '回归工作区', username: 'reg-owner', password: 'owner-pass-123' }),
        })
        assert.equal(setup.workspace.centerHostId, hostId, '工作区中心应为当前 Host')
        const login = async (username, password) => {
          const res = await fetch(`${base}/api/accounts/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password }),
          })
          assert.ok(res.ok, `账号登录失败：${username} ${res.status}`)
          return res.json()
        }
        const ownerLogin = await login('reg-owner', 'owner-pass-123')
        assert.equal(ownerLogin.account.role, 'owner')
        const code = await api(base, token, '/api/accounts/workspace/join-code', { method: 'POST', body: '{}' })
        const joined = await api(accountsBase, accountsToken, '/api/accounts/workspace/join', {
          method: 'POST',
          body: JSON.stringify({ centerUrl: base, code: code.code }),
        })
        assert.equal(joined.workspace.id, setup.workspace.id, '第二台 Host 加入的工作区应一致')
        const collaborator = await api(base, token, '/api/accounts/accounts', {
          method: 'POST',
          body: JSON.stringify({
            username: 'reg-collab',
            password: 'collab-pass-123',
            name: '回归协作者',
            role: 'collaborator',
            scope: 'hosts',
            hostIds: [accountsHostId],
          }),
        })
        const collabLogin = await login('reg-collab', 'collab-pass-123')
        assert.deepEqual(collabLogin.hosts.map((h) => h.id), [accountsHostId], '协作者只应拿到被授权的 Host')
        const okOnSecond = await fetch(`${accountsBase}/api/host`, {
          headers: { authorization: `Bearer ${collabLogin.accessToken}` },
        })
        assert.ok(okOnSecond.ok, '账号令牌应在被授权的 Host 上可用')
        const deniedOnCenter = await fetch(`${base}/api/host`, {
          headers: { authorization: `Bearer ${collabLogin.accessToken}` },
        })
        assert.equal(deniedOnCenter.status, 401, '范围外 Host 应拒绝账号令牌')
        // 观察者可以读，但不能新建会话/发消息。
        const observer = await api(base, token, '/api/accounts/accounts', {
          method: 'POST',
          body: JSON.stringify({ username: 'reg-observer', password: 'observer-pass-123', role: 'observer', scope: 'all' }),
        })
        const observerLogin = await login('reg-observer', 'observer-pass-123')
        const observerRead = await fetch(`${accountsBase}/api/host`, {
          headers: { authorization: `Bearer ${observerLogin.accessToken}` },
        })
        assert.ok(observerRead.ok, '观察者应能读取')
        const observerWrite = await fetch(`${accountsBase}/api/sessions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${observerLogin.accessToken}`, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(observerWrite.status, 403, '观察者新建会话应 403')
        // 刷新令牌一次性轮换。
        const refreshed = await fetch(`${base}/api/accounts/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: ownerLogin.refreshToken }),
        })
        assert.ok(refreshed.ok, '刷新令牌应可用')
        const reused = await fetch(`${base}/api/accounts/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: ownerLogin.refreshToken }),
        })
        assert.equal(reused.status, 401, '旧刷新令牌重放应被拒绝')
        // 吊销协作者后，第二台 Host 立即拒绝（中心签名快照推送 + 轮询兜底）。
        const revokeRes = await fetch(`${base}/api/accounts/accounts/${collaborator.id}/revoke`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.ok(revokeRes.ok, `吊销账号失败：${revokeRes.status} ${await revokeRes.text()}`)
        let revokedStatus = 0
        for (let i = 0; i < 25; i += 1) {
          const res = await fetch(`${accountsBase}/api/host`, {
            headers: { authorization: `Bearer ${collabLogin.accessToken}` },
          })
          revokedStatus = res.status
          if (revokedStatus === 401) break
          await sleep(200)
        }
        assert.equal(revokedStatus, 401, '吊销后第二台 Host 应立即失效')
        assert.ok(observer.id, '观察者账号创建成功')
        // 单机模式：主 token 不受工作区影响。
        const ownerStillWorks = await fetch(`${accountsBase}/api/host`, {
          headers: { authorization: `Bearer ${accountsToken}` },
        })
        assert.ok(ownerStillWorks.ok, '单机主 token 应照旧可用')
      } finally {
        accountsHost.child.kill('SIGTERM')
      }
    }

    browser = await chromium.launch({ headless: true })
    const desktopContext = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
    const mobileContext = await browser.newContext({
      viewport: MOBILE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const smallContext = await browser.newContext({
      viewport: SMALL,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })

    const checks = []
    const desktop = (name, fn) => checks.push({ name, viewport: 'desktop', fn })
    const mobile = (name, fn) => checks.push({ name, viewport: 'mobile', fn })
    const small = (name, fn) => checks.push({ name, viewport: 'small', fn })

    const newPage = async (ctx, viewport) => {
      const page = await ctx.newPage()
      page.setDefaultTimeout(15_000)
      // 所有页面统一固定在造数时刻：日期、相对时间、倒计时都以同一「今天」计算。
      await page.clock.setFixedTime(today)
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
      // 手机首页默认可能是收件箱页签（有待审批时没有输入框），用「新会话」按钮兜底。
      await page
        .locator('textarea[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      // 升级导览卡固定在右下角；先关掉，避免遮挡后续用例的点击（专门的导览用例会重新触发）。
      await page
        .locator('[aria-label="暂时关闭新功能提示"]')
        .first()
        .waitFor({ state: 'visible', timeout: 1200 })
        .then(() => page.locator('[aria-label="暂时关闭新功能提示"]').first().click())
        .catch(() => {})
      page.__errors = pageErrors
      page.__viewport = viewport
      return page
    }

    const openSession = async (page, id) => {
      // 直接深链会被初始化流程重置回首页（Host 列表晚于路由到达），
      // 先等会话列表就绪，再用 hashchange 走真实路由。
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      // 客户端用自己的 Host id（query token 首次连接时生成），与 Host 配置里的 hostId 不同。
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${id}`)
      await page.waitForFunction(
        (sessionId) => window.location.hash.includes(`/s/${sessionId}`),
        id,
        { timeout: 10_000 },
      )
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(350)
    }

    const waitOnline = async (page) => {
      await page.getByText('在线', { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => {})
    }

    const waitModelReady = async (page) => {
      await page
        .waitForFunction(
          () => {
            const buttons = [...document.querySelectorAll('button[aria-label^="选择模型"]')]
            return buttons.some((b) => (b.textContent ?? '').trim() && !(b.textContent ?? '').includes('选择模型'))
          },
          null,
          { timeout: 10_000 },
        )
        .catch(() => {})
    }

    // 设置导航已分组：旧用例仍按页签名调用，这里映射到「分组页面 + 子页签」。
    const SETTINGS_PAGE_BY_TAB = {
      '通用': 'general',
      '主机': 'hosts',
      'Host 管理': 'hosts',
      '账号与模型': 'profiles',
      '自动路由': 'routing',
      '模型路由': 'routing',
      '用量': 'usage-budgets',
      '预算': 'usage-budgets',
      '用量与预算': 'usage-budgets',
      '权限': 'permissions',
      '权限与安全': 'permissions',
      'Secrets': 'secrets',
      '成员': 'team-shares',
      '团队与共享': 'team-shares',
      '成员与分享': 'team-shares',
      '分享': 'team-shares',
      '子代理': 'agent',
      'Skills': 'agent',
      '提示词': 'agent',
      'Agent 能力': 'agent',
      '定时任务': 'schedules',
      '记忆': 'memory',
      '评测': 'evals',
      '网关': 'gateway',
      '同步与备份': 'sync',
      '外观': 'appearance',
      '通知': 'notifications',
      '语音': 'voice',
      '浏览器': 'browser',
      'MCP': 'extensions',
      'Hooks': 'extensions',
      '扩展': 'extensions',
    }
    const ADVANCED_SETTING_PAGES = new Set(['extensions', 'evals', 'gateway', 'sync'])
    const openSettings = async (page, tab, viewport) => {
      const dialog = page.getByRole('dialog', { name: '设置' })
      if (!(await dialog.isVisible().catch(() => false))) {
        if (viewport === 'mobile') {
          await page.getByRole('button', { name: '打开侧栏' }).click()
          await page.waitForTimeout(350)
          await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
        } else {
          await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
        }
      }
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const pageId = SETTINGS_PAGE_BY_TAB[tab] ?? 'general'
      if (ADVANCED_SETTING_PAGES.has(pageId)) {
        const group = dialog.locator('[data-settings-group="advanced"] > button').first()
        if ((await group.getAttribute('aria-expanded')) === 'false') {
          await group.click()
          await page.waitForTimeout(120)
        }
      }
      await dialog.locator(`[data-settings-page="${pageId}"]`).click()
      await page.waitForTimeout(120)
      const subtab = dialog
        .locator('[data-settings-subtabs]')
        .getByRole('button', { name: tab, exact: true })
      if (await subtab.count()) {
        await subtab.click()
        await page.waitForTimeout(120)
      }
      await page.waitForTimeout(220)
      return dialog
    }

    const closeSettings = async (page) => {
      const dialog = page.getByRole('dialog', { name: '设置' })
      if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      }
    }

    // ---------------------------------------------------------------- desktop

    desktop('长会话打开贴在最新消息', async (page) => {
      await openSession(page, 'long')
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const root = document.querySelector('.chat-scroll')
        const last = document.querySelector('[data-turn-id="u40"]')
        const r = root.getBoundingClientRect()
        const lr = last.getBoundingClientRect()
        return {
          top: root.scrollTop,
          client: root.clientHeight,
          scroll: root.scrollHeight,
          lastTop: lr.top - r.top,
          lastBottom: lr.bottom - r.top,
        }
      })
      assert.ok(info.top + info.client >= info.scroll - 40, `距底部 ${Math.round(info.scroll - info.top - info.client)}px`)
      assert.ok(info.lastTop < info.client && info.lastBottom > 0, '最后一条用户消息不在视口内')
    })

    desktop('大会话首屏只下发尾部消息', async (page) => {
      const tail = await wsSessionSnapshot(base, token, 'huge', 200)
      assert.equal(tail.msg.session.messages.length, 200, '尾部快照条数不是 200')
      assert.equal(tail.msg.session.totalMessages, 640, '尾部快照 totalMessages 不对')
      assert.equal(tail.msg.session.firstMessageId, 'hu221', '尾部快照首条 id 不对')
      assert.equal(tail.msg.truncated, true, '尾部快照未标记 truncated')
      assert.equal(tail.msg.session.hasEarlier, true, '尾部快照未标记还有更早消息')
      assert.ok(tail.bytes < 200 * 1024, `首屏下发 ${(tail.bytes / 1024).toFixed(0)}KB，超过 200KB`)

      // 旧客户端不带 tail：保持全量兼容。
      const full = await wsSessionSnapshot(base, token, 'huge')
      assert.equal(full.msg.session.messages.length, 640, '旧客户端未拿到全量快照')

      await openSession(page, 'huge')
      const button = page.locator('[data-load-earlier] button')
      await button.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await button.innerText(), /已加载 200 \/ 640 条/, '首屏未只加载尾部 200 条')
    })

    desktop('大会话滚到顶加载更早消息且位置不跳', async (page) => {
      await openSession(page, 'huge')
      await page.locator('[data-load-earlier] button').waitFor({ state: 'visible', timeout: 10_000 })
      const before = await page.evaluate(() => {
        const box = document.querySelector('.chat-scroll')
        const boxTop = box.getBoundingClientRect().top
        box.scrollTop = 0
        const row = [...document.querySelectorAll('.msg-row[data-message-id]')].find(
          (el) => el.getBoundingClientRect().top >= boxTop - 2,
        )
        return {
          height: box.scrollHeight,
          top: box.scrollTop,
          id: row?.dataset.messageId,
          offset: row ? row.getBoundingClientRect().top - boxTop : null,
        }
      })
      assert.equal(before.id, 'hu221', `滚动到顶后首条不是 hu221（${before.id}）`)
      await page.waitForFunction(
        (height) => (document.querySelector('.chat-scroll')?.scrollHeight ?? 0) > height + 500,
        before.height,
        { timeout: 20_000 },
      )
      // content-visibility 会在后续帧继续修正行高；等锚点回到原位（最多 5s）再断言。
      await page
        .waitForFunction(
          ({ id, offset }) => {
            const box = document.querySelector('.chat-scroll')
            const row = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.closest('.msg-row')
            if (!box || !row) return false
            return Math.abs(row.getBoundingClientRect().top - box.getBoundingClientRect().top - offset) < 4
          },
          { id: before.id, offset: before.offset },
          { timeout: 5_000 },
        )
        .catch(() => {})
      await page.waitForTimeout(150)
      const after = await page.evaluate((id) => {
        const box = document.querySelector('.chat-scroll')
        const boxTop = box.getBoundingClientRect().top
        const row = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.closest('.msg-row')
        return {
          height: box.scrollHeight,
          top: box.scrollTop,
          offset: row ? row.getBoundingClientRect().top - boxTop : null,
        }
      }, before.id)
      assert.ok(after.top > 500, `加载更早消息后滚动位置跳回顶部：${after.top}`)
      assert.ok(
        after.offset !== null && Math.abs(after.offset - before.offset) < 4,
        `锚点消息位移 ${after.offset - before.offset}px`,
      )
      assert.match(
        await page.locator('[data-load-earlier] button').innerText(),
        /已加载 400 \/ 640 条/,
        '滚到顶没有自动加载更早的一页',
      )
    })

    desktop('轮次大纲跳到未加载的轮', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('[data-load-earlier] button').waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const box = document.querySelector('.chat-scroll')
        const row = document.querySelector('[data-turn-id="hu1"]')
        const gap = document.querySelector('[data-message-gap]')
        return {
          offset: row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top : null,
          client: box.clientHeight,
          gap: !!gap,
          count: document.querySelector('.turn-count')?.textContent ?? '',
          rows: document.querySelectorAll('.msg-row').length,
        }
      })
      assert.ok(info.offset !== null && info.offset >= -4 && info.offset < info.client, `第 1 轮位置 ${info.offset}`)
      assert.ok(info.gap, '跳转到更早的轮后没有缺口占位')
      assert.match(info.count, /第 1 \/ 320 轮/, '轮次大纲没有定位到第 1 轮')
      assert.ok(info.rows > 300, `按需加载后只渲染了 ${info.rows} 行`)
    })

    desktop('上下文面板显示最大占用项', async (page) => {
      await openSession(page, 'long')
      const ring = page.getByRole('button', { name: /^上下文 \d+%/ }).first()
      await ring.click()
      await page.getByText('最占空间').first().waitFor({ state: 'visible', timeout: 5_000 })
      const items = page.locator('[data-context-top="popover"] [data-context-item="true"]')
      const count = await items.count()
      assert.ok(count > 0 && count <= 10, `最大占用项数量 ${count}`)
      const first = await items.first().innerText()
      assert.match(first, /第 \d+ 轮/, `最大占用项缺少轮次：${first}`)
      await page.getByText(/下次自动压缩将在约 \d+% 时触发|自动压缩已关闭/).first().waitFor({
        state: 'visible',
        timeout: 3_000,
      })
      const before = await page.evaluate(
        () => document.querySelector('.chat-scroll')?.scrollTop ?? 0,
      )
      await items.first().click()
      await page.waitForTimeout(700)
      const after = await page.evaluate(
        () => document.querySelector('.chat-scroll')?.scrollTop ?? 0,
      )
      assert.notEqual(after, before, '点击最大占用项后没有跳转到对应消息')
    })

    desktop('配额将尽时交接卡可切换备用分组', async (page) => {
      await openSession(page, 'quota')
      await waitOnline(page)
      await waitModelReady(page)
      const box = page.locator('textarea[aria-label="消息输入框"]').first()
      await box.fill('第二轮：继续实现')
      await box.press('Enter')
      await page.getByText('配额主分组回复：第二次请求完成。').first().waitFor({ timeout: 20_000 })

      // 用量卡显示按当前速度的预估（受限于 Key 限流）
      const quotaLine = page.locator('[data-quota-line="usage"]')
      await quotaLine.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await quotaLine.innerText(), /按当前速度约可再跑 \d+ 轮（受限于：Key 限流）/)

      // 主分组下一次请求 429：出现交接卡（默认策略「询问」）
      await box.fill('第三轮：继续实现')
      await box.press('Enter')
      const card = page.locator('[data-handoff-card="true"]')
      await card.waitFor({ state: 'visible', timeout: 20_000 })
      const cardText = await card.innerText()
      assert.match(cardText, /额度将尽/)
      assert.match(cardText, /切换到 .*备用分组/, `交接卡缺少备用分组：${cardText}`)
      await page.screenshot({ path: path.join(shots, 'quota-handoff-card.png') })

      await card.getByRole('button', { name: /^切换到 / }).click()
      await page.getByText(/已从 .* 交接到 /).first().waitFor({ timeout: 20_000 })
      await page.getByText('配额备用分组回复：已继续。').first().waitFor({ timeout: 20_000 })
      await page.screenshot({ path: path.join(shots, 'quota-handoff-switched.png') })

      const after = await api(base, token, '/api/sessions/quota')
      assert.equal(after.groupId, 'g-quota-backup', '切换后会话应使用备用分组')
      assert.equal(after.model, 'quota-backup-model', '切换后应使用备用分组的默认模型')
      assert.equal(after.handoff?.status, 'done', '交接状态应为 done')
      assert.ok(after.handoff?.checkpointId, '切换前应保存检查点')
      const checkpoints = await api(base, token, '/api/sessions/quota/checkpoints')
      assert.ok(
        checkpoints.some((item) => item.id === after.handoff.checkpointId),
        '检查点列表里找不到交接检查点',
      )
      const quotaAfter = page.locator('[data-quota-line="usage"]')
      assert.match(await quotaAfter.innerText(), /按当前速度约可再跑 \d+ 轮/)
    })


    desktop('Secrets 工具输出显示打码标签', async (page) => {
      await openSession(page, 'secrets')
      await page.locator('.tool-row').first().click()
      const tag = page.locator('[data-secret-redacted="DB_PASSWORD"]').first()
      await tag.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await tag.innerText(), '[secret:DB_PASSWORD]', '打码标签文案不对')
      const detail = await page.locator('.tool-detail').first().innerText()
      assert.ok(detail.includes('[secret:DB_PASSWORD]'), '工具输出里没有打码标签')
      assert.ok(!detail.includes('S3cr3t'), '工具输出泄露了 secret 明文')
      await tag.hover()
      await page.waitForFunction(
        () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
        null,
        { timeout: 5_000 },
      )
      const tip = await page.locator('#tandem-tooltip').innerText()
      assert.match(tip, /已隐藏 secret：DB_PASSWORD/, `hover 提示不对：${tip}`)
    })

    desktop('轮次条点击第 30 轮精准定位（不跳到相邻轮）', async (page) => {
      await openSession(page, 'long')
      const nav = page.locator('nav[aria-label="轮次导航"]')
      await nav.waitFor({ state: 'attached' })
      const hit = page.locator('.turn-hit')
      const hb = await hit.boundingBox()
      assert.ok(hb, '轮次条命中区不存在')
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.waitForTimeout(500)
      assert.equal(await nav.getAttribute('data-open'), 'true', '悬停后大纲未展开')
      const target = await page.evaluate(() => {
        const clip = document.querySelector('.turn-clip').getBoundingClientRect()
        for (const item of document.querySelectorAll('.turn-item')) {
          if ((item.querySelector('.turn-item-n')?.textContent ?? '') !== '30') continue
          const r = item.getBoundingClientRect()
          if (r.top < clip.top - 1 || r.bottom > clip.bottom + 1) continue
          if (Number(getComputedStyle(item).opacity) < 0.5) continue
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        return null
      })
      assert.ok(target, '展开后的面板中找不到第 30 轮行')
      await page.mouse.move(target.x, target.y)
      await page.waitForTimeout(80)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(900)
      assert.equal(await hit.getAttribute('aria-valuenow'), '30', '点击后落点不是第 30 轮')
      const position = await page.evaluate(() => {
        const root = document.querySelector('.chat-scroll')
        const el = root.querySelector('[data-turn-id="u30"]')
        if (!el) return null
        return el.getBoundingClientRect().top - root.getBoundingClientRect().top
      })
      assert.ok(position !== null, '找不到第 30 轮消息')
      assert.ok(position >= -4 && position <= 120, `第 30 轮未定位到视口顶部（${Math.round(position)}px）`)
      assert.match(await nav.innerText(), /第\s*30\s*\/\s*40\s*轮/, '计数胶囊与落点不一致')
    })

    desktop('设置窗口固定尺寸，切换页签不跳动', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const box = await dialog.boundingBox()
      withinViewport(box, DESKTOP, '设置窗口')
      assert.ok(Math.abs(box.width - 1320) <= 2, `设置窗口宽度 ${box.width}，预期 1320`)
      assert.ok(Math.abs(box.height - 920) <= 2, `设置窗口高度 ${box.height}，预期 920`)
      for (const tab of ['权限', 'MCP', '用量', '同步与备份', '外观', '记忆']) {
        await openSettings(page, tab, 'desktop')
        await page.waitForTimeout(160)
        const next = await dialog.boundingBox()
        assert.ok(Math.abs(next.width - box.width) <= 1 && Math.abs(next.height - box.height) <= 1, `切到「${tab}」后尺寸变化`)
        withinViewport(next, DESKTOP, `设置窗口（${tab}）`)
      }
      await closeSettings(page)
    })

    desktop('Host 诊断：面板打开、失败项排在最前、报告不含 Key', async (page) => {
      const dialog = await openSettings(page, 'Host 管理', 'desktop')
      await dialog.getByRole('button', { name: '诊断', exact: true }).first().click()
      const doctor = page.getByRole('dialog', { name: '主机诊断' })
      await doctor.waitFor({ state: 'visible', timeout: 10_000 })
      await doctor.locator('[data-doctor-check]').first().waitFor({ timeout: 60_000 })
      const skipText = (await doctor.locator('[data-doctor-check="profiles"]').textContent()) ?? ''
      assert.ok(skipText.includes('未执行'), `默认不应执行账号连通性：${skipText.slice(0, 80)}`)

      // 勾选后：mock 账号正常，自建端点（127.0.0.1:4321）连不上
      const toggle = doctor.getByRole('switch', { name: '检测账号连通性' })
      await toggle.click()
      await toggle.waitFor({ state: 'visible' })
      await page.waitForFunction(
        () => document.querySelector('[role="switch"][aria-label="检测账号连通性"]')?.getAttribute('aria-checked') === 'true',
        null,
        { timeout: 5_000 },
      )
      await doctor.getByRole('button', { name: '重新检查' }).click()
      await doctor
        .locator('[data-doctor-check^="profile."][data-doctor-status="fail"]')
        .first()
        .waitFor({ timeout: 90_000 })
      const statuses = await doctor
        .locator('[data-doctor-check]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-doctor-status')))
      assert.equal(statuses[0], 'fail', `失败项没有排在最前：${statuses.join(',')}`)
      assert.ok(statuses.lastIndexOf('ok') > statuses.indexOf('fail'), '正常项应排在失败项之后')
      const text = (await doctor.textContent()) ?? ''
      assert.ok(text.includes('自建端点'), '诊断面板缺少坏账号结果')
      assert.ok(text.includes('连接正常'), '诊断面板缺少正常账号结果')
      assert.ok(!/reg-key/.test(text), '诊断面板泄露了 Key')

      await doctor.getByRole('button', { name: '复制报告' }).click()
      await page.waitForTimeout(250)
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
      if (clip) {
        assert.ok(!/reg-key/.test(clip), '诊断报告泄露了 Key')
        assert.ok(/Tandem (主机|Host) 诊断报告/.test(clip), '复制内容不是诊断报告')
      }
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

    desktop('设置弹窗焦点陷阱与关闭后焦点还原', async (page) => {
      await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor()
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), '打开后焦点未进入弹窗')
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
        assert.ok(inside, `第 ${i + 1} 次 Tab 后焦点逃出弹窗`)
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.waitForTimeout(250)
      const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
      assert.match(text, /设置/, '关闭后焦点没有回到「设置」按钮')
    })

    desktop('侧栏会话 ⋯ 菜单与 tooltip 不被裁切', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-session-id="long"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), DESKTOP, '会话操作菜单')
      assert.match(await menu.innerText(), /重命名|置顶|归档/, '会话菜单缺少常用项')
      await page.keyboard.press('Escape')
      await page.mouse.move(DESKTOP.width / 2, DESKTOP.height / 2)
      await page.waitForTimeout(200)
      await row.hover()
      const tip = page.locator('#tandem-tooltip')
      await page.waitForFunction(() => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'), null, { timeout: 5_000 })
      withinViewport(await tip.boundingBox(), DESKTOP, '侧栏 tooltip')
      assert.match(await tip.innerText(), /回归长会话/, 'tooltip 不是会话完整标题')
    })

    desktop('模型菜单级联（账号 → 分组 → 模型）可用且不越界', async (page) => {
      await openSession(page, 'long')
      await waitModelReady(page)
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const rootMenu = page.locator('[role="menu"]').first()
      await rootMenu.waitFor()
      withinViewport(await rootMenu.boundingBox(), DESKTOP, '模型菜单')
      const accountTrigger = page.getByRole('menuitem', { name: /切换账号/ }).first()
      await accountTrigger.hover()
      const accountMenu = page.locator('[aria-label="切换账号"]')
      await accountMenu.waitFor({ state: 'visible' })
      withinViewport(await accountMenu.boundingBox(), DESKTOP, '切换账号子菜单')
      assert.ok((await accountMenu.getByText('生产', { exact: true }).count()) >= 1, '账号子菜单没有列出分组')
      assert.ok((await accountMenu.getByText('备用', { exact: true }).count()) >= 1, '账号子菜单没有列出分组')
      await accountMenu.getByText('备用', { exact: true }).click()
      await page.waitForTimeout(250)
      const response = page.waitForResponse(
        (res) => res.url().includes('/api/sessions/long') && res.request().method() === 'PATCH',
        { timeout: 10_000 },
      )
      await page.getByRole('menuitem', { name: /O3/i }).click()
      await response
      assert.match(await page.getByRole('button', { name: '选择模型' }).first().innerText(), /O3/, '选择后模型按钮未更新')
      const stored = await api(base, token, '/api/sessions/long')
      assert.equal(stored.model, 'o3', '会话模型未落库')
      assert.equal(stored.groupId, 'g2', '会话分组未落库')
    })

    desktop('环境条容器透明、触发器可见且不越界', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        if (!wrap) return null
        const bg = getComputedStyle(wrap).backgroundColor
        const buttons = [...wrap.querySelectorAll(':scope button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { text: b.textContent.trim(), x: r.x, right: r.right, height: r.height, font: getComputedStyle(b).fontSize }
        })
        return { bg, width: wrap.getBoundingClientRect().width, buttons }
      }, repo)
      assert.ok(info, '找不到环境条容器')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条容器不透明：${info.bg}`)
      assert.ok(info.buttons.length >= 3, `环境条只有 ${info.buttons.length} 个触发器`)
      for (const button of info.buttons) {
        assert.ok(button.right <= DESKTOP.width + 1, `环境条「${button.text}」右缘越界 ${button.right}`)
        assert.ok(button.height >= 20, `环境条「${button.text}」高度异常 ${button.height}`)
        assert.ok(parseFloat(button.font) >= 12.5, `环境条「${button.text}」字号 ${button.font}`)
      }
    })

    desktop('环境条文件夹弹层向上弹出且完整可见', async (page) => {
      await openSession(page, 'long')
      const trigger = page.locator(`button[title="${repo}"]`).first()
      await trigger.click()
      const panel = page.locator('[role="menu"].popover-panel').first()
      await panel.waitFor()
      assert.equal(await panel.getAttribute('data-side'), 'top', '文件夹弹层没有向上弹出')
      withinViewport(await panel.boundingBox(), DESKTOP, '文件夹弹层')
      assert.equal(await panel.locator('[aria-label="使用此目录"]').count(), 1, '文件夹弹层内容未加载')
      await page.keyboard.press('Escape')
    })

    desktop('粘贴一次同一张图片只生成一个附件', async (page) => {
      await openSession(page, 'long')
      const textarea = page.locator('textarea[aria-label="消息输入框"]')
      await textarea.evaluate((el) => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1])
        const data = new DataTransfer()
        for (let i = 0; i < 2; i++) data.items.add(new File([bytes], 'same.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await page.waitForTimeout(900)
      assert.equal(await page.getByRole('button', { name: '移除图片' }).count(), 1, '同一张图片被重复添加')
    })

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
      const folderTrigger = page.locator(`button[title="${repo}"]`).first()
      await folderTrigger.click()
      const popover = page.locator('[role="menu"].popover-panel').first()
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

    desktop('模型菜单：单价未设置时可跳到该账号的单价覆盖', async (page) => {
      // 用未被其它用例改过模型的会话，保证看到内置表里没有的 mock-1。
      await openSession(page, 'nockpt')
      await waitModelReady(page)
      const modelButton = page.locator('button[aria-label^="选择模型"]').first()
      await modelButton.click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const setup = menu.getByRole('button', { name: '单价未设置 · 去设置' }).first()
      await setup.waitFor({ timeout: 10_000 })
      assert.equal(await menu.getByText('单价未知', { exact: false }).count(), 0, '仍在显示「单价未知」')
      await setup.click()
      await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const prices = dialog.locator('[data-setting-id="profiles.prices"]')
      await prices.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(await dialog.getByText('自定义单价').first().isVisible(), '没有定位到单价覆盖区')
    })

    desktop('新会话页环境条显示当前分支名而不是「分支」占位词', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('textarea[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      await page.locator('button:has(svg.lucide-folder-open)').first().click()
      const input = page.getByRole('textbox', { name: '筛选文件夹或输入路径' })
      await input.waitFor()
      await input.fill(repo)
      await input.press('Enter')
      const branchButton = page.locator('button[title="创建会话后可切换分支"]').first()
      await branchButton.waitFor()
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('button[title="创建会话后可切换分支"]')].some(
            (b) => (b.textContent ?? '').trim() === 'main',
          ),
        null,
        { timeout: 10_000 },
      )
      const label = ((await branchButton.textContent()) ?? '').trim()
      assert.equal(label, 'main', `环境条分支显示为「${label}」`)
    })

    desktop('Windows 盘符路径文件链接可打开预览', async (page) => {
      await openSession(page, 'links')
      const link = page.locator('a[title^="打开 D:/"]').first()
      await link.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.locator('[title*="D:/repo/demo.ts"]').count() > 0, true, '预览路径未归一化为 D:/repo/demo.ts')
      await page.getByRole('button', { name: '关闭文件预览' }).click()
      const inline = page.locator('code.file-ref-inline').first()
      await inline.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '关闭文件预览' }).click()
    })

    desktop('改动审阅把未跟踪目录展开为文件', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('one.ts', { exact: true }).waitFor({ timeout: 10_000 })
      assert.equal(await panel.getByText('two.ts', { exact: true }).count(), 1, '未跟踪目录里的嵌套文件没有展开')
      await panel.getByText('one.ts', { exact: true }).click()
      await panel.getByText(/export const one/).waitFor({ timeout: 10_000 })
    })

    desktop('改动审阅行内评论浮窗与行标记', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('hello.ts', { exact: true }).waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      const row = panel.locator('.chat-diff-row[data-kind="add"]').first()
      await row.waitFor({ timeout: 10_000 })
      const rb = await row.boundingBox()
      assert.ok(rb, '没有可评论的 diff 行')
      await page.mouse.click(rb.x + 120, rb.y + rb.height / 2)
      const input = page.getByRole('textbox', { name: '行内评论' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('这里需要调整')
      await input.press('Enter')
      await page.waitForTimeout(400)
      assert.ok((await panel.locator('.diff-comment-btn').count()) >= 1, '评论发送后行右侧没有标记')
      assert.ok((await panel.locator('[data-commented="true"]').count()) >= 1, '评论行没有 data-commented 标记')
      assert.match(
        await panel.getByRole('button', { name: /1 条待发送评论/ }).first().innerText(),
        /1 条评论/,
      )
    })

    desktop('提交前 AI 评审挂行、忽略无效行并采纳意见', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByText('hello.ts', { exact: true }).waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      await panel.getByRole('button', { name: 'AI 评审', exact: true }).click()
      await panel.getByText('有阻塞问题').waitFor({ timeout: 20_000 })
      const text = await panel.innerText()
      assert.match(text, /已忽略 1 条指向不存在行的意见/, '无效行意见没有被忽略并提示')
      assert.match(text, /阻塞 1 · 警告 0 · 细节 1/, '评审结论计数不正确')
      const markers = panel.locator('.diff-comment-btn[data-ai]')
      await markers.first().waitFor({ timeout: 10_000 })
      assert.equal(await markers.count(), 2, 'blocker 与 nit 应各有一个行标记')
      assert.ok((await panel.getByText('1 个阻塞').count()) >= 1, '提交按钮旁没有阻塞提示')
      await markers.first().click()
      await page.getByRole('button', { name: '采纳', exact: true }).click()
      await page
        .getByRole('button', { name: /1 条待发送评论/ })
        .first()
        .waitFor({ timeout: 5_000 })
      assert.match(await panel.innerText(), /1 条评论/, '采纳后没有进入待发送评论')
      assert.equal(await panel.locator('.diff-comment-btn[data-ai]').count(), 1, '采纳后的 AI 标记应移除')
    })

    desktop('改动审阅提交范围带文件数与二次确认', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      const commitButton = panel.getByRole('button', { name: /^提交 \d+ 个文件$/ })
      await commitButton.waitFor({ timeout: 10_000 })
      const label = await commitButton.innerText()
      const count = Number(/(\d+)/.exec(label)?.[1] ?? 0)
      assert.ok(count >= 5, `提交按钮只显示 ${count} 个文件`)
      await panel.getByPlaceholder('提交信息').fill('回归提交')
      await commitButton.click()
      const confirm = page.getByRole('dialog', { name: '提交全部改动' })
      await confirm.waitFor({ state: 'visible' })
      withinViewport(await confirm.boundingBox(), DESKTOP, '提交确认弹窗')
      assert.match(await confirm.innerText(), /未跟踪文件/)
      assert.match(await confirm.innerText(), new RegExp(`全部\\s*${count}\\s*个文件`))
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
    })

    desktop('自定义兼容账号显示「自定义接口」而不是 DeepSeek', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      await dialog.getByText('自建端点').waitFor()
      await dialog.getByRole('button', { name: '编辑 自建端点' }).click()
      const editor = page.getByRole('dialog')
      await editor.getByText('自定义接口').first().waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await editor.getByText('DeepSeek').count(), 0, '自定义端点被误标为 DeepSeek')
      await page.keyboard.press('Escape')
    })

    desktop('worktree 会话按原仓库归组而不是目录名 cache', async (page) => {
      await openSession(page, 'wt')
      const nav = page.locator('nav[aria-label="会话列表"]')
      await nav.getByText('重构 worktree 缓存').waitFor()
      const text = await nav.innerText()
      assert.match(text, new RegExp(path.basename(repo)), '侧栏没有显示原仓库名')
      const lines = text.split('\n').map((line) => line.trim())
      assert.equal(lines.includes('cache'), false, '侧栏把 worktree 目录当成项目名')
    })

    desktop('无检查点的会话仍可只回退对话', async (page) => {
      await openSession(page, 'nockpt')
      const row = page.locator('[data-turn-id="n3"]').first()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await page.waitForTimeout(300)
      const text = await dialog.innerText()
      assert.match(text, /只能恢复对话/, '没有提示只能恢复对话')
      assert.equal(
        await dialog.getByRole('radio', { name: /恢复代码和对话/ }).isDisabled(),
        true,
        '没有检查点时仍能选择恢复代码',
      )
      await dialog.getByRole('button', { name: '回退', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
      await page.waitForFunction(() => !document.querySelector('[data-turn-id="n3"]'))
      assert.ok(await page.locator('[data-turn-id="n1"]').count(), '回退时误删了更早的消息')
    })

    desktop('删除 dirty worktree 的确认列出文件与分支', async (page) => {
      await openSession(page, 'wtdirty')
      const row = page.locator('[data-session-id="wtdirty"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      await menu.getByRole('menuitem', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog').last()
      await dialog.getByText('确定删除').waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await page.waitForFunction(() => document.body.innerText.includes('tandem/dirty'), null, {
        timeout: 10_000,
      })
      const dirtyDialog = page.getByRole('dialog').filter({ hasText: 'worktree 有未提交改动' })
      const text = await dirtyDialog.innerText()
      assert.match(text, /dirty\.txt/, '二次确认没有列出未提交文件')
      assert.match(text, /tandem\/dirty/, '二次确认没有说明将删除的分支')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    })

    desktop('删除邀请记录需要二次确认', async (page) => {
      await openSettings(page, '成员', 'desktop')
      const remove = page.getByRole('button', { name: '删除邀请' }).first()
      await remove.waitFor({ timeout: 10_000 })
      await remove.click()
      const dialog = page.getByRole('dialog', { name: '删除邀请记录' })
      await dialog.waitFor({ state: 'visible' })
      assert.match(await dialog.innerText(), /王敏|观察者|审批者/, '确认框没有说明要删除的邀请')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await closeSettings(page)
    })

    desktop('移除 MCP 服务器需要二次确认', async (page) => {
      await openSettings(page, 'MCP', 'desktop')
      const remove = page.getByRole('button', { name: '删除 reg-fs' })
      await remove.waitFor({ timeout: 10_000 })
      await remove.click()
      const confirm = page.getByRole('dialog', { name: '移除 MCP 服务器' })
      await confirm.waitFor({ state: 'visible' })
      assert.match(await confirm.innerText(), /mcp\.json/)
      assert.ok(JSON.stringify(JSON.parse(readFileSync(path.join(configDir, 'mcp.json'), 'utf8'))).includes('reg-fs'), '确认前已删除配置')
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await page.waitForTimeout(200)
      assert.ok(JSON.stringify(JSON.parse(readFileSync(path.join(configDir, 'mcp.json'), 'utf8'))).includes('reg-fs'), '取消后配置被删除')
      await closeSettings(page)
    })

    desktop('SSH 一键部署远程主机、流式回复与卸载', async (page) => {
      const remoteName = 'SSH 回归远程'
      const portProbe = http.createServer()
      const sshRemotePort = await listen(portProbe)
      await new Promise((resolve) => portProbe.close(resolve))
      await openSettings(page, '主机', 'desktop')
      await page.locator('[data-setting-id="hosts.ssh.add"]').click()
      const dialog = page.getByRole('dialog', { name: '通过 SSH 添加远程主机' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.locator('[data-setting-id="hosts.ssh.target"]').fill('reg@127.0.0.1')
      await dialog.locator('[data-setting-id="hosts.ssh.port"]').fill('22')
      await dialog.getByRole('button', { name: '私钥文件', exact: true }).click()
      await dialog.locator('[data-setting-id="hosts.ssh.key"]').fill(path.join(home, 'fake-key'))
      await dialog.locator('[data-setting-id="hosts.ssh.name"]').fill(remoteName)
      await dialog.locator('[data-setting-id="hosts.ssh.remotePort"]').fill(String(sshRemotePort))
      await dialog.getByRole('button', { name: '检测主机' }).click()
      await dialog.getByText('主机公钥指纹').waitFor({ timeout: 20_000 })
      assert.match(await dialog.innerText(), /SHA256:/, '没有展示主机公钥指纹')
      await dialog.getByRole('button', { name: '确认指纹并检测' }).click()
      await dialog.getByText('将安装到').waitFor({ timeout: 20_000 })
      assert.match(await dialog.innerText(), /Node v/, '探测结果没有 Node 版本')
      await dialog.locator('[data-setting-id="hosts.ssh.deploy"]').click()
      const item = page.locator('.settings-item').filter({ hasText: remoteName })
      await item.waitFor({ timeout: 180_000 })
      assert.match(await item.innerText(), /SSH/, '主机项没有 SSH 标签')
      assert.match(await item.innerText(), /经 SSH 隧道连接/, '主机项没有隧道信息')
      const hosts = await page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]'))
      const remote = hosts.find((h) => h.name === remoteName)
      assert.ok(remote?.mode === 'ssh' && remote.sshHostId, '远程主机没有按 SSH 模式保存')
      const headers = { Authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' }
      const profileRes = await fetch(`${remote.url}/api/profiles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Mock',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'test',
          models: ['mock-1'],
          defaultModel: 'mock-1',
        }),
      })
      assert.ok(profileRes.ok, '无法在远程 Host 创建账号')
      const profile = await profileRes.json()
      const sessionRes = await fetch(`${remote.url}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cwd: repo,
          profileId: profile.id,
          model: 'mock-1',
          permissionMode: 'bypassPermissions',
          title: 'SSH 回归会话',
        }),
      })
      assert.ok(sessionRes.ok, '无法在远程 Host 创建会话')
      const session = await sessionRes.json()
      await page.evaluate(({ hostId, sessionId }) => {
        window.location.hash = `#/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}`
      }, { hostId: remote.id, sessionId: session.id })
      const composer = page.locator('textarea[aria-label="消息输入框"]')
      await composer.waitFor({ timeout: 20_000 })
      await composer.fill('你好')
      await composer.press('Enter')
      await page.getByText('回归回复。', { exact: true }).first().waitFor({ timeout: 30_000 })

      await openSettings(page, '主机', 'desktop')
      await page.locator('[data-setting-id="hosts.ssh.menu"]').click()
      await page.getByRole('menuitem', { name: '查看日志' }).click()
      const logs = page.getByRole('dialog', { name: /远程日志/ })
      await logs.waitFor({ timeout: 20_000 })
      await page.waitForTimeout(800)
      assert.match(await logs.innerText(), /Tandem Host 已启动/, '日志里没有远程 Host 启动记录')
      await logs.getByRole('button', { name: '关闭', exact: true }).last().click()

      await page.locator('[data-setting-id="hosts.ssh.menu"]').click()
      await page.getByRole('menuitem', { name: '重启', exact: true }).click()
      await page.locator('[data-setting-id="hosts.ssh.job"]').waitFor({ timeout: 20_000 })
      await page.waitForFunction(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((el) =>
          el.querySelector('[data-setting-id="hosts.ssh.job"]'),
        )
        const close = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === '关闭')
        return close && !close.disabled
      }, null, { timeout: 60_000 })
      await page.getByRole('button', { name: '关闭', exact: true }).last().click()

      await page.locator('[data-setting-id="hosts.ssh.menu"]').click()
      await page.getByRole('menuitem', { name: '卸载…' }).click()
      const uninstall = page.getByRole('dialog', { name: '卸载远程主机' })
      await uninstall.waitFor()
      assert.match(await uninstall.innerText(), /保留远程数据/, '卸载确认没有保留数据选项')
      await uninstall.getByRole('button', { name: '取消', exact: true }).click()
      await page.locator('[data-setting-id="hosts.ssh.menu"]').click()
      await page.getByRole('menuitem', { name: '卸载…' }).click()
      await page.locator('[data-setting-id="hosts.ssh.uninstall.confirm"]').click()
      await page.waitForFunction(
        (name) =>
          ![...document.querySelectorAll('.settings-item')].some((el) =>
            (el.textContent ?? '').includes(name),
          ),
        remoteName,
        { timeout: 60_000 },
      )
      await closeSettings(page)
    })

    desktop('只监听回环时「连接手机」不展示二维码', async (page) => {
      await openSettings(page, 'Host 管理', 'desktop')
      await page.getByRole('button', { name: '连接手机' }).first().click()
      const dialog = page.getByRole('dialog', { name: '连接手机' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByText('手机暂时连不上这台主机').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await dialog.locator('[aria-label="配对二维码"]').count(), 0, '回环状态仍渲染了二维码')
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

    desktop('回退对话框引用目标消息并显示删除范围', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-turn-id="u2"]')
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await dialog.getByText('第 2 轮：检查文件').waitFor({ timeout: 5_000 })
      assert.match(await dialog.innerText(), /第 2 轮：检查文件/, '没有展示被回退的用户消息')
      withinViewport(await dialog.boundingBox(), DESKTOP, '回退对话框')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    })

    desktop('同步与备份：空口令时导出按钮禁用', async (page) => {
      await openSettings(page, '同步与备份', 'desktop')
      const exportButton = page.getByRole('button', { name: '导出并下载' })
      await exportButton.waitFor()
      assert.equal(await exportButton.isDisabled(), true, '空口令仍可点击导出')
      await closeSettings(page)
    })

    desktop('同步与备份：替换导入需二次确认并标注危险', async (page) => {
      await openSettings(page, '同步与备份', 'desktop')
      const fileInput = page.locator('input[type="file"][accept*="json"]')
      await fileInput.setInputFiles({
        name: 'tandem-config.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            encrypted: 'AAAA',
            salt: 'AAAA',
            iv: 'AAAA',
            createdAt: Date.now(),
            hostName: 'reg',
          }),
        ),
      })
      await page.getByRole('button', { name: /^替换/ }).click()
      assert.equal(await page.getByRole('button', { name: /^替换/ }).getAttribute('aria-pressed'), 'true')
      await page.getByPlaceholder('导出时设置的口令').fill('reg-pass')
      await page.getByRole('button', { name: '导入配置' }).click()
      const confirm = page.getByRole('dialog', { name: /替换现有配置/ })
      await confirm.waitFor({ state: 'visible', timeout: 3_000 })
      withinViewport(await confirm.boundingBox(), DESKTOP, '替换确认弹窗')
      assert.match(await confirm.innerText(), /账号/, '确认文案没有说明将删除的账号数量')
      assert.match(await confirm.innerText(), /主机/, '确认文案没有说明将删除的主机数量')
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await closeSettings(page)
    })

    desktop('侧栏「新会话」清空草稿并聚焦输入框', async (page) => {
      await openSession(page, 'long')
      const textarea = page.locator('textarea[aria-label="消息输入框"]')
      await textarea.fill('第一段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.inputValue(), '', '已在首页再点「新会话」没有清空草稿')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '消息输入框', '清空后没有聚焦输入框')
      await textarea.fill('第二段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.inputValue(), '', '第二次点击「新会话」没有清空草稿')
    })

    desktop('新会话默认带上工作目录且双击发送只创建一次', async (page) => {
      await waitModelReady(page)
      await page.waitForFunction(
        () => {
          const trigger = [...document.querySelectorAll('button[title]')].find((b) => /^\//.test(b.getAttribute('title') ?? ''))
          return !!trigger
        },
        null,
        { timeout: 10_000 },
      )
      const folderTitle = await page.evaluate(() => {
        const trigger = [...document.querySelectorAll('button[title]')].find((b) => /^\//.test(b.getAttribute('title') ?? ''))
        return trigger?.getAttribute('title') ?? ''
      })
      assert.ok(folderTitle.includes(path.sep), `默认工作目录为空：${folderTitle}`)

      let posts = 0
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') posts += 1
      })
      await page.locator('textarea[aria-label="消息输入框"]').fill('新会话双击发送回归')
      const send = page.getByRole('button', { name: '发送消息' })
      await send.waitFor()
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        return button && !button.disabled
      })
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        button?.click()
        button?.click()
      })
      await page.waitForTimeout(1500)
      assert.equal(posts, 1, `连续点击发送创建了 ${posts} 个会话`)
      const sessions = await api(base, token, '/api/sessions')
      const created = sessions
        .filter((session) => session.title.includes('新会话双击') || session.cwd)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      assert.ok(created?.cwd, '新会话没有工作目录')
      await page.getByText('先选择一个工作目录').waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {})
      assert.equal(await page.getByText('先选择一个工作目录').count(), 0, '发送时仍提示先选择目录')
    })

    desktop('记忆编辑器不暴露内部元数据行', async (page) => {
      const dialog = await openSettings(page, '记忆', 'desktop')
      await dialog.getByRole('button', { name: '编辑 全局' }).click()
      const textarea = page.getByRole('textbox', { name: '记忆 Markdown' })
      await textarea.waitFor({ state: 'visible', timeout: 5_000 })
      const value = await textarea.inputValue()
      assert.equal(value.includes('tandem-memory'), false, '编辑器仍显示内部元数据注释')
      assert.match(value, /用户喜欢深色主题/)
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

    desktop('设置页字号不低于 11px（记忆/提示词/Skills）', async (page) => {
      const dialog = await openSettings(page, '记忆', 'desktop')
      for (const tab of ['记忆', '提示词', 'Skills']) {
        await openSettings(page, tab, 'desktop')
        await page.waitForTimeout(350)
        const smallest = await dialog.evaluate((root) => {
          let min = Infinity
          let text = ''
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walker.nextNode())) {
            const content = node.textContent?.trim()
            if (!content) continue
            const el = node.parentElement
            if (!el) continue
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const rect = el.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) continue
            if (el.closest('svg')) continue
            const size = parseFloat(style.fontSize)
            if (Number.isFinite(size) && size < min) {
              min = size
              text = content.slice(0, 24)
            }
          }
          return { min, text }
        })
        assert.ok(smallest.min >= 10.9, `「${tab}」页出现 ${smallest.min}px 文字：${smallest.text}`)
      }
      await closeSettings(page)
    })

    checks.push({ name: '断网后立即显示重新连接条', viewport: 'desktop', context: 'offline', fn: async (page) => {
      await openSession(page, 'long')
      await page.waitForTimeout(500)
      await page.context().setOffline(true)
      const banner = page.getByText('重新连接中…').first()
      await banner.waitFor({ state: 'visible', timeout: 6_000 })
      await page.context().setOffline(false)
      await page.waitForTimeout(500)
    } })

    checks.push({ name: 'Windows 桌面顶栏 36px 且按钮不溢出', viewport: 'desktop', context: 'win32', fn: async (page) => {
      const header = page.locator('header').first()
      await header.waitFor()
      const info = await header.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const buttons = [...el.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { right: r.right, top: r.top, bottom: r.bottom, height: r.height }
        })
        return {
          height: rect.height,
          paddingRight: getComputedStyle(el).paddingRight,
          overflow: el.scrollWidth > el.clientWidth + 1,
          buttons,
          width: rect.width,
          viewport: window.innerWidth,
        }
      })
      assert.ok(Math.abs(info.height - 36) <= 1, `Windows 顶栏高度 ${info.height}，预期 36`)
      assert.ok(Math.abs(parseFloat(info.paddingRight) - 140) <= 1, `右侧留白 ${info.paddingRight}，预期 140`)
      assert.equal(info.overflow, false, '顶栏出现横向溢出')
      for (const button of info.buttons) {
        assert.ok(button.right <= info.viewport + 1, `顶栏按钮右缘越界 ${button.right}`)
        assert.ok(button.top >= 0 && button.bottom <= info.height + 1, '顶栏按钮垂直错位')
      }
    } })

    desktop('断点续跑胶囊显示倒计时与操作', async (page) => {
      await openSession(page, 'retry')
      const text = page.getByText(/网络中断，\d+ 秒后重试/).first()
      await text.waitFor({ state: 'visible', timeout: 8_000 })
      const pill = text.locator('..')
      withinViewport(await pill.boundingBox(), DESKTOP, '重试胶囊')
      await page.getByRole('button', { name: '立即重试' }).first().waitFor()
      await page.getByRole('button', { name: '停止', exact: true }).first().waitFor()
    })

    // ----------------------------------------------------------------- mobile

    mobile('手机设置全屏、三列导航且无横向溢出', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      const box = await dialog.boundingBox()
      withinViewport(box, MOBILE, '手机设置')
      assert.ok(box.width >= 389 && box.height >= 843, `手机设置没有全屏：${box.width}×${box.height}`)
      const nav = dialog.locator('nav').first()
      const info = await nav.evaluate((el) => ({
        columns: getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
        height: el.getBoundingClientRect().height,
        minHeight: Math.min(...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)),
      }))
      assert.equal(info.columns, 3, `手机设置导航 ${info.columns} 列`)
      assert.ok(info.height <= 360, `手机设置导航过高 ${info.height}px`)
      assert.ok(info.minHeight >= 43, `手机设置页签触控高度 ${info.minHeight}px`)
      const pageWidth = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: window.innerWidth,
      }))
      assertNoOverflow('手机设置页', pageWidth)
      await dialog.locator('nav').first().getByRole('button', { name: '权限', exact: true }).click()
      await page.waitForTimeout(200)
      const next = await dialog.boundingBox()
      assert.ok(Math.abs(next.height - box.height) <= 1, '切换页签后手机设置脱离全屏')
      await closeSettings(page)
    })

    mobile('手机环境条不越界、容器透明、触控 44px', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        if (!wrap) return null
        const rect = wrap.getBoundingClientRect()
        const children = [...wrap.children].map((child) => {
          const r = child.getBoundingClientRect()
          return { width: r.width, right: r.right, height: r.height }
        })
        return {
          bg: getComputedStyle(wrap).backgroundColor,
          scrollWidth: wrap.scrollWidth,
          clientWidth: wrap.clientWidth,
          left: rect.left,
          right: rect.right,
          children,
        }
      }, repo)
      assert.ok(info, '找不到手机环境条')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `手机环境条容器不透明：${info.bg}`)
      assertNoOverflow('手机环境条', info)
      assert.ok(info.right <= MOBILE.width + 1, `环境条右缘 ${info.right} 越界`)
      for (const child of info.children) {
        assert.ok(child.width > 0, '环境条存在不可见子项')
        assert.ok(child.right <= MOBILE.width + 1, `环境条子项右缘 ${child.right} 越界`)
        assert.ok(child.height >= 43, `环境条触控高度 ${child.height}px，低于 44px`)
      }
    })

    mobile('手机重试胶囊独立一行且不压顶栏', async (page) => {
      await openSession(page, 'retry')
      const retryText = page.getByText(/网络中断，\d+ 秒后重试/).first()
      await retryText.waitFor({ state: 'visible', timeout: 8_000 })
      const header = page.locator('header').first()
      const headerBox = await header.boundingBox()
      const rowBox = await retryText.locator('..').boundingBox()
      assert.ok(rowBox.y >= headerBox.y + headerBox.height - 1, '重试提示与顶栏重叠')
      assert.ok(Math.abs(rowBox.width - MOBILE.width) <= 2, `重试提示行宽度 ${rowBox.width}`)
      const headerText = await header.innerText()
      assert.equal(headerText.includes('网络中断'), false, '手机顶栏内仍渲染重试胶囊')
      withinViewport(rowBox, MOBILE, '手机重试提示')
      await page.getByRole('button', { name: '立即重试' }).first().waitFor()
    })

    mobile('手机账号卡只有一行编辑/删除操作', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      await dialog.getByText('自建端点').waitFor()
      for (const name of ['主力账号', '自建端点']) {
        assert.equal(await dialog.getByRole('button', { name: `编辑 ${name}` }).count(), 1, `${name} 出现重复编辑入口`)
        assert.equal(await dialog.getByRole('button', { name: `删除 ${name}` }).count(), 1, `${name} 出现重复删除入口`)
      }
      await closeSettings(page)
    })

    mobile('手机权限规则匹配模式独占一行', async (page) => {
      const dialog = await openSettings(page, '权限', 'mobile')
      const input = dialog.getByRole('textbox', { name: '匹配模式' })
      await input.waitFor({ timeout: 10_000 })
      const box = await input.boundingBox()
      assert.ok(box.width >= 180, `匹配模式输入框只有 ${box.width}px 宽`)
      withinViewport(box, MOBILE, '匹配模式输入框')
      await closeSettings(page)
    })

    mobile('手机用量柱状图可点按查看每日花费', async (page) => {
      const dialog = await openSettings(page, '用量', 'mobile')
      const chart = dialog.locator('svg[aria-label="按天花费柱状图"]')
      await chart.waitFor({ timeout: 10_000 })
      const box = await chart.boundingBox()
      assert.ok(box.width >= 300, `手机用量图只有 ${box.width}px 宽`)
      const bars = chart.locator('g[aria-label*="花费"]')
      assert.ok((await bars.count()) >= 3, '用量图没有每日柱子')
      // 按造数时的日期定位当天柱子，不依赖「最后一根」；跨零点时也稳定。
      const todayBar = chart.locator(`g[aria-label^="${dayString(0)} "]`)
      await todayBar.waitFor({ timeout: 3_000 })
      await todayBar.click({ force: true })
      await page.waitForTimeout(250)
      const tip = dialog.getByText(dayString(0), { exact: true })
      await tip.waitFor({ state: 'visible', timeout: 3_000 })
      withinViewport(await tip.locator('..').boundingBox(), MOBILE, '用量 tooltip')
      await closeSettings(page)
    })

    mobile('手机提示词点选后编辑区滚入视口', async (page) => {
      const dialog = await openSettings(page, '提示词', 'mobile')
      const list = dialog.locator('nav').nth(1)
      const first = list.getByRole('button').first()
      await first.waitFor({ timeout: 10_000 })
      await first.click()
      await page.waitForTimeout(700)
      const editor = dialog.locator('.scroll-mt-2').first()
      const box = await editor.boundingBox()
      assert.ok(box, '提示词编辑区不存在')
      assert.ok(box.y >= 0 && box.y < 720, `提示词编辑区仍在视口外 y=${box.y}`)
      withinViewport(box, MOBILE, '提示词编辑区')
      await closeSettings(page)
    })

    mobile('手机消息操作只剩一个更多操作按钮且触控 44px', async (page) => {
      await openSession(page, 'long')
      const lastRow = page.locator('[data-turn-id="u40"]')
      const more = lastRow.locator('.msg-more button[aria-label="消息操作"]')
      await more.waitFor({ state: 'visible', timeout: 5_000 })
      const box = await more.boundingBox()
      assert.ok(box.height >= 43, `消息操作按钮高度 ${box.height}px`)
      const desktopActionsVisible = await page.evaluate(() =>
        [...document.querySelectorAll('.msg-actions')].some((el) => getComputedStyle(el).display !== 'none'),
      )
      assert.equal(desktopActionsVisible, false, '触屏下仍显示桌面消息操作条')
    })

    mobile('手机模型菜单与文件夹弹层都在视口内', async (page) => {
      await openSession(page, 'long')
      await waitModelReady(page)
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const menu = page.locator('[role="menu"]').first()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), MOBILE, '手机模型菜单')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      await page.locator(`button[title="${repo}"]`).first().click()
      const popover = page.locator('[role="menu"].popover-panel').first()
      await popover.waitFor()
      withinViewport(await popover.boundingBox(), MOBILE, '手机文件夹弹层')
      await page.keyboard.press('Escape')
    })

    mobile('手机嵌套弹窗按 Esc 只关闭最上层', async (page) => {
      const dialog = await openSettings(page, 'MCP', 'mobile')
      const remove = dialog.getByRole('button', { name: '删除 reg-fs' })
      await remove.waitFor({ timeout: 10_000 })
      await remove.click()
      const confirm = page.getByRole('dialog', { name: '移除 MCP 服务器' })
      await confirm.waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      await confirm.waitFor({ state: 'hidden' })
      assert.ok(await dialog.isVisible(), 'Esc 同时关闭了设置弹窗')
      await closeSettings(page)
    })

    small('360 小屏：会话顶栏标题与状态不重叠、输入框不横向溢出', async (page) => {
      await openSession(page, 'approve')
      const info = await page.evaluate(() => {
        const header = document.querySelector('header')
        const hb = header.getBoundingClientRect()
        const title = [...header.querySelectorAll('h1')].find((e) => (e.textContent || '').includes('等待审批'))
        const tr = title?.getBoundingClientRect()
        const pill = [...header.querySelectorAll('span')].find((e) => (e.textContent || '').trim().startsWith('待审批'))
        const pr = pill?.getBoundingClientRect()
        const card = document.querySelector('.composer-card')
        const cr = card.getBoundingClientRect()
        return {
          headerH: hb.height,
          headerRight: hb.right,
          titleW: tr?.width ?? 0,
          pillRight: pr?.right ?? 0,
          cardRight: cr.right,
          cardSW: card.scrollWidth,
          cardCW: card.clientWidth,
          docSW: document.documentElement.scrollWidth,
        }
      })
      assert.ok(info.titleW >= 80, `手机顶栏标题被挤到 ${Math.round(info.titleW)}px`)
      assert.ok(info.headerH >= 88, `手机顶栏没有分两行：${Math.round(info.headerH)}px`)
      assert.ok(info.pillRight <= info.headerRight - 40, `状态胶囊压到了右侧图标：${Math.round(info.pillRight)} > ${Math.round(info.headerRight - 40)}`)
      assert.ok(info.cardSW <= info.cardCW + 1, `输入框横向溢出 ${info.cardSW} > ${info.cardCW}`)
      assert.ok(info.cardRight <= SMALL.width + 1, `输入框右缘 ${Math.round(info.cardRight)} 越界`)
      assert.ok(info.docSW <= SMALL.width, `页面横向溢出 ${info.docSW} > ${SMALL.width}`)
    })

    small('360 小屏：更多菜单项 44px 且弹层不越界', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: /更多设置/ }).click()
      const menu = page.locator('[role="menu"]').first()
      await menu.waitFor()
      await waitAnimations(menu)
      const info = await menu.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const items = [...el.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
          (i) => i.getBoundingClientRect().height,
        )
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, min: Math.min(...items), count: items.length }
      })
      assert.ok(info.count >= 5, `更多菜单只有 ${info.count} 项`)
      assert.ok(info.min >= 43, `手机菜单项高度 ${Math.round(info.min)}px，低于 44px`)
      assert.ok(info.top >= -1 && info.bottom <= info.vh + 1, `菜单超出视口 ${Math.round(info.top)}–${Math.round(info.bottom)} / ${info.vh}`)
      await page.keyboard.press('Escape')
    })

    small('360 小屏：审批卡按钮 2×2 且触控 44px', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor()
      const buttons = card.locator('.permission-actions button')
      assert.equal(await buttons.count(), 4, '审批按钮不是 4 个')
      const boxes = []
      for (let i = 0; i < 4; i++) {
        const box = await buttons.nth(i).boundingBox()
        assert.ok(box, `第 ${i + 1} 个审批按钮不可见`)
        assert.ok(box.height >= 43, `审批按钮高度 ${Math.round(box.height)}px`)
        assert.ok(box.width >= 120, `审批按钮宽度 ${Math.round(box.width)}px`)
        boxes.push(box)
      }
      assert.equal(new Set(boxes.map((b) => Math.round(b.y))).size, 2, '审批按钮没有排成两行')
      assert.equal(new Set(boxes.map((b) => Math.round(b.x))).size, 2, '审批按钮没有排成两列')
      const cardBox = await card.boundingBox()
      for (const box of boxes) {
        assert.ok(box.x >= cardBox.x - 1 && box.x + box.width <= cardBox.x + cardBox.width + 1, '审批按钮超出卡片')
      }
    })

    desktop('审批策略：同类请求多次批准后审批卡出现项目快捷规则', async (page) => {
      await openSession(page, 'learn')
      const learned = page.locator('[data-permission-learned]')
      await learned.waitFor({ timeout: 10_000 })
      const text = await learned.innerText()
      assert.match(text, /以后在本项目自动允许/)
      assert.match(text, /vitest run\*/)
    })

    desktop('命令沙箱：工作目录外写入在 acceptEdits 下仍出现审批卡', async (page) => {
      await openSession(page, 'outside')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      const text = await card.innerText()
      assert.match(text, /工作目录之外/, '审批卡没有说明写入工作目录之外')
      assert.match(text, /tandem-reg-outside\.txt/, '审批卡没有显示越界路径')
    })

    desktop('沙箱：worktree 会话写 cwd 内文件不弹审批', async () => {
      const { evaluateSandbox } = await import(
        pathToFileURL(path.join(ROOT, 'packages/server/dist/sandbox.js')).href
      )
      const wtCwd = path.join(configDir, 'worktrees', 'repo', 'tandem-demo')
      const settings = { enabled: true, network: 'host', strict: false, allowedHosts: ['localhost'] }
      const base = {
        settings,
        cwd: wtCwd,
        worktreePath: wtCwd,
        home: os.homedir(),
        tandemHome: configDir,
      }
      const write = evaluateSandbox(
        'Write',
        { file_path: path.join(wtCwd, 'src', 'a.ts'), content: 'x' },
        base,
      )
      assert.equal(write.notices.length, 0, `worktree 内写入被拦截：${write.notices[0]?.reason ?? ''}`)
      const bash = evaluateSandbox('Bash', { command: 'echo x > src/a.ts' }, base)
      assert.equal(bash.notices.length, 0, `worktree 内 Bash 写入被拦截：${bash.notices[0]?.reason ?? ''}`)
      const config = evaluateSandbox(
        'Write',
        { file_path: path.join(configDir, 'config.json'), content: 'x' },
        base,
      )
      assert.equal(config.notices[0]?.kind, 'protected', 'Tandem 配置文件没有受保护')
    })

    desktop('审批策略：危险命令审批卡不出现项目快捷规则', async (page) => {
      await openSession(page, 'danger')
      await page.locator('.permission-card').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      assert.equal(
        await page.locator('[data-permission-learned]').count(),
        0,
        '危险命令出现了自动允许快捷选项',
      )
    })

    desktop('审批策略：权限页显示统计与建议，危险命令只建议询问', async (page) => {
      const dialog = await openSettings(page, '权限', 'desktop')
      const stats = await dialog.locator('[data-approval-stats]').innerText()
      assert.match(stats, /弹窗 9 次/)
      assert.match(stats, /被规则自动处理 2 次/)
      const learned = dialog.locator('[data-suggestion="vitest run*"]')
      await learned.waitFor({ timeout: 10_000 })
      assert.match(await learned.innerText(), /自动允许/)
      assert.equal(await learned.getByRole('button', { name: '采纳' }).count(), 1)
      assert.equal(await learned.getByRole('button', { name: '忽略' }).count(), 1)
      const danger = dialog.locator('[data-suggestion="rm*"]')
      await danger.waitFor()
      const dangerText = await danger.innerText()
      assert.match(dangerText, /总是询问/)
      assert.equal(/自动允许/.test(dangerText), false, '危险命令被建议自动允许')
      await dialog.getByLabel('用一句话生成权限规则').waitFor()
      await closeSettings(page)
    })

    small('手机长按用户消息打开操作菜单', async (page) => {
      await openSession(page, 'long')
      const bubble = page.locator('.msg-group .whitespace-pre-wrap.break-words').last()
      await bubble.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(250)
      const box = await bubble.boundingBox()
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + 16, y: box.y + 12 }],
      })
      await page.waitForTimeout(650)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const menu = page.getByRole('menu', { name: '消息操作' })
      await menu.waitFor({ state: 'visible', timeout: 3_000 })
      await page.waitForTimeout(250)
      const item = menu.getByRole('menuitem').first()
      const itemBox = await item.boundingBox()
      assert.ok(itemBox.height >= 43, `长按菜单项高度 ${Math.round(itemBox.height)}px`)
      await page.keyboard.press('Escape')
    })

    small('360 小屏：侧栏行与图标触控 44px', async (page) => {
      await page.getByRole('button', { name: '打开侧栏' }).click()
      const aside = page.locator('aside').first()
      await aside.waitFor({ state: 'visible' })
      const info = await aside.evaluate((el) => {
        const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)
        const rows = [...el.querySelectorAll('[data-session-row]')].map((r) => r.getBoundingClientRect().height)
        return { minButton: Math.min(...buttons), minRow: Math.min(...rows) }
      })
      assert.ok(info.minButton >= 43, `侧栏按钮最小高度 ${Math.round(info.minButton)}px`)
      assert.ok(info.minRow >= 43, `会话行高度 ${Math.round(info.minRow)}px`)
      await page.keyboard.press('Escape')
    })

    small('360 小屏：设置页按钮触控 44px', async (page) => {
      const dialog = await openSettings(page, '账号与模型', 'mobile')
      withinViewport(await dialog.boundingBox(), SMALL, '手机设置')
      const min = await dialog.evaluate((el) =>
        Math.min(...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height)),
      )
      assert.ok(min >= 43, `设置页按钮最小高度 ${Math.round(min)}px`)
      await closeSettings(page)
    })

    mobile('手机点按文件引用打开预览并可关闭', async (page) => {
      await openSession(page, 'links')
      const ref = page.locator('code.file-ref-inline, a.file-ref').first()
      await ref.waitFor({ state: 'visible' })
      await ref.tap()
      const close = page.getByRole('button', { name: '关闭文件预览' })
      await close.waitFor({ state: 'visible', timeout: 5_000 })
      const box = await close.boundingBox()
      assert.ok(box.height >= 43, `预览关闭按钮高度 ${Math.round(box.height)}px`)
      await close.tap()
      await close.waitFor({ state: 'hidden', timeout: 5_000 })
    })

    desktop('团队：成员页审计中文化、邀请二维码与警告分行', async (page) => {
      const dialog = await openSettings(page, '成员', 'desktop')
      await dialog.getByText('王敏').first().waitFor({ timeout: 10_000 })
      const auditText = await dialog.locator('section').last().innerText()
      assert.ok(auditText.includes('审批者'), `审计未显示中文角色：${auditText.slice(0, 120)}`)
      assert.ok(!/\b(observer|approver|collaborator)\b/.test(auditText), `审计仍有英文枚举：${auditText.slice(0, 120)}`)
      await dialog.getByPlaceholder('/home/you/project').first().fill(repo)
      await dialog.getByRole('button', { name: '添加', exact: true }).last().click()
      await dialog.getByRole('button', { name: '生成邀请链接' }).click()
      await dialog.locator('svg[viewBox]').first().waitFor({ state: 'visible', timeout: 10_000 })
      const warning = dialog.getByText(/只监听 127\.0\.0\.1/)
      await warning.waitFor({ state: 'visible', timeout: 5_000 })
      const box = await dialog.getByText(/仅展示一次/).boundingBox()
      assert.ok(box, '邀请面板未展示')
      await closeSettings(page)
    })

    desktop('评测：对比表字号 ≥12px、时间中文化、轨迹与并排可开', async (page) => {
      const dialog = await openSettings(page, '评测', 'desktop')
      await dialog.getByText('回归用例 A').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      const text = await dialog.innerText()
      assert.ok(!/\b(AM|PM)\b/.test(text), '运行时间仍是 12 小时制英文格式')
      const minFont = await dialog.evaluate((el) => {
        const nodes = [...el.querySelectorAll('tbody td *')].filter((n) => (n.textContent ?? '').trim())
        return Math.min(...nodes.map((n) => parseFloat(getComputedStyle(n).fontSize)))
      })
      assert.ok(minFont >= 12, `结果表最小字号 ${minFont}px`)
      await dialog.locator('tbody tr').first().locator('td').nth(1).locator('button').first().click()
      const trace = page.getByRole('dialog', { name: '评测轨迹' })
      await trace.waitFor({ state: 'visible', timeout: 10_000 })
      await page.keyboard.press('Escape')
      await trace.waitFor({ state: 'hidden', timeout: 5_000 })
      await dialog.getByRole('button', { name: '并排' }).first().click()
      const compare = page.getByRole('dialog', { name: '评测并排对比' })
      await compare.waitFor({ state: 'visible', timeout: 10_000 })
      assertNoOverflow('并排对比', await compare.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))
      await page.keyboard.press('Escape')
      await compare.waitFor({ state: 'hidden', timeout: 5_000 })
      await closeSettings(page)
    })

    desktop('浏览器：工具卡与浏览器面板空态', async (page) => {
      await openSession(page, 'browser')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '浏览器', exact: true }).click()
      const panel = page.getByRole('dialog', { name: '浏览器' })
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      await panel.getByText(/本会话还没有打开浏览器|页面还没有截图/).first().waitFor({ timeout: 5_000 })
      assertNoOverflow('浏览器面板', await panel.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden', timeout: 5_000 })
    })

    desktop('应用预览：自动识别、设备切换、点选元素、Edit 自动刷新与改前对比', async (page) => {
      const sessionId = 'preview'
      const waitPreview = async (predicate, label, timeout = 40_000) => {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          try {
            const state = await api(base, token, `/api/sessions/${sessionId}/preview/state`)
            if (predicate(state)) return state
          } catch {
            /* Host 可能正在启动预览 */
          }
          await sleep(250)
        }
        throw new Error(`等待预览状态超时：${label}`)
      }
      const requestCount = (host) => previewApp.requests.filter((item) => item.host === host).length

      // 非白名单地址：API 直接拒绝，且 Host 不应向目标发出任何请求。
      const blockedHost = `0.0.0.0:${previewApp.blockedPort}`
      const blockedBefore = requestCount(blockedHost)
      const blocked = await fetch(`${base}/api/sessions/${sessionId}/preview/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://${blockedHost}/` }),
      })
      assert.equal(blocked.status, 400, '非白名单地址应被拒绝')
      assert.match(await blocked.text(), /不在浏览器允许列表/)
      await sleep(600)
      assert.equal(requestCount(blockedHost), blockedBefore, '非白名单地址不应发出真实网络请求')

      // 自动识别：package.json dev 脚本端口 + 本机探测可达。
      const candidates = await api(base, token, `/api/sessions/${sessionId}/preview/detect`)
      const auto = candidates.find((item) => item.url === `http://localhost:${previewApp.port}/`)
      assert.ok(auto, `没有识别到 package.json dev 端口：${JSON.stringify(candidates)}`)
      assert.equal(auto.source, 'package')
      assert.equal(auto.reachable, true, 'dev 端口应探测为可访问')

      await openSession(page, sessionId)
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '应用预览', exact: true }).click()
      const panel = page.getByTestId('preview-panel')
      await panel.waitFor({ state: 'visible', timeout: 10_000 })

      // 不需要输入地址：面板自动识别并打开本机应用。
      const shotImg = panel.getByTestId('preview-shot')
      await shotImg.waitFor({ state: 'visible', timeout: 40_000 })
      const address = panel.getByRole('textbox', { name: '应用地址' })
      assert.match(await address.inputValue(), new RegExp(`localhost:${previewApp.port}`))
      const opened = await waitPreview((state) => state.active && !!state.screenshotId, '自动打开')
      const beforeShotId = opened.screenshotId

      // 设备尺寸：手机 390×844，Host 同步改变 viewport。
      await panel.getByTitle('手机 390×844').click()
      await waitPreview((state) => state.width === 390 && state.height === 844, '手机尺寸')
      await panel.getByText('390×844', { exact: true }).waitFor({ timeout: 5_000 })
      const phoneShot = await waitPreview(
        (state) => state.width === 390 && state.screenshotId !== beforeShotId,
        '手机截图',
      )

      // 点选元素：选择模式下点击预览里的 React 按钮。
      await panel.getByRole('button', { name: '选择元素' }).click()
      const box = await shotImg.boundingBox()
      assert.ok(box, '预览截图没有可见区域')
      const clickX = box.x + (100 / phoneShot.width) * box.width
      const clickY = box.y + (170 / phoneShot.height) * box.height
      await page.mouse.click(clickX, clickY)
      const selectionStrip = panel.getByTestId('preview-selections')
      await selectionStrip.waitFor({ state: 'visible', timeout: 15_000 })
      const selectionText = await selectionStrip.innerText()
      assert.match(selectionText, /<button> 登录/, `元素胶囊内容不对：${selectionText}`)
      assert.match(selectionText, /src\/App\.tsx/, `没有读到 React 源码位置：${selectionText}`)
      mkdirSync('/tmp/preview-shots', { recursive: true })
      await panel.screenshot({ path: '/tmp/preview-shots/selection.png' }).catch(() => {})

      // R14：面板与对话区并存，选完元素焦点回到输入框，附件胶囊立即可见。
      assert.ok(await panel.isVisible(), '选中元素后面板被关闭')
      const textarea = page.locator('textarea[aria-label="消息输入框"]')
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '消息输入框',
        null,
        { timeout: 3_000 },
      )
      assert.equal(await textarea.isEnabled(), true, '预览打开时输入框不可用')
      const chip = page.getByTestId('composer-preview-selections')
      await chip.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await chip.innerText(), /登录/)
      assert.match(await chip.innerText(), /src\/App\.tsx/)
      const composerBox = await textarea.boundingBox()
      const panelBox = await panel.boundingBox()
      assert.ok(composerBox && panelBox, '输入框或预览面板没有可见区域')
      assert.ok(
        composerBox.x + composerBox.width <= panelBox.x + 1,
        '预览面板盖住了输入框',
      )

      // R14：关闭再打开恢复地址、设备尺寸与已选元素。
      const addressBefore = await address.inputValue()
      await panel.getByRole('button', { name: '关闭应用预览' }).click()
      await panel.waitFor({ state: 'detached', timeout: 5_000 })
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu2 = page.locator('[role="menu"]').last()
      await menu2.waitFor({ state: 'visible', timeout: 5_000 })
      await menu2.getByRole('menuitem', { name: '应用预览', exact: true }).click()
      const panel2 = page.getByTestId('preview-panel')
      await panel2.waitFor({ state: 'visible', timeout: 10_000 })
      const address2 = panel2.getByRole('textbox', { name: '应用地址' })
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="preview-panel"] input[aria-label="应用地址"]')?.value ===
          expected,
        addressBefore,
        { timeout: 10_000 },
      )
      assert.equal(await address2.inputValue(), addressBefore, '重开预览没有恢复地址')
      await panel2.getByText('390×844', { exact: true }).waitFor({ timeout: 10_000 })
      const selectionStrip2 = panel2.getByTestId('preview-selections')
      await selectionStrip2.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await selectionStrip2.innerText(), /登录/, '重开预览没有恢复已选元素')

      // 改前快照。
      await panel2.getByRole('button', { name: '截取改前快照' }).click()
      await panel2.getByText('改前快照', { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})

      // 面板保持打开时也能输入并发送：元素上下文 + PREVIEW_EDIT 指令，mock 会回复并发一次 Edit。
      const contentFile = path.join(previewApp.root, 'content.js')
      await textarea.fill(`PREVIEW_EDIT ${contentFile}`)
      await page.getByRole('button', { name: '发送消息' }).click()
      await page.getByText('收到选中的元素，修改预览页面。').first().waitFor({ timeout: 20_000 })
      const fileDeadline = Date.now() + 20_000
      while (Date.now() < fileDeadline && !readFileSync(contentFile, 'utf8').includes('PREVIEW_MARKER_EDITED')) {
        await sleep(200)
      }
      assert.match(readFileSync(contentFile, 'utf8'), /PREVIEW_MARKER_EDITED/, 'agent 的 Edit 没有落盘')
      assert.ok(
        provider.seenUserTexts.some((text) => text.includes('关于这个元素：<button> 登录按钮')),
        `模型没有收到元素上下文：${provider.seenUserTexts.slice(-2).join(' | ')}`,
      )

      // 改完自动刷新：面板角落显示「已根据 1 处改动刷新」。
      const refreshed = await waitPreview((state) => state.autoRefresh?.count >= 1, '改完自动刷新')
      assert.notEqual(refreshed.screenshotId, beforeShotId, '自动刷新后截图应更新')
      await panel2.getByTestId('preview-auto-refresh').waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await panel2.getByTestId('preview-auto-refresh').innerText(), /已根据 1 处改动刷新/)
      assert.ok(await panel2.isVisible(), '发送后面板被关闭')

      // 改前 / 当前对比：截取快照后自动进入对比，改完刷新后仍保留。
      const compare = panel2.getByTestId('preview-compare')
      await compare.waitFor({ state: 'visible', timeout: 15_000 })
      assert.ok((await compare.locator('img').count()) >= 2, '对比视图应有改前与当前两张图')
      for (const image of await compare.locator('img').all()) {
        await image.evaluate((el) => (el.decode ? el.decode().catch(() => {}) : undefined))
      }
      await page.waitForTimeout(250)
      await panel2.getByRole('button', { name: '左右' }).click().catch(() => {})
      await page.screenshot({ path: '/tmp/preview-shots/compare.png' }).catch(() => {})

      // 界面里再试一次非白名单地址：错误提示出现，预览状态不被破坏。
      await address2.fill(`http://${blockedHost}/`)
      await panel2.getByRole('button', { name: '打开', exact: true }).click()
      await page.getByText(/不在浏览器允许列表/).first().waitFor({ timeout: 10_000 })
      await panel2.getByRole('button', { name: '关闭应用预览' }).click()
      await panel2.waitFor({ state: 'detached', timeout: 5_000 })
      assert.equal(requestCount(blockedHost), blockedBefore, '界面输入非白名单地址也不应发出请求')
    })

    desktop('收件箱：同一回合多次审批聚合为一条，展开可见流水', async (page) => {
      const sessionId = 'inboxmulti'
      await openSession(page, sessionId)
      const sessionOf = () => api(base, token, `/api/sessions/${sessionId}`)
      const before = (await sessionOf()).messages.length
      await page.locator('textarea[aria-label="消息输入框"]').fill('INBOX_MULTI')
      await page.getByRole('button', { name: '发送消息' }).click()

      // 逐个允许本轮的两个 Bash 审批。
      for (let i = 0; i < 2; i += 1) {
        const allow = page.locator('button[data-permission-allow]').last()
        await allow.waitFor({ state: 'visible', timeout: 25_000 })
        await allow.click()
        await page.waitForTimeout(400)
      }
      await waitUntil('收件箱聚合用例回合完成', async () => {
        const current = await sessionOf()
        return current.status === 'idle' && current.messages.length > before
      })

      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      const dialog = page.getByRole('dialog', { name: '收件箱' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const group = dialog
        .getByTestId('inbox-history-group')
        .filter({ hasText: '收件箱聚合用例' })
        .filter({ hasText: '回合完成' })
      await group.first().waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await group.count(), 1, '同一回合的审批流水被拆成多条')
      const groupText = await group.first().innerText()
      assert.match(groupText, /回合完成 · 运行了 2 条命令（已允许）/, `聚合标题不对：${groupText}`)
      assert.equal(/已允许 · Bash/.test(groupText), false, '未展开时不应逐条显示审批流水')

      await group.first().locator('button').first().click()
      const details = group.first().getByTestId('inbox-history-details')
      await details.waitFor({ state: 'visible', timeout: 5_000 })
      const detailText = await details.innerText()
      assert.equal(
        (detailText.match(/已允许 · Bash/g) ?? []).length,
        2,
        `明细条数不对：${detailText}`,
      )
      assert.match(detailText, /打开会话/, '展开明细后没有打开会话入口')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
    })

    mobile('手机评测结果表可横向滚动并打开轨迹', async (page) => {
      const dialog = await openSettings(page, '评测', 'mobile')
      await dialog.getByText('回归用例 A').first().waitFor({ timeout: 10_000 })
      const table = dialog.locator('.overflow-x-auto').last()
      const info = await table.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      assert.ok(info.clientWidth <= MOBILE.width + 1, `结果表超出屏幕：${info.clientWidth}`)
      await dialog.locator('tbody tr').first().locator('td').nth(1).locator('button').first().tap()
      const trace = page.getByRole('dialog', { name: '评测轨迹' })
      await trace.waitFor({ state: 'visible', timeout: 10_000 })
      await trace.getByRole('button', { name: '关闭' }).tap()
      await trace.waitFor({ state: 'hidden', timeout: 5_000 })
    })

    desktop('无障碍扫描：主要页面 serious/critical 违规为 0', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.waitForTimeout(400)
      await auditA11y(page, '新会话页')
      await openSession(page, 'long')
      await auditA11y(page, '会话页（工具卡）')
      await openSession(page, 'approve')
      await page.locator('.permission-card').first().waitFor()
      await auditA11y(page, '审批卡')
      await page.evaluate(() => (window.location.hash = '#/dev/ui'))
      await page.getByRole('heading', { name: '组件画廊' }).waitFor()
      await auditA11y(page, '组件画廊')
      await openSettings(page, '通用', 'desktop')
      await auditA11y(page, '设置 · 通用')
      await closeSettings(page)
    })

    desktop('命令面板：搜「桌面通知」定位到对应设置项', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ timeout: 5_000 })
      await input.fill('桌面通知')
      await page.waitForTimeout(220)
      const row = page
        .locator('[data-palette-index]')
        .filter({ hasText: '桌面通知' })
        .filter({ hasText: '设置 · 通知' })
        .first()
      await row.click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const marker = dialog.locator('[data-setting-id="notifications.desktop"]')
      await marker.waitFor({ state: 'visible', timeout: 10_000 })
      // 定位在打开设置后异步执行，等高亮真正加上再断言，避免弹层入场动画期间读到旧状态。
      await page
        .waitForFunction(
          () =>
            (document.querySelector('[data-setting-id="notifications.desktop"]')?.className ?? '')
              .toString()
              .includes('setting-highlight'),
          null,
          { timeout: 5_000 },
        )
        .catch(() => {})
      const cls = (await marker.getAttribute('class')) ?? ''
      assert.ok(cls.includes('setting-highlight'), '定位后没有高亮目标设置项')
      const navTab = dialog.locator('nav').first().getByRole('button', { name: '通知', exact: true })
      assert.equal(await navTab.getAttribute('aria-current'), 'page', '没有切到「通知」页')
      const box = await marker.boundingBox()
      assert.ok(box && box.y >= 0 && box.y < DESKTOP.height, `设置项不在视口内：${JSON.stringify(box)}`)
      await closeSettings(page)
    })

    desktop('命令面板：前缀筛选与拼音首字母匹配', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ timeout: 5_000 })
      const kinds = async () =>
        page.locator('[data-palette-index]').evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-palette-kind')),
        )
      await input.fill('>')
      await page.waitForTimeout(220)
      const commandKinds = await kinds()
      assert.ok(commandKinds.length > 0, '`>` 前缀没有命令结果')
      assert.ok(commandKinds.every((kind) => kind === 'command'), '`>` 前缀混入了非命令结果')
      await input.fill('#')
      await page.waitForTimeout(220)
      const settingKinds = await kinds()
      assert.ok(settingKinds.length > 0, '`#` 前缀没有设置结果')
      assert.ok(settingKinds.every((kind) => kind === 'setting'), '`#` 前缀混入了非设置结果')
      await input.fill('@')
      await page.waitForTimeout(220)
      const sessionKinds = await kinds()
      assert.ok(sessionKinds.length > 0, '`@` 前缀没有会话结果')
      assert.ok(sessionKinds.every((kind) => kind === 'session'), '`@` 前缀混入了非会话结果')
      await input.fill('xhh')
      await page.waitForTimeout(220)
      const newSession = page
        .locator('[data-palette-kind="command"]')
        .filter({ hasText: '新会话' })
        .first()
      await newSession.waitFor({ state: 'visible', timeout: 3_000 })
      await page.keyboard.press('Escape')
    })

    desktop('设置分组：7 组、合并页与高级折叠', async (page) => {
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('nav').first()
      for (const group of ['基础', '模型与账号', '权限与安全', 'Agent 与自动化', '团队与共享', '外观与辅助', '高级']) {
        assert.equal(
          await nav.locator(`[data-settings-group] > button`).filter({ hasText: group }).count(),
          1,
          `设置导航缺少分组「${group}」`,
        )
      }
      for (const pageName of ['用量与预算', 'Agent 能力', '成员与分享']) {
        assert.equal(await nav.getByRole('button', { name: pageName, exact: true }).count(), 1, `缺少合并页「${pageName}」`)
      }
      const advanced = nav.locator('[data-settings-group="advanced"] > button').first()
      assert.equal(await advanced.getAttribute('aria-expanded'), 'false', '高级组默认没有折叠')
      assert.equal(await nav.locator('[data-settings-page="evals"]').count(), 0, '高级组折叠时仍渲染评测页')
      assert.equal(await nav.locator('[data-settings-page]').count(), 15, '设置导航可见页面数不是 15')
      await advanced.click()
      await page.waitForTimeout(150)
      assert.equal(await advanced.getAttribute('aria-expanded'), 'true', '高级组无法展开')
      for (const id of ['extensions', 'evals', 'gateway', 'sync']) {
        assert.equal(await nav.locator(`[data-settings-page="${id}"]`).count(), 1, `高级组缺少 ${id}`)
      }
      // 合并页：一个导航入口，两个子页签。
      await nav.locator('[data-settings-page="usage-budgets"]').click()
      await page.waitForTimeout(150)
      const subtabs = dialog.locator('[data-settings-subtabs="usage-budgets"]')
      await subtabs.waitFor({ state: 'visible', timeout: 3_000 })
      assert.equal(await subtabs.getByRole('button').count(), 2, '用量与预算子页签数量不对')
      assert.equal(await nav.locator('[data-settings-page="usage-budgets"]').getAttribute('aria-current'), 'page')
      await closeSettings(page)
    })

    desktop('顶栏图标数 ≤5 且低频入口收进更多菜单', async (page) => {
      await openSession(page, 'long')
      const labels = await page.locator('header button[aria-label]').evaluateAll((els) =>
        els
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => el.getAttribute('aria-label') ?? ''),
      )
      assert.ok(labels.length <= 5, `顶栏图标 ${labels.length} 个：${labels.join(' / ')}`)
      assert.ok(labels.some((label) => label === '更多'), '顶栏没有「更多」入口')
      const more = page.getByRole('button', { name: '更多', exact: true })
      await more.click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible', timeout: 3_000 })
      for (const item of ['后台任务', '子代理', '浏览器', '文件', 'PR 与 CI', '评测与轨迹', '分屏']) {
        assert.ok((await menu.getByRole('menuitem', { name: item }).count()) >= 1, `更多菜单缺少「${item}」`)
      }
      await page.keyboard.press('Escape')
    })

    desktop('命令面板可搜到更多菜单的全部入口', async (page) => {
      for (const keyword of ['后台任务', '子代理', '浏览器', '文件', 'PR 与 CI', '评测与轨迹', '分屏打开']) {
        await page.keyboard.press('Control+k')
        const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
        await input.waitFor({ state: 'visible', timeout: 5_000 })
        await input.fill(`>${keyword}`)
        await page.waitForTimeout(200)
        const row = page
          .locator('[data-palette-kind="command"]')
          .filter({ hasText: keyword })
          .first()
        assert.ok(await row.isVisible().catch(() => false), `命令面板搜不到「${keyword}」`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(120)
      }
    })

    desktop('新功能导览：出现、跳转并全部标为已读', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('textarea[aria-label="消息输入框"]').first().waitFor({ timeout: 20_000 })
      const pill = page.getByRole('button', { name: /新功能 · \d+ 项/ }).first()
      await pill.waitFor({ state: 'visible', timeout: 10_000 })
      const pillText = (await pill.textContent()) ?? ''
      const expectedItems = Number(/新功能 · (\d+) 项/.exec(pillText)?.[1] ?? 0)
      assert.ok(expectedItems >= 12, `导览项数量异常：${pillText}`)
      await pill.click()
      const panel = page.getByRole('region', { name: '新功能导览' })
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await panel.getByRole('button', { name: /去看看/ }).count(), expectedItems, '导览项数量与入口不一致')
      await panel.getByRole('button', { name: /自动模型路由/ }).click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await dialog.locator('[data-settings-page-content="routing"]').count(),
        1,
        '导览跳转没有打开自动路由页',
      )
      assert.equal(
        await dialog.locator('[data-settings-page="routing"]').getAttribute('aria-current'),
        'page',
        '导览跳转后导航没有选中自动路由',
      )
      await closeSettings(page)
      // 再次出现后标记全部已读。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /新功能 · \d+ 项/ }).first().waitFor({ timeout: 10_000 })
      await page.getByRole('button', { name: /新功能 · \d+ 项/ }).first().click()
      const panel2 = page.getByRole('region', { name: '新功能导览' })
      await panel2.waitFor({ state: 'visible', timeout: 5_000 })
      await panel2.getByRole('button', { name: '全部标为已读' }).click()
      await page.waitForTimeout(250)
      assert.equal(await page.getByRole('button', { name: /新功能 · \d+ 项/ }).count(), 0, '已读后导览卡仍出现')
      const seen = await page.evaluate(() => localStorage.getItem('tandem.changelogSeen.v1'))
      assert.ok(seen, '已读版本没有写入 localStorage')
    })

    desktop('会话筛选：状态筛选与「已筛选 · 清除」', async (page) => {
      const row = (id) => page.locator(`[data-session-row][data-session-id="${id}"]`)
      await row('long').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '筛选会话' }).click()
      await page.getByRole('menuitemradio', { name: '已完成未读' }).click()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      await row('unreadonly').waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await row('long').isVisible(), false, '状态筛选后仍显示其他会话')
      const tag = page.getByRole('button', { name: /已筛选/ })
      await tag.waitFor({ state: 'visible', timeout: 3_000 })
      await tag.click()
      await row('long').waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await page.getByRole('button', { name: /已筛选/ }).count(), 0, '清除后筛选标签仍在')
    })

    desktop('全文搜索：命中片段、打开会话并高亮消息', async (page) => {
      await page.keyboard.press('Control+k')
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('中文短语')
      const hit = page
        .locator('[data-search-hit]')
        .filter({ hasText: '全文检索会话' })
        .first()
      await hit.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(
        (await hit.locator('mark.chat-match').count()) > 0,
        '搜索命中没有高亮片段',
      )
      assert.ok(
        ((await hit.textContent()) ?? '').includes('中文短语'),
        '搜索命中片段缺少关键词',
      )
      await hit.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/search'), null, {
        timeout: 10_000,
      })
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-message-id="s2"]')
            ?.classList.contains('msg-jump-hit') === true,
        null,
        { timeout: 12_000 },
      )
    })

    desktop('快捷键：外观页由命令注册表生成、自定义生效、冲突提示', async (page) => {
      const dialog = await openSettings(page, '外观', 'desktop')
      const rows = dialog.locator('[data-command-shortcut]')
      assert.ok((await rows.count()) >= 10, `快捷键表只有 ${await rows.count()} 行`)
      const themeRow = dialog.locator('[data-command-shortcut="app.toggle-theme"]')
      const before = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      await themeRow.getByRole('button', { name: '修改 切换主题 快捷键' }).click()
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(220)
      const kbd = (await themeRow.locator('kbd').textContent()) ?? ''
      assert.ok(kbd.includes('T') && kbd.includes('Shift'), `自定义快捷键未保存：${kbd}`)
      await closeSettings(page)
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(260)
      const after = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      assert.notEqual(after, before, '自定义快捷键没有触发切换主题')
      const dialog2 = await openSettings(page, '外观', 'desktop')
      const sidebarRow = dialog2.locator('[data-command-shortcut="app.toggle-sidebar"]')
      await sidebarRow.getByRole('button', { name: '修改 切换侧栏 快捷键' }).click()
      await page.keyboard.press('Control+Shift+t')
      await page.waitForTimeout(220)
      const warning = (await dialog2.getByRole('status').textContent()) ?? ''
      assert.ok(warning.includes('冲突'), `冲突没有提示：${warning}`)
      await dialog2.getByRole('button', { name: '全部恢复默认' }).click()
      await closeSettings(page)
    })

    mobile('手机顶栏搜索按钮打开命令面板', async (page) => {
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      const input = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await input.waitFor({ state: 'visible', timeout: 5_000 })
      await input.fill('# 主题')
      await page.waitForTimeout(220)
      const kinds = await page
        .locator('[data-palette-index]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-palette-kind')))
      assert.ok(kinds.length > 0, '手机命令面板没有设置结果')
      assert.ok(kinds.every((kind) => kind === 'setting'), '手机命令面板前缀筛选失效')
      await page.keyboard.press('Escape')
    })

    desktop('分屏：双窗格收发、焦点跟随右栏与比例恢复', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      await page
        .locator('[data-session-row][data-session-id="split-b"]')
        .click({ modifiers: ['Control'] })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(500)
      const panes = page.locator('[data-split-pane]')
      assert.equal(await panes.count(), 2, '分屏窗格数量不是 2')
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        'Ctrl+点击后焦点不在新窗格',
      )

      // 窗格 B 独立发送并收到回复。
      const paneB = panes.nth(1)
      await paneB.locator('textarea[aria-label="消息输入框"]').fill('分屏 B 测试')
      await paneB.locator('textarea[aria-label="消息输入框"]').press('Enter')
      await paneB.locator('.msg-row', { hasText: '分屏 B 测试' }).waitFor({ timeout: 10_000 })
      await paneB.locator('.msg-row', { hasText: '回归回复。' }).waitFor({ timeout: 15_000 })

      // 焦点切到 A：右栏待办跟随。
      await panes.nth(0).getByText('分屏会话 A', { exact: true }).click()
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-split-pane][data-focused="true"]')?.textContent ?? '').includes(
            '分屏会话 A',
          ),
        null,
        { timeout: 10_000 },
      )
      await page.getByText('分屏 A 的待办').first().waitFor({ timeout: 10_000 })

      // 窗格 A 独立发送，不与 B 串台。
      const paneA = panes.nth(0)
      await paneA.locator('textarea[aria-label="消息输入框"]').fill('分屏 A 测试')
      await paneA.locator('textarea[aria-label="消息输入框"]').press('Enter')
      await paneA.locator('.msg-row', { hasText: '分屏 A 测试' }).waitFor({ timeout: 10_000 })
      await paneA.locator('.msg-row', { hasText: '回归回复。' }).waitFor({ timeout: 15_000 })
      assert.equal(
        await paneB.locator('.msg-row', { hasText: '分屏 A 测试' }).count(),
        0,
        'A 的消息串到 B 窗格',
      )
      assert.equal(
        await paneA.locator('.msg-row', { hasText: '分屏 B 测试' }).count(),
        0,
        'B 的消息串到 A 窗格',
      )

      // 再切回 B：右栏待办跟着变。
      await panes.nth(1).getByText('分屏会话 B', { exact: true }).click()
      await page.getByText('分屏 B 的待办').first().waitFor({ timeout: 10_000 })

      // 拖动分隔条后比例写入 localStorage。
      const splitter = page.locator('[data-split-splitter="x"]').first()
      const box = await splitter.boundingBox()
      assert.ok(box, '找不到分屏分隔条')
      await page.mouse.move(box.x + box.width / 2, box.y + 80)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 70, box.y + 80, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(300)
      const saved = await page.evaluate(() => {
        const raw = localStorage.getItem('tandem.split.v1')
        return raw ? JSON.parse(raw) : null
      })
      assert.ok(saved && saved.panes.length === 2, '分屏布局未写入 localStorage')
      assert.ok(saved.cols[0] < 0.49, `拖动分隔条后比例未更新：${saved.cols[0]}`)
      const ratioOf = async () =>
        page.locator('[data-split-pane]').evaluateAll((els) => {
          const widths = els.map((el) => el.getBoundingClientRect().width)
          return widths[0] / widths.reduce((sum, width) => sum + width, 0)
        })
      const ratioBefore = await ratioOf()

      // 刷新后两个窗格、聚焦会话与比例都恢复。
      await page.reload()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 15_000 },
      )
      await page.waitForTimeout(900)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        '刷新后聚焦窗格丢失',
      )
      await page.getByText('分屏 B 的待办').first().waitFor({ timeout: 10_000 })
      const ratioAfter = await ratioOf()
      assert.ok(
        Math.abs(ratioBefore - ratioAfter) < 0.05,
        `刷新后分屏比例未恢复：${ratioBefore} -> ${ratioAfter}`,
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

    desktop('分屏：拖拽分区、Ctrl+1 焦点与 Ctrl+W 关闭', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      const root = page.locator('[data-split-root]')
      const box = await root.boundingBox()
      assert.ok(box, '单窗格缺少拖拽落区')
      await page
        .locator('[data-session-row][data-session-id="split-b"]')
        .dragTo(root, {
          targetPosition: { x: box.width * 0.8, y: box.height * 0.4 },
        })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 B/,
        '拖入右半边后焦点不在新窗格',
      )

      await page.keyboard.press('Control+1')
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 A/,
        'Ctrl+1 未切到第一个窗格',
      )

      // 浏览器可能拦截真实 Ctrl+W，这里派发同形态的键盘事件验证应用快捷键。
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'w',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 0,
        null,
        { timeout: 10_000 },
      )
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 B/,
        'Ctrl+W 关闭聚焦窗格后未落到相邻会话',
      )

      // 命令面板「分屏打开…」+ 会话选择弹层。
      await page.keyboard.press('Control+k')
      const paletteInput = page.getByRole('textbox', { name: '搜索会话、命令与设置' })
      await paletteInput.fill('分屏打开')
      await page.getByText('分屏打开…', { exact: true }).click()
      const dialog = page.getByRole('dialog').filter({ hasText: '分屏打开会话' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByPlaceholder('搜索会话标题、目录或 Host…').fill('分屏会话 A')
      await page.waitForTimeout(250)
      await dialog.getByRole('button', { name: /分屏会话 A/ }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-split-pane]').length === 2,
        null,
        { timeout: 10_000 },
      )
      await page.waitForTimeout(400)
      assert.match(
        (await page.locator('[data-split-pane][data-focused="true"]').textContent()) ?? '',
        /分屏会话 A/,
        '命令面板分屏打开后焦点不在新窗格',
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

    mobile('手机分屏：圆点指示与左右滑动切换', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
      await openSession(page, 'split-a')
      await page.getByRole('button', { name: '打开侧栏' }).click()
      await page.waitForTimeout(300)
      const row = page.locator('[data-session-row][data-session-id="split-b"]')
      await row.getByRole('button', { name: '会话操作' }).click()
      await page.getByRole('menuitem', { name: '在分屏中打开' }).click()
      await page.waitForTimeout(800)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)

      const tabs = page.getByRole('tab')
      assert.equal(await tabs.count(), 2, '手机分屏圆点数量不是 2')
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true')
      await tabs.nth(0).click()
      await page.waitForTimeout(500)
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 A/,
        '点击圆点未切到第一个窗格',
      )

      const box = await page.locator('[data-split-pager]').boundingBox()
      assert.ok(box, '手机分屏容器不存在')
      const client = await page.context().newCDPSession(page)
      const y = box.y + Math.min(120, box.height * 0.3)
      const startX = box.x + box.width * 0.8
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      })
      for (let i = 1; i <= 6; i++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX - (box.width * 0.1) * i, y }],
        })
        await sleep(20)
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(700)
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 B/,
        '左滑后未切到第二个窗格',
      )
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true')

      // 手机也能退出分屏：关闭当前窗格后回到单会话。
      await page.getByRole('button', { name: '关闭当前窗格' }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[role="tab"]').length === 0,
        null,
        { timeout: 10_000 },
      )
      assert.match(
        (await page.locator('header h1').first().textContent()) ?? '',
        /分屏会话 A/,
        '手机关闭当前窗格后未回到相邻会话',
      )
      await page.evaluate(() => localStorage.removeItem('tandem.split.v1'))
    })

    // ------------------------------------------------------------------ 任务看板

    const boardCall = (pathname, init = {}) =>
      api(base, token, `/api/boards${pathname}`, {
        ...init,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })

    const waitUntil = async (label, fn, timeout = 40_000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const value = await fn()
        if (value) return value
        await sleep(200)
      }
      throw new Error(`等待超时：${label}`)
    }

    const openBoardPage = async (page, boardId) => {
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      const clientHostId = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
      )
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/b/${boardId}`)
      await page.getByTestId('board-view').waitFor({ timeout: 15_000 })
    }

    const boardColumn = (page, status) => page.locator(`[data-column="${status}"]`)
    const boardCardIn = (page, status, title) =>
      boardColumn(page, status).locator('[data-card-id]').filter({ hasText: title })

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
      await page.locator('aside').getByRole('button', { name: '任务看板', exact: true }).click()
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

    // ------------------------------------------------------------------ 自动模型路由

    desktop('自动模型路由：简单快速、困难强力、失败升级、连续成功回落与节省统计', async (page) => {
      await api(base, token, '/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          resumeOnRestart: 'auto',
          modelRouting: {
            preference: 'balanced',
            candidates: [
              { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
              { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
              { profileId: 'p-route', model: 'route-power', tier: 'power' },
            ],
          },
        }),
      })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-route',
          model: 'auto',
          permissionMode: 'bypassPermissions',
          title: '自动路由回归',
        }),
      })
      assert.equal(session.autoRoute, true, '创建会话时未启用自动路由')

      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      const clientHostId = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
      )
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${session.id}`)
      await page.locator('textarea[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: /^选择模型：自动/ }).first().waitFor({ timeout: 15_000 })

      const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
      const sendTurn = async (text, expected) => {
        const before = (await sessionOf()).messages.length
        await page.locator('textarea[aria-label="消息输入框"]').fill(text)
        await page.getByRole('button', { name: '发送消息' }).click()
        await waitUntil(`自动路由回复：${text.slice(0, 10)}`, async () => {
          const current = await sessionOf()
          return (
            current.status === 'idle' &&
            current.messages.length > before &&
            JSON.stringify(current.messages).includes(expected)
          )
        })
        return sessionOf()
      }

      const simple = await sendTurn('改个名', '路由模型 route-mini 已回复。')
      assert.equal(simple.route?.model, 'route-mini', '简单任务未走快速档')
      assert.match(simple.route?.reason ?? '', /简单/, '简单任务理由不明确')
      assert.ok(
        simple.messages.some((message) => message.notice && message.route?.model === 'route-mini'),
        '自动路由切换未插入提示行',
      )

      // 困难 + 长消息：偏强力档
      const hard = await sendTurn(
        '请帮我重构整个并发架构，解释为什么这里会有死锁和竞态，并设计迁移方案。'.repeat(4),
        '路由模型 route-power 已回复。',
      )
      assert.equal(hard.route?.model, 'route-power', '困难任务未升级到强力档')

      // 两个工具调用同时失败：下一次请求自动升级一档
      const failed = await sendTurn('触发失败 改个名', '路由模型 route-mid 已回复。')
      assert.equal(failed.route?.model, 'route-mid', '工具连续失败后未升级')
      assert.ok(failed.route?.scores?.escalated, '升级决策没有打上 escalated 标记')

      // 连续 3 轮简单成功：下一轮回落一档
      for (let i = 0; i < 3; i++) {
        const mid = await sendTurn('简单总结一下', '路由模型 route-mid 已回复。')
        assert.equal(mid.route?.model, 'route-mid', `第 ${i + 1} 轮回落过早`)
      }
      const downgraded = await sendTurn('简单总结一下', '路由模型 route-mini 已回复。')
      assert.equal(downgraded.route?.model, 'route-mini', '连续简单成功后未回落')
      assert.ok(downgraded.route?.scores?.downgraded, '回落决策没有打上 downgraded 标记')
      assert.ok((downgraded.routeSavings?.savedUsd ?? 0) > 0, '自动路由节省统计没有累计')

      // 模型按钮显示「自动 · 当前模型名」，切换提示可 hover 看打分明细
      await page.getByRole('button', { name: /自动 · Route Mini/ }).first().waitFor({ timeout: 10_000 })
      assert.match(
        (await page.getByRole('button', { name: /^选择模型：/ }).first().getAttribute('aria-label')) ?? '',
        /自动 · Route Mini/,
      )
      const lastNotice = page.locator('[data-route-notice]').last()
      const detail = (await lastNotice.getAttribute('title')) ?? ''
      assert.match(detail, /复杂度 \d+\/100/, '提示行缺少打分明细')
      await lastNotice.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await lastNotice.hover({ position: { x: 8, y: 4 } })
      await page.locator('#tandem-tooltip[data-open]').waitFor({ timeout: 5000 })
      assert.match(
        (await page.locator('#tandem-tooltip').innerText().catch(() => '')) ?? '',
        /复杂度 \d+\/100/,
        'hover 后没有展示打分明细',
      )
      assert.ok(
        provider.routeSeen.some((item) => item.model === 'route-mini') &&
          provider.routeSeen.some((item) => item.model === 'route-power') &&
          provider.routeSeen.some((item) => item.model === 'route-mid'),
        'mock provider 没有收到三种档位的请求',
      )

      // 菜单展示参考单价与「自动」项
      await page.getByRole('button', { name: /^选择模型：/ }).first().click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuText = await menu.innerText()
      assert.match(menuText, /自动/, '模型菜单缺少「自动」')
      assert.match(menuText, /输入 \$0\.1 · 输出 \$0\.2/, '模型菜单缺少参考单价')
      assert.match(menuText, /缓存 \$0\.05/, '模型菜单缺少缓存命中价')
      await page.keyboard.press('Escape')
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

    desktop('项目 Wiki：浏览、全文搜索与手写段落', async (page) => {
      await openSession(page, 'search')
      // Wiki 卡片（右栏）显示页数与 commit，点「浏览」打开 Wiki 视图。
      await page.getByText('共 3 页').first().waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: '浏览', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: '项目 Wiki' })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /基于 commit [0-9a-f]{7}/)
      assert.match(await dialog.innerText(), /Mock 概览/)
      // 左树切换到模块页。
      await dialog.getByRole('button', { name: 'src', exact: true }).first().click()
      await dialog.getByText('Mock 职责：示例源码。').waitFor()
      // 全文搜索：命中概览页并可跳转。
      await dialog.getByLabel('搜索 Wiki', { exact: true }).fill('regrepo')
      await dialog.getByRole('button', { name: /项目概览/ }).first().click()
      await dialog.getByText('Mock 概览：回归仓库。').waitFor()
      // 回到模块页编辑手写段落。
      await dialog.getByRole('button', { name: 'src', exact: true }).first().click()
      await dialog.getByText('Mock 职责：示例源码。').waitFor()
      await dialog.getByRole('button', { name: '编辑手写段落' }).click()
      const manual = dialog.getByLabel('手写段落')
      await manual.fill('手写：回归新增的说明。')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByText('已保存手写段落').waitFor()
      const saved = await api(base, token, `/api/wiki/page?project=${encodeURIComponent(repo)}&page=m-src`)
      assert.equal(saved.manual, '手写：回归新增的说明。')
      assert.match(saved.auto, /Mock 职责/)
      await dialog.getByLabel('关闭').click()
    })


    desktop('演示工作区可创建、场景可打开、可清除且不污染真实数据', async (page) => {
      const beforeSessions = await api(base, token, '/api/sessions')
      const beforeUsage = await api(base, token, '/api/usage')
      const beforeLong = beforeSessions.find((item) => item.id === 'long')
      const beforeLongDetail = await api(base, token, '/api/sessions/long')
      const state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      assert.equal(state.active, true, '演示工作区未创建')
      assert.equal(state.scenarios.length, 17, `场景数不对：${state.scenarios.length}`)
      assert.equal(state.networkRequests, 0, '演示模型不应发出网络请求')
      assert.equal(state.profile?.kind, 'demo', '演示账号类型不对')
      assert.equal(state.profile?.baseUrl, 'http://127.0.0.1:1', '演示账号应使用不可达地址证明不发网络请求')

      const profiles = await api(base, token, '/api/profiles')
      assert.ok(!profiles.some((profile) => profile.kind === 'demo'), '演示账号不应出现在正常账号列表')

      const byId = new Map(state.scenarios.map((scenario) => [scenario.id, scenario]))
      for (const required of [
        'chat-tools', 'permission', 'plan', 'subagents', 'background', 'delegation',
        'auto-compact', 'handoff', 'ai-review', 'changes', 'board', 'evals', 'wiki',
        'preview', 'inbox', 'resume', 'hooks',
      ]) {
        assert.ok(byId.has(required), `缺少演示场景 ${required}`)
      }
      for (const scenario of state.scenarios) {
        for (const sessionId of scenario.sessionIds ?? []) {
          const session = await api(base, token, `/api/sessions/${encodeURIComponent(sessionId)}`)
          assert.equal(session.demo, true, `场景 ${scenario.id} 的会话未标记演示数据`)
        }
        if (scenario.boardId) {
          const board = await api(base, token, `/api/boards/${encodeURIComponent(scenario.boardId)}`)
          assert.ok(board.cards.length >= 6, '演示看板卡片不足')
          assert.equal(board.cards.filter((card) => card.deps.length > 0).length >= 3, true, '缺少依赖卡')
          assert.ok(board.cards.some((card) => card.status === 'approval'), '缺少待审批卡')
          assert.ok(board.cards.some((card) => card.status === 'review'), '缺少待评审卡')
          assert.ok(board.cards.some((card) => card.status === 'failed'), '缺少失败卡')
          assert.ok(board.cards.some((card) => card.proposedBy), '缺少 AI 拆分草稿')
        }
        if (scenario.evalRunId) {
          const run = await api(base, token, `/api/evals/runs/${encodeURIComponent(scenario.evalRunId)}`)
          assert.equal(run.results.length, 6, '演示评测对比结果不足')
        }
        if (scenario.kind === 'wiki') {
          const wiki = await api(base, token, `/api/wiki?project=${encodeURIComponent(state.project)}`)
          assert.equal(wiki.exists, true, '演示 Wiki 不存在')
          assert.ok(wiki.pages.length >= 3, '演示 Wiki 页面不足')
        }
      }

      // 重新播放：只替换该场景会话，旧会话被删除。
      const chatBeforeReplay = byId.get('chat-tools').sessionIds[0]
      const replayed = await api(base, token, '/api/demo/scenarios/chat-tools/replay', { method: 'POST', body: JSON.stringify({}) })
      const chatAfterReplay = replayed.scenarios.find((item) => item.id === 'chat-tools').sessionIds[0]
      assert.notEqual(chatAfterReplay, chatBeforeReplay, '重新播放没有创建新会话')
      const oldChat = await fetch(`${base}/api/sessions/${encodeURIComponent(chatBeforeReplay)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(oldChat.status, 404, '重新播放后旧会话仍然存在')
      const replayState = await api(base, token, '/api/demo')
      byId.set('chat-tools', replayState.scenarios.find((item) => item.id === 'chat-tools'))

      // UI：看板场景可打开并显示预置卡片。
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => { window.location.hash = hash }, `#/h/${clientHostId}/b/demo-board`)
      await page.getByText('演示 · 任务看板', { exact: true }).first().waitFor({ timeout: 15_000 })
      await page.getByText('AI 拆分草稿：补充测试与截图', { exact: true }).first().waitFor({ timeout: 10_000 })
      await page.getByText('待审批：更新发布说明', { exact: true }).first().waitFor({ timeout: 10_000 })

      // UI：演示会话可继续对话，演示模型不发网络请求（baseUrl 不可达也能完成）。
      const chatId = byId.get('chat-tools').sessionIds[0]
      await openSession(page, chatId)
      const composer = page.locator('textarea[aria-label="消息输入框"]').first()
      await composer.fill('再总结一下这个演示项目')
      await composer.press('Enter')
      await page.getByText(/工具结果已返回。演示模型只执行固定剧本/).first().waitFor({ timeout: 20_000 })
      const usageAfterTurn = await api(base, token, '/api/usage')
      assert.deepEqual(usageAfterTurn, beforeUsage, '演示模型不应写入真实用量统计')

      // 清除：会话、看板、评测、Wiki、任务、账号与目录都不留痕迹；真实会话不受影响。
      await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' })
      const afterDemo = await api(base, token, '/api/demo')
      assert.equal(afterDemo.active, false, '清除后演示状态仍为 active')
      const afterSessions = await api(base, token, '/api/sessions')
      assert.equal(afterSessions.length, beforeSessions.length, `清除后会话数 ${afterSessions.length} != ${beforeSessions.length}`)
      assert.ok(afterSessions.some((item) => item.id === 'long'), '清除演示数据误删了真实会话')
      const afterLongDetail = await api(base, token, '/api/sessions/long')
      assert.equal(afterLongDetail.messages.length, beforeLongDetail.messages.length, '真实会话消息被改动')
      assert.ok(beforeLong, '真实会话 long 不存在')
      assert.deepEqual(await api(base, token, '/api/usage'), beforeUsage, '清除后真实用量被改动')
      assert.ok(!(await api(base, token, '/api/profiles')).some((profile) => profile.kind === 'demo'), '演示账号未清除')
      assert.ok(!(await api(base, token, '/api/boards')).some((board) => board.id === 'demo-board'), '演示看板未清除')
      assert.ok(!(await api(base, token, '/api/evals/runs')).some((run) => run.id === 'demo-eval-run'), '演示评测未清除')
      assert.ok(!(await api(base, token, '/api/tasks')).some((task) => task.cwd?.startsWith(state.root)), '演示后台任务未清除')
      assert.equal(existsSync(state.root), false, '演示目录未删除')
      const search = await api(base, token, `/api/search?q=${encodeURIComponent('演示 · 基础对话')}`)
      assert.equal(search.hits.length, 0, '演示会话仍留在搜索索引')
      const wikiAfter = await api(base, token, `/api/wiki?project=${encodeURIComponent(state.project)}`)
      assert.equal(wikiAfter.exists, false, '演示 Wiki 未清除')
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

      const downloadPromise = page.waitForEvent('download')
      page.once('dialog', (dialog) => dialog.accept())
      await bar.getByRole('button', { name: '导出', exact: true }).click()
      const download = await downloadPromise
      const downloadFile = path.join(home, 'feedback-export.json')
      await download.saveAs(downloadFile)
      const exported = JSON.parse(readFileSync(downloadFile, 'utf8'))
      assert.ok(Array.isArray(exported.featureGroups), '导出 JSON 缺少 featureGroups')
      assert.ok(exported.featureGroups.some((group) => group.name === '任务看板'), '导出未按功能分组')
      assert.equal(exported.items[0].featureName, '任务看板', '反馈条目没有功能标签')
      assert.equal(typeof exported.checklistReport?.markdown, 'string', '导出未附带体验清单报告')

      const unpacked = mkdtempSync(path.join(home, 'feedback-unpack-'))
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/feedback-unpack.mjs'), downloadFile, unpacked], { encoding: 'utf8' })
      assert.ok(existsSync(path.join(unpacked, 'by-feature', '任务看板.md')), '缺少 by-feature 分组文件')
      assert.ok(existsSync(path.join(unpacked, '体验清单.md')), '缺少体验清单报告')
      const feedbackMd = readFileSync(path.join(unpacked, 'feedback.md'), 'utf8')
      assert.ok(feedbackMd.includes('## 功能：任务看板'), 'feedback.md 未按功能分组')

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

    desktop('工作站：跨主机 ADB/串口挂载、审批与终端', async (page) => {
      const tokenA = randomUUID()
      const hostIdA = randomUUID()
      const hostA = startHost({
        home: path.join(home, 'host-a'),
        token: tokenA,
        hostId: hostIdA,
        extraEnv: { FAKE_ADB_SERIAL: 'REG_A_01', FAKE_ADB_DEVICE: 'RegBoard' },
      })
      let sessionId
      let logTask
      try {
        const portA = await hostA.ready
        const baseA = `http://127.0.0.1:${portA}`
        let devicesA
        for (let i = 0; i < 20; i += 1) {
          devicesA = await api(baseA, tokenA, '/api/devices')
          if (devicesA.devices.some((device) => device.id === 'adb:REG_A_01')) break
          await sleep(200)
        }
        assert.ok(devicesA.devices.some((device) => device.id === 'adb:REG_A_01'), '设备 Host A 未发现假 ADB 设备')
        assert.ok(devicesA.devices.some((device) => device.id === 'serial:mock://ttyUSB0'), '设备 Host A 未发现虚拟串口')
        assert.equal(devicesA.serial.mock, true, '串口 mock 未启用')

        const issued = await api(baseA, tokenA, '/api/devices/peer-tokens', {
          method: 'POST',
          body: JSON.stringify({ label: '回归设备代理' }),
        })
        assert.ok(issued.token.startsWith('dvt_'), '设备令牌格式错误')
        // 设备令牌只能访问设备服务，不能读会话。
        const denied = await fetch(`${baseA}/api/sessions`, {
          headers: { authorization: `Bearer ${issued.token}` },
        })
        assert.equal(denied.status, 403, '设备令牌越权访问了会话列表')
        // 明文只出现一次。
        const tokenList = await api(baseA, tokenA, '/api/devices/peer-tokens')
        assert.ok(tokenList.every((item) => !('token' in item)), '设备令牌列表泄露明文')

        const cwd = path.join(home, 'device-workspace')
        mkdirSync(cwd, { recursive: true })
        const created = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd, profileId: 'p-main', groupId: 'g1', model: 'mock-1' }),
        })
        sessionId = created.id
        for (const deviceId of ['adb:REG_A_01', 'serial:mock://ttyUSB0']) {
          const mount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
            method: 'POST',
            body: JSON.stringify({ deviceId, peerUrl: baseA, peerToken: issued.token }),
          })
          assert.equal(mount.source.kind, 'peer', `设备 ${deviceId} 未记录为跨主机来源`)
          assert.equal(mount.source.hostId, hostIdA, `设备 ${deviceId} 的来源 Host 不正确`)
        }
        const mounted = await api(base, token, `/api/sessions/${sessionId}/devices`)
        assert.equal(mounted.mounts.length, 2, '会话挂载数量不正确')
        const serialMount = mounted.mounts.find((item) => item.kind === 'serial')
        const opened = await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200 }),
        })
        assert.equal(opened.writable, true, '首个串口租约应可写')
        const first = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`,
        )
        assert.ok(first.data.includes('Tandem virtual serial ready'), '跨主机串口未读到启动日志')
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/write`, {
          method: 'POST',
          body: JSON.stringify({ data: 'hello from regression\n' }),
        })
        await sleep(900)
        const echoed = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`,
        )
        assert.ok(echoed.data.includes('[echo] hello from regression'), '跨主机串口写入未回显')

        // 另一个会话独占同一串口应被拒绝，共享只读租约不能写。
        const second = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd, profileId: 'p-main', groupId: 'g1', model: 'mock-1' }),
        })
        const secondMount = await api(base, token, `/api/sessions/${second.id}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'serial:mock://ttyUSB0', peerUrl: baseA, peerToken: issued.token }),
        })
        const exclusive = await fetch(`${base}/api/sessions/${second.id}/devices/${secondMount.id}/serial/open`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ baud: 115200 }),
        })
        assert.equal(exclusive.status, 400, '串口独占锁未生效')
        const shared = await api(base, token, `/api/sessions/${second.id}/devices/${secondMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200, shared: true }),
        })
        assert.equal(shared.writable, false, '共享串口租约不应可写')
        const sharedWrite = await fetch(`${base}/api/sessions/${second.id}/devices/${secondMount.id}/serial/write`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ data: 'blocked' }),
        })
        assert.equal(sharedWrite.status, 400, '只读共享租约写入了串口')
        const deleted = await fetch(`${base}/api/sessions/${second.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
        assert.ok(deleted.ok, `清理第二个会话失败：${deleted.status}`)

        // 让 agent 走完 7 个设备工具；WS 自动允许审批并记录审批数。
        const approvals = []
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
        await new Promise((resolve, reject) => {
          ws.on('open', resolve)
          ws.on('error', reject)
        })
        ws.send(JSON.stringify({ type: 'subscribe', sessionId }))
        const turnDone = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('设备 agent 回合超时')), 60_000)
          ws.on('message', (raw) => {
            let msg
            try {
              msg = JSON.parse(String(raw))
            } catch {
              return
            }
            if (msg.type === 'permission_request') {
              approvals.push(msg.request.toolName)
              ws.send(JSON.stringify({ type: 'permission', requestId: msg.request.id, decision: 'allow' }))
            }
            if (msg.type === 'turn_end') {
              clearTimeout(timer)
              resolve(msg)
            }
          })
        })
        ws.send(
          JSON.stringify({
            type: 'send',
            sessionId,
            content: [{ type: 'text', text: 'DEVICE_E2E 开始设备回归' }],
          }),
        )
        const ended = await turnDone
        ws.close()
        assert.equal(ended.reason, 'done', `设备回合未正常结束：${ended.reason}`)
        assert.ok(approvals.length >= 7, `设备工具审批不足：${approvals.join(',')}`)
        const tasks = await api(base, token, `/api/tasks?sessionId=${sessionId}`)
        logTask = tasks.find((task) => task.command.includes('logcat'))
        assert.ok(logTask && logTask.status === 'running', 'logcat 未复用后台任务')
        const full = await api(base, token, `/api/sessions/${sessionId}`)
        const allText = JSON.stringify(full.messages)
        assert.ok(allText.includes('RegBoard'), 'AdbShell 未通过设备 Host 返回型号')
        assert.ok(allText.includes('FakeApp'), 'AdbLogcat 未返回日志')
        assert.ok(allText.includes('Tandem virtual serial ready'), 'SerialRead 未读到串口启动日志')
        assert.ok(allText.includes('已发送 6 字符'), 'SerialWrite 未写入串口')

        // 工作站视图：把设备 Host 也加进客户端，确认两台主机的设备同屏可见。
        await page.evaluate(
          ({ url, token: hostToken }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-a', name: '设备主机 A', url, token: hostToken, addedAt: Date.now(), mode: 'direct' })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseA, token: tokenA },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openSession(page, sessionId)
        await page.getByRole('button', { name: '工作站' }).click()
        const dialog = page.getByRole('dialog', { name: '工作站' })
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByText('设备主机 A', { exact: true }).waitFor({ timeout: 10_000 })
        await dialog.getByText(/REG_A_01/).first().waitFor({ timeout: 10_000 })
        assert.ok((await dialog.getByText(/Tandem Mock/).count()) >= 2, '两台主机的串口未同时列出')
        await dialog.getByRole('button', { name: '完成' }).click()
      } finally {
        if (logTask) {
          await api(base, token, `/api/tasks/${logTask.id}/kill`, { method: 'POST' }).catch(() => {})
        }
        hostA.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostA.child.once('exit', resolve)),
          sleep(3000).then(() => hostA.child.kill('SIGKILL')),
        ])
      }
    })

    // ------------------------------------------------------------------ 执行

    const selected = ONLY ? checks.filter((item) => item.name.includes(ONLY)) : checks
    if (ONLY && !selected.length) throw new Error(`--only "${ONLY}" 没有匹配任何用例`)

    for (const check of selected) {
      let ctx =
        check.viewport === 'mobile'
          ? mobileContext
          : check.viewport === 'small'
            ? smallContext
            : desktopContext
      let ownContext = false
      if (check.context === 'offline') {
        ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
        ownContext = true
      } else if (check.context === 'win32') {
        ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
        await ctx.addInitScript(() => {
          window.tandemDesktop = { isDesktop: true, platform: 'win32' }
        })
        ownContext = true
      }
      const page = await newPage(ctx, check.viewport)
      const started = Date.now()
      try {
        await check.fn(page)
        assert.equal(page.__errors.length, 0, `页面脚本错误：${page.__errors.join('；')}`)
        passed += 1
        console.log(`✓ ${check.name}  ${Date.now() - started}ms`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ name: check.name, message })
        const shot = path.join(shots, `${check.viewport}-${failures.length}.png`)
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
        console.error(`✗ ${check.name}\n  ${message}\n  截图：${shot}`)
      } finally {
        await page.close().catch(() => {})
        if (ownContext) await ctx.close().catch(() => {})
      }
    }

    console.log(`\n=== regression 汇总 ===`)
    console.log(`通过 ${passed} / ${selected.length} 条，失败 ${failures.length} 条`)
    for (const failure of failures) console.log(`- ${failure.name}：${failure.message}`)
    if (failures.length) process.exitCode = 1
  } catch (error) {
    console.error(`regression: 运行失败\n${error instanceof Error ? error.stack : error}`)
    console.error(host.logs())
    process.exitCode = 1
  } finally {
    await browser?.close().catch(() => {})
    try {
      const pidFile = path.join(home, 'fake-remote', '.tandem-host', 'pid')
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGTERM')
    } catch {
      /* 远程 Host 可能已被卸载 */
    }
    if (!host.child.killed) host.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => host.child.once('exit', resolve)),
      sleep(3000).then(() => host.child.kill('SIGKILL')),
    ])
    await new Promise((resolve) => provider.close(resolve))
    await previewApp?.close().catch(() => {})
    if (process.exitCode === 1) {
      console.error(`regression: 临时目录保留在 ${home}（截图在 ${shots}）`)
    } else {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
