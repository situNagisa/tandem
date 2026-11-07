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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'

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
  return server
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function startHost({ home, token, hostId }) {
  const configDir = path.join(home, 'tandem')
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
      CODEX_HOME: path.join(home, 'home', '.codex'),
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

function seedData({ configDir, repo, hostId, mockPort, today, day }) {
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
    mk('links', '文件链接会话', linksMessages, { updatedAt: Date.now() - 1500 }),
    mk('nockpt', '无检查点会话', [
      message('n1', 'user', '先看看目录'),
      message('n2', 'assistant', '目录结构如下。', { model: 'mock-1' }),
      message('n3', 'user', '再列一下文件'),
    ]),
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
    seedData({ configDir, repo, hostId, mockPort, today: dayString(0), day: dayString })

    const hostPort = await host.ready
    const base = `http://127.0.0.1:${hostPort}`
    const appUrl = `${base}/?token=${token}#/h/${hostId}`

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
      await dialog.locator('nav').first().getByRole('button', { name: tab, exact: true }).click()
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
        await dialog.locator('nav').first().getByRole('button', { name: tab, exact: true }).click()
        await page.waitForTimeout(160)
        const next = await dialog.boundingBox()
        assert.ok(Math.abs(next.width - box.width) <= 1 && Math.abs(next.height - box.height) <= 1, `切到「${tab}」后尺寸变化`)
        withinViewport(next, DESKTOP, `设置窗口（${tab}）`)
      }
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

    desktop('只监听回环时「连接手机」不展示二维码', async (page) => {
      await openSettings(page, 'Host 管理', 'desktop')
      await page.getByRole('button', { name: '连接手机' }).first().click()
      const dialog = page.getByRole('dialog', { name: '连接手机' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByText('手机暂时连不上这台 Host').waitFor({ state: 'visible', timeout: 10_000 })
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
      assert.match(await confirm.innerText(), /Host/, '确认文案没有说明将删除的 Host 数量')
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
        await dialog.locator('nav').first().getByRole('button', { name: tab, exact: true }).click()
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
      await page.getByRole('button', { name: '浏览器', exact: true }).first().click()
      const panel = page.getByRole('dialog', { name: '浏览器' })
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      await panel.getByText(/本会话还没有打开浏览器|页面还没有截图/).first().waitFor({ timeout: 5_000 })
      assertNoOverflow('浏览器面板', await panel.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })))
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden', timeout: 5_000 })
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
    if (!host.child.killed) host.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => host.child.once('exit', resolve)),
      sleep(3000).then(() => host.child.kill('SIGKILL')),
    ])
    await new Promise((resolve) => provider.close(resolve))
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
