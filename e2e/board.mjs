#!/usr/bin/env node
/**
 * 任务看板端到端：临时 Host（TANDEM_HOME=/tmp/tandem-board，端口 8321）+ 本地 mock provider（OpenAI 兼容 SSE，
 * 按提示词里的指令返回不同结果：写文件 / 慢 / 失败 / 要审批的命令 / 高花费）+ /tmp 下的 git 仓库。
 * 覆盖：依赖顺序、并发上限、审批门、worktree 合入依赖与按序合并、冲突、失败重试、预算上限、工具审批、
 * 收件箱 board 事件、Host 重启续跑。不读真实 Key、不连公网。
 *
 * 前置：npm run build。用法：node e2e/board.mjs [--keep]   （--keep 保留临时目录与 Host 运行，供截图脚本使用）
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const HOME = '/tmp/tandem-board'
const REPO = '/tmp/board-repo'
const PORT = 8321
const TOKEN = 'board-e2e-token'
const KEEP = process.argv.includes('--keep')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- mock provider ----------
const failedOnce = new Set()
let mockRequests = 0

function userText(messages) {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n')))
    .join('\n')
}

function createMock() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    mockRequests += 1
    const messages = body.messages ?? []
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const content = String(system).includes('任务看板规划器')
        ? JSON.stringify([
            { ref: 'be', title: '后端接口', prompt: 'WRITE src/api.txt api-ready', deps: [] },
            { ref: 'fe', title: '前端按钮', prompt: 'WRITE src/button.txt button-ready', deps: [] },
            { ref: 'qa', title: '测试', prompt: 'WRITE tests/qa.txt qa-ready', deps: ['be', 'fe'], gate: true },
          ])
        : '看板测试'
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
      return
    }
    // 指令取最近一条带指令的用户消息（重试/打回的追加消息不带指令，沿用上一条）
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => userText([m]))
    const text = [...userTexts].reverse().find((t) => /^(WRITE|BASH|SLEEP|FAILONCE|FAILALWAYS|COST)\b/m.test(t)) ?? userTexts.join('\n')
    const directive = (name) => {
      const m = text.match(new RegExp(`^${name}(?: (.*))?$`, 'm'))
      return m ? (m[1] ?? '') : undefined
    }
    const failOnce = directive('FAILONCE')
    if (directive('FAILALWAYS') !== undefined || (failOnce && !failedOnce.has(failOnce))) {
      if (failOnce) failedOnce.add(failOnce)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock failure', type: 'invalid_request_error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const chunk = (delta, finish = null) => send({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
    const usageTokens = Number(directive('COST') ?? 20)
    const done = (finish) => {
      chunk({}, finish)
      send({ id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usageTokens, completion_tokens: 5, total_tokens: usageTokens + 5 } })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const sleepMs = Number(directive('SLEEP') ?? 0)
    if (sleepMs) await sleep(sleepMs)
    const lastRole = messages.at(-1)?.role
    if (lastRole !== 'tool') {
      const write = directive('WRITE')
      const bash = directive('BASH')
      if (write) {
        const [file, ...rest] = write.split(' ')
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${mockRequests}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: file, content: `${rest.join(' ')}\n` }) } }] })
        done('tool_calls')
        return
      }
      if (bash) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${mockRequests}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: bash, description: '看板审批测试' }) } }] })
        done('tool_calls')
        return
      }
    }
    chunk({ role: 'assistant', content: `完成：${text.split('\n')[0].slice(0, 40)}` })
    done('stop')
  })
}

// ---------- host ----------
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

function seedRepo() {
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(path.join(REPO, 'src'), { recursive: true })
  git(REPO, 'init', '-q', '-b', 'main')
  git(REPO, 'config', 'user.email', 'board@example.com')
  git(REPO, 'config', 'user.name', 'board')
  writeFileSync(path.join(REPO, 'README.md'), '# board-repo\n')
  writeFileSync(path.join(REPO, 'src/index.txt'), 'index\n')
  git(REPO, 'add', '.')
  git(REPO, 'commit', '-qm', 'init')
}

function seedHome(mockPort) {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(path.join(HOME, 'sessions'), { recursive: true })
  writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ hostId: 'board-e2e', token: TOKEN, idleTimeoutSec: 180, resumeOnRestart: 'auto', defaultDelegation: 'less' }, null, 2))
  writeFileSync(
    path.join(HOME, 'profiles.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'p-mock',
          name: '看板 mock',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'board-key',
          models: ['mock-1'],
          defaultModel: 'mock-1',
          // 1000 美元 / 百万 token：COST 2000 ≈ 2 美元，用来测单卡预算
          price: { 'mock-1': { input: 1000, output: 1000 } },
          createdAt: Date.now(),
        },
      ],
    }),
  )
}

function startHost() {
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: `${HOME}-home`,
      TANDEM_HOME: HOME,
      TANDEM_BOARD_RETRY_MS: '600',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (d) => (logs += d))
  child.stderr.on('data', (d) => (logs += d))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${logs}`)), 25_000)
    child.stdout.on('data', () => {
      if (/访问:\s+http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => reject(new Error(`Host 提前退出 ${code}\n${logs}`)))
  })
  return { child, ready, logs: () => logs }
}

const base = `http://127.0.0.1:${PORT}`
async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${text}`), { status: res.status })
  return text ? JSON.parse(text) : undefined
}

function openWs(onMessage) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
  ws.onmessage = (event) => onMessage(JSON.parse(event.data))
  return new Promise((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe_inbox' }))
      resolve(ws)
    }
  })
}

async function waitFor(label, fn, timeout = 30_000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    last = await fn()
    if (last) return last
    await sleep(150)
  }
  throw new Error(`等待超时：${label}`)
}

const results = []
function step(name, ok = true) {
  results.push(name)
  console.log(`  ✓ ${name}`)
  return ok
}

async function main() {
  const mock = createMock()
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  seedRepo()
  seedHome(mockPort)
  let host = startHost()
  await host.ready
  const inbox = []
  let wsRef
  const ws = await openWs((msg) => {
    // worktree 位于 TANDEM_HOME 下，沙箱把它当受保护路径强制审批写入（待沙箱修复）；这里像用户一样批准 Write，Bash 留给审批用例
    if (msg.type === 'inbox_event' && msg.event.kind === 'permission' && msg.event.permission?.toolName === 'Write') {
      wsRef?.send(JSON.stringify({ type: 'permission', requestId: msg.event.permission.id, decision: 'allow' }))
    }
    if (msg.type === 'inbox_event' && msg.event.kind === 'board') inbox.push(msg.event.board)
    if (msg.type === 'inbox_event' && msg.event.kind === 'permission') inbox.push({ permission: msg.event.permission, sessionId: msg.event.sessionId })
    if (msg.type === 'inbox_event' && msg.event.kind === 'turn_end') inbox.push({ turnEnd: msg.event.sessionId })
  })
  wsRef = ws
  const failures = []
  try {
    // 1. 建看板 + AI 拆分
    const board = await api('/api/boards', { method: 'POST', body: { cwd: REPO, name: '看板回归', maxParallel: 2, defaults: { profileId: 'p-mock' } } })
    assert.equal(board.isGit, true)
    assert.equal(board.maxParallel, 2)
    const bid = board.id
    const call = (p, init) => api(`/api/boards/${bid}${p}`, init)
    const { drafts } = await call('/plan', { method: 'POST', body: { goal: '给设置页加导出功能' } })
    assert.equal(drafts.length, 3)
    assert.deepEqual(drafts[2].deps, ['be', 'fe'])
    assert.equal((await call('')).cards.length, 0)
    step('AI 拆分只返回草稿，未创建卡片')
    const applied = await call('/plan/apply', { method: 'POST', body: { drafts } })
    assert.equal(applied.cards.length, 3)
    assert.ok(applied.cards.every((c) => c.status === 'todo'))
    const [be, fe, qa] = applied.cards
    assert.deepEqual(qa.deps, [be.id, fe.id])
    assert.equal(qa.exec.gate, true)
    step('确认草稿后创建 3 张待办卡（依赖已映射、测试卡带审批门）')

    // 环检测
    await assert.rejects(() => call(`/cards/${be.id}`, { method: 'PUT', body: { deps: [qa.id] } }), /环/)
    step('依赖成环被拒绝')

    // 给前两张卡加延时，便于观察并发与顺序；另加两张独立卡测并发上限
    await call(`/cards/${be.id}`, { method: 'PUT', body: { prompt: 'WRITE src/api.txt api-ready\nSLEEP 1200' } })
    await call(`/cards/${fe.id}`, { method: 'PUT', body: { prompt: 'WRITE src/button.txt button-ready\nSLEEP 1200' } })
    const d1 = await call('/cards', { method: 'POST', body: { title: '独立卡 D1', prompt: 'WRITE docs/d1.txt d1\nSLEEP 800' } })
    const d2 = await call('/cards', { method: 'POST', body: { title: '独立卡 D2', prompt: 'WRITE docs/d2.txt d2\nSLEEP 800' } })

    // 先放行 测试卡 → 应等待；再放行 be/fe/d1/d2 → 同时最多 2 张运行
    const act = (cid, action, extra = {}) => call(`/cards/${cid}/action`, { method: 'POST', body: { action, ...extra } })
    await act(qa.id, 'start')
    for (const c of [be, fe, d1, d2]) await act(c.id, 'start')
    let maxRunning = 0
    let qaStartedBeforeDeps = false
    await waitFor('测试卡进入待评审', async () => {
      const b = await call('')
      const running = b.cards.filter((c) => c.status === 'running').length
      maxRunning = Math.max(maxRunning, running)
      const byId = Object.fromEntries(b.cards.map((c) => [c.id, c]))
      if (['running', 'review'].includes(byId[qa.id].status) && !(byId[be.id].status === 'done' && byId[fe.id].status === 'done')) qaStartedBeforeDeps = true
      return byId[qa.id].status === 'review' ? b : undefined
    }, 60_000)
    assert.ok(maxRunning <= 2, `并发超限：${maxRunning}`)
    assert.ok(maxRunning >= 2, '并发没有跑满 2')
    assert.equal(qaStartedBeforeDeps, false)
    step(`并发上限生效（同时最多 ${maxRunning} 张）；依赖未完成时测试卡不启动`)

    // 2. 审批门：测试卡停在待评审；其 worktree 含上游改动
    let b = await call('')
    const qaCard = b.cards.find((c) => c.id === qa.id)
    assert.equal(qaCard.status, 'review')
    const qaSession = await api(`/api/sessions/${qaCard.sessionId}`)
    const wt = qaSession.worktree?.path
    assert.ok(wt && existsSync(path.join(wt, 'src/api.txt')) && existsSync(path.join(wt, 'src/button.txt')), '测试卡 worktree 应合入上游分支')
    assert.equal(qaCard.result.files, 1, `测试卡自己的改动应只有 1 个文件，实际 ${qaCard.result.files}`)
    assert.match(qaCard.result.summary, /完成/)
    step('审批门：测试卡停在待评审；worktree 已合入前两张卡的改动，结果只统计自己的 1 个文件')
    assert.ok(inbox.some((e) => e.event === 'review' && e.cardId === qa.id), '收件箱应有待评审事件')
    assert.ok(!inbox.some((e) => e.turnEnd && e.turnEnd === qaCard.sessionId), '卡片会话不应产生 turn_end 收件箱项')
    step('收件箱：待评审事件已推送，卡片会话不重复产生回合结束项')

    // 打回 → 同会话继续 → 再次待评审 → 通过
    await act(qa.id, 'reject', { note: '请补一个断言文件' })
    await waitFor('打回后再次待评审', async () => (await call('')).cards.find((c) => c.id === qa.id).status === 'review')
    assert.equal((await api(`/api/sessions/${qaCard.sessionId}`)).id, qaCard.sessionId)
    await act(qa.id, 'approve')
    b = await call('')
    assert.equal(b.cards.find((c) => c.id === qa.id).status, 'done')
    step('打回意见在同一会话继续并再次进入待评审；通过后完成')

    // 3. 按依赖顺序合并
    await waitFor('其余卡完成', async () => (await call('')).cards.filter((c) => c.status === 'done').length === 5)
    const merged = await call('/merge-all', { method: 'POST', body: {} })
    assert.equal(merged.failed.length, 0, JSON.stringify(merged.failed))
    assert.equal(merged.merged.length, 5)
    for (const file of ['src/api.txt', 'src/button.txt', 'tests/qa.txt', 'docs/d1.txt', 'docs/d2.txt']) {
      assert.ok(existsSync(path.join(REPO, file)), `${file} 应已合并到 main`)
    }
    assert.equal(git(REPO, 'branch', '--show-current').trim(), 'main')
    step('merge-all 按依赖顺序合并 5 张卡到 main，文件齐全')

    // 4. 失败重试 / 重试耗尽 / 上游失败阻塞 / 重试动作
    const flaky = await call('/cards', { method: 'POST', body: { title: '偶发失败', prompt: 'FAILONCE flaky-1\nWRITE docs/flaky.txt ok', status: 'queued' } })
    await waitFor('偶发失败卡经重试完成', async () => (await call('')).cards.find((c) => c.id === flaky.id).status === 'done')
    const flakyDone = (await call('')).cards.find((c) => c.id === flaky.id)
    assert.equal(flakyDone.attempts, 1)
    step('回合出错后同会话自动重试 1 次并完成')
    const broken = await call('/cards', { method: 'POST', body: { title: '总是失败', prompt: 'FAILALWAYS', exec: { maxRetries: 1 }, status: 'queued' } })
    const down = await call('/cards', { method: 'POST', body: { title: '下游卡', prompt: 'WRITE docs/down.txt x', deps: [broken.id], status: 'queued' } })
    await waitFor('总是失败卡失败', async () => (await call('')).cards.find((c) => c.id === broken.id).status === 'failed')
    b = await call('')
    assert.equal(b.cards.find((c) => c.id === broken.id).attempts, 1)
    await waitFor('下游卡被标记上游失败', async () => (await call('')).cards.find((c) => c.id === down.id).blocked === 'upstream_failed')
    assert.equal(b.cards.find((c) => c.id === down.id).status, 'queued')
    assert.ok(inbox.some((e) => e.event === 'failed' && e.cardId === broken.id))
    step('重试耗尽后失败并推送收件箱；下游保持排队并标记"上游失败"')
    await call(`/cards/${broken.id}`, { method: 'PUT', body: { prompt: 'WRITE docs/fixed.txt fixed' } })
    await act(broken.id, 'retry')
    await waitFor('重试后上下游依次完成', async () => {
      const cards = (await call('')).cards
      return cards.find((c) => c.id === broken.id).status === 'done' && cards.find((c) => c.id === down.id).status === 'done'
    })
    step('失败卡编辑后"重试"成功，下游随后自动运行')

    // 5. 工具审批：Bash 在 acceptEdits 下需审批，卡进入待审批列，不占并发槽
    const bash = await call('/cards', { method: 'POST', body: { title: '需要审批的命令', prompt: 'BASH echo board-approval', status: 'queued' } })
    const waiting = await waitFor('卡进入待审批', async () => {
      const card = (await call('')).cards.find((c) => c.id === bash.id)
      return card.status === 'approval' ? card : undefined
    })
    assert.match(waiting.activity ?? '', /Bash/)
    const perm = await waitFor('收件箱出现审批', () => inbox.find((e) => e.permission?.sessionId === waiting.sessionId))
    ws.send(JSON.stringify({ type: 'permission', requestId: perm.permission.id, decision: 'allow' }))
    await waitFor('批准后完成', async () => (await call('')).cards.find((c) => c.id === bash.id).status === 'done')
    step('工具审批：卡显示待审批（含"等待允许 Bash"），批准后继续并完成')

    // 6. 单卡预算
    const rich = await call('/cards', { method: 'POST', body: { title: '超预算', prompt: 'COST 2000\nWRITE docs/rich.txt x', exec: { budgetUsd: 1, maxRetries: 3 }, status: 'queued' } })
    await waitFor('超预算卡失败', async () => (await call('')).cards.find((c) => c.id === rich.id).status === 'failed')
    const richCard = (await call('')).cards.find((c) => c.id === rich.id)
    assert.match(richCard.error, /超出单卡预算/)
    assert.equal(richCard.attempts, 0, '预算超限不应重试')
    step('单卡预算：累计花费超限后失败且不重试')

    // 7. 合并冲突：两张卡改同一文件
    const x = await call('/cards', { method: 'POST', body: { title: '冲突 X', prompt: 'WRITE src/index.txt from-x', status: 'queued' } })
    const y = await call('/cards', { method: 'POST', body: { title: '冲突 Y', prompt: 'WRITE src/index.txt from-y', status: 'queued' } })
    await waitFor('冲突卡完成', async () => {
      const cards = (await call('')).cards
      return [x, y].every((c) => cards.find((i) => i.id === c.id).status === 'done')
    })
    const mx = await act(x.id, 'merge')
    assert.ok(mx.result.mergedAt)
    const my = await act(y.id, 'merge')
    assert.ok(!my.result.mergedAt && /冲突/.test(my.result.mergeError ?? ''), JSON.stringify(my.result))
    assert.equal(git(REPO, 'status', '--porcelain').trim(), '', '冲突合并应已中止，工作区干净')
    step('合并冲突：第二张被中止并给出错误，主仓库保持干净')

    // 8. 删除卡片会清理依赖引用
    await call(`/cards/${d1.id}`, { method: 'DELETE' })
    assert.ok(!(await call('')).cards.some((c) => c.id === d1.id))
    step('删除卡片')

    // 9. Host 重启续跑：运行中的卡在重启后被收养并完成
    const slow = await call('/cards', { method: 'POST', body: { title: '重启续跑', prompt: 'WRITE docs/slow.txt slow\nSLEEP 6000', status: 'queued' } })
    await waitFor('慢卡开始运行', async () => (await call('')).cards.find((c) => c.id === slow.id).status === 'running')
    await sleep(500)
    host.child.kill('SIGKILL')
    await sleep(500)
    host = startHost()
    await host.ready
    const after = await waitFor('重启后看板仍在且卡被收养', async () => {
      const card = (await call('')).cards.find((c) => c.id === slow.id)
      return card && ['running', 'done'].includes(card.status) ? card : undefined
    })
    await waitFor('重启后慢卡完成', async () => (await call('')).cards.find((c) => c.id === slow.id).status === 'done', 60_000)
    step(`Host 被杀后重启：看板从磁盘恢复，运行中的卡（重启后为 ${after.status}）续跑并完成`)

    const summary = await api('/api/boards')
    assert.equal(summary.length, 1)
    assert.ok(summary[0].counts.done >= 8)
    console.log(`\n看板回归通过：${results.length} 项。`)
  } catch (err) {
    failures.push(err)
    console.error('\n看板回归失败：', err)
    console.error('--- Host 日志（末尾）---\n', host.logs().slice(-3000))
  } finally {
    ws.close()
    if (!KEEP) {
      await new Promise((resolve) => {
        host.child.once('exit', resolve)
        host.child.kill('SIGTERM')
        setTimeout(resolve, 5000)
      })
      mock.close()
      for (const dir of [HOME, `${HOME}-home`, REPO]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } else {
      console.log(`保留：Host http://127.0.0.1:${PORT}/?token=${TOKEN} ，mock 端口 ${mockPort}（Ctrl+C 结束）`)
      await new Promise(() => {})
    }
  }
  process.exit(failures.length ? 1 : 0)
}

main()
