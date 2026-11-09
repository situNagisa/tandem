#!/usr/bin/env node
/**
 * 无障碍扫描：临时 Host + Playwright + axe-core。
 *
 * 覆盖：新会话页、会话页（工具卡 / 审批卡 / 计划卡）、侧栏、设置全部页签、
 * 收件箱、反馈模式、组件画廊 #/dev/ui；深色与浅色各扫一遍。
 *
 * 用法：
 *   node scripts/a11y-scan.mjs                     默认 /tmp/tandem-a11y、端口 8262
 *   node scripts/a11y-scan.mjs --out docs/a11y-v1.json
 *   node scripts/a11y-scan.mjs --only home,session 只扫指定页面
 *
 * 前置：npm run build。成功退出码 0（无 serious/critical）；有严重违规退出码 1。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium } from 'playwright'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
const HOST_ID = 'a11y-host'
const TOKEN = 'a11y-token-local'
const PORT = Number(process.env.A11Y_PORT ?? 8262)
const SEVERE = new Set(['serious', 'critical'])
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const SETTINGS_TABS = [
  '通用', '语音', '浏览器', '账号与模型', 'Host 管理', '成员', '权限', 'Hooks', 'MCP',
  'Skills', '记忆', '子代理', '提示词', '评测', '定时任务', '预算', '用量', '通知',
  '分享', '同步与备份', '外观',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { home: '/tmp/tandem-a11y', out: '', only: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out.out = args[++i]
    else if (args[i] === '--home') out.home = args[++i]
    else if (args[i] === '--only') out.only = new Set(args[++i].split(','))
  }
  return out
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function seedRepo(repo) {
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'a11y@example.com')
  git('config', 'user.name', 'a11y')
  writeFileSync(path.join(repo, 'README.md'), '# a11y repo\n')
  writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  writeFileSync(path.join(repo, 'src/app.ts'), 'export const a = 2\nexport const b = 3\n')
  writeFileSync(path.join(repo, 'src/new.ts'), 'export const c = 4\n')
}

function seed(configDir, repo) {
  const now = Date.now()
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
  writeJson(path.join(configDir, 'profiles.json'), {
    profiles: [
      {
        id: 'p-main',
        name: '主力账号',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'a11y-fake-key',
        models: ['mock-1', 'mock-2'],
        defaultModel: 'mock-1',
        createdAt: now - 10000,
        groups: [
          { id: 'g1', name: '生产', apiKey: 'a11y-fake-g1', models: ['mock-1', 'mock-2'], defaultModel: 'mock-1' },
        ],
      },
    ],
  })

  const msg = (id, role, content, extra = {}) => ({
    id,
    role,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    createdAt: now - 60000 + Number(id.replace(/\D/g, '') || 0) * 1000,
    ...extra,
  })

  const main = {
    ...common,
    id: 'main',
    title: '无障碍走查会话',
    createdAt: now - 3600000,
    updatedAt: now - 1000,
    messages: [
      msg('m1', 'user', '帮我读一下 src/app.ts，然后更新待办。'),
      msg('m2', 'assistant', [
        { type: 'thinking', thinking: '先读取文件，确认内容后再更新待办。' },
        { type: 'text', text: '我先读取文件。' },
        { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'src/app.ts' } },
        { type: 'tool_use', id: 'tu-todo', name: 'TodoWrite', input: { todos: [{ content: '读取文件', status: 'completed' }, { content: '汇总结果', status: 'in_progress' }] } },
        { type: 'text', text: '文件内容正常，已更新待办。' },
      ], { model: 'mock-1', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }),
      msg('m3', 'user', '再跑一下 npm test。'),
      msg('m4', 'assistant', [
        { type: 'text', text: '我来运行测试。' },
        { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: '测试全部通过。' },
      ], { model: 'mock-1', usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.002 } }),
    ],
  }

  const approve = {
    ...common,
    id: 'approve',
    title: '等待审批的会话',
    createdAt: now - 3000000,
    updatedAt: now - 500,
    messages: [
      msg('a1', 'user', '跑一下测试，然后提交。'),
      msg('a2', 'assistant', [
        { type: 'text', text: '我先运行测试。' },
        { type: 'tool_use', id: 'tu-ap', name: 'Bash', input: { command: 'npm test' } },
      ], { model: 'mock-1' }),
    ],
    runState: {
      version: 1,
      startedAt: now - 5000,
      updatedAt: now - 1000,
      completedMessages: ['a1', 'a2'],
      queue: [],
      inFlightTools: [{ id: 'tu-ap', name: 'Bash', startedAt: now - 1000 }],
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
      assistantMessageId: 'a2',
    },
  }

  const plan = {
    ...common,
    id: 'plan',
    title: '等待批准的计划',
    permissionMode: 'plan',
    createdAt: now - 2400000,
    updatedAt: now - 400,
    messages: [
      msg('p1', 'user', '设计一下登录模块的重构方案。'),
      msg('p2', 'assistant', '我把计划整理好了，请确认。', { model: 'mock-1' }),
    ],
    runState: {
      version: 1,
      startedAt: now - 4000,
      updatedAt: now - 800,
      completedMessages: ['p1', 'p2'],
      queue: [],
      inFlightTools: [],
      pendingPermissions: [
        {
          id: 'perm-plan',
          sessionId: 'plan',
          toolUseId: 'tu-plan',
          toolName: 'ExitPlanMode',
          input: { plan: '## 登录模块重构\n\n1. 抽出 `auth/session.ts`\n2. 统一 token 刷新\n3. 补充单元测试' },
          description: '批准计划',
        },
      ],
      phase: 'plan',
      permissionMode: 'plan',
      assistantMessageId: 'p2',
    },
  }

  for (const session of [main, approve, plan]) {
    writeJson(path.join(configDir, 'sessions', `${session.id}.json`), session)
  }
  writeJson(path.join(configDir, 'permissions.json'), [])
}

function startHost({ home }) {
  const configDir = path.join(home, 'tandem')
  const repo = path.join(home, 'repo')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  mkdirSync(path.join(home, 'home'), { recursive: true })
  seedRepo(repo)
  writeJson(path.join(configDir, 'config.json'), {
    hostId: HOST_ID,
    token: TOKEN,
    idleTimeoutSec: 600,
    resumeOnRestart: 'auto',
    defaultDelegation: 'less',
  })
  seed(configDir, repo)

  const child = spawn(process.execPath, [HOST_ENTRY, '--port', String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(home, 'home'),
      TANDEM_HOME: configDir,
      TANDEM_DEBUG_ACCOUNT: '0',
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
  child.stdout.on('data', (c) => (stdout += c))
  child.stderr.on('data', (c) => (stderr += c))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host 启动超时\n${stdout}\n${stderr}`)), 30000)
    const check = () => {
      if (stdout.includes(`http://127.0.0.1:${PORT}/?token=`)) {
        clearTimeout(timer)
        resolve()
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

export function summarize(results) {
  const all = new Map()
  for (const pageResult of results) {
    for (const v of pageResult.violations) {
      const key = `${v.id}|${v.impact ?? 'unknown'}`
      const entry = all.get(key) ?? {
        id: v.id,
        impact: v.impact ?? 'unknown',
        help: v.help,
        rule: v.id,
        pages: new Set(),
        nodes: [],
        nodeCount: 0,
      }
      entry.pages.add(`${pageResult.theme}/${pageResult.page}`)
      entry.nodeCount += v.nodes.length
      for (const n of v.nodes.slice(0, 3)) entry.nodes.push({ target: n.target.join(' '), summary: n.failureSummary })
      all.set(key, entry)
    }
  }
  return [...all.values()]
    .map((entry) => ({ ...entry, pages: [...entry.pages] }))
    .sort((a, b) => {
      const order = { critical: 0, serious: 1, moderate: 2, minor: 3 }
      return (order[a.impact] ?? 9) - (order[b.impact] ?? 9) || b.nodeCount - a.nodeCount
    })
}

function severityCounts(results) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const pageResult of results) {
    for (const v of pageResult.violations) {
      for (const n of v.nodes) counts[v.impact ?? 'minor'] += 1
    }
  }
  return counts
}

async function scan(page, label, theme, results) {
  try {
    const builder = new AxeBuilder({ page }).withTags(TAGS)
    const analysis = await builder.analyze()
    results.push({
      page: label,
      theme,
      url: page.url(),
      violations: analysis.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          html: n.html?.slice(0, 500),
          failureSummary: n.failureSummary,
        })),
      })),
      passes: analysis.passes.length,
    })
    console.log(`  · ${theme}/${label}: ${analysis.violations.length} 条规则违规`)
  } catch (err) {
    results.push({ page: label, theme, error: String(err), violations: [] })
    console.log(`  ! ${theme}/${label}: 扫描失败 ${err}`)
  }
}

async function settle(page, ms = 350) {
  await page.waitForTimeout(ms)
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('tandem.theme.v1', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
  }, theme)
  await settle(page, 150)
}

async function openSettings(page) {
  await page.getByRole('button', { name: '设置', exact: true }).last().click()
  await page.getByRole('dialog', { name: '设置' }).waitFor()
  await settle(page)
}

async function closeDialog(page) {
  await page.keyboard.press('Escape')
  await settle(page, 250)
}

export async function runA11yScan(options = {}) {
  const home = options.home ?? '/tmp/tandem-a11y'
  const only = options.only ?? null
  const host = startHost({ home })
  await host.ready
  const browser = await chromium.launch()
  const results = []
  const base = `http://127.0.0.1:${PORT}/?token=${TOKEN}`
  const sessionUrl = (id) => `${base}#/h/${HOST_ID}/s/${id}`
  const want = (name) => !only || only.has(name)

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      try {
        localStorage.setItem('tandem.gate.skip', '1')
      } catch {
        /* 忽略 */
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (err) => console.log('  pageerror:', err.message))
    await page.goto(base)
    await page.getByRole('button', { name: /^新会话/ }).waitFor({ timeout: 20000 })
    await settle(page, 800)

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme)
      console.log(`\n[${theme}]`)

      if (want('home')) {
        await page.evaluate(() => (window.location.hash = '#/'))
        await settle(page, 400)
        await scan(page, 'home', theme, results)
      }
      if (want('session')) {
        await page.goto(sessionUrl('main'))
        await page.getByText('无障碍走查会话').first().waitFor({ timeout: 15000 })
        await settle(page, 500)
        await scan(page, 'session', theme, results)
        if (want('sidebar')) {
          const aside = page.locator('aside').first()
          const builder = new AxeBuilder({ page }).include('aside').withTags(TAGS)
          const analysis = await builder.analyze()
          results.push({ page: 'sidebar', theme, url: page.url(), violations: analysis.violations, scoped: 'aside' })
          console.log(`  · ${theme}/sidebar: ${analysis.violations.length} 条规则违规`)
        }
      }
      if (want('approval')) {
        await page.goto(sessionUrl('approve'))
        await page.getByText('等待审批的会话').first().waitFor({ timeout: 15000 })
        await settle(page, 500)
        await scan(page, 'approval', theme, results)
      }
      if (want('plan')) {
        await page.goto(sessionUrl('plan'))
        await page.getByText('等待批准的计划').first().waitFor({ timeout: 15000 })
        await settle(page, 500)
        await scan(page, 'plan', theme, results)
      }
      if (want('gallery')) {
        await page.goto(`${base}#/dev/ui`)
        await page.getByRole('heading', { name: '组件画廊' }).waitFor({ timeout: 15000 })
        await settle(page, 400)
        await scan(page, 'gallery', theme, results)
      }
      if (want('settings')) {
        await page.goto(sessionUrl('main'))
        await page.getByRole('button', { name: /^新会话/ }).waitFor()
        await settle(page, 400)
        await openSettings(page)
        for (const tab of SETTINGS_TABS) {
          await page
            .getByRole('dialog', { name: '设置' })
            .locator('nav')
            .getByRole('button', { name: tab, exact: true })
            .click()
          await settle(page, 350)
          await scan(page, `settings:${tab}`, theme, results)
        }
        await closeDialog(page)
      }
      if (want('inbox')) {
        await page.getByRole('button', { name: /^收件箱/ }).click()
        await page.getByRole('dialog').first().waitFor()
        await settle(page, 400)
        await scan(page, 'inbox', theme, results)
        await closeDialog(page)
      }
      if (want('feedback')) {
        await page.keyboard.press('Control+Shift+F')
        await settle(page, 600)
        await scan(page, 'feedback', theme, results)
        await page.keyboard.press('Control+Shift+F')
        await settle(page, 300)
      }
    }
    await context.close()
  } finally {
    await browser.close()
    host.child.kill('SIGTERM')
  }

  const counts = severityCounts(results)
  return { results, counts, summary: summarize(results), logs: host.logs() }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isCli) {
  const args = parseArgs()
  const { results, counts, summary } = await runA11yScan({ home: args.home, only: args.only })
  const output = { generatedAt: new Date().toISOString(), counts, summary, results }
  if (args.out) writeJson(path.resolve(ROOT, args.out), output)
  console.log('\n=== 汇总 ===')
  console.log(`节点数：critical ${counts.critical} / serious ${counts.serious} / moderate ${counts.moderate} / minor ${counts.minor}`)
  for (const item of summary) {
    console.log(`${item.impact.padEnd(8)} ${item.id.padEnd(38)} ${item.nodeCount} 节点  ${item.help}`)
  }
  const severe = counts.critical + counts.serious
  if (severe > 0) {
    console.log(`\n严重/关键违规共 ${severe} 个节点`)
    process.exitCode = 1
  } else {
    console.log('\n严重/关键违规为 0')
  }
}

// 导出供 Playwright 回归复用。
export function axeTags() {
  return TAGS
}
export function isSevere(impact) {
  return SEVERE.has(impact)
}
export { readFileSync, os }
