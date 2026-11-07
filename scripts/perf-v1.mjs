#!/usr/bin/env node
// 性能专项测量：大仓库 / 长会话 / 多会话搜索 / 并发。结果写 /tmp/perf-<tag>.json。
// 用法：node scripts/perf-v1.mjs before [--skip-ui] [--skip-concurrency]
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOME = '/tmp/tandem-perf/home'
const TANDEM = '/tmp/tandem-perf'
const REPO = path.join(TANDEM, 'repo')
const PORT = 8261
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'perf-token'
const HOST_ID = 'perf-host'
const tag = process.argv[2] ?? 'before'
const skipUi = process.argv.includes('--skip-ui')
const skipConcurrency = process.argv.includes('--skip-concurrency')
const uiOnly = process.argv.includes('--ui-only')
const out = {}

function record(group, name, ms, extra = {}) {
  out[group] ??= {}
  out[group][name] = { ms: +ms.toFixed(1), ...extra }
  console.log(`${group}.${name}: ${ms.toFixed(1)}ms${extra.bytes ? ` (${(extra.bytes / 1048576).toFixed(1)}MB)` : ''}`)
}

async function timeApi(pathname, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${BASE}${pathname}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  const body = await res.arrayBuffer()
  if (res.status >= 400) console.log(`! ${pathname} -> ${res.status}: ${Buffer.from(body).toString().slice(0, 200)}`)
  return { ms: performance.now() - t0, status: res.status, bytes: body.byteLength, json: () => JSON.parse(Buffer.from(body).toString()) }
}

function memRss(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return Number(status.match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0) * 1024
}

/** 假 OpenAI 兼容端点：流式文本，可并发。 */
function startMock() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'perf', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404); res.end('{}'); return
    }
    for await (const _ of req) { /* 消费请求体 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'perf', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    chunk({ role: 'assistant', content: '' })
    const text = '性能测试流式输出。'.repeat(180) // ~2.3KB
    for (let i = 0; i < 60; i++) {
      chunk({ content: text })
      await sleep(15)
    }
    chunk({}, 'stop')
    res.write(`data: ${JSON.stringify({ id: 'perf', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => server.listen(8262, '127.0.0.1', () => resolve(server)))
}

function startHost() {
  const t0 = performance.now()
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/perf-host.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HOME, TANDEM_HOME: TANDEM, CODEX_HOME: path.join(HOME, '.codex'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${stdout}\n${stderr}`)), 120_000)
    const check = () => {
      if (stdout.includes('PERF_HOST_PID')) {
        clearTimeout(timer)
        resolve({ pid: Number(stdout.match(/PERF_HOST_PID (\d+)/)[1]), startupMs: performance.now() - t0 })
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => reject(new Error(`Host 退出 ${code}\n${stdout}\n${stderr}`)))
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function wsSend(ws, sessionId, text) {
  ws.send(JSON.stringify({ type: 'send', sessionId, content: [{ type: 'text', text }] }))
}

function waitWs(ws, pred, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', on); reject(new Error('WS 等待超时')) }, timeout)
    const on = (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (pred(msg)) { clearTimeout(timer); ws.off('message', on); resolve(msg) }
    }
    ws.on('message', on)
  })
}

async function measureServer(pid) {
  record('startup', 'host', (await readyPromise).startupMs)
  record('memory', 'rssAfterStartup', 0, { bytes: memRss(pid) })

  // fs/list
  for (const [name, q] of [['flat5000', 'path=' + encodeURIComponent(path.join(REPO, 'flat')) + '&files=1'], ['repo2000dirs', 'path=' + encodeURIComponent(REPO)]]) {
    const r = await timeApi(`/api/fs/list?${q}`)
    const body = r.json()
    record('fs-list', name, r.ms, { bytes: r.bytes, entries: body.length })
  }

  // fs/complete：冷（首次遍历）与热
  const comp = `/api/fs/complete?cwd=${encodeURIComponent(REPO)}&q=p123`
  const cold = await timeApi(comp)
  record('fs-complete', 'cold', cold.ms, { bytes: cold.bytes, results: cold.json().length })
  const warm = []
  for (let i = 0; i < 3; i++) warm.push((await timeApi(comp)).ms)
  record('fs-complete', 'warm', Math.min(...warm), { bytes: cold.bytes })

  // 会话列表 / 打开长会话
  const list = await timeApi('/api/sessions')
  record('sessions', 'list200', list.ms, { bytes: list.bytes })
  const list2 = await timeApi('/api/sessions')
  record('sessions', 'list200Warm', list2.ms, { bytes: list2.bytes })
  const longGet = await timeApi('/api/sessions/long')
  record('sessions', 'openLong', longGet.ms, { bytes: longGet.bytes })

  // changes / diff
  const changes = await timeApi('/api/sessions/long/changes')
  record('changes', 'list3000', changes.ms, { bytes: changes.bytes, files: changes.json().files?.length })
  for (const file of ['big2.log', 'big1.log', 'pkg/p0000/src/file00.ts']) {
    const r = await timeApi(`/api/sessions/long/changes/diff?path=${encodeURIComponent(file)}`)
    record('changes', `diff:${file}`, r.ms, { bytes: r.bytes })
  }

  // 外部会话：冷/热/增量
  const extCold = await timeApi('/api/external-sessions')
  record('external', 'cold3000', extCold.ms, { bytes: extCold.bytes, sessions: extCold.json().length })
  const extWarm = await timeApi('/api/external-sessions')
  record('external', 'warm3000', extWarm.ms, { bytes: extWarm.bytes })
  const since = Date.now() - 3_600_000
  const extInc = await timeApi(`/api/external-sessions?since=${since}`)
  record('external', 'incremental', extInc.ms, { bytes: extInc.bytes })

  // Glob / Grep 工具
  const glob = await import(path.join(ROOT, 'packages/server/dist/tools/glob.js'))
  const grep = await import(path.join(ROOT, 'packages/server/dist/tools/grep.js'))
  const ctx = { cwd: REPO, signal: new AbortController().signal }
  let t0 = performance.now()
  const globRes = await glob.run({ pattern: '**/*.ts' }, ctx)
  record('tools', 'glob50k', performance.now() - t0, { bytes: globRes.content.length })
  t0 = performance.now()
  const grepRes = await grep.run({ pattern: 'export const value12', output_mode: 'files_with_matches' }, ctx)
  record('tools', 'grep50k', performance.now() - t0, { bytes: grepRes.content.length })
  t0 = performance.now()
  const grepJs = await grep.run({ pattern: 'export const value12', output_mode: 'files_with_matches' }, ctx)
  record('tools', 'grep50kRepeat', performance.now() - t0, { bytes: grepJs.content.length })

  record('memory', 'rssAfterScan', 0, { bytes: memRss(pid) })
}

function measureStore() {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/perf-store.mjs')], { encoding: 'utf8' })
  for (const line of output.trim().split('\n')) {
    const [name, ms, bytes] = line.split(' ')
    record('store', name, Number(ms), { bytes: Number(bytes) })
  }
}

async function measureConcurrency(pid) {
  // 建 10 个会话
  const ids = []
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: REPO, profileId: 'mock', model: 'perf', title: `并发 ${i}` }),
    })
    ids.push((await res.json()).id)
  }
  const clients = await Promise.all(ids.map(() => wsConnect()))
  await Promise.all(clients.map((ws, i) => {
    const snap = waitWs(ws, (m) => m.type === 'session_snapshot' && m.session.id === ids[i])
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: ids[i] }))
    return snap
  }))
  process.kill(pid, 'SIGUSR1')
  const pings = []
  let running = true
  const pingLoop = (async () => {
    const ws = clients[0]
    while (running) {
      const t = performance.now()
      ws.send(JSON.stringify({ type: 'ping' }))
      await waitWs(ws, (m) => m.type === 'pong', 10_000)
      pings.push(performance.now() - t)
      await sleep(20)
    }
  })()
  const ends = clients.map((ws, i) => waitWs(ws, (m) => m.type === 'turn_end' && m.sessionId === ids[i], 120_000))
  const t0 = performance.now()
  await Promise.all(clients.map((ws, i) => wsSend(ws, ids[i], '并发压测：请输出一段文本')))
  await Promise.all(ends)
  const elapsed = performance.now() - t0
  await sleep(1200)
  running = false
  await pingLoop
  process.kill(pid, 'SIGUSR1')
  await sleep(300)
  pings.sort((a, b) => a - b)
  record('concurrency', '10sessionsWall', elapsed)
  record('concurrency', 'pingP50', pings[Math.floor(pings.length / 2)])
  record('concurrency', 'pingP99', pings[Math.floor(pings.length * 0.99)])
  record('concurrency', 'pingMax', pings[pings.length - 1])
  for (const ws of clients) ws.close()
}

function readEld(logs) {
  const lines = logs.split('\n').filter((l) => l.startsWith('ELD '))
  return lines.map((l) => JSON.parse(l.slice(4)))
}

async function measureUi() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // 页面内埋点：长任务、首行时间、侧栏外部会话入口时间
  await page.addInitScript(() => {
    window.__longtasks = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longtasks.push({ start: e.startTime, dur: e.duration })
      }).observe({ entryTypes: ['longtask'] })
    } catch {}
    window.__marks = {}
    const mo = new MutationObserver(() => {
      if (!window.__marks.sidebarRows && document.querySelector('[data-session-row]')) {
        window.__marks.sidebarRows = performance.now()
      }
      if (!window.__marks.externalMore && [...document.querySelectorAll('button')].some((b) => /更多 Claude Code 会话/.test(b.textContent || ''))) {
        window.__marks.externalMore = performance.now()
      }
    })
    mo.observe(document, { childList: true, subtree: true, characterData: true })
  })
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-session-row]', { timeout: 60_000 })
  const hostId = await page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') || '[]')[0]?.id)
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /更多 Claude Code 会话/.test(b.textContent || '')), null, { timeout: 60_000 }).catch(() => {})
  const marks = await page.evaluate(() => window.__marks)
  record('ui', 'sidebarFirstRow', marks.sidebarRows ?? -1, { rows: await page.locator('[data-session-row]').count() })
  if (marks.externalMore) record('ui', 'sidebarExternalsLoaded', marks.externalMore)
  const sidebarLong = await page.evaluate(() => window.__longtasks.filter((t) => t.start < performance.now()).reduce((m, t) => Math.max(m, t.dur), 0))
  record('ui', 'sidebarMaxLongTask', sidebarLong)

  // Ctrl+K 搜索
  const search = await page.evaluate(async () => {
    window.__longtasks = []
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const openMs = performance.now() - t0
    const input = document.querySelector('input[placeholder="搜索全部 Host 的会话"]')
    if (!input) return { openMs, searchMs: -1, results: -1 }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const t1 = performance.now()
    setter.call(input, '外部会话 2999')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      if (document.body.textContent.includes('个结果')) break
    }
    const searchMs = performance.now() - t1
    const foot = [...document.querySelectorAll('div')].map((d) => d.textContent).find((t) => /^\d+ 个结果$/.test(t || ''))
    return { openMs, searchMs, results: foot ? Number(foot.split(' ')[0]) : -1, longtask: Math.max(0, ...window.__longtasks.map((t) => t.dur)) }
  })
  record('ui', 'searchOpen', search.openMs)
  record('ui', 'searchType', search.searchMs, { results: search.results })
  record('ui', 'searchMaxLongTask', search.longtask ?? -1)
  await page.keyboard.press('Escape')

  // 打开长会话（整页重载，含 JSON 下载/解析/渲染）
  await page.goto(`${BASE}/?token=${TOKEN}#/h/${hostId}/s/long`, { waitUntil: 'domcontentloaded' })
  const t0 = performance.now()
  await page.waitForFunction(() => document.body.textContent.includes('第 1000 轮完成'), null, { timeout: 180_000 })
  record('ui', 'openLongSession', performance.now() - t0, {
    domNodes: await page.evaluate(() => document.querySelectorAll('*').length),
    msgRows: await page.locator('.msg-row').count(),
    longtasks: await page.evaluate(() => window.__longtasks.length),
  })
  record('ui', 'openLongMaxLongTask', await page.evaluate(() => Math.max(0, ...window.__longtasks.map((t) => t.dur))))
  // 等渐进加载补齐历史，避免把后台补齐计入滚动帧
  await page.waitForFunction(() => !document.querySelector('[data-loading-history]'), null, { timeout: 120_000 }).catch(() => {})
  record('ui', 'openLongFullRender', await page.evaluate(() => performance.now()))

  // 滚动帧时间（长会话）
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('.chat-scroll')
    el.scrollTop = 0
    await new Promise((r) => requestAnimationFrame(r))
    const frames = []
    let last = performance.now()
    for (let i = 0; i < 90; i++) {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * (i / 89)
      await new Promise((r) => requestAnimationFrame(r))
      const now = performance.now()
      frames.push(now - last)
      last = now
    }
    frames.sort((a, b) => a - b)
    return { p50: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1] }
  })
  record('ui', 'scrollFrameP50', scroll.p50)
  record('ui', 'scrollFrameP95', scroll.p95)
  record('ui', 'scrollFrameMax', scroll.max)

  // 长会话流式输出时的主线程长任务
  await sleep(1200)
  const ws = await wsConnect()
  const snap = waitWs(ws, (m) => m.type === 'session_snapshot' && m.session.id === 'long', 180_000)
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'long' }))
  await snap
  await page.evaluate(() => { window.__longtasks = [] })
  const done = waitWs(ws, (m) => m.type === 'turn_end' && m.sessionId === 'long', 180_000)
  const streamStart = performance.now()
  await wsSend(ws, 'long', '继续，输出性能测试文本')
  await done
  const streamMs = performance.now() - streamStart
  await sleep(500)
  const streamStats = await page.evaluate(() => ({
    count: window.__longtasks.length,
    max: Math.max(0, ...window.__longtasks.map((t) => t.dur)),
    total: window.__longtasks.reduce((n, t) => n + t.dur, 0),
  }))
  record('ui', 'streamWall', streamMs)
  record('ui', 'streamMaxLongTask', streamStats.max, { count: streamStats.count, busyMs: +streamStats.total.toFixed(0) })
  ws.close()
  await browser.close()
}

const mock = await startMock()
const host = startHost()
const readyPromise = host.ready
try {
  const { pid } = await readyPromise
  if (!uiOnly) {
    await measureServer(pid)
    measureStore()
    if (!skipConcurrency) await measureConcurrency(pid)
    record('memory', 'rssAfterConcurrency', 0, { bytes: memRss(pid) })
    const eld = readEld(host.logs())
    const peak = eld.length ? Math.max(...eld.map((e) => e.p99)) : -1
    record('concurrency', 'eventLoopP99', peak)
  }
  if (!skipUi) await measureUi()
  const finalRss = memRss(pid)
  record('memory', 'rssFinal', 0, { bytes: finalRss })
  writeFileSync(`/tmp/perf-${tag}.json`, JSON.stringify(out, null, 2))
  console.log(`\nwritten /tmp/perf-${tag}.json`)
} finally {
  host.child.kill('SIGTERM')
  await sleep(1500)
  if (!host.child.killed) host.child.kill('SIGKILL')
  mock.close()
}
