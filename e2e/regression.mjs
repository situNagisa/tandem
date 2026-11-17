#!/usr/bin/env node
/**
 * 回归走查：把 docs/archive/reviews/ 下 qa-v6、bugs-v6、review-v4/v5/v7a/v7b/v7c 中标记「已修」的
 * P0/P1 交互整理成可重复执行的断言。
 *
 * 全程使用临时 Host（TANDEM_HOME=/tmp/tandem-reg-<随机>、随机端口）与假 OpenAI 兼容端点；
 * 不读真实 Key、不碰 ~/.tandem。成功退出码 0，任一断言失败退出码 1 并保留临时目录与截图。
 *
 * 用例按功能拆在 e2e/regression/<功能>.mjs，公共夹具与页面助手在 e2e/regression/lib/；
 * 源码路径到功能文件的映射见 e2e/regression/map.mjs。
 *
 * 前置：npm run build（check.mjs 会先构建）。
 * 用法：
 *   npm run regression                                  全量
 *   node e2e/regression.mjs --only "更多菜单"            只跑名称包含该片段的用例（可重复，命中任一即可）
 *   node e2e/regression.mjs --from 70 --to 80           只跑 order 区间内的用例（定位「前序用例 + 失败用例」）
 *   node e2e/regression.mjs --changed                   只跑与改动相关的功能文件
 *   node e2e/regression.mjs --changed --changed-base HEAD  验收/调试：只看工作区改动（无改动或只改文档时跳过）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { DESKTOP, MOBILE, ROOT, SMALL, listen, sleep } from './regression/lib/common.mjs'
import { createMockProvider } from './regression/lib/mock-provider.mjs'
import {
  api,
  importSeededProfiles,
  seedData,
  seedPreviewApp,
  seedRepo,
  seedWiki,
  startHost,
  writeJson,
} from './regression/lib/seeds.mjs'
import { createPageHelpers } from './regression/lib/page.mjs'
import { changedFiles, selectFeatures } from './regression/map.mjs'
import { KNOWN_FLAKY, flakyWarnings, recordRun } from './regression/lib/flaky.mjs'
import * as conversation from './regression/conversation.mjs'
import * as composer from './regression/composer.mjs'
import * as sidebar from './regression/sidebar.mjs'
import * as sessionGraph from './regression/session-graph.mjs'
import * as mobile from './regression/mobile.mjs'
import * as settings from './regression/settings.mjs'
import * as modelAccounts from './regression/model-accounts.mjs'
import * as routing from './regression/routing.mjs'
import * as sandbox from './regression/sandbox.mjs'
import * as workspace from './regression/workspace.mjs'
import * as board from './regression/board.mjs'
import * as feedback from './regression/feedback.mjs'
import * as workstation from './regression/workstation.mjs'
import * as shell from './regression/shell.mjs'

const FEATURES = [
  conversation,
  composer,
  sidebar,
  sessionGraph,
  mobile,
  settings,
  modelAccounts,
  routing,
  sandbox,
  workspace,
  board,
  feedback,
  workstation,
  shell,
]

const ONLY = process.argv.flatMap((arg, index) => (arg === '--only' ? [process.argv[index + 1] ?? ''] : [])).filter(Boolean)
const numberArg = (flag) => {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : null
}
// 按 order 区间选跑：二分状态泄漏时，把「前序用例 + 失败用例」放在一起复现。
const FROM = numberArg('--from')
const TO = numberArg('--to')
// 按改动选跑：改动 → 功能文件；无改动或只改文档跳过；未命中的改动回落全量。
const CHANGED = process.argv.includes('--changed')
const changedBaseIndex = process.argv.indexOf('--changed-base')
const CHANGED_BASE = changedBaseIndex >= 0 ? (process.argv[changedBaseIndex + 1] ?? null) : null

async function main() {
  let selection = null
  if (CHANGED) {
    selection = selectFeatures(changedFiles(ROOT, CHANGED_BASE))
    if (selection.skip) {
      console.log(`${selection.reason}，跳过回归`)
      return
    }
  }

  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-reg-'))
  const wsHome = path.join(home, 'tandem')
  const configDir = path.join(wsHome, 'local-host')
  const repo = path.join(home, 'repo')
  const shots = path.join(home, 'shots')
  mkdirSync(shots, { recursive: true })
  const seedToken = randomUUID()
  const hostId = randomUUID()
  let token = seedToken
  let wsBase = ''

  const provider = createMockProvider()
  const mockPort = await listen(provider)
  // 预览页先启动，避免 Host 在会话文件写入前完成加载；Host 仍只监听本机。
  const previewApp = await seedPreviewApp(path.join(home, 'preview-app'))
  // 后台任务悬停列表：Host 启动时从 tasks/*.json 载入，先于进程启动写入。
  const seededTasksDir = path.join(configDir, 'tasks')
  mkdirSync(seededTasksDir, { recursive: true })
  for (const task of [
    {
      id: 'bash_reg_dev',
      command: 'npm run dev -- --port 4173',
      status: 'exited',
      exitCode: 0,
      startedAt: Date.now() - 125_000,
      endedAt: Date.now() - 5_000,
    },
    {
      id: 'bash_reg_test',
      command: 'npm test -- --watch=false',
      status: 'killed',
      startedAt: Date.now() - 260_000,
      endedAt: Date.now() - 140_000,
    },
  ]) {
    writeFileSync(
      path.join(seededTasksDir, `${task.id}.json`),
      JSON.stringify({
        sessionId: 'long',
        cwd: repo,
        outputChars: 0,
        ...task,
      }),
    )
  }
  // 造数用的「今天」固定为脚本启动时刻；页面里也用 page.clock 固定到同一时刻，
  // 否则跨零点运行时界面已经进入新的一天，与造好的用量行错位。
  const today = new Date()
  const dayString = (offset) => {
    const d = new Date(today)
    d.setDate(d.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  let browser
  /** @type {ReturnType<typeof startHost> | undefined} */
  let host
  const failures = []
  let passed = 0

  try {
    seedRepo(repo)
    seedWiki(configDir, repo)
    const seeded = seedData({
      configDir,
      repo,
      hostId,
      mockPort,
      previewCwd: previewApp.root,
      today: dayString(0),
      day: dayString,
    })

    // 外部会话夹具（反馈9#01）：Claude Code jsonl 带 model / usage 与一次 Edit，
    // 供只读预览的轮次大纲、用量 tooltip 与信息面板断言。
    {
      const externalDir = path.join(home, 'home', '.claude', 'projects', '-tmp-reg-demo')
      mkdirSync(externalDir, { recursive: true })
      const externalLines = [
        {
          type: 'user',
          uuid: 'eu1',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:00:00.000Z',
          message: { role: 'user', content: '外部会话第一轮：检查构建脚本' },
        },
        {
          type: 'assistant',
          uuid: 'ea1',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:00:05.000Z',
          message: {
            id: 'emsg1',
            role: 'assistant',
            model: 'claude-sonnet-4-5-20250929',
            content: [
              { type: 'text', text: '我先查看 package.json。' },
              { type: 'tool_use', id: 'etool1', name: 'Read', input: { file_path: 'package.json' } },
            ],
            usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200 },
          },
        },
        {
          type: 'user',
          uuid: 'eu2',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:00:06.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'etool1', content: '{"name":"demo"}' }] },
        },
        {
          type: 'assistant',
          uuid: 'ea2',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:00:08.000Z',
          message: {
            id: 'emsg2',
            role: 'assistant',
            model: 'claude-sonnet-4-5-20250929',
            content: [{ type: 'text', text: '构建脚本正常。' }],
            usage: { input_tokens: 1500, output_tokens: 120, cache_read_input_tokens: 3200, cache_creation_input_tokens: 0 },
          },
        },
        {
          type: 'user',
          uuid: 'eu3',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:02:00.000Z',
          message: { role: 'user', content: '外部会话第二轮：清理测试脚本' },
        },
        {
          type: 'assistant',
          uuid: 'ea3',
          cwd: '/tmp/reg-external-demo',
          timestamp: '2026-11-09T01:02:05.000Z',
          message: {
            id: 'emsg3',
            role: 'assistant',
            model: 'claude-sonnet-4-5-20250929',
            content: [
              { type: 'text', text: '已清理测试脚本。' },
              { type: 'tool_use', id: 'etool2', name: 'Edit', input: { file_path: 'scripts/test.sh', old_string: 'a', new_string: 'b' } },
            ],
            usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
          },
        },
      ]
      writeFileSync(
        path.join(externalDir, 'reg-external.jsonl'),
        `${externalLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      )
    }

    // 反馈16#05：Codex 回归夹具。developer/system 注入、AGENTS.md / skills / multi_agent_role
    // 与 "You are Codex…" 基础提示混在 user 消息里，真实用户只有两轮。
    {
      const codexDir = path.join(home, 'home', '.codex', 'sessions', '2026', '11', '10')
      mkdirSync(codexDir, { recursive: true })
      const codexId = '11111111-2222-3333-4444-555555555555'
      const codexLines = [
        {
          timestamp: '2026-11-10T01:00:00.000Z',
          type: 'session_meta',
          payload: { id: codexId, cwd: '/tmp/reg-codex', originator: 'codex_cli_rs', source: 'cli' },
        },
        {
          timestamp: '2026-11-10T01:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'You are Codex, an agent based on GPT-6. You and the user share one workspace.' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'You are Codex, an agent based on GPT-6. You and the user share one workspace.' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\nA skill is a set of local instructions to follow.' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<multi_agent_role>You are `/root`, the primary agent in a team of agents collaborating.' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/reg-codex\n<INSTRUCTIONS>使用 pnpm。</INSTRUCTIONS>' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:07.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '真实第一轮：检查 npm 构建' }],
          },
        },
        {
          timestamp: '2026-11-10T01:00:08.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '构建正常。' }],
          },
        },
        {
          timestamp: '2026-11-10T01:02:00.000Z',
          type: 'turn_context',
          payload: { cwd: '/tmp/reg-codex', model: 'gpt-6.1-sol' },
        },
        {
          timestamp: '2026-11-10T01:02:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '真实第二轮：继续处理' }],
          },
        },
        {
          timestamp: '2026-11-10T01:02:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '继续处理完成。' }],
          },
        },
      ]
      writeFileSync(
        path.join(codexDir, `rollout-2026-11-10T01-00-00-${codexId}.jsonl`),
        `${codexLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      )
      globalThis.__regCodexId = codexId
    }

    // 先启动一次让调试账号与加密存储生成，再把造数用的模型账号导入，然后重启工作站。
    const first = startHost({ home, token: seedToken, hostId })
    await first.session
    first.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => first.child.once('exit', resolve)),
      sleep(5000).then(() => first.child.kill('SIGKILL')),
    ])
    await importSeededProfiles(wsHome, seeded.profiles)
    host = startHost({ home, token: seedToken, hostId })
    const sessionInfo = await host.session
    token = sessionInfo.token
    wsBase = sessionInfo.wsBase
    // 调试版会额外自动加一台演示主机；主回归只留本机。
    for (const item of await api(wsBase, token, '/api/workstation/hosts')) {
      if (item.demo) await api(wsBase, token, `/api/workstation/hosts/${item.id}`, { method: 'DELETE' })
    }
    const hostPort = await host.ready
    const base = `${wsBase}/h/${hostId}`
    const appUrl = `${wsBase}/`

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


    browser = await chromium.launch({ headless: true })
    const CONTEXT_OPTIONS = {
      desktop: { viewport: DESKTOP, deviceScaleFactor: 1 },
      mobile: { viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      small: { viewport: SMALL, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    }
    const desktopContext = await browser.newContext(CONTEXT_OPTIONS.desktop)
    const mobileContext = await browser.newContext(CONTEXT_OPTIONS.mobile)
    const smallContext = await browser.newContext(CONTEXT_OPTIONS.small)

    const checks = []
    const desktop = (name, fn) => checks.push({ name, viewport: 'desktop', fn })
    const mobile = (name, fn) => checks.push({ name, viewport: 'mobile', fn })
    const small = (name, fn) => checks.push({ name, viewport: 'small', fn })
    // 反馈2102：与用户截图同尺寸、深色主题的桌面窗口。
    const fb2102 = (name, fn) => checks.push({ name, viewport: 'desktop', context: 'fb2102', fn })
    // 反馈「调整」：与用户截图同类的深色 1440×900 窗口。
    const fbAdjust = (name, fn) => checks.push({ name, viewport: 'desktop', context: 'fb-adjust', fn })
    // 调整工具在手机布局（412×915、触屏）下同样可用。
    const fbAdjustMobile = (name, fn) =>
      checks.push({ name, viewport: 'mobile', context: 'fb-adjust-mobile', fn })

    const pageHelpers = createPageHelpers({ appUrl, today, base, token })
    const ctx = {
      ...pageHelpers,
      desktop,
      mobile,
      small,
      fb2102,
      fbAdjust,
      fbAdjustMobile,
      home,
      wsHome,
      configDir,
      repo,
      shots,
      hostId,
      token,
      wsBase,
      provider,
      mockPort,
      previewApp,
      today,
      dayString,
      browser,
      base,
      appUrl,
      seeded,
      host,
    }

    let selectedFeatures = null
    if (CHANGED) {
      if (selection.all) {
        console.log(`--changed: 回落全量（${selection.reason}）`)
      } else {
        selectedFeatures = new Set(selection.features)
        console.log(`--changed: 只跑 ${[...selectedFeatures].join('、')}`)
      }
    }

    for (const module of FEATURES) {
      if (selectedFeatures && !selectedFeatures.has(module.feature)) continue
      const before = checks.length
      module.register(checks, ctx)
      // 按拆分前的全局序号回填，全量的执行顺序与拆分前完全一致（共享 context/localStorage 的用例顺序不变）。
      const added = checks.slice(before)
      if (module.order?.length === added.length) {
        added.forEach((check, index) => {
          check.order = module.order[index]
        })
      } else {
        console.warn(`regression: ${module.feature} 的 order 与用例数不一致（${module.order?.length} / ${added.length}）`)
      }
    }

    // ------------------------------------------------------------------ 执行

    const selected = checks
      .filter((item) => (ONLY.length ? ONLY.some((pattern) => item.name.includes(pattern)) : true))
      .filter((item) => (FROM === null && TO === null ? true : item.order !== undefined && item.order >= (FROM ?? -Infinity) && item.order <= (TO ?? Infinity)))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    if (ONLY.length && !selected.length) throw new Error(`--only "${ONLY.join(' / ')}" 没有匹配任何用例`)
    if ((FROM !== null || TO !== null) && !selected.length) throw new Error(`--from/--to ${FROM ?? ''}..${TO ?? ''} 没有匹配任何用例`)
    if (CHANGED && !selected.length) throw new Error('--changed 没有匹配任何用例')

    /** 跑一条用例；gate/offline/win32 等用例各自建独立 context（共享 context 会带上前面用例的存储）。 */
    const runCheck = async (check, attempt = 1) => {
      let context
      let ownContext = false
      if (check.gate) {
        // 登录门用例用独立 context：前面的用例可能通过 context 级 init script / 登录状态污染共享存储。
        context = await browser.newContext(CONTEXT_OPTIONS.desktop)
        ownContext = true
      } else if (check.context === 'offline') {
        context = await browser.newContext(CONTEXT_OPTIONS.desktop)
        ownContext = true
      } else if (check.context === 'win32') {
        context = await browser.newContext(CONTEXT_OPTIONS.desktop)
        await context.addInitScript(() => {
          window.tandemDesktop = { isDesktop: true, platform: 'win32' }
        })
        ownContext = true
      } else if (check.context === 'fb2102') {
        context = await browser.newContext({ viewport: { width: 1912, height: 914 }, deviceScaleFactor: 1 })
        await context.addInitScript(() => {
          localStorage.setItem('tandem.theme.v1', 'dark')
        })
        ownContext = true
      } else if (check.context === 'fb-adjust') {
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
        await context.addInitScript(() => {
          localStorage.setItem('tandem.theme.v1', 'dark')
        })
        ownContext = true
      } else if (check.context === 'fb-adjust-mobile') {
        context = await browser.newContext({
          viewport: { width: 412, height: 915 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        })
        await context.addInitScript(() => {
          localStorage.setItem('tandem.theme.v1', 'dark')
        })
        ownContext = true
      } else if (attempt > 1) {
        // 偶发重跑用全新 context：共享 context 的 localStorage（最近模型、主题、折叠/固定状态等）
        // 可能已被前序用例改过，原样重跑会再次撞上同一份污染。
        context = await browser.newContext(CONTEXT_OPTIONS[check.viewport] ?? CONTEXT_OPTIONS.desktop)
        ownContext = true
      } else {
        context =
          check.viewport === 'mobile'
            ? mobileContext
            : check.viewport === 'small'
              ? smallContext
              : desktopContext
      }
      const page = await pageHelpers.newPage(context, check.viewport, { gate: !!check.gate })
      const started = Date.now()
      try {
        await check.fn(page)
        assert.equal(page.__errors.length, 0, `页面脚本错误：${page.__errors.join('；')}`)
        return { ok: true, ms: Date.now() - started }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const shot = path.join(shots, `${check.viewport}-${check.name.length}-${attempt}.png`)
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
        return { ok: false, message, shot, ms: Date.now() - started }
      } finally {
        await page.close().catch(() => {})
        if (ownContext) await context.close().catch(() => {})
      }
    }

    const fullRun = !CHANGED && !ONLY
    const flaky = []
    for (const check of selected) {
      const first = await runCheck(check)
      if (first.ok) {
        passed += 1
        console.log(`✓ ${check.name}  ${first.ms}ms`)
        continue
      }
      // 负载下时序用例偶发失败：单独重跑一次，通过则记为 flaky，不算失败。
      const retry = await runCheck(check, 2)
      if (retry.ok) {
        passed += 1
        flaky.push(check.name)
        console.log(`~ ${check.name}  ${retry.ms}ms（首次失败，单独重跑通过；首次：${first.message.split('\n')[0]}）`)
        continue
      }
      failures.push({ name: check.name, message: retry.message })
      console.error(`✗ ${check.name}\n  ${retry.message}\n  截图：${retry.shot}`)
    }

    const history = recordRun({ full: fullRun, flaky })
    const warnings = flakyWarnings(history, flaky) 
    if (flaky.length) {
      console.log(`\n=== 偶发（flaky） ===`)
      console.log(`单独重跑通过 ${flaky.length} 条：${flaky.join('、')}`)
    }
    if (warnings.length) {
      console.log(`\n⚠ 偶发警告名单（同一次全量 flaky ≥2 次，或连续 3 次全量都 flaky；需要排查修复）`)
      for (const warning of warnings) console.log(`- ${warning}`)
    }
    if (KNOWN_FLAKY.length) {
      console.log(`\n已知偶发记录（历史，出现时优先对照）：${KNOWN_FLAKY.map((item) => item.name).join('、')}`)
    }

    console.log(`\n=== regression 汇总 ===`)
    console.log(`通过 ${passed} / ${selected.length} 条，失败 ${failures.length} 条，偶发 ${flaky.length} 条`)
    for (const failure of failures) console.log(`- ${failure.name}：${failure.message}`)
    if (failures.length) process.exitCode = 1
  } catch (error) {
    console.error(`regression: 运行失败\n${error instanceof Error ? error.stack : error}`)
    console.error(host?.logs() ?? '')
    process.exitCode = 1
  } finally {
    await browser?.close().catch(() => {})
    if (host && !host.child.killed) host.child.kill('SIGTERM')
    if (host) {
      await Promise.race([
        new Promise((resolve) => host.child.once('exit', resolve)),
        sleep(3000).then(() => host.child.kill('SIGKILL')),
      ])
    }
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
