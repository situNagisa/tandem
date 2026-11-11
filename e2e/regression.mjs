#!/usr/bin/env node
/**
 * 回归走查：把 docs/archive/reviews/ 下 qa-v6、bugs-v6、review-v4/v5/v7a/v7b/v7c 中标记「已修」的
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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import WebSocket from 'ws'
import { runWorkstationCheck } from './workstation-check.mjs'
import { killExecutorsUnder, runExecutorCheck } from './executor-check.mjs'

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
  // 分工路由：模拟 prompt 缓存按模型命中（同一模型连续请求返回 cached_tokens）。
  const routePromptTokens = new Map()
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
    // 反馈10#04：多代/别名/快照混在一起的模型列表，用于验证「只勾选最新一代」。
    if (req.method === 'GET' && req.url.includes('/versioned/') && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            'claude-fable-5',
            'claude-fable-5-1',
            'claude-haiku-4-5-20251001',
            'claude-haiku-5-5',
            'claude-opus-4-5-20251101',
            'claude-opus-4-6',
            'claude-opus-5-5',
            'claude-sonnet-4-5',
            'claude-sonnet-5-5',
          ].map((id) => ({ id, object: 'model' })),
        }),
      )
      return
    }
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
      routeSeen.push({
        model: body.model,
        stream: body.stream === true,
        systemText: (body.messages ?? [])
          .filter((message) => message.role === 'system')
          .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
          .join('\n'),
        toolNames: Array.isArray(body.tools)
          ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
          : [],
      })
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
      // 只看本轮用户消息：历史里出现过的「触发失败」等关键词不能重放工具调用。
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')
      const userText =
        typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n')
      const hasToolResult = messages[messages.length - 1]?.role === 'tool'
      const promptTokens = Math.max(40, Math.ceil(JSON.stringify(messages).length / 4))
      const cachedTokens = routePromptTokens.get(body.model) ?? 0
      routePromptTokens.set(body.model, promptTokens)
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
      } else if (
        body.model === 'route-power' &&
        systemText.includes('多代理协作 · 本轮') &&
        userText.includes('前端批量') &&
        !hasToolResult
      ) {
        chunk({ role: 'assistant', content: '先派发两个自包含子任务。' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_division_ui',
              type: 'function',
              function: {
                name: 'Task',
                arguments: JSON.stringify({
                  description: '改组件样式',
                  prompt: '只改 src/components/Button.tsx，把按钮间距改为 12px；不要动其他文件。',
                  role: 'specialist',
                  domain: 'ui',
                }),
              },
            },
            {
              index: 1,
              id: 'call_division_test',
              type: 'function',
              function: {
                name: 'Task',
                arguments: JSON.stringify({
                  description: '跑 lint 测试',
                  prompt: '在仓库根目录运行 npm run lint 与 npm test，只回传结果与失败摘要。',
                  role: 'executor',
                  domain: 'test',
                }),
              },
            },
          ],
        })
        chunk({}, 'tool_calls')
      } else if (body.model === 'route-kimi') {
        chunk({ role: 'assistant', content: '前端改动完成：按钮间距已改为 12px。' })
        chunk({}, 'stop')
      } else if (body.model === 'route-mini' && userText.includes('安装依赖')) {
        chunk({ role: 'assistant', content: '便宜执行完成：依赖已安装，构建通过。' })
        chunk({}, 'stop')
      } else if (body.model === 'route-mini' && userText.includes('npm run lint')) {
        chunk({ role: 'assistant', content: '测试执行完成：lint 与测试通过。' })
        chunk({}, 'stop')
      } else if (body.model === 'route-power' && hasToolResult && userText.includes('前端批量')) {
        chunk({ role: 'assistant', content: '多代理协作完成：已审查执行结果，样式与测试均通过。' })
        chunk({}, 'stop')
      } else {
        chunk({ role: 'assistant', content: `路由模型 ${body.model} 已回复。` })
        chunk({}, 'stop')
      }
      send({
        id: 'chatcmpl-route',
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 100,
          total_tokens: promptTokens + 100,
          prompt_tokens_details: { cached_tokens: Math.min(cachedTokens, promptTokens) },
        },
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
    // ---------- 反馈1919#07：长流式回复（持续撑高消息区，验证底部跟随） ----------
    if (
      body.stream === true &&
      (body.messages ?? []).some(
        (m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes('SCROLL_E2E'),
      )
    ) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish = null) =>
        send({
          id: 'chatcmpl-scroll',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      for (let i = 0; i < 240; i++) {
        chunk({ content: `第 ${i + 1} 段：流式输出持续增高，对话区在底部时应当跟随到最新内容。\n\n` })
        await sleep(40)
      }
      chunk({}, 'stop')
      send({
        id: 'chatcmpl-scroll',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 240, total_tokens: 280 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    // ---------- 反馈16#10：慢速回合（等首个 token、长时间运行的工具） ----------
    if (
      body.stream === true &&
      (body.messages ?? []).some(
        (m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes('SLOW_E2E'),
      )
    ) {
      const lastRole = body.messages?.at(-1)?.role
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish = null) =>
        send({
          id: 'chatcmpl-slow',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      if (lastRole === 'tool') {
        chunk({ role: 'assistant', content: '慢速工具执行完成。' })
        chunk({}, 'stop')
      } else {
        // 首个 token 之前停留 1.5s：客户端应显示「正在思考…」。
        await sleep(1500)
        chunk({ role: 'assistant', content: '慢速回复开始。' })
        for (let i = 0; i < 4; i++) {
          await sleep(300)
          chunk({ content: ` 第${i + 2}段。` })
        }
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_slow_${Date.now()}`,
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 2', description: '慢速工具' }) },
            },
          ],
        })
        chunk({}, 'tool_calls')
      }
      send({
        id: 'chatcmpl-slow',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
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

/** 启动工作站进程；本机主机上下文的数据在 <工作站>/local-host/。 */
function startHost({ home, token, hostId, extraEnv = {} }) {
  mkdirSync(home, { recursive: true })
  const wsHome = path.join(home, 'tandem')
  const configDir = path.join(wsHome, 'local-host')
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

  const env = {
    ...process.env,
      HOME: path.join(home, 'home'),
      TANDEM_HOME: wsHome,
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
  }
  // extraEnv 里显式 undefined 表示“删掉这个变量”，用于让调试版默认值生效。
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0'], {
    cwd: ROOT,
    env,
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
    const timer = setTimeout(() => reject(new Error(`工作站启动超时\n${stdout}\n${stderr}`)), 25_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })

  // 调试账号免密登录，并等本机主机上下文登记上线；返回访问本机主机的根地址与账号令牌。
  const debugEnabled = (env.TANDEM_DEBUG_ACCOUNT ?? '') !== '0'
  const session = !debugEnabled
    ? undefined
    : (async () => {
    const port = await ready
    const wsBase = `http://127.0.0.1:${port}`
    const res = await fetch(`${wsBase}/api/debug/auto-login`, { method: 'POST' })
    if (!res.ok) throw new Error(`调试账号登录失败（${res.status}）：${stdout}\n${stderr}`)
    const login = await res.json()
    const record = await waitForValue(async () => {
      const list = await fetch(`${wsBase}/api/workstation/hosts`, {
        headers: { authorization: `Bearer ${login.accessToken}` },
      }).then((r) => r.json())
      return list.find((item) => item.id === hostId && item.online)
    }, 30_000, '本机主机上线')
      return {
        wsBase,
        base: `${wsBase}/h/${hostId}`,
        token: login.accessToken,
        hostId,
        fingerprint: record.fingerprint,
      }
    })()

  return { child, ready, session, logs: () => `${stdout}\n${stderr}`, configDir, wsHome }
}

/** 独立工作站进程：登录门用例只验证客户端流程，不再借 Host 侧本机路由启动。 */
function startWorkstation({ home }) {
  mkdirSync(home, { recursive: true })
  const env = {
    ...process.env,
    HOME: path.join(home, 'home'),
    TANDEM_HOME: home,
    TANDEM_DEBUG_ACCOUNT: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env,
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
    const timer = setTimeout(() => reject(new Error(`工作站启动超时\n${stdout}\n${stderr}`)), 25_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

/** 轮询直到 fn 返回真值；超时给出标签与最后一次结果。 */
async function waitForValue(fn, timeout, label) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** 把造数用的模型账号写进工作站账号级加密存储（调试账号），并去掉调试用的演示账号。 */
async function importSeededProfiles(wsHome, profiles) {
  const file = path.join(wsHome, 'accounts.json')
  const accounts = JSON.parse(readFileSync(file, 'utf8'))
  const debug = (accounts.accounts ?? []).find((account) => account.username === 'debug')
  if (!debug) throw new Error('工作站里没有调试账号，无法导入模型账号')
  const { AccountProfileStore } = await import(
    pathToFileURL(path.join(ROOT, 'packages/server/dist/workstation/profiles.js')).href
  )
  const store = new AccountProfileStore(wsHome)
  for (const item of store.list(debug.id)) {
    if (item.kind === 'demo') store.remove(debug.id, item.id)
  }
  store.importStored(debug.id, profiles)
  store.dispose()
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
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
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

/** 订阅会话并取第一份快照（用于验证首屏下发字节/条数）。 */
function wsInboxSnapshot(base, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('inbox snapshot timeout'))
    }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe_inbox' })))
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type !== 'inbox_snapshot') return
      clearTimeout(timer)
      ws.close()
      resolve(msg.snapshot)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

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

  writeFileSync(
    path.join(repo, 'src/hello.ts'),
    'export const hello = 2\nexport const world = 3\nexport const longLine = "' + '长'.repeat(120) + '"\n',
  )
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
  const dirty = path.join(path.dirname(repo), 'tandem', 'dirty-wt')
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
          // 反馈1323#02：旧数据里同一分组有两个 Key，界面只显示第一个可用的，保存不删其余。
          keys: [
            { id: 'k-g1-a', label: '主', apiKey: 'reg-key-g1' },
            { id: 'k-g1-b', label: '备', apiKey: 'reg-key-g1-backup' },
          ],
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
      models: ['route-mini', 'route-mid', 'route-power', 'route-kimi'],
      defaultModel: 'route-mini',
      price: {
        'route-mini': { input: 0.1, output: 0.2 },
        'route-mid': { input: 1, output: 2 },
        'route-kimi': { input: 4, output: 12 },
        'route-power': { input: 10, output: 20 },
      },
      createdAt: Date.now() - 28_000,
    },
    {
      // 反馈10#04：多代/别名/日期快照混在一起的模型列表。
      id: 'p-versioned',
      name: '多代模型账号',
      kind: 'openai-compatible',
      baseUrl: baseUrl.replace(/\/v1$/, '/versioned/v1'),
      apiKey: 'reg-key-versioned',
      models: ['claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-4-5',
      groups: [
        {
          id: 'g-versioned',
          name: 'aws',
          kind: 'openai-compatible',
          apiKey: 'sk-reg-abcdefghij',
          models: ['claude-sonnet-4-5'],
          defaultModel: 'claude-sonnet-4-5',
        },
      ],
      createdAt: Date.now() - 30_000,
    },
    {
      // 菜单反馈 #17：一个分组塞满模型，验证列表滚动、底部操作固定可见。
      id: 'p-many',
      name: '多模型账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-many',
      models: [
        ...Array.from({ length: 20 }, (_, i) => `many-${String(i).padStart(2, '0')}`),
        'many-extra-long-model-name-0123456789',
      ],
      defaultModel: 'many-00',
      groups: [
        {
          id: 'g-many',
          name: '大分组',
          apiKey: 'reg-key-many-g',
          models: [
            ...Array.from({ length: 20 }, (_, i) => `many-${String(i).padStart(2, '0')}`),
            'many-extra-long-model-name-0123456789',
          ],
          defaultModel: 'many-00',
        },
      ],
      createdAt: Date.now() - 29_000,
    },
  ]

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
        durationMs: 12_300,
        ttftMs: 800,
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

  // 宽内容回归（#7-02）：长表格 + 长代码行。
  const wideCode = `const LONG_LINE = "${'x'.repeat(260)}"`
  const wideCell = `这是一段足够长的说明-${'wide-token-'.repeat(4)}`
  const wideToken = 'X'.repeat(90)
  const wideMarkdown = [
    '宽内容回归：',
    '',
    '| 模块 | 说明 | 负责人 | 状态 | 备注 | 路径 | 数量 | 更新时间 | 关联 | 操作 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Array.from(
      { length: 10 },
      (_, i) =>
        `| module-${i} | ${wideCell} | 张三 | 进行中 | ${wideToken}-${i} | ${wideToken}/src/features/module-${i}/index.ts | ${i * 17} | 2026-11-09 | 关联-${wideToken} | 查看 |`,
    ),
    '',
    '```ts',
    wideCode,
    '```',
  ].join('\n')
  const wideMessages = [
    message('w1', 'user', '看看这张宽表格和长代码行'),
    message('w2', 'assistant', wideMarkdown, { model: 'mock-1' }),
  ]

  // 反馈16：照着真实会话（截图 10）还原的夹具——多个 PowerShell/bash 代码块、
  // 带行内代码的表格、长段落、工具调用、多轮；旧版宽内容改造把块推到正文列之外，
  // 在消息列里看起来是空白块 / 表格缺列。
  const richCode = (text) => `\`\`\`powershell\n${text}\n\`\`\``
  const richMessages = [
    message('r16u1', 'user', '帮我在我的windows上安装一下sdk环境'),
    message('r16a1', 'assistant', '我首先检查手机端的构建脚本和 Android 配置，再看看本机已安装的 SDK、Java 等依赖，确认生成 APK 还缺哪些东西。', {
      model: 'mock-1',
      usage: { inputTokens: 16_100, outputTokens: 69, costUsd: 0.01 },
      createdAt: createdAt + 600_000,
      durationMs: 15_300,
      content: [
        { type: 'text', text: '我首先检查手机端的构建脚本和 Android 配置，再看看本机已安装的 SDK、Java 等依赖，确认生成 APK 还缺哪些东西。' },
        { type: 'tool_use', id: 'tu-r16-1', name: 'Bash', input: { command: 'cd', description: '运行 cd' } },
      ],
    }),
    {
      id: 'r16r1',
      role: 'user',
      createdAt: createdAt + 601_000,
      content: [{ type: 'tool_result', toolUseId: 'tu-r16-1', content: '/home/user/project' }],
    },
    message(
      'r16a2',
      'assistant',
      [
        '检查过了，目前打包脚本找不到 JDK 21 和 Android SDK。我实际运行了该命令调用的脚本，环境检查报错：',
        '',
        '```text',
        '缺少打包环境：',
        '- JDK 21（设置 JAVA_HOME，或安装 Temurin 21 / Android Studio 自带 JBR）',
        '- Android SDK（设置 ANDROID_HOME 或 sdk.dir）',
        '```',
        '',
        '你的 `Node.js` 是 24.0.2，满足项目要求。Java、SDK 的环境变量都没有设置，默认安装目录中也未找到它们；如果装在自定义目录，需要配置路径。',
        '',
        '需要准备这些：',
        '',
        '| 本项目的版本 / 用途 |',
        '| --- |',
        '| 21，编译 Android 代码 |',
        '| Android 16 / API 36，项目明确制定 compileSdkVersion = 36 |',
        '| 建议安装 35.0.0，供项目使用的 Android Gradle Plugin 8.13 使用 |',
        '| 包含 adb，方便连接手机安装、调试 |',
        '| 建议安装最新版，方便管理 SDK 和接受许可 |',
        '',
        'Windows 上最简单的方式是安装 Android Studio，再通过它的 SDK Manager 安装组件：',
        '',
        '1. 安装并启动 Android Studio，完成首次 SDK 安装向导。',
        '2. 打开 More Actions → SDK Manager。',
        '3. 在 SDK Platforms 勾选 Android 16 / API 36。',
        '',
        'Android Studio 自带 Java 运行环境，脚本会搜索默认路径 C:\\Program Files\\Android\\Android Studio\\jbr；确认其版本为 21，或者单独安装 Temurin JDK 21，SDK 默认路径是：',
        '',
        '```text',
        'C:\\Users\\<用户名>\\AppData\\Local\\Android\\Sdk',
        '```',
        '',
        '安装好后，在 PowerShell 中进入实际项目根目录运行：',
        '',
        richCode('npm ci --include=dev\nnpm run build\nnpx cap sync android\ncd packages/mobile/android\n.\\gradlew.bat assembleDebug'),
        '',
        '构建成功后会自动生成 `dist-apk\\tandem-debug.apk`，并自动复制到你的下载文件夹。',
      ].join('\n'),
      { model: 'mock-1', usage: { inputTokens: 15_100, outputTokens: 312, costUsd: 0.02 }, createdAt: createdAt + 602_000, durationMs: 41_100 },
    ),
    message('r16u2', 'user', 'android studio是否太大一个了，有没有更干净，更新的方式', {
      createdAt: createdAt + 700_000,
    }),
    message(
      'r16a3',
      'assistant',
      [
        '是的，只为了生成 APK，没必要装整个 Android Studio，更精简的方案是：JDK 21 + Google 官方 Android SDK 命令行工具，直接用项目自带的 Gradle 构建。',
        '',
        '推荐这样配置：',
        '',
        '| 组件 | 安装方式 |',
        '| --- | --- |',
        '| JDK 21 | 通过 Windows 的 `winget` 安装 |',
        '| Platform-Tools（adb） | 从 Google 官网下载独立压缩包 |',
        '| Command-line Tools | 用 `sdkmanager` 安装 |',
        '',
        '安装 JDK 后重新打开 PowerShell，确认 `JAVA_HOME` 指向 JDK 安装目录，再执行：',
        '',
        richCode(`$env:JAVA_HOME = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.8.9-hotspot"\n$env:ANDROID_HOME = "C:\\Android\\Sdk"\n& "$env:ANDROID_HOME\\${'cmdline-tools\\latest\\bin\\sdkmanager.bat'}" --licenses\n& "$env:ANDROID_HOME\\${'cmdline-tools\\latest\\bin\\sdkmanager.bat'}" "platform-tools" "platforms;android-36" "build-tools;35.0.0"`),
        '',
        '最后回到项目运行：',
        '',
        '```bash\nnpm ci --include=dev\nnpm run build\nnpm run apk -w @tandem/mobile\n```',
      ].join('\n'),
      { model: 'mock-1', usage: { inputTokens: 19_400, outputTokens: 1_040, costUsd: 0.03 }, createdAt: createdAt + 800_000, durationMs: 43_500 },
    ),
    // 时间格式：两天前的一条（`MM-DD HH:mm`）与一条十年前的（带年份）。
    message('r16a4', 'assistant', '两天前的回复：分页正常。', {
      model: 'mock-1',
      createdAt: createdAt - 2 * 86_400_000,
      content: [{ type: 'text', text: '两天前的回复：分页正常。' }, { type: 'tool_use', id: 'tu-r16-old', name: 'Read', input: { file_path: 'README.md' } }],
    }),
    {
      id: 'r16rold',
      role: 'user',
      createdAt: createdAt - 2 * 86_400_000 + 1000,
      content: [{ type: 'tool_result', toolUseId: 'tu-r16-old', content: '# demo' }],
    },
    message('r16a5', 'assistant', '去年的回复：归档。', { model: 'mock-1', createdAt: createdAt - 400 * 86_400_000 }),
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
    // 侧栏「固定项目 / 最近项目」分组：第二个项目用于验证固定后跨组移动。
    mk('otherproj', '另一个项目会话', [
      message('op1', 'user', '看看另一个项目'),
      message('op2', 'assistant', '另一个项目正常。', { model: 'mock-1' }),
    ], {
      cwd: previewCwd,
      env: { repoRoot: previewCwd, repoName: 'second-project', branch: 'main' },
      updatedAt: Date.now() - 1450,
    }),
    mk('turns4', '四轮工具会话', [
      message('t41', 'user', '第一轮：检查目录'),
      {
        id: 't42',
        role: 'assistant',
        createdAt,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先读 README。' },
          { type: 'tool_use', id: 'tu-turns4', name: 'Read', input: { file_path: 'README.md' } },
        ],
        durationMs: 12_300,
        ttftMs: 800,
      },
      {
        id: 't43',
        role: 'user',
        createdAt: createdAt + 3000,
        content: [{ type: 'tool_result', toolUseId: 'tu-turns4', content: '# regrepo' }],
        toolDurationMs: 40_000,
      },
      message('t44', 'user', '第二轮：继续'),
      message('t45', 'assistant', '第二轮完成。', { model: 'mock-1' }),
      message('t46', 'user', '第三轮：再确认'),
      message('t47', 'assistant', '第三轮完成。', { model: 'mock-1' }),
      message('t48', 'user', '第四轮：收尾'),
      message('t49', 'assistant', '收尾完成。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 950 }),
    mk('priced', '参考价会话', [
      message('pr1', 'user', '看看这个模型的价格'),
      message('pr2', 'assistant', '按参考价估算。', { model: 'o3' }),
    ], { groupId: 'g2', model: 'o3', updatedAt: Date.now() - 980 }),
    // 反馈1601#03：输入 6 tok、按参考价折算后不足 $0.0001，不能显示成 $0.0000。
    mk('tinycost', '小额花费会话', [
      message('tc1', 'user', '这条输入的金额不要显示成 0', {
        usage: { inputTokens: 6, outputTokens: 0, costUsd: 0.00003 },
      }),
      message('tc2', 'assistant', '已记录。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 1565 }),
    mk('huge', '超大会话 · 320 轮', hugeMessages, { updatedAt: Date.now() - 900 }),
    mk('links', '文件链接会话', linksMessages, { updatedAt: Date.now() - 1500 }),
    mk('wide', '宽内容会话', wideMessages, { updatedAt: Date.now() - 1520 }),
    mk('codeblock', '代码块与表格会话', richMessages, { updatedAt: Date.now() - 1530 }),
    mk('slow2', '排队消息会话', [
      message('sq1', 'user', '先看看项目'),
      message('sq2', 'assistant', '项目看起来正常。', { model: 'mock-1' }),
    ], { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1536 }),
    mk('scroll', '流式跟随会话', Array.from({ length: 8 }, (_, i) => [
      message(`sc${i}u`, 'user', `第 ${i + 1} 个问题：请逐段介绍一下项目的结构与约定。`),
      message(
        `sc${i}a`,
        'assistant',
        Array.from({ length: 6 }, (_, j) => `第 ${i + 1} 节第 ${j + 1} 段：较长的说明文字，用来撑高对话区，便于观察滚动位置。`).join('\n\n'),
        { model: 'mock-1' },
      ),
    ]).flat(), { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1534 }),
    mk('slow', '慢速运行会话', [
      message('slow1', 'user', '先看看项目'),
      message('slow2', 'assistant', '项目看起来正常。', { model: 'mock-1' }),
    ], { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1535 }),
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
    // 菜单反馈 #17：模型很多的账号/分组。
    mk('many', '多模型分组会话', [
      message('ma1', 'user', '帮我选一个模型'),
      message('ma2', 'assistant', '已就绪。', { model: 'many-00' }),
    ], {
      profileId: 'p-many',
      groupId: 'g-many',
      model: 'many-00',
      updatedAt: Date.now() - 1560,
    }),
    // 状态筛选用：专用未读会话（其他用例不打开它，避免提前清除未读）
    mk('unreadonly', '未读筛选专用会话', [
      message('uo1', 'user', '这个会话只用于未读筛选。'),
      message('uo2', 'assistant', '完成后保持未读。', { model: 'mock-1' }),
    ], { unread: true, updatedAt: Date.now() - 1700 }),
    // 未读持久化专用：打开一次后重新加载，未读点不能再出现（反馈2156#02）。
    mk('unreadopen', '未读持久化会话', [
      message('up1', 'user', '打开我以后未读应该被记住清除。'),
      message('up2', 'assistant', '这轮结果已经完成。', { model: 'mock-1' }),
    ], { unread: true, updatedAt: Date.now() - 1710 }),
    // 全文搜索：中文短语只出现在 s2，用于断言命中片段与跳转定位
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
    title: '等待审批：在 taskcli 项目里运行 npm test 并一句话汇报结果，不要改代码。请先阅读任务说明，然后运行测试，最后把输出贴到回复里。',
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
  // 压缩着色：当前消息只含摘要 + 压缩提示 + 保留轮；原文备份里有被压掉的两轮。
  const compactOlder = [
    message('cu1', 'user', '旧轮一：改造登录', { createdAt: createdAt + 100_000 }),
    message('ca1', 'assistant', '旧轮一结果：登录已改造。', {
      model: 'mock-1',
      usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.001 },
    }),
    message('cu2', 'user', '旧轮二：补测试', { createdAt: createdAt + 110_000 }),
    message('ca2', 'assistant', '旧轮二结果：测试已补齐。', {
      model: 'mock-1',
      usage: { inputTokens: 300, outputTokens: 80, costUsd: 0.0008 },
    }),
  ]
  sessions.push(
    mk(
      'compact',
      '压缩着色会话',
      [
        {
          id: 'cmp-summary',
          role: 'user',
          summary: true,
          createdAt: createdAt + 120_000,
          content: [{ type: 'text', text: '[此前对话摘要]\n\n旧轮一、旧轮二已完成。' }],
        },
        {
          id: 'cmp-notice',
          role: 'assistant',
          notice: true,
          createdAt: createdAt + 120_001,
          content: [{ type: 'text', text: '已压缩上下文 · 节省 1.2k tokens' }],
          compaction: {
            summary: '旧轮一、旧轮二已完成。',
            savedTokens: 1200,
            keptTurns: 1,
            auto: false,
            canUndo: true,
          },
        },
        message('ck1', 'user', '保留轮：继续收尾', { createdAt: createdAt + 130_000 }),
        message('ck2', 'assistant', '保留轮结果：收尾完成。', {
          model: 'mock-1',
          usage: { inputTokens: 200, outputTokens: 50, costUsd: 0.0004 },
        }),
      ],
      { updatedAt: Date.now() - 940 },
    ),
  )
  for (const session of sessions) writeJson(path.join(configDir, 'sessions', `${session.id}.json`), session)
  writeJson(path.join(configDir, 'sessions', 'compact.compact.json'), {
    noticeId: 'cmp-notice',
    at: createdAt + 120_001,
    summary: '旧轮一、旧轮二已完成。',
    messages: compactOlder,
  })

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
  return { profiles }
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
    // 反馈2102：与用户截图同尺寸、深色主题的桌面窗口。
    const fb2102 = (name, fn) => checks.push({ name, viewport: 'desktop', context: 'fb2102', fn })

    const newPage = async (ctx, viewport, opts = {}) => {
      const page = await ctx.newPage()
      page.setDefaultTimeout(15_000)
      // 登录门用例要从干净状态开始；其余用例靠调试账号在回环地址自动登录。
      if (opts.gate) {
        await page.addInitScript(() => {
          try {
            localStorage.removeItem('tandem.gate.skip')
            for (const key of [
              'tandem.account.v1',
              'tandem.hosts.v1',
              'tandem.localhosts.v1',
              'tandem.workstation.lastUrl.v1',
            ]) {
              localStorage.removeItem(key)
            }
          } catch {
            /* 忽略 */
          }
        })
      }
      // 所有页面统一固定在造数时刻：日期、相对时间、倒计时都以同一「今天」计算。
      // 登录门页面不固定时钟：调试版自动登录的重试以 Date.now() 计超时，冻结后永远不会结束。
      if (!opts.gate) await page.clock.setFixedTime(today)
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      if (opts.gate) {
        // 登录门用例自己打开目标工作站地址，并等登录页出现。
        page.__errors = pageErrors
        page.__viewport = viewport
        return page
      }
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
      // 手机首页默认可能是收件箱页签（有待审批时没有输入框），用「新会话」按钮兜底。
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
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

    /** 打开一个可能还没有任何轮次的新会话（openSession 依赖 [data-turn-id]）。 */
    const gotoSession = async (page, id) => {      await page.waitForFunction(
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
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(300)
    }

    /** 造一个非 Git 目录的会话并打开，结束后删掉会话与临时目录。 */
    const withNonGitSession = async (page, fn) => {
      const nonGit = mkdtempSync(path.join(os.tmpdir(), 'tandem-reg-nogit-'))
      let created
      try {
        created = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: nonGit,
            profileId: 'p-main',
            groupId: 'g1',
            model: 'mock-1',
            title: '非 Git 会话',
          }),
        })
        await gotoSession(page, created.id)
        await page.locator('[data-env-bar]').first().waitFor()
        await page.waitForTimeout(400)
        await fn()
      } finally {
        if (created) {
          await api(base, token, `/api/sessions/${created.id}?deleteWorktree=false`, { method: 'DELETE' }).catch(() => {})
        }
        rmSync(nonGit, { recursive: true, force: true })
      }
    }

    /** 打开外部会话只读预览（Claude Code / Codex）。 */
    const openExternal = async (page, source, id) => {
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
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/x/${source}/${id}`)
      await page.waitForFunction(
        (externalId) => window.location.hash.includes(`/x/`) && window.location.hash.includes(`/${externalId}`),
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
      '工作站': 'workstation',
      '分享': 'shares',
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

    /** 设备面板的唯一入口：设置 → 主机 → 主机行 → 设备。 */
    const openWorkstationPanel = async (page) => {
      const settings = await openSettings(page, '主机', 'desktop')
      await settings.locator('[data-host-row]').first().click()
      const detail = page.getByRole('dialog', { name: '主机详情' })
      await detail.waitFor({ state: 'visible', timeout: 10_000 })
      await detail.getByRole('button', { name: '设备', exact: true }).click()
      // 设备弹层在设置之上；直接把设置层关掉，后面只操作设备弹层。
      await settings.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await page.getByRole('dialog', { name: '设备' }).waitFor({ state: 'visible', timeout: 10_000 })
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
      const band = page.locator('.msg-gap-band').first()
      await band.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await band.innerText(), /第 1–\d+ 轮未加载/, '首屏顶部没有未加载轮次的占位条')
      const loaded = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      assert.ok(loaded >= 150 && loaded <= 220, `首屏挂载了 ${loaded} 行，不是尾部 200 条消息`)
    })

    desktop('大会话滚到顶加载更早消息且位置不跳', async (page) => {
      await openSession(page, 'huge')
      await page.locator('.msg-gap-band').first().waitFor({ state: 'visible', timeout: 10_000 })
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
      await page.waitForFunction(
        () => document.querySelectorAll('.msg-row[data-message-id]').length >= 300,
        null,
        { timeout: 20_000 },
      )
    })

    desktop('轮次大纲跳到未加载的轮', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.msg-gap-band').first().waitFor({ state: 'visible', timeout: 10_000 })
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

    desktop('轮次大纲滚轮只预览、点击未加载轮能定位（反馈10#01 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const read = () =>
        page.evaluate(() => ({
          top: document.querySelector('.chat-scroll')?.scrollTop ?? -1,
          value: document.querySelector('.turn-hit')?.getAttribute('aria-valuenow') ?? '',
          count: document.querySelector('.turn-count')?.textContent ?? '',
        }))
      const before = await read()
      const box = await page.locator('.turn-hit').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -100)
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(600)
      const afterWheel = await read()
      assert.equal(afterWheel.top, before.top, '滚轮滚动大纲时对话区被滚动了')
      assert.equal(afterWheel.value, before.value, '滚轮滚动大纲时当前轮被改变了')
      assert.equal(afterWheel.count, before.count, '滚轮滚动大纲时轮次胶囊被改变了')

      // 预览滚动到最早几轮后点其中一行：应先加载该段消息，再滚动定位（不加高亮）。
      for (let i = 0; i < 420; i++) await page.mouse.wheel(0, -100)
      await page.waitForTimeout(800)
      const row = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.turn-item')]
          .filter((el) => Number(el.dataset.turnPos) > 0 && Number(el.dataset.turnPos) <= 8)
          .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
        const el = items[0]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, pos: Number(el.dataset.turnPos) }
      })
      assert.ok(row, '滚轮后大纲里看不到最早几轮')
      await page.mouse.click(row.x, row.y)
      await page.locator(`[data-turn-id="hu${row.pos}"]`).waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        `hu${row.pos}`,
        { timeout: 5_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后消息仍被高亮')
      const jumped = await read()
      assert.match(jumped.count, new RegExp(`第 ${row.pos} / 320 轮`), '点击大纲后没有定位到目标轮')
      await page.screenshot({ path: '/tmp/fb10-after/01.png' })
    })

    desktop('占位条标注未加载轮次并可分段加载（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      const band = page.locator('.msg-gap-band').first()
      await band.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await band.innerText(), /第 1–\d+ 轮未加载（\d+ 轮）/, '占位条没有轮次范围')
      const height = await band.evaluate((el) => el.getBoundingClientRect().height)
      assert.equal(Math.round(height), 40, `占位条高度 ${height}px，不是固定 40px`)
      assert.equal(await band.getAttribute('data-unmounted'), null, '未加载占位条被标成未显示')
      await band.getByRole('button', { name: '加载前 10 轮' }).click()
      await page.waitForFunction(
        () => !document.querySelector('[data-turn-id="hu1"]') === false,
        null,
        { timeout: 20_000 },
      )
      await page.waitForFunction(
        () => (document.querySelector('.msg-gap-band')?.textContent ?? '').includes('第 1–') === false,
        null,
        { timeout: 20_000 },
      )
      const firstId = await page.evaluate(
        () => document.querySelector('.msg-row[data-message-id]')?.dataset.messageId ?? '',
      )
      assert.equal(firstId, 'hu1', `加载前 10 轮后首条不是 hu1（${firstId}）`)
      await page.screenshot({ path: '/tmp/fb11-after/05-band.png' })
    })

    desktop('固定轮次滚到底部仍挂载、中间占位条可加载（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page
        .locator('[data-turn-id="hu1"]')
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => page.keyboard.press('Home'))
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(600)
      const gap = page.locator('.msg-gap-band').first()
      await gap.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await gap.innerText(), /轮未加载/, '跳到早期轮后中间没有未加载占位条')
      const before = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      await gap.getByRole('button', { name: '全部' }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.msg-gap-band').length === 0,
        null,
        { timeout: 40_000 },
      )
      const after = await page.evaluate(
        () => document.querySelectorAll('.msg-row[data-message-id]').length,
      )
      assert.ok(after >= before, `加载全部后挂载行数反而减少：${before} → ${after}`)

      // 固定第 5 轮，再滚到底部：固定的轮必须仍在 DOM 里。
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 10_000 })
      await page
        .locator('[data-turn-id="hu5"]')
        .getByRole('button', { name: '固定此轮' })
        .click()
      await page.waitForFunction(
        () => !!document.querySelector('[data-turn-id="hu5"] [aria-label="取消固定此轮"]'),
        null,
        { timeout: 10_000 },
      )
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => {
          const box = document.querySelector('.chat-scroll')
          if (box) box.scrollTop = box.scrollHeight
        })
        await page.waitForTimeout(180)
      }
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '滚到底部后固定的第 5 轮被卸载了',
      )
      const mountedGap = page.locator('.msg-gap-band').first()
      await mountedGap.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await mountedGap.innerText(), /轮未显示/, '固定轮与当前窗口之间没有占位条')
      const height = await mountedGap.evaluate((el) => el.getBoundingClientRect().height)
      assert.equal(Math.round(height), 40, `占位条高度 ${height}px，不是固定 40px`)
      await mountedGap.getByRole('button', { name: '显示' }).click()
      await page.locator('[data-turn-id="hu6"]').waitFor({ state: 'attached', timeout: 10_000 })
      await page.screenshot({ path: '/tmp/fb11-after/05.png' })
    })

    desktop('大纲标识未加载轮次并可点击跳转（反馈11#05 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(600)
      const readUnloaded = () =>
        page.evaluate(() => {
          const hitRect = document.querySelector('.turn-hit')?.getBoundingClientRect()
          const items = [...document.querySelectorAll('.turn-item[data-unloaded="true"]')]
            .filter((el) => {
              if (Number(el.dataset.turnPos) <= 0 || !el.checkVisibility()) return false
              const style = getComputedStyle(el)
              if (Number(style.opacity) < 0.2 || style.visibility === 'hidden') return false
              const r = el.getBoundingClientRect()
              const y = r.y + r.height / 2
              if (!hitRect || y < hitRect.top + 18 || y > hitRect.bottom - 18) return false
              return r.width > 40
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
          const el = items[0]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            pos: Number(el.dataset.turnPos),
            tag: el.querySelector('.turn-item-c')?.textContent ?? '',
            title: el.getAttribute('title') ?? '',
            dashed: getComputedStyle(el.querySelector('.turn-item-k')).backgroundImage,
          }
        })
      let row = null
      for (let attempt = 0; attempt < 6 && !row; attempt++) {
        for (let i = 0; i < 140; i++) await page.mouse.wheel(0, -100)
        await page.waitForTimeout(600)
        row = await readUnloaded()
      }
      assert.ok(row, '大纲里看不到未加载轮次')
      assert.equal(row.tag.trim(), '未加载', `未加载轮的行尾标记是「${row.tag}」`)
      assert.match(row.title, /未加载/, '未加载轮的 tooltip 没有说明')
      assert.match(row.dashed, /repeating|gradient/, '未加载轮的刻度不是虚线')
      await page.mouse.click(row.x, row.y)
      await page.waitForTimeout(400)
      const target = Number(
        (await page.locator('.turn-count').innerText()).match(/第 (\d+) \/ 320 轮/)?.[1] ?? 0,
      )
      assert.ok(target > 0, '点击未加载轮后大纲没有更新当前轮')
      await page
        .locator(`[data-turn-id="hu${target}"]`)
        .waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        `hu${target}`,
        { timeout: 5_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转到未加载轮后消息仍被高亮')
      assert.ok(row, '点击未加载轮没有跳转到位')
      await page.screenshot({ path: '/tmp/fb11-after/05-rail.png' })
    })

    desktop('跳转统一：会话图与轮次大纲调用同一个实现（反馈0220#03）', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      assert.ok(count >= 3, `会话图节点太少：${count}`)
      // 记下所有跳转派发：统一实现在每次跳转只派发一次并带递增 token，
      // 旧实现会在 12 秒内每 300ms 反复派发（会话图点击后滚轮抽搐的根因）。
      await page.evaluate(() => {
        window.__jumpLog = []
        window.addEventListener('tandem-jump-message', (event) => {
          window.__jumpLog.push(event.detail ?? {})
        })
      })
      const node = nodes.nth(Math.floor(count * 0.5))
      const turnId = await node.getAttribute('data-graph-turn-id')
      await node.click()
      await page.waitForTimeout(400)
      let log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 1, `会话图点击派发了 ${log.length} 次跳转事件`)
      assert.equal(log[0].messageId, turnId, '会话图跳转目标不对')
      assert.equal(typeof log[0].token, 'number', '会话图跳转没有走统一的跳转服务（缺少 token）')
      await page.waitForTimeout(900)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 1, `跳转后仍在反复派发事件（${log.length} 次），会不断把视口拉回去`)

      // 从轮次大纲点同一轮：也必须只派发一次，且 token 递增（同一个服务、后一次替换前一次）。
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      let row = null
      for (let step = 0; step < 60 && !row; step++) {
        if (step > 0) {
          await page.mouse.wheel(0, -100)
          await page.waitForTimeout(140)
        }
        row = await page.evaluate((id) => {
          const pin = document.querySelector(`.turn-item-p[data-turn="${CSS.escape(id)}"]`)
          const el = pin?.closest('.turn-item')
          if (!el || !el.checkVisibility() || Number(getComputedStyle(el).opacity) < 0.5) return null
          const r = el.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, pos: el.dataset.turnPos }
        }, turnId)
      }
      assert.ok(row, '大纲里找不到会话图点击的同一轮')
      await page.mouse.click(row.x, row.y)
      await page.waitForTimeout(500)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 2, `大纲点击派发了 ${log.length - 1} 次跳转事件`)
      assert.equal(log[1].messageId, turnId, '大纲与会话图点的不是同一条消息')
      assert.ok(log[1].token > log[0].token, '大纲跳转没有复用同一个跳转服务')
      await page.waitForTimeout(900)
      log = await page.evaluate(() => window.__jumpLog)
      assert.equal(log.length, 2, '大纲跳转后仍在反复派发事件')
      await page.screenshot({ path: '/tmp/jump-0220/reg-unified.png' })
    })

    desktop('跳转后用户滚动不被拉回（反馈0220#03 R68）', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      await page.evaluate(() => {
        window.__scroll = { on: true, samples: [] }
        const tick = () => {
          const box = document.querySelector('.chat-scroll')
          if (!window.__scroll.on) return
          window.__scroll.samples.push(box.scrollTop)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await nodes.nth(Math.floor(count * 0.6)).click()
      await page.waitForTimeout(200)
      const box = await page.locator('.chat-scroll').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.evaluate(() => (window.__scroll.wheelAt = window.__scroll.samples.length))
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -160)
        await page.waitForTimeout(180)
      }
      await page.waitForTimeout(1500)
      const data = await page.evaluate(() => {
        window.__scroll.on = false
        return window.__scroll
      })
      const after = data.samples.slice(data.wheelAt ?? 0)
      assert.ok(after.length > 30, `滚轮期间采样帧太少：${after.length}`)
      assert.ok(Math.min(...after) < after[0] - 100, '滚轮上滚没有生效')
      let pulledBack = 0
      for (let i = 1; i < after.length; i++) if (after[i] > after[i - 1] + 3) pulledBack += 1
      assert.equal(pulledBack, 0, `用户滚轮后视口被拉回 ${pulledBack} 次（跳转的定时补正仍在执行）`)
      await page.screenshot({ path: '/tmp/jump-0220/reg-wheel.png' })
    })

    desktop('大纲未加载轮标注、点击只取该片段（反馈0220#03 R40）', async (page) => {
      const asked = []
      page.on('request', (request) => {
        const url = request.url()
        if (url.includes('/api/sessions/huge/messages')) asked.push(url)
      })
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      let row = null
      for (let attempt = 0; attempt < 6 && !row; attempt++) {
        for (let i = 0; i < 140; i++) await page.mouse.wheel(0, -100)
        await page.waitForTimeout(500)
        row = await page.evaluate(() => {
          const hit = document.querySelector('.turn-hit')?.getBoundingClientRect()
          const el = [...document.querySelectorAll('.turn-item[data-unloaded="true"]')]
            .filter((item) => {
              if (Number(item.dataset.turnPos) < 2 || !item.checkVisibility()) return false
              const style = getComputedStyle(item)
              if (Number(style.opacity) < 0.2 || style.visibility === 'hidden') return false
              const r = item.getBoundingClientRect()
              const y = r.y + r.height / 2
              return !!hit && y > hit.top + 18 && y < hit.bottom - 18 && r.width > 40
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            pos: Number(el.dataset.turnPos),
            no: Number(el.dataset.turnNo),
            tag: el.querySelector('.turn-item-c')?.textContent?.trim() ?? '',
            dashed: getComputedStyle(el.querySelector('.turn-item-k')).backgroundImage,
          }
        })
      }
      assert.ok(row, '大纲里看不到未加载轮次')
      assert.equal(row.tag, '未加载', `未加载轮的标记是「${row.tag}」`)
      assert.match(row.dashed, /repeating|gradient/, '未加载轮的刻度不是虚线')
      const before = asked.length
      await page.mouse.click(row.x, row.y)
      await page.locator(`[data-turn-id="hu${row.no}"]`).waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-turn-id="${id}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.top >= -4 && rect.top < window.innerHeight - 120
        },
        `hu${row.no}`,
        { timeout: 5_000 },
      )
      const fetched = asked.slice(before)
      assert.equal(fetched.length, 1, `点击未加载轮请求了 ${fetched.length} 次片段（应只取该轮所在的一段）`)
      const url = fetched[0]
      assert.match(url, new RegExp(`around=hu${row.no}(&|$)`), `不是按该轮取片段：${url}`)
      assert.doesNotMatch(url, /before=/, '点击未加载轮却按翻页取了一整段历史')
      assert.match(
        await page.locator('.turn-count').innerText(),
        new RegExp(`第 ${row.no} / 320 轮`),
        '点击未加载轮后大纲没有定位到该轮',
      )
      await page.screenshot({ path: '/tmp/jump-0220/reg-unloaded-rail.png' })
    })

    desktop('固定轮次初次打开、滚动、跳转后始终挂载（反馈0220#03 R40）', async (page) => {
      await openSession(page, 'huge')
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      )
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('Home')
      await page.locator('[data-turn-id="hu1"]').waitFor({ state: 'attached', timeout: 20_000 })
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 10_000 })
      // 行上的操作条是悬停才显示的浮层，用 DOM 点击避免被同一行的时间/用量浮层挡住。
      await page.evaluate(() => {
        const row = document.querySelector('[data-turn-id="hu5"]')
        row?.querySelector('button[aria-label="固定此轮"]')?.click()
      })
      await page.waitForFunction(
        () => !!document.querySelector('[data-turn-id="hu5"] [aria-label="取消固定此轮"]'),
        null,
        { timeout: 10_000 },
      )
      // 重新打开会话：首屏只有尾部消息，固定的第 5 轮不在其中，仍必须取回并挂载。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => /第 \d+ \/ 320 轮/.test(document.querySelector('.turn-count')?.textContent ?? ''),
        null,
        { timeout: 20_000 },
      )
      await page.locator('[data-turn-id="hu5"]').waitFor({ state: 'attached', timeout: 20_000 })
      // 滚到底部：固定轮不参与卸载。
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const box = document.querySelector('.chat-scroll')
          if (box) box.scrollTop = box.scrollHeight
        })
        await page.waitForTimeout(180)
      }
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '滚到底部后固定的第 5 轮被卸载了',
      )
      // 再跳到最后一轮：固定轮仍挂在 DOM 里。
      await page.locator('.turn-hit').focus()
      await page.keyboard.press('End')
      await page.locator('[data-turn-id="hu320"]').waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(400)
      assert.equal(
        await page.locator('[data-turn-id="hu5"]').count(),
        1,
        '跳转后固定的第 5 轮不在了',
      )
      await page.screenshot({ path: '/tmp/jump-0220/reg-pinned.png' })
    })

    desktop('轮次大纲悬停显示该轮用量、全文可读（#01 R15）', async (page) => {
      await openSession(page, 'long')
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const info = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.turn-item-t')]
        const visible = items.find((el) => (el.textContent ?? '').trim().length > 0)
        const row = visible?.parentElement
        return {
          text: (visible?.textContent ?? '').trim(),
          textTitle: visible?.getAttribute('title') ?? '',
          rowTitle: row?.getAttribute('title') ?? '',
          rowLabel: row?.getAttribute('aria-label') ?? '',
          readout: document.querySelector('[data-testid="turn-readout"]')?.textContent ?? '',
        }
      })
      assert.ok(info.text.length > 0, '大纲行没有真实文本节点')
      // 反馈6#01：悬停只显示该轮用量，不再重复大纲文字；全文保留在 aria-label 与 sr-only 列表。
      assert.equal(info.textTitle, '', '大纲文字仍在重复弹出全文提示')
      assert.match(info.rowTitle, /^输入 .+ · 输出 .+ · 缓存命中 \d+% · \$/, `大纲行没有用量 tooltip：${info.rowTitle}`)
      assert.match(info.rowTitle, /占本会话 \d+%/, `用量 tooltip 缺少占本会话比例：${info.rowTitle}`)
      assert.match(info.rowLabel, /^第 \d+ 轮：/, '大纲行缺少读屏 aria-label')
      assert.match(info.readout, /第 1 轮：/, '读屏列表没有轮次全文')
      // 反馈8#07：着色固定为上下文占用。
      // 标准 tooltip（ui/Tooltip 的 .ui-tip）在悬停行后显示用量。
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /输入 .+ · 输出 .+ · 缓存命中 \d+% · \$/, '悬停大纲行没有显示用量')
      assert.match(await tip.innerText(), /占本会话 \d+%/, '悬停用量没有占本会话比例')
      assert.doesNotMatch(await tip.innerText(), /第 \d+ 轮：/, '用量 tooltip 重复了大纲文字')
    })

    desktop('外部会话预览：轮次大纲、用量 tooltip 与信息面板（反馈9#01 R37）', async (page) => {
      await openExternal(page, 'claude-code', 'reg-external')
      await page.locator('.turn-rail').waitFor({ state: 'attached', timeout: 10_000 })
      assert.equal(
        await page.locator('[data-testid="turn-readout"] li').count(),
        2,
        '外部会话大纲没有列出两轮',
      )
      const panel = page
        .locator('aside')
        .filter({ has: page.getByRole('heading', { name: '会话信息' }) })
        .last()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      // 复用正常会话的卡片：详情、用量、上下文、文件改动都来自原日志。
      const text = await panel.innerText()
      assert.match(text, /claude-sonnet-4-5-20250929/, '信息面板缺少模型')
      assert.match(text, /\/tmp\/reg-external-demo/, '信息面板缺少工作目录')
      assert.match(text, /轮数[\s\S]*2/, '信息面板缺少轮数')
      assert.equal(await panel.locator('[data-group="usage"]').count(), 1, '信息面板缺少用量卡')
      assert.match(text, /输入[\s\S]*缓存命中率/, '用量卡没有 token 明细')
      assert.equal(await panel.locator('[data-group="context"]').count(), 1, '信息面板缺少上下文卡')
      assert.equal(await panel.locator('[data-group="changes"]').count(), 1, '信息面板缺少文件改动卡')
      assert.match(text, /scripts\/test\.sh/, '文件改动没有列出原会话编辑过的文件')
      // 只读：没有输入框，保留「在 Tandem 中继续」。
      assert.equal(await page.locator('[aria-label="消息输入框"]').count(), 0, '外部会话不应可发送')
      assert.ok(await page.getByRole('button', { name: /在 Tandem 中继续/ }).count(), '缺少导入继续入口')

      // 大纲悬停：有 usage 就显示用量，没有价格时不编造「花费未知」。
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(800)
      const info = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.turn-item')].filter(
          (el) => (el.querySelector('.turn-item-t')?.textContent ?? '').trim().length > 0,
        )
        const first = rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
        return {
          title: first?.getAttribute('title') ?? '',
          label: first?.getAttribute('aria-label') ?? '',
          pin: first?.querySelector('.turn-item-p')?.getAttribute('data-turn') ?? '',
        }
      })
      assert.match(info.title, /^输入 .+ · 输出 .+ · 缓存命中 \d+% · 占本会话 \d+%/, `外部大纲用量异常：${info.title}`)
      assert.doesNotMatch(info.title, /花费未知|\$/, '外部会话没有价格时不应显示花费')
      assert.match(info.label, /^第 \d+ 轮：/, '外部大纲缺少读屏全文')
      assert.equal(info.pin, '', '只读外部会话不应出现固定图钉')

      // 信息面板可关闭并从顶栏重新打开（与正常会话共用 panelOpen）。
      await panel.getByRole('button', { name: '关闭信息面板' }).click()
      await panel.waitFor({ state: 'hidden', timeout: 5_000 })
      await page.getByRole('button', { name: '切换信息面板' }).first().click()
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      // 拖宽手柄也复用同一实现。
      assert.ok(
        await page.getByRole('separator', { name: '调整会话信息面板宽度' }).count(),
        '外部会话信息面板缺少拖宽手柄',
      )
    })


    desktop('反馈16#05：Codex 注入内容不作为用户轮（大纲/会话图）', async (page) => {
      const codexId = globalThis.__regCodexId
      assert.ok(codexId, '缺少 Codex 外部会话夹具')
      await openExternal(page, 'codex', codexId)

      // 大纲只列两轮真实用户发言；注入内容不算轮。
      assert.equal(
        await page.locator('[data-testid="turn-readout"] li').count(),
        2,
        'Codex 注入内容被当成用户轮次',
      )

      const panel = page
        .locator('aside')
        .filter({ has: page.getByRole('heading', { name: '会话信息' }) })
        .last()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })

      // 会话图也只画两轮主线。
      const graph = panel.locator('[data-group="graph"] [data-session-graph]')
      await graph.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await graph.locator('[data-graph-turn-id]').count(),
        2,
        '会话图把注入内容画成了用户轮',
      )
    })

    desktop('轮次大纲固定按上下文占用着色，压缩轮最浅并标已压缩（#01 追加 / 反馈8#07）', async (page) => {
      await openSession(page, 'compact')
      await page.locator('.turn-hit').hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(800)
      const readRows = () =>
        page.evaluate(() => {
          const rows = [...document.querySelectorAll('.turn-item')].filter(
            (el) => (el.querySelector('.turn-item-t')?.textContent ?? '').trim().length > 0,
          )
          return rows.map((el) => ({
            heat: el.dataset.heat ?? '',
            summary: el.dataset.summary === 'true',
            compressed: el.dataset.compressed === 'true',
            label: el.getAttribute('aria-label') ?? '',
            title: el.getAttribute('title') ?? '',
            badge: el.querySelector('.turn-item-c')?.textContent ?? '',
            number: el.querySelector('.turn-item-n')?.textContent ?? '',
            text: el.querySelector('.turn-item-t')?.textContent ?? '',
          }))
        })
      const rows = await readRows()
      const compressed = rows.filter((row) => row.compressed)
      const summary = rows.find((row) => row.summary)
      assert.equal(compressed.length, 2, `没有显示被压缩的轮次：${JSON.stringify(rows)}`)
      assert.ok(summary, '没有显示摘要行')
      assert.ok(
        new Set(rows.map((row) => row.heat)).size >= 2,
        `用量着色没有分档：${JSON.stringify(rows.map((row) => row.heat))}`,
      )
      // 反馈8#07：被压缩的轮占用为 0，固定显示为最浅档。
      assert.ok(
        compressed.every((row) => row.heat === '1'),
        `压缩轮不是最浅档：${JSON.stringify(compressed.map((row) => row.heat))}`,
      )
      assert.ok(compressed.every((row) => row.badge === '已压缩'), '压缩轮没有标记')
      assert.ok(compressed.every((row) => /已压缩到摘要/.test(row.title)), '压缩轮 tooltip 没有说明已压缩')
      assert.ok(rows.every((row) => /用量(低|较低|中|较高|高)/.test(row.label)), 'aria-label 缺少用量档位')
      assert.equal(summary?.number, '摘', '摘要行没有标记')
      assert.equal(summary?.text, '摘要', '摘要行文案不对')

      // 撤销压缩后：摘要与压缩行消失，恢复为真实轮次（走 WS 快照，不刷新页面）。
      await api(base, token, '/api/sessions/compact/compaction/cmp-notice/undo', {
        method: 'POST',
        body: '{}',
      })
      await page.waitForFunction(
        () => document.querySelectorAll('.turn-item[data-summary="true"]').length === 0,
        null,
        { timeout: 8_000 },
      )
      await page.waitForTimeout(400)
      const restored = await page.evaluate(() => ({
        summary: document.querySelectorAll('.turn-item[data-summary="true"]').length,
        compressed: document.querySelectorAll('.turn-item[data-compressed="true"]').length,
      }))
      assert.equal(restored.summary, 0, '撤销压缩后仍显示摘要行')
      assert.equal(restored.compressed, 0, '撤销压缩后仍显示已压缩轮次')
    })

    desktop('压缩确认与上下文面板按真实用户轮次统计（R16）', async (page) => {
      await openSession(page, 'turns4')
      const meter = page
        .locator('button[aria-label^="上下文"], button[aria-label="暂无上下文数据"]')
        .first()
      await meter.waitFor({ timeout: 15_000 })
      await meter.click()
      await page.getByText('4 轮对话', { exact: true }).first().waitFor({ timeout: 5_000 })
      await page.getByRole('button', { name: '压缩上下文（/compact）' }).click()
      const dialog = page.getByRole('dialog', { name: '压缩上下文' })
      await dialog.waitFor()
      const text = await dialog.innerText()
      assert.match(text, /当前会话的 4 轮对话/, `压缩确认轮次不对：${text}`)
      assert.equal(/当前会话的 [5-9] 轮对话|当前会话的 \d{2,} 轮对话/.test(text), false, '工具结果被算成了用户轮次')
      await dialog.getByRole('button', { name: '取消' }).click()
    })

    desktop('上下文卡：鲜明分类色、自定义 agents、缓存条与阈值刻度（反馈13#05）', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const group = page.locator('[data-group="context"]').first()
      await group.waitFor({ state: 'visible', timeout: 15_000 })
      const card = group.locator('[data-context-card]').first()
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      const legend = card.locator('[data-context-legend="true"]')
      const legendText = await legend.innerText()
      const cardText = await card.innerText()
      const order = ['系统提示', '工具定义', 'MCP 工具', '自定义 agents', '记忆文件', '对话', '工具结果', '剩余']
      const positions = order.map((label) => legendText.indexOf(label))
      assert.ok(
        positions.every((position) => position >= 0),
        `上下文卡缺少分类：${order.filter((_, index) => positions[index] < 0).join('、')}`,
      )
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions,
        `上下文分类顺序不对：${order.map((label, index) => `${label}@${positions[index]}`).join(' ')}`,
      )
      assert.doesNotMatch(cardText, /缓存命中率/, '上下文卡重复显示了缓存命中率（反馈16#04）')
      assert.match(cardText, /自动压缩：达到 \d+% 时触发|自动压缩已关闭/, '上下文卡缺少自动压缩说明')

      // 分类色必须鲜明且彼此区分（不能退回一组灰调）。
      const colors = await card.evaluate((el) =>
        [...el.querySelectorAll('.grid span[aria-hidden="true"]')].map(
          (dot) => getComputedStyle(dot).backgroundColor,
        ),
      )
      assert.ok(new Set(colors).size >= 7, `上下文分类色区分不足：${colors.join(' / ')}`)
      assert.equal(
        colors.some((color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent'),
        false,
        `上下文分类色存在透明项：${colors.join(' / ')}`,
      )

      // 85% 阈值刻度画在分段条上。
      const threshold = card.locator('[data-context-threshold="true"]')
      assert.equal(await threshold.count(), 1, '分段条缺少自动压缩阈值刻度')
      assert.match(await threshold.evaluate((el) => el.style.left), /\d+(\.\d+)?%/, '阈值刻度位置没有按百分比设置')

      // 反馈2156#04：上下文卡片不再有「最占空间」轮次列表。
      assert.doesNotMatch(cardText, /最占空间/, '上下文卡仍在显示最占空间')
      assert.equal(await card.locator('[data-context-turn="true"]').count(), 0, '上下文卡仍有最占空间轮次行')
    })

    desktop('警告与状态色饱和、对比度达标（反馈13#03）', async (page) => {
      await openSession(page, 'long')
      const result = await page.evaluate(() => {
        const parse = (value) => {
          const raw = value.trim()
          const rgb = raw.match(/rgba?\(([^)]+)\)/)
          if (rgb) return rgb[1].split(',').slice(0, 3).map((n) => Number(n.trim()) / 255)
          const hex = raw.match(/^#([0-9a-f]{6})$/i)
          if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255)
          return null
        }
        const lum = (rgb) => {
          const c = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        }
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
          return (x + 0.05) / (y + 0.05)
        }
        const root = document.documentElement
        const read = (theme) => {
          const dark = theme === 'dark'
          root.classList.toggle('dark', dark)
          const style = getComputedStyle(root)
          const bg = parse(style.getPropertyValue('--t-surface'))
          const data = ['--t-status-warn', '--t-status-online', '--t-status-error'].map((name) => {
            const value = style.getPropertyValue(name)
            return { name, value: value.trim(), contrast: Number(ratio(parse(value), bg).toFixed(2)) }
          })
          data.push({
            name: '--t-warning-soft',
            value: style.getPropertyValue('--t-warning-soft').trim(),
            contrast: 0,
          })
          return data
        }
        const previous = root.classList.contains('dark') ? 'dark' : 'light'
        const themes = { light: read('light'), dark: read('dark') }
        root.classList.toggle('dark', previous === 'dark')
        return themes
      })
      for (const [theme, tokens] of Object.entries(result)) {
        for (const token of tokens) {
          if (token.name === '--t-warning-soft') {
            assert.match(
              token.value,
              /^(?:rgba?\(|#[0-9a-f]{8}$)/i,
              `${theme} 主题的 --t-warning-soft 不是可见色底：${token.value}`,
            )
            continue
          }
          assert.ok(token.contrast >= 4.5, `${theme} 主题 ${token.name}=${token.value} 对比度只有 ${token.contrast}`)
        }
      }
    })

    desktop('配额将尽时交接卡可切换备用分组', async (page) => {
      await openSession(page, 'quota')
      await waitOnline(page)
      await waitModelReady(page)
      const box = page.locator('[aria-label="消息输入框"]').first()
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

    desktop('反馈15：设置内容区限宽留白、通知卡图标在卡片内且与标题对齐（R01）', async (page) => {
      // 用户实际视口 1912×914；设置内容统一容器限宽 820px，剩余空间左右居中留白。
      await page.setViewportSize({ width: 1912, height: 914 })
      const measureContent = () =>
        page.evaluate(() => {
          const pane = document.querySelector('[data-settings-page-content]')
          const content = document.querySelector('[data-settings-content]')
          if (!pane || !content) return null
          const p = pane.getBoundingClientRect()
          const c = content.getBoundingClientRect()
          return {
            page: pane.getAttribute('data-settings-page-content'),
            width: c.width,
            leftGap: c.left - p.left,
            rightGap: p.right - c.right,
          }
        })
      const dialog = await openSettings(page, '记忆', 'desktop')
      const memory = await measureContent()
      assert.ok(memory, '设置内容区容器缺失')
      assert.ok(memory.width <= 840, `设置内容区宽 ${Math.round(memory.width)}px，应 ≤840`)
      assert.ok(
        memory.leftGap >= 32 && memory.rightGap >= 32,
        `设置内容区左右留白 ${Math.round(memory.leftGap)}/${Math.round(memory.rightGap)}px，应 ≥32`,
      )
      // 页头操作按钮（主机下拉、刷新）随内容区右缘对齐。
      const header = await page.evaluate(() => {
        const content = document.querySelector('[data-settings-content]')
        const row = document.querySelector('[data-setting-id="memory.host"]')
        const refresh = row
          ? [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '刷新')
          : null
        if (!content || !row || !refresh) return null
        const c = content.getBoundingClientRect()
        const r = refresh.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        return { rightGap: c.right - r.right, leftGap: rowBox.left - c.left }
      })
      assert.ok(header, '记忆页头缺少主机选择或刷新按钮')
      assert.ok(
        header.rightGap >= -1 && header.rightGap <= 8,
        `页头「刷新」未随内容区右缘对齐：差 ${Math.round(header.rightGap)}px`,
      )

      // 所有设置页共用同一容器：逐页确认宽度与左右留白。
      await openSettings(page, '通知', 'desktop')
      const pageIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-settings-page]')].map((el) =>
          el.getAttribute('data-settings-page'),
        ),
      )
      assert.ok(pageIds.length > 10, `设置导航页数异常：${pageIds.length}`)
      const wide = []
      for (const id of pageIds) {
        const pageButton = dialog.locator(`[data-settings-page="${id}"]`)
        if (!(await pageButton.count())) continue
        await pageButton.click()
        await page.waitForTimeout(110)
        const info = await measureContent()
        if (!info) {
          wide.push(`${id}: 无内容容器`)
          continue
        }
        if (info.width > 840 || info.leftGap < 32 || info.rightGap < 32) {
          wide.push(
            `${id}: ${Math.round(info.width)}px / 留白 ${Math.round(info.leftGap)}/${Math.round(info.rightGap)}`,
          )
        }
        // 同类图标溢出：设置行标题图标必须在所在卡片的 ≥8px 内边距里。
        const iconOverflow = await page.evaluate(() =>
          [...document.querySelectorAll('[data-settings-content] .setting-row-icon')]
            .map((el) => {
              const card = el.closest('section, .setting-card, .settings-item')
              if (!card) return null
              const c = card.getBoundingClientRect()
              const i = el.getBoundingClientRect()
              const inset = Math.min(i.left - c.left, c.right - i.right, i.top - c.top, c.bottom - i.bottom)
              return inset >= 8 ? null : Math.round(inset)
            })
            .filter((value) => value !== null),
        )
        if (iconOverflow.length) wide.push(`${id}: 图标越出卡片 ${iconOverflow.join('/')}px`)
      }
      assert.deepEqual(wide, [], `设置内容区未统一限宽留白：${wide.join('；')}`)

      // 通知页：桌面通知 / App 通知 / 后台保持连接三个卡片的图标须在卡片内边距里，
      // 与标题文字垂直居中；下方提示行缩进与标题左对齐。
      await openSettings(page, '通知', 'desktop')
      const cards = await page.evaluate(() =>
        ['notifications.desktop', 'notifications.app', 'notifications.background'].map((id) => {
          const card = document.querySelector(`[data-setting-id="${id}"]`)
          if (!card) return { id, missing: true }
          const icon = card.querySelector('.setting-row-icon svg')
          const label = card.querySelector('.setting-row-label')
          const title = label?.querySelector(':scope > :not(.setting-row-icon):not(.setting-row-hint)')
          const note = card.querySelector('.setting-note')
          const noteText = note?.querySelector(':scope > span:last-child')
          if (!icon || !title) return { id, missing: true }
          const box = card.getBoundingClientRect()
          const i = icon.getBoundingClientRect()
          const t = title.getBoundingClientRect()
          const n = noteText?.getBoundingClientRect()
          return {
            id,
            insets: [i.left - box.left, box.right - i.right, i.top - box.top, box.bottom - i.bottom],
            iconLeft: i.left,
            centerDiff: Math.abs(i.top + i.height / 2 - (t.top + t.height / 2)),
            note: n ? { leftDiff: n.left - t.left, rightOverflow: n.right - box.right } : null,
          }
        }),
      )
      for (const card of cards) {
        assert.ok(!card.missing, `通知卡片缺失：${card.id}`)
        assert.ok(
          card.insets.every((value) => value >= 8),
          `${card.id} 图标不在卡片内边距里（上/右/下/左 ${card.insets.map(Math.round).join('/')}）`,
        )
        assert.ok(
          card.centerDiff <= 2,
          `${card.id} 图标与标题中线差 ${card.centerDiff.toFixed(1)}px`,
        )
        if (card.note) {
          assert.ok(
            Math.abs(card.note.leftDiff) <= 2,
            `${card.id} 提示行未与标题左对齐（差 ${Math.round(card.note.leftDiff)}px）`,
          )
          assert.ok(card.note.rightOverflow <= 0, `${card.id} 提示行溢出卡片`)
        }
        // 三个卡片同一列图标：左缘一致。
      }
      const iconLefts = cards.map((card) => card.iconLeft)
      assert.ok(
        Math.max(...iconLefts) - Math.min(...iconLefts) <= 1,
        `通知卡图标左缘不一致：${iconLefts.map(Math.round).join('/')}`,
      )
      await closeSettings(page)
    })

    desktop('反馈9：滚动条唯一且不占宽、设置行单行、高级展开不位移、右键菜单接管', async (page) => {
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('[data-settings-nav-scroll]')
      const adv = dialog.locator('[data-settings-group="advanced"] > button').first()
      if ((await adv.getAttribute('aria-expanded')) === 'true') {
        await adv.click()
        await page.waitForTimeout(150)
      }
      await nav.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(200)
      const before = await adv.boundingBox()
      await adv.click()
      await page.waitForTimeout(350)
      const after = await adv.boundingBox()
      assert.ok(before && after, '高级分组不可见')
      assert.ok(
        Math.abs(after.y - before.y) <= 1,
        `高级分组展开后标题位移 ${Math.round(after.y - before.y)}px`,
      )
      // 设置内容区一定会溢出：滚动它来触发 overlay 滚动条。
      // 用 scrollBy 保证一定产生 scroll 事件（直接赋当前值不会触发）；可见性由 rAF 更新，等到出现为止。
      const content = dialog.locator('[data-settings-page-content]')
      await content.evaluate((el) => {
        const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
        el.scrollBy(0, atBottom ? -40 : 40)
      })
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.overlay-scrollbar')].some(
            (el) => el.dataset.visible === 'true',
          ),
        null,
        { timeout: 3_000 },
      )
      const scroll = await page.evaluate(() => {
        const list = document.querySelector('[data-settings-nav-scroll]')
        const pane = document.querySelector('[data-settings-page-content]')
        const visible = [...document.querySelectorAll('.overlay-scrollbar')].filter(
          (el) => el.dataset.visible === 'true',
        )
        return {
          listGutter: list ? list.offsetWidth - list.clientWidth : null,
          paneGutter: pane ? pane.offsetWidth - pane.clientWidth : null,
          paneOverflow: pane ? pane.scrollHeight > pane.clientHeight : false,
          visibleBars: visible.length,
        }
      })
      assert.equal(scroll.listGutter, 0, '设置导航的滚动条占用了布局宽度')
      assert.equal(scroll.paneGutter, 0, '设置内容区的滚动条占用了布局宽度')
      assert.ok(scroll.paneOverflow, '用例前置：设置内容区应可滚动')
      assert.equal(scroll.visibleBars, 1, `同时可见 ${scroll.visibleBars} 根滚动条`)
      // 裸 title 由 scripts/ui-audit.mjs 的 native-title 规则做源码级检查。

      // 数值单位必须与输入框同一行、紧贴右侧；行高保持单行。
      const row = dialog.locator('.setting-row', { hasText: '触发阈值' }).first()
      await row.waitFor({ state: 'visible', timeout: 5_000 })
      const layout = await row.evaluate((el) => {
        const input = el.querySelector('input')
        const unit = el.querySelector('.setting-row-unit')
        const label = el.querySelector('.setting-row-label')
        const a = input?.getBoundingClientRect()
        const b = unit?.getBoundingClientRect()
        const c = label?.getBoundingClientRect()
        return a && b && c
          ? {
              height: el.getBoundingClientRect().height,
              inputWidth: a.width,
              unitGap: b.left - a.right,
              sameLine: Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)) < 4,
            }
          : null
      })
      assert.ok(layout, '触发阈值行缺少输入框或单位')
      assert.ok(layout.height <= 36, `设置行高 ${layout.height}px，未收成单行`)
      assert.ok(layout.inputWidth <= 90, `数值输入宽 ${layout.inputWidth}px，应为窄宽度`)
      assert.ok(layout.unitGap >= 0 && layout.unitGap <= 10, `单位与输入框间距 ${layout.unitGap}px`)
      assert.ok(layout.sameLine, '单位或输入框换到了下一行')

      // 右键菜单由 ui/Menu 接管，原生菜单不再出现（能检测到的是我们的 role=menu）。
      await page.mouse.click(900, 420, { button: 'right' })
      await page.waitForTimeout(250)
      const menu = page.getByRole('menu')
      assert.equal(await menu.count(), 1, '没有出现自定义右键菜单')
      for (const name of ['复制', '剪切', '粘贴', '全选']) {
        assert.ok(await menu.getByRole('menuitem', { name }).count(), `右键菜单缺少「${name}」`)
      }
      await page.keyboard.press('Escape')
      await closeSettings(page)

      // 输入框关闭签名控件；文本仍可选择复制。
      const attrs = await page.evaluate(() => {
        const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]')
        return {
          suggestions: document.documentElement.getAttribute('writingsuggestions'),
          spellcheck: input?.getAttribute('spellcheck'),
          autocomplete: input?.getAttribute('autocomplete'),
          selectable: getComputedStyle(document.body).userSelect,
        }
      })
      assert.equal(attrs.suggestions, 'false', 'writingsuggestions 未关闭')
      assert.equal(attrs.spellcheck, 'false', '输入框拼写检查未关闭')
      assert.equal(attrs.autocomplete, 'off', '输入框自动填充未关闭')
      assert.notEqual(attrs.selectable, 'none', '不应禁用文本选择')
    })

    desktop('反馈11：设置页输入框全局屏蔽、设置导航滚动条进 gutter 不压文字（R37/R36）', async (page) => {
      // 用户实际视口 1912×914：用相近尺寸让设置导航溢出（2552 宽高下导航无需滚动）。
      await page.setViewportSize({ width: 1366, height: 860 })
      // 设置导航：滚动时指示条应落在 nav 的右侧留白里，不与行文字/行背景相交。
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('[data-settings-nav-scroll]')
      const navBox = await nav.boundingBox()
      assert.ok(navBox, '设置导航不可见')
      await page.mouse.move(navBox.x + navBox.width - 3, navBox.y + navBox.height / 2)
      await nav.evaluate((el) => {
        el.scrollTop = Math.min(120, el.scrollHeight - el.clientHeight)
      })
      await page.waitForFunction(
        () => document.querySelector('.overlay-scrollbar[data-axis="y"]')?.dataset.visible === 'true',
        null,
        { timeout: 3_000 },
      )
      const bar = await page.evaluate(() => {
        const nav = document.querySelector('[data-settings-nav-scroll]')
        const bar = document.querySelector('.overlay-scrollbar[data-axis="y"]')
        const b = bar.getBoundingClientRect()
        const n = nav.getBoundingClientRect()
        let maxRight = 0
        const walk = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT)
        while (walk.nextNode()) {
          const node = walk.currentNode
          if (!node.textContent.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (rect.width > 0) maxRight = Math.max(maxRight, rect.right)
          }
        }
        return { left: b.left, right: b.right, navRight: n.right, textRight: maxRight }
      })
      assert.ok(
        bar.left >= bar.navRight + 1,
        `设置导航滚动条仍在内容区内：bar ${Math.round(bar.left)} / nav ${Math.round(bar.navRight)}`,
      )
      assert.ok(
        bar.left > bar.textRight + 4,
        `滚动条与最近文字相交：bar ${Math.round(bar.left)} / text ${Math.round(bar.textRight)}`,
      )
      // 全局默认关闭拼写/自动填充：覆盖设置页（Portal）里所有非密码输入框。
      const loose = await page.evaluate(() =>
        [...document.querySelectorAll('input, textarea')]
          .filter((el) => !(el instanceof HTMLInputElement && el.type === 'password'))
          .filter(
            (el) =>
              el.getAttribute('spellcheck') !== 'false' || !el.getAttribute('autocomplete'),
          )
          .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('type') ?? ''}]`),
      )
      assert.deepEqual(loose, [], `设置页输入框仍会触发原生拼写/自动填充：${loose.join(', ')}`)
      assert.equal(
        await page.evaluate(() => document.documentElement.getAttribute('spellcheck')),
        'false',
        '根节点未关闭拼写检查',
      )
      await closeSettings(page)

    })

    desktop('Host 诊断：面板打开、失败项排在最前、报告不含 Key', async (page) => {
      const dialog = await openSettings(page, 'Host 管理', 'desktop')
      await dialog.locator('[data-host-row]').first().click()
      const detail = page.getByRole('dialog', { name: '主机详情' })
      await detail.waitFor({ state: 'visible', timeout: 10_000 })
      await detail.getByRole('button', { name: '诊断', exact: true }).click()
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
      // 等焦点陷阱真正接管（弹窗可见与 effect 执行之间有一帧；不要用固定 sleep）。
      await page.waitForFunction(
        () => !!document.activeElement?.closest('[role="dialog"]'),
        null,
        { timeout: 5_000 },
      )
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

    desktop('模型菜单级联（账号 → 分组 → 模型）逐级飞出且不越界（#7-04）', async (page) => {
      await openSession(page, 'long')
      await waitModelReady(page)
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const rootMenu = page.locator('[role="menu"]').first()
      await rootMenu.waitFor()
      withinViewport(await rootMenu.boundingBox(), DESKTOP, '模型菜单')
      assert.match(await rootMenu.innerText(), /切换账号/, '主菜单缺少「切换账号」级联入口')
      const accountTrigger = rootMenu.getByRole('menuitem', { name: /切换账号/ }).first()
      await accountTrigger.hover()
      const accountMenu = page.locator('[role="menu"][aria-label="切换账号"]').first()
      await accountMenu.waitFor({ state: 'visible' })
      withinViewport(await accountMenu.boundingBox(), DESKTOP, '切换账号子菜单')
      // 反馈 #7-04：悬停账号 → 右侧飞出分组，不允许在原地替换或出现返回行。
      assert.equal(
        await accountMenu.getByText(/返回|‹/).count(),
        0,
        '账号子菜单出现了「返回」式原地导航',
      )
      const mainAccount = accountMenu.getByRole('menuitem', { name: /主力账号/ }).first()
      await mainAccount.hover()
      const groupMenu = page.locator('[role="menu"][aria-label="主力账号"]').first()
      await groupMenu.waitFor({ state: 'visible', timeout: 5_000 })
      withinViewport(await groupMenu.boundingBox(), DESKTOP, '分组子菜单')
      assert.equal(
        await groupMenu.getByText(/返回|‹/).count(),
        0,
        '分组子菜单出现了「返回」式原地导航',
      )
      const backup = groupMenu.getByRole('menuitem', { name: /备用/ }).first()
      await backup.hover()
      const modelMenu = page.locator('[role="menu"][aria-label="主力账号 · 备用"]').first()
      await modelMenu.waitFor({ state: 'visible', timeout: 5_000 })
      withinViewport(await modelMenu.boundingBox(), DESKTOP, '模型子菜单')
      assert.ok((await modelMenu.getByRole('menuitem', { name: /O3/i }).count()) >= 1, '模型子菜单没有列出模型')
      const response = page.waitForResponse(
        (res) => res.url().includes('/api/sessions/long') && res.request().method() === 'PATCH',
        { timeout: 10_000 },
      )
      await modelMenu.getByRole('menuitem', { name: /O3/i }).click()
      await response
      await rootMenu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      assert.match(await page.getByRole('button', { name: '选择模型' }).first().innerText(), /O3/, '选择后模型按钮未更新')
      const stored = await api(base, token, '/api/sessions/long')
      assert.equal(stored.model, 'o3', '会话模型未落库')
      assert.equal(stored.groupId, 'g2', '会话分组未落库')
    })

    desktop('思考强度档位来自模型能力，名称用厂商叫法（#7-05）', async (page) => {
      await openSession(page, 'priced')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const effortTrigger = menu.getByRole('menuitem', { name: /思考强度/ }).first()
      await effortTrigger.hover()
      const submenu = page.locator('[role="menu"][aria-label="思考强度"]').first()
      await submenu.waitFor({ state: 'visible', timeout: 5_000 })
      const text = await submenu.innerText()
      assert.match(text, /低 · low/, `o3 档位没有使用 reasoning_effort 原名：${text}`)
      assert.match(text, /中 · medium/, `o3 档位缺少 medium：${text}`)
      assert.match(text, /高 · high/, `o3 档位缺少 high：${text}`)
      assert.equal(await submenu.getByRole('menuitemradio', { name: '关', exact: true }).count(), 0, 'o3 不应出现「关」档位')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // 不支持思考的模型隐藏整个「思考强度」项。
      await openSession(page, 'nockpt')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const plainMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await plainMenu.waitFor()
      assert.equal(
        await plainMenu.getByRole('menuitem', { name: /思考强度/ }).count(),
        0,
        '未知/不支持思考的模型仍显示思考强度',
      )
      await page.keyboard.press('Escape')
    })

    desktop('输入框：token 估算、切换确认与分工取向合并（反馈8#01 #03 #05 #08 #09 #11 / 10#02 / 2009#01）', async (page) => {
      mkdirSync('/tmp/fb8-after', { recursive: true })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g2',
          model: 'o3',
          permissionMode: 'default',
          title: '输入框回归',
        }),
      })
      await gotoSession(page, session.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()

      // 1601#04：分工与取向并入模型菜单；原生开关在最上面，没有再「记住为会话偏好」，芯片只显示模型名。
      const routeChip = page.locator('button[aria-label^="选择模型："]').first()
      assert.doesNotMatch(
        (await routeChip.getAttribute('aria-label')) ?? '',
        /分工|取向/,
        '模型芯片上不应额外显示分工/取向',
      )
      const openModel = async () => {
        await routeChip.click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        return menu
      }
      const modelMenu = await openModel()
      const modelMenuText = await modelMenu.innerText()
      await page.screenshot({ path: '/tmp/fb8-after/03.png' })
      for (const label of ['原生', '分工', '取向']) {
        assert.ok(modelMenuText.includes(label), `模型菜单缺少「${label}」：${modelMenuText}`)
      }
      assert.ok(!modelMenuText.includes('记住为会话偏好'), '模型菜单不应再有「记住为会话偏好」')
      await modelMenu.getByRole('menuitem', { name: /^分工/ }).hover()
      const delegationMenu = page.locator('[role="menu"][aria-label="分工"]').first()
      await delegationMenu.waitFor({ state: 'visible', timeout: 5_000 })
      const delegationText = await delegationMenu.innerText()
      for (const label of ['关闭', '适度', '积极']) {
        assert.ok(delegationText.includes(label), `分工缺少「${label}」：${delegationText}`)
      }
      await page.screenshot({ path: '/tmp/fb8-after/09.png' })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      const biasRoute = await openModel()
      await biasRoute.getByRole('menuitem', { name: /^取向/ }).hover()
      const biasMenu = page.locator('[role="menu"][aria-label="取向"]').first()
      await biasMenu.waitFor({ state: 'visible', timeout: 5_000 })
      const biasText = await biasMenu.innerText()
      for (const label of ['省钱', '均衡', '质量优先']) {
        assert.ok(biasText.includes(label), `取向缺少「${label}」：${biasText}`)
      }
      await page.screenshot({ path: '/tmp/fb8-after/01.png' })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // #05：输入时显示估算 token；发送后（已有上下文）显示预计占用百分比。
      await input.fill('请检查一下输入框的 token 估算')
      const tokenChip = page.locator('[data-composer-tokens]').first()
      await tokenChip.waitFor()
      assert.match(await tokenChip.innerText(), /~[\d.]+k? tok/, '输入框没有估算 token')
      const before = (await api(base, token, `/api/sessions/${session.id}`)).messages.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await api(base, token, `/api/sessions/${session.id}`)
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      await input.fill('继续')
      await page.waitForFunction(
        () => (document.querySelector('[data-composer-tokens]')?.textContent ?? '').includes('发送后'),
        null,
        { timeout: 10_000 },
      )
      const tokenText = await tokenChip.innerText()
      assert.match(tokenText, /发送后 ~\d+%|发送后 ~<1%/, `发送后上下文百分比缺失：${tokenText}`)
      await page.screenshot({ path: '/tmp/fb8-after/05.png' })

      // 反馈10#02：模型菜单不显示常驻缓存提示；真正切换模型/账号/分组时弹确认框；取消不改变当前模型。
      await api(base, token, `/api/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ effort: 'low' }),
      })
      const switchToMock2 = async () => {
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        await menu.getByRole('menuitem', { name: /切换账号|切换分组|全部模型/ }).first().hover()
        const accounts = page.locator('[role="menu"][aria-label="切换账号"]').first()
        await accounts.waitFor({ timeout: 5_000 })
        await accounts.getByRole('menuitem', { name: /主力账号/ }).first().hover()
        const groups = page.locator('[role="menu"][aria-label="主力账号"]').first()
        await groups.waitFor({ timeout: 5_000 })
        await groups.getByRole('menuitem', { name: /生产/ }).first().hover()
        const models = page.locator('[role="menu"][aria-label*="生产"]').first()
        await models.waitFor({ timeout: 5_000 })
        await models.getByRole('menuitem', { name: 'mock-2' }).first().click()
      }
      await switchToMock2()
      const switchDialog = page.getByRole('dialog').filter({ hasText: '切换后提示缓存将失效' })
      await switchDialog.waitFor({ timeout: 5_000 })
      const switchText = await switchDialog.innerText()
      const beforeModel = (await api(base, token, `/api/sessions/${session.id}`)).model
      assert.match(switchText, /下一轮按完整上下文计费/, `切换确认缺少计费说明：${switchText}`)
      assert.match(switchText, /约 ~[\d.]+k? tok/, `切换确认缺少 token 估算：${switchText}`)
      assert.doesNotMatch(switchText, /不再提示/, '切换确认仍有「不再提示」')
      await page.screenshot({ path: '/tmp/fb10-after/02.png' })
      await switchDialog.getByRole('button', { name: '取消' }).click()
      await page.waitForTimeout(200)
      await waitModelReady(page)
      assert.equal(
        (await api(base, token, `/api/sessions/${session.id}`)).model,
        beforeModel,
        '取消切换后模型被改掉',
      )
      await switchToMock2()
      await switchDialog.waitFor({ timeout: 5_000 })
      await switchDialog.getByRole('button', { name: '切换' }).click()
      await page.waitForTimeout(500)
      assert.match(
        await page.locator('button[aria-label^="选择模型"]').first().getAttribute('aria-label'),
        /Mock 2|mock-2/i,
        '确认后没有切换模型',
      )
      // 回到支持思考档位的 o3，继续验证芯片的小点与 tooltip。
      await api(base, token, `/api/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: 'o3', groupId: 'g2', effort: 'low' }),
      })
      await page.waitForTimeout(400)

      // #11：模型芯片只显示模型名，思考强度只在 tooltip / aria-label。
      await waitModelReady(page)
      const chip = page.locator('button[aria-label^="选择模型"]').first()
      const chipText = await chip.innerText()
      assert.ok(!/(极低|最高|关闭)/.test(chipText) && !/\s(低|中|高)$/.test(chipText), `模型芯片仍显示思考强度：${chipText}`)
      assert.match((await chip.getAttribute('aria-label')) ?? '', /思考强度：低/, '模型芯片 aria-label 缺少思考强度')
      await chip.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /思考强度 低/, '模型芯片 tooltip 缺少思考强度档位')
      await page.screenshot({ path: '/tmp/fb8-after/11-chip.png' })
    })

    desktop('输入框 Markdown 实时预览：光标外隐藏标记、代码块整块渲染、Enter 续号与原始内容发送（反馈8#02 / 1323#05）', async (page) => {
      mkdirSync('/tmp/md-cm', { recursive: true })
      const mdSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: 'Markdown 回归',
        }),
      })
      await gotoSession(page, mdSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()
      const value = () => input.getAttribute('data-value')
      const lineTexts = () =>
        input.evaluate((root) => [...root.querySelectorAll('.cm-line')].map((line) => line.textContent ?? ''))
      const sessionOf = () => api(base, token, `/api/sessions/${mdSession.id}`)
      const messageCount = async () => (await sessionOf()).messages.length

      // 代码围栏：开围栏行回车自动补闭合围栏，光标停在中间。
      const beforeCode = await messageCount()
      await input.fill('```ts')
      await input.press('Enter')
      assert.equal(await value(), '```ts\n\n```\n', '代码围栏没有自动成对')
      await input.type('const a = 1')
      await input.press('Tab')
      assert.match(await value(), /const a = 1 {2}\n```/, '代码块内 Tab 没有缩进两格')
      await input.press('Enter')
      assert.equal(await messageCount(), beforeCode, '代码块内回车触发了发送')
      // 光标在块内：源码态代码块仍是等宽字体与浅色底。
      const codeStyle = await input.evaluate((root) => {
        const line = root.querySelector('.md-code-line')
        if (!line) return null
        const style = getComputedStyle(line)
        return {
          mono: /mono/i.test(style.fontFamily) || style.fontFamily.includes('Consolas'),
          background: style.backgroundColor,
        }
      })
      assert.ok(codeStyle, '光标在块内时没有源码态代码块')
      assert.ok(codeStyle.mono, `代码块不是等宽字体：${codeStyle && codeStyle.background}`)
      assert.notEqual(codeStyle.background, 'rgba(0, 0, 0, 0)', '代码块没有浅色底')
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const session = await sessionOf()
        if (session.status === 'idle' && session.messages.length > beforeCode) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('```ts') && text.includes('const a = 1')),
        '发送内容没有保留原始代码块',
      )

      // 行内 Markdown：粗体、斜体、行内代码同步呈现，源码不变。
      await input.fill('**粗体** *斜体* `code`')
      const inline = await input.evaluate((root) => ({
        strong: root.querySelector('.md-strong')?.textContent ?? '',
        em: root.querySelector('.md-em')?.textContent ?? '',
        code: root.querySelector('.md-inline-code')?.textContent ?? '',
        strongWeight: (() => {
          const el = root.querySelector('.md-strong')
          return el ? getComputedStyle(el).fontWeight : ''
        })(),
        emStyle: (() => {
          const el = root.querySelector('.md-em')
          return el ? getComputedStyle(el).fontStyle : ''
        })(),
        codeMono: (() => {
          const el = root.querySelector('.md-inline-code')
          return el ? getComputedStyle(el).fontFamily : ''
        })(),
      }))
      assert.equal(inline.strong, '粗体', '粗体没有就地渲染')
      assert.equal(inline.em, '斜体', '斜体没有就地渲染')
      assert.equal(inline.code, 'code', '行内代码没有就地渲染')
      assert.ok(Number(inline.strongWeight) >= 600, '粗体字重没有生效')
      assert.equal(inline.emStyle, 'italic', '斜体没有生效')
      assert.match(inline.codeMono, /mono|Consolas/i, '行内代码不是等宽字体')
      assert.equal(await value(), '**粗体** *斜体* `code`', '渲染改变了原始 Markdown')

      // 有序列表自动续号、空列表项回车结束列表；回车不发送。
      const beforeList = await messageCount()
      await input.fill('1. 第一项')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. ', '有序列表没有续号')
      await input.type('第二项')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. 第二项\n3. ', '有序列表第二次没有续号')
      assert.equal(await messageCount(), beforeList, '列表回车触发了发送')
      const listStyle = await input.evaluate((root) => {
        const lines = [...root.querySelectorAll('.md-list-line')]
        return {
          count: lines.length,
          padding: lines[0] ? parseFloat(getComputedStyle(lines[0]).paddingLeft) : 0,
          marks: root.querySelectorAll('.md-bullet, .md-list-mark').length,
        }
      })
      assert.ok(listStyle.count >= 2, '列表项没有独立行样式')
      assert.ok(listStyle.marks >= 2, '列表序号没有样式')
      assert.ok(listStyle.padding > 0, '列表项没有缩进')
      await input.press('Enter')
      assert.equal(await value(), '1. 第一项\n2. 第二项\n', '空列表项回车没有结束列表')
      assert.equal(await messageCount(), beforeList, '结束列表时触发了发送')
      const seenBeforeOrdered = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > beforeList) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts
          .slice(seenBeforeOrdered)
          .some((text) => text.includes('1. 第一项') && text.includes('2. 第二项')),
        '有序列表没有按原文发送',
      )

      // 无序列表自动续项；非光标行显示为圆点。
      const beforeUnordered = await messageCount()
      await input.fill('- 项目一')
      await input.press('Enter')
      assert.equal(await value(), '- 项目一\n- ', '无序列表没有续项')
      await input.type('项目二')
      await input.press('Enter')
      assert.equal(await value(), '- 项目一\n- 项目二\n- ', '无序列表第二次没有续项')
      assert.ok((await input.locator('.md-bullet').count()) >= 1, '非光标行的无序列表没有显示圆点')
      const seenBeforeUnordered = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > beforeUnordered) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts
          .slice(seenBeforeUnordered)
          .some((text) => text.includes('- 项目一') && text.includes('- 项目二')),
        '无序列表没有按原文发送',
      )

      // 标题 / 分割线：非光标行不显示源码标记。
      await input.fill('# 标题\n\n---\n\n正文')
      assert.ok((await input.locator('.md-heading').count()) >= 1, '标题没有进入样式层')
      assert.equal(await value(), '# 标题\n\n---\n\n正文', '标题行改变了原文')

      // 实时预览：光标不在的行隐藏 ** 与 #，移入后显示源码。
      await input.fill('# 标题\n\n正文 **粗体**')
      let texts = await lineTexts()
      assert.ok(!texts[0].includes('#'), `非光标行仍显示标题标记：${texts[0]}`)
      assert.ok(texts[0].includes('标题'), `标题内容没有渲染：${texts[0]}`)
      // 光标所在行显示源码（粗体标记可见）。
      assert.ok(texts[texts.length - 1].includes('**'), '光标所在行没有显示源码')
      await input.press('ArrowUp')
      await input.press('ArrowUp')
      await input.press('Home')
      texts = await lineTexts()
      assert.ok(texts[0].includes('#'), `光标移入标题行后没有显示源码：${texts[0]}`)
      assert.ok(!texts[texts.length - 1].includes('**'), '移出后正文仍显示粗体标记')
      assert.ok(texts[texts.length - 1].includes('粗体'), '移出后粗体内容没有渲染')
      await input.press('Control+End')
      texts = await lineTexts()
      assert.ok(!texts[0].includes('#'), '光标移出后标题仍显示标记')

      // 代码块整块渲染：光标在块外时为消息区样式的卡片，没有头部工具条；点击回到源码。
      await input.fill('正文\n\n```ts\nconst a = 1\n```\n\n尾部')
      assert.equal(await input.locator('.md-code-widget').count(), 1, '光标在块外时代码块没有整块渲染')
      assert.equal(await page.locator('.composer-editor .chat-code-tools').count(), 0, '输入框代码块出现了头部工具条')
      const widgetStyle = await input.evaluate((root) => {
        const card = root.querySelector('.md-code-widget')
        const pre = card?.querySelector('pre')
        if (!card || !pre) return null
        return {
          text: pre.textContent ?? '',
          mono: /mono/i.test(getComputedStyle(pre).fontFamily),
          background: getComputedStyle(card).backgroundColor,
        }
      })
      assert.ok(widgetStyle, '找不到代码块卡片')
      assert.equal(widgetStyle.text, 'const a = 1', '代码块卡片内容不对')
      assert.ok(widgetStyle.mono, '代码块卡片不是等宽字体')
      assert.notEqual(widgetStyle.background, 'rgba(0, 0, 0, 0)', '代码块卡片没有底色')
      await input.locator('.md-code-widget').click()
      assert.equal(await input.locator('.md-code-widget').count(), 0, '点击代码块后没有回到源码')
      assert.ok((await input.locator('.md-code-line').count()) >= 3, '光标进入代码块后没有显示源码')
      await input.press('Control+End')

      // 输入法组合期间 Enter 不发送。
      const beforeIme = await messageCount()
      await input.fill('你好')
      await input.evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
      await input.press('Enter')
      await sleep(120)
      assert.equal(await messageCount(), beforeIme, '输入法组合期间回车触发了发送')
      await input.evaluate((el) =>
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' })),
      )
      await sleep(120)
      assert.equal(await messageCount(), beforeIme, '输入法结束后误发送了消息')

      // 深/浅主题截图：标题/列表渲染、代码块卡片与光标行源码。
      await input.fill('# 标题\n\n- 列表项\n\n```ts\nconst x = 1\n```\n\n正文 **粗体**')
      await page.screenshot({ path: '/tmp/md-cm/composer-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/composer-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await input.fill('')
    })

    desktop('用户气泡完整渲染 Markdown：标题降级、列表、代码块与源码编辑（Markdown 实时预览）', async (page) => {
      mkdirSync('/tmp/md-cm', { recursive: true })
      const bubbleSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '用户气泡 Markdown',
        }),
      })
      await gotoSession(page, bubbleSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      await input.waitFor()
      // 会话切换后草稿恢复会覆盖输入，等输入框稳定再写入。
      await page.waitForTimeout(400)
      const source = '## 小标题\n\n- 列表项\n\n```ts\nconst a = 1\n```\n\n**粗体**'
      for (let attempt = 0; attempt < 3; attempt++) {
        await input.fill(source)
        try {
          await page.waitForFunction(
            (want) =>
              document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-value') === want,
            source,
            { timeout: 1200 },
          )
          break
        } catch {
          await page.waitForTimeout(300)
        }
      }
      assert.equal(await input.getAttribute('data-value'), source, '输入框没有接受 Markdown 文本')
      const sessionOf = () => api(base, token, `/api/sessions/${bubbleSession.id}`)
      const before = (await sessionOf()).messages.length
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('## 小标题') && text.includes('```ts')),
        '用户消息没有按 Markdown 源码发送',
      )
      const bubble = page.locator('[data-msg-bubble]').last()
      await bubble.locator('h2').waitFor({ timeout: 10_000 })
      const rendered = await bubble.evaluate((el) => ({
        text: el.innerText,
        h2: el.querySelector('h2')?.textContent ?? '',
        h2Weight: (() => {
          const h2 = el.querySelector('h2')
          return h2 ? getComputedStyle(h2).fontWeight : ''
        })(),
        li: el.querySelector('li')?.textContent ?? '',
        code: el.querySelector('.chat-code pre')?.textContent ?? '',
        strong: el.querySelector('strong')?.textContent ?? '',
        inlineMarkers: el.innerText.includes('**') || el.innerText.includes('##') || el.innerText.includes('```'),
      }))
      assert.equal(rendered.h2, '小标题', '用户气泡标题没有渲染')
      assert.ok(Number(rendered.h2Weight) >= 600, '用户气泡标题没有加粗')
      assert.equal(rendered.li, '列表项', '用户气泡列表没有渲染')
      assert.equal(rendered.code, 'const a = 1', '用户气泡代码块没有渲染')
      assert.equal(rendered.strong, '粗体', '用户气泡粗体没有渲染')
      assert.ok(!rendered.inlineMarkers, `用户气泡仍显示 Markdown 标记：${rendered.text}`)
      // 复制消息仍复制源码；编辑时回到源码。
      const row = page.locator('.msg-row[data-turn-id]').filter({ has: bubble }).first()
      await row.hover()
      await row.getByRole('button', { name: '编辑并重发' }).click()
      const editor = page.locator('textarea[aria-label="编辑并重发"]')
      await editor.waitFor({ timeout: 5_000 })
      assert.equal(await editor.inputValue(), source, '编辑用户消息时没有回到 Markdown 源码')
      await page.getByRole('button', { name: '取消', exact: true }).last().click()
      await page.screenshot({ path: '/tmp/md-cm/user-bubble-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/user-bubble-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))

      // 助手正文对照：同一套 Markdown 排版。
      await openSession(page, 'codeblock')
      await page.waitForTimeout(400)
      await page.screenshot({ path: '/tmp/md-cm/assistant-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/md-cm/assistant-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
    })

    desktop('输入框 @ 选文件与文件夹：文件夹可进入、路径标记只显示名字、发送仍是完整路径（反馈2102#07）', async (page) => {
      mkdirSync('/tmp/fix-1323b', { recursive: true })
      const atSession = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '@ 补全回归',
        }),
      })
      await gotoSession(page, atSession.id)
      await waitModelReady(page)
      const input = page.locator('[aria-label="消息输入框"]')
      const value = () => input.getAttribute('data-value')
      const waitCaret = (pos) =>
        page.waitForFunction(
          (want) =>
            Number(
              document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-caret'),
            ) === want,
          pos,
          { timeout: 5_000 },
        )
      const menu = page.locator('.completion-panel').first()
      const sessionOf = () => api(base, token, `/api/sessions/${atSession.id}`)
      const messageCount = async () => (await sessionOf()).messages.length

      // 列表里同时有文件夹与文件；文件夹带图标。
      await input.fill('@sr')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('src/', { exact: false }).first().waitFor({ timeout: 5_000 })
      assert.ok((await menu.locator('.lucide-folder').count()) >= 1, '@ 列表里文件夹没有图标')
      assert.ok((await menu.innerText()).includes('hello.ts'), '@ 列表里没有文件')

      // 进入文件夹继续浏览，不关闭补全。
      await input.press('ArrowRight')
      assert.equal(await value(), '@src/', '进入文件夹后查询没有变成目录前缀')
      await menu.getByText('hello.ts', { exact: false }).first().waitFor({ timeout: 5_000 })
      assert.ok((await menu.innerText()).includes('src/'), '进入文件夹后没有列出目录内容')
      await input.press('Escape')

      // 直接选中文件夹：输入框只显示文件夹名，悬停给完整路径。
      await input.fill('@sr')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('src/', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(5)
      assert.equal(await value(), 'src/ ', '选中文件夹后原文不是完整路径')
      const folderToken = input.locator('.ce-path').first()
      assert.equal((await folderToken.innerText()).trim(), 'src/', '文件夹标记没有只显示名字')
      assert.equal(await folderToken.getAttribute('title'), 'src/', '文件夹标记悬停没有完整路径')

      // 选中文件：标记只显示文件名，发送内容包含完整相对路径。
      await input.fill('@hello')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('hello.ts', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(13)
      assert.equal(await value(), 'src/hello.ts ', '选中文件后原文不是完整路径')
      const fileToken = input.locator('.ce-path').first()
      assert.equal((await fileToken.innerText()).trim(), 'hello.ts', '文件标记没有只显示文件名')
      assert.equal(await fileToken.getAttribute('title'), 'src/hello.ts', '文件标记悬停没有完整路径')
      // 退格整块删除：先删尾随空格，标记仍是整块，再退格才移除。
      const waitValue = (expected) =>
        page.waitForFunction(
          (want) =>
            document.querySelector('[data-testid="composer-input"]')?.getAttribute('data-value') ===
            want,
          expected,
          { timeout: 5_000 },
        )
      await input.press('Backspace')
      await waitValue('src/hello.ts')
      assert.equal(await input.locator('.ce-path').count(), 1, '删掉尾随空格后标记被拆成纯文本')
      await input.press('Backspace')
      await waitValue('')
      assert.equal((await value()).trim(), '', '退格没有整块删除路径标记')
      assert.equal(await input.locator('.ce-path').count(), 0, '路径标记没有被移除')
      // 清掉残留的空白，再重新选文件（fill 直接覆盖带标记的 DOM 不可靠）。
      await page.keyboard.press('Control+a')
      await input.press('Backspace')
      await waitValue('')
      assert.equal(await value(), '', '全选删除后输入框没有清空')
      await input.fill('@hello')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByText('hello.ts', { exact: false }).first().waitFor()
      await input.press('Enter')
      await waitCaret(13)
      await page.screenshot({ path: '/tmp/fix-1323b/2102-light.png' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.screenshot({ path: '/tmp/fix-1323b/2102-dark.png' })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))

      const before = await messageCount()
      const seenBefore = provider.seenUserTexts.length
      await page.getByRole('button', { name: '发送消息' }).click()
      for (let i = 0; i < 80; i++) {
        const current = await sessionOf()
        if (current.status === 'idle' && current.messages.length > before) break
        await sleep(100)
      }
      assert.ok(
        provider.seenUserTexts.slice(seenBefore).some((text) => text.includes('src/hello.ts')),
        '发送内容没有包含完整路径',
      )
      await input.fill('')
    })

    desktop('模型菜单顶部显示最近使用模型（跨账号分组）并可直接选中（#7-04）', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => {
        localStorage.setItem(
          'tandem.recentModels.v1',
          JSON.stringify([
            { profileId: 'p-main', groupId: 'g1', model: 'mock-2', count: 9, lastUsedAt: Date.now() },
            { profileId: 'p-main', groupId: 'g2', model: 'o3', count: 5, lastUsedAt: Date.now() - 1000 },
            { profileId: 'p-main', groupId: 'g1', model: 'mock-1', count: 2, lastUsedAt: Date.now() - 2000 },
          ]),
        )
      })
      await page.getByRole('button', { name: '选择模型' }).first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      const labels = await menu.getByRole('menuitem').allInnerTexts()
      const topIndex = labels.findIndex((text) => /mock[\s-]?2/i.test(text))
      const o3Index = labels.findIndex((text) => /O3/i.test(text))
      const mockIndex = labels.findIndex((text) => /mock[\s-]?1/i.test(text))
      assert.ok(topIndex >= 0, '最近使用列表缺少常用模型 mock-2')
      assert.ok(o3Index >= 0, '最近使用列表缺少跨分组模型 O3')
      assert.ok(mockIndex >= 0, '最近使用列表缺少 mock-1')
      assert.ok(topIndex < o3Index && o3Index < mockIndex, `最近使用没有按次数排序：${labels.join(' | ')}`)
      assert.match(labels[topIndex], /生产/, '最近使用模型没有标注分组')
      assert.match(labels[o3Index], /备用/, '最近使用模型没有标注分组')
      const response = page.waitForResponse(
        (res) => res.url().includes('/api/sessions/long') && res.request().method() === 'PATCH',
        { timeout: 10_000 },
      )
      await menu.getByRole('menuitem').filter({ hasText: /mock[\s-]?2/i }).first().click()
      await response
      const stored = await api(base, token, '/api/sessions/long')
      assert.equal(stored.model, 'mock-2', '最近使用模型没有生效')
      assert.equal(stored.groupId, 'g1', '最近使用模型没有切换分组')
    })

    desktop('环境条容器透明、触发器可见且不越界', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => b.getAttribute('data-tip') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        const bar = document.querySelector('[data-env-bar]')
        if (!wrap || !bar) return null
        const bg = getComputedStyle(wrap).backgroundColor
        // 反馈1323#06：行内除触发器自身外不应有任何底色；直接子项的底色都必须透明。
        const stray = [...wrap.children]
          .map((child) => ({
            tag: child.tagName,
            text: (child.textContent ?? '').trim().slice(0, 12),
            bg: getComputedStyle(child).backgroundColor,
          }))
          .filter((child) => !/rgba?\(0, 0, 0, 0\)|transparent/.test(child.bg))
        const buttons = [...wrap.querySelectorAll(':scope button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { text: b.textContent.trim(), x: r.x, right: r.right, height: r.height, font: getComputedStyle(b).fontSize }
        })
        return {
          bg,
          barBg: getComputedStyle(bar).backgroundColor,
          parentBg: getComputedStyle(bar.parentElement).backgroundColor,
          stray,
          width: wrap.getBoundingClientRect().width,
          buttons,
        }
      }, repo)
      assert.ok(info, '找不到环境条容器')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条容器不透明：${info.bg}`)
      assert.match(info.barBg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条根节点不透明：${info.barBg}`)
      assert.match(info.parentBg, /rgba?\(0, 0, 0, 0\)|transparent/, `环境条外层不透明：${info.parentBg}`)
      assert.equal(
        info.stray.length,
        0,
        `环境条行内仍有背景：${info.stray.map((item) => `${item.text || item.tag}=${item.bg}`).join(' | ')}`,
      )
      assert.ok(info.buttons.length >= 3, `环境条只有 ${info.buttons.length} 个触发器`)
      for (const button of info.buttons) {
        assert.ok(button.right <= DESKTOP.width + 1, `环境条「${button.text}」右缘越界 ${button.right}`)
        assert.ok(button.height >= 20, `环境条「${button.text}」高度异常 ${button.height}`)
        assert.ok(parseFloat(button.font) >= 12.5, `环境条「${button.text}」字号 ${button.font}`)
      }
    })

    desktop('环境条文件夹弹层向上弹出且完整可见', async (page) => {
      await openSession(page, 'long')
      const trigger = page.locator(`button[data-tip="${repo}"]`).first()
      await trigger.click()
      const panel = page.locator('[role="menu"]:has(> .popover-panel)').first()
      await panel.waitFor()
      assert.equal(await panel.getAttribute('data-side'), 'top', '文件夹弹层没有向上弹出')
      withinViewport(await panel.boundingBox(), DESKTOP, '文件夹弹层')
      const openFolder = panel.getByRole('menuitem', { name: '打开文件夹…' })
      assert.equal(await openFolder.count(), 1, '文件夹弹层缺少「打开文件夹…」')
      await openFolder.click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      withinViewport(await dialog.boundingBox(), DESKTOP, '文件夹浏览对话框')
      assert.equal(
        await dialog.locator('[aria-label="使用此目录"]').count(),
        1,
        '文件夹浏览对话框内容未加载',
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' }).catch(() => {})
    })

    desktop('环境条文件夹弹层只列最近文件夹与「打开文件夹…」（反馈1323#09）', async (page) => {
      await openSession(page, 'long')
      const hostKey = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? 'local',
      )
      await page.evaluate(
        ({ hostKey, dirs }) => localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [hostKey]: dirs })),
        { hostKey, dirs: [repo, path.dirname(repo)] },
      )
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const panel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await panel.waitFor({ state: 'visible' })
      const items = (await panel.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.ok(items[0].includes(path.basename(repo)), `最近文件夹没有排在最前：${items.join(' | ')}`)
      assert.ok(!items.includes('..'), `文件夹弹层不应再直接列目录：${items.join(' | ')}`)
      assert.equal(items[items.length - 1], '打开文件夹…', `文件夹弹层底部不是「打开文件夹…」：${items.join(' | ')}`)
      assert.equal(
        await panel.locator('input[aria-label="筛选文件夹或输入路径"]').count(),
        0,
        '文件夹弹层里不应常驻目录浏览器',
      )
      // 无最近记录时只显示「打开文件夹…」。
      await page.evaluate((key) => localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [key]: [] })), hostKey)
      await page.keyboard.press('Escape')
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const emptyPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await emptyPanel.waitFor({ state: 'visible' })
      const emptyItems = (await emptyPanel.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.deepEqual(emptyItems, ['打开文件夹…'], `无最近记录时弹层应只有「打开文件夹…」：${emptyItems.join(' | ')}`)
      await page.keyboard.press('Escape')
    })

    desktop('非 Git 仓库时不显示 Worktree 开关（反馈1323#07）', async (page) => {
      await withNonGitSession(page, async () => {
        const bar = page.locator('[data-env-bar]').first()
        assert.equal(await bar.getByText('Worktree', { exact: true }).count(), 0, '非 Git 时仍显示 Worktree')
        assert.equal(await bar.getByRole('switch', { name: 'Worktree' }).count(), 0, '非 Git 时仍有 Worktree 开关')
        assert.equal(
          await bar.locator('button[aria-haspopup="menu"]').count(),
          2,
          '非 Git 时环境条应只剩主机与文件夹',
        )
      })
      // git 仓库保持原样。
      await openSession(page, 'long')
      const gitBar = page.locator('[data-env-bar]').first()
      assert.equal(await gitBar.getByRole('switch', { name: 'Worktree' }).count(), 1, 'git 仓库缺少 Worktree 开关')
    })

    desktop('非 Git 仓库时不显示分支触发器（反馈1323#08）', async (page) => {
      await withNonGitSession(page, async () => {
        const bar = page.locator('[data-env-bar]').first()
        assert.equal(await bar.getByText('非 Git 仓库', { exact: true }).count(), 0, '非 Git 时仍显示「非 Git 仓库」')
        assert.equal(await bar.locator('svg.lucide-git-branch').count(), 0, '非 Git 时仍有分支触发器')
      })
      // git 仓库保持原样：分支触发器在。
      await openSession(page, 'long')
      const gitBar = page.locator('[data-env-bar]').first()
      assert.equal(await gitBar.getByText('main', { exact: true }).count() >= 1, true, 'git 仓库缺少分支名')
    })

    desktop('侧栏项目分「固定 / 最近」两组，固定图标语义与悬停规则（R01）', async (page) => {
      const recent = page.locator('[data-recent-projects]')
      await recent.waitFor({ state: 'visible' })
      assert.match(await recent.innerText(), /最近项目/, '最近项目分组缺少标题')
      const project = recent.locator('[data-project-row][data-project-key$=":repo"]').first()
      await project.waitFor({ state: 'visible' })
      const pin = project.getByRole('button', { name: '固定项目 repo', exact: true })
      assert.equal(
        await pin.evaluate((el) => getComputedStyle(el).opacity),
        '0',
        '未固定项目平时不应显示固定图标',
      )
      await project.hover()
      await pin.waitFor({ state: 'visible' })
      const pinnedIcon = (await pin.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(pinnedIcon.includes('lucide-pin'), `未固定项目的图标应为普通图钉：${pinnedIcon.join(' ')}`)
      assert.ok(!pinnedIcon.includes('lucide-pin-off'), '未固定项目误用了带斜杠的图钉')
      await pin.click()

      const pinnedSection = page.locator('[data-pinned-projects]')
      await pinnedSection.waitFor({ state: 'visible' })
      assert.match(await pinnedSection.innerText(), /固定项目/, '固定分组缺少标题')
      const pinnedProject = pinnedSection.locator('[data-project-row][data-project-key$=":repo"]').first()
      await pinnedProject.waitFor({ state: 'visible' })
      assert.equal(
        await recent.locator('[data-project-row][data-project-key$=":repo"]').count(),
        0,
        '固定后项目仍留在最近分组',
      )
      await pinnedProject.hover()
      const unpin = pinnedProject.getByRole('button', { name: '取消固定项目 repo', exact: true })
      await unpin.waitFor({ state: 'visible' })
      const unpinIcon = (await unpin.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(unpinIcon.includes('lucide-pin-off'), '已固定项目悬停应显示带斜杠的图钉')
      assert.ok(!unpinIcon.includes('lucide-pin'), '已固定项目误用了普通图钉')
      await unpin.click()
      await recent.locator('[data-project-row][data-project-key$=":repo"]').first().waitFor({ state: 'visible' })
      assert.equal(await page.locator('[data-pinned-projects]').count(), 0, '取消固定后固定分组仍在')

      // 会话级置顶遵循同一图标规则：平时不显示，悬停显示固定 / 取消固定。
      const sessionRow = page.locator('[data-session-row][data-session-id="long"]').first()
      await sessionRow.hover()
      const pinSession = sessionRow.getByRole('button', { name: '在项目中置顶', exact: true })
      await pinSession.waitFor({ state: 'visible' })
      const sessionPinIcon = (await pinSession.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(sessionPinIcon.includes('lucide-pin'), '未置顶会话应显示普通图钉')
      await pinSession.click()
      assert.equal(await sessionRow.getAttribute('data-session-pinned'), 'true', '会话置顶状态未生效')
      await sessionRow.hover()
      const unpinSession = sessionRow.getByRole('button', { name: '取消项目置顶', exact: true })
      await unpinSession.waitFor({ state: 'visible' })
      const sessionUnpinIcon = (await unpinSession.locator('svg').getAttribute('class'))?.split(/\s+/) ?? []
      assert.ok(sessionUnpinIcon.includes('lucide-pin-off'), '已置顶会话应显示带斜杠的图钉')
      await unpinSession.click()
      assert.equal(await sessionRow.getAttribute('data-session-pinned'), null, '取消置顶未生效')
    })

    desktop('侧栏项目 tooltip 显示主机与完整路径（R06）', async (page) => {
      const hostName = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.name ?? '',
      )
      const project = page.locator('[data-project-row][data-project-key$=":repo"] button').first()
      await project.hover()
      await page.waitForFunction(
        () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
        null,
        { timeout: 5_000 },
      )
      const tip = await page.locator('#tandem-tooltip').innerText()
      assert.ok(tip.includes(hostName), `项目 tooltip 缺少主机名：${tip}`)
      assert.ok(tip.includes(repo), `项目 tooltip 缺少完整路径：${tip}`)
      assert.ok(!tip.trim().startsWith('repo ·'), `项目 tooltip 仍在重复项目名：${tip}`)
    })

    desktop('后台任务悬停展开列表并跳到对应输出（R01）', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ state: 'visible' })
      await menu.getByRole('menuitem', { name: /后台任务/ }).hover()
      const submenu = page.locator('[aria-label="后台任务"]')
      await submenu.waitFor({ state: 'visible', timeout: 5_000 })
      const listText = await submenu.innerText()
      assert.match(listText, /npm run dev/, `后台任务列表缺少命令：${listText}`)
      assert.match(listText, /已结束/, `后台任务列表缺少状态：${listText}`)
      await submenu.getByRole('menuitem', { name: /npm run dev/ }).waitFor({ state: 'visible' })
      const taskItem = submenu.getByRole('menuitem', { name: /npm run dev/ })
      const box = await taskItem.boundingBox()
      assert.ok(box, '找不到后台任务列表项')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
      await page.mouse.down()
      await page.mouse.up()
      const dialog = page.getByRole('dialog', { name: '后台任务' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      assert.ok(
        (await dialog.innerText()).includes('npm run dev -- --port 4173'),
        '打开的面板没有定位到对应后台任务',
      )
      await dialog.getByRole('button', { name: '关闭' }).click()

      await openSession(page, 'turns4')
      await page.getByRole('button', { name: '更多', exact: true }).click()
      const emptyMenu = page.locator('[role="menu"]').last()
      await emptyMenu.waitFor({ state: 'visible' })
      await emptyMenu.getByRole('menuitem', { name: /后台任务/ }).hover()
      const emptySubmenu = page.locator('[aria-label="后台任务"]')
      await emptySubmenu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await emptySubmenu.innerText(), /暂无后台任务/, '没有后台任务时未显示空态')
      await page.keyboard.press('Escape')
    })

    desktop('反馈16#02：宽表格与长代码行限制在正文宽度内、块内部横向滚动', async (page) => {
      await openSession(page, 'wide')
      const paraWidth = await page.evaluate(
        () => document.querySelector('[data-message-id="w2"] .chat-md p')?.getBoundingClientRect().width ?? 0,
      )
      assert.ok(paraWidth > 200, `找不到正文段落宽度：${paraWidth}`)
      const table = page.locator('[data-message-id="w2"] .md-table-wrap').first()
      await table.waitFor({ timeout: 10_000 })
      const tableBox = await table.boundingBox()
      assert.ok(tableBox, '找不到宽表格')
      assert.ok(
        tableBox.width <= paraWidth + 2,
        `表格超出正文阅读宽度：${Math.round(tableBox.width)}px > ${Math.round(paraWidth)}px`,
      )
      const scroll = table.locator('.md-table-scroll')
      const metrics = await scroll.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      assert.ok(metrics.scrollWidth > metrics.clientWidth, '宽表格没有在块内部横向滚动')
      await table.locator('.x-scroll-more[data-visible="true"]').waitFor({ timeout: 5_000 })

      const code = page.locator('[data-message-id="w2"] .chat-code').first()
      await code.waitFor({ timeout: 10_000 })
      const codeBox = await code.boundingBox()
      assert.ok(codeBox, '找不到代码块')
      assert.ok(
        codeBox.width <= paraWidth + 2,
        `代码块超出正文阅读宽度：${Math.round(codeBox.width)}px > ${Math.round(paraWidth)}px`,
      )
      const pre = code.locator('pre')
      const before = await pre.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: getComputedStyle(el).whiteSpace,
      }))
      assert.notEqual(before.whiteSpace, 'pre-wrap', '代码块默认不应自动换行')
      assert.ok(before.scrollWidth > before.clientWidth, '长代码行没有在块内部横向滚动')

      await code.hover()
      await code.getByTestId('code-wrap-toggle').click()
      const after = await pre.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: getComputedStyle(el).whiteSpace,
      }))
      assert.equal(after.whiteSpace, 'pre-wrap', '打开自动换行后仍不换行')
      assert.ok(after.scrollWidth <= after.clientWidth + 1, '自动换行后仍横向溢出')
      // 还原全局换行偏好，避免影响后续用例（代码块换行是跨会话记忆的）。
      await code.getByTestId('code-wrap-toggle').click()
    })

    desktop('反馈16#02：代码块有文字且落在可见区域、表格不缺列（真实会话夹具）', async (page) => {
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))
      await openSession(page, 'codeblock')
      const row = page.locator('[data-message-id="r16a2"]')
      await row.waitFor({ timeout: 15_000 })
      const paraWidth = await row
        .locator('.chat-md p')
        .first()
        .evaluate((el) => el.getBoundingClientRect().width)
      assert.ok(paraWidth > 300, `正文段落宽度异常：${paraWidth}`)

      const codes = row.locator('.chat-code')
      const codeCount = await codes.count()
      assert.ok(codeCount >= 3, `真实会话夹具里的代码块太少：${codeCount}`)
      for (let i = 0; i < codeCount; i += 1) {
        const info = await codes.nth(i).evaluate((el) => {
          const box = el.getBoundingClientRect()
          const pre = el.querySelector('pre')
          const preBox = pre.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(pre)
          const rects = [...range.getClientRects()].filter((r) => r.width > 0)
          return {
            width: box.width,
            left: box.left,
            textLength: (pre.textContent ?? '').trim().length,
            scrollHeight: pre.scrollHeight,
            color: getComputedStyle(pre).color,
            bg: getComputedStyle(el).backgroundColor,
            firstTextLeft: rects.length ? Math.min(...rects.map((r) => r.left)) : null,
            hasRectInBox: rects.some(
              (r) => r.right > preBox.left + 2 && r.left < preBox.right - 2 && r.height > 0,
            ),
          }
        })
        assert.ok(info.textLength > 0, `代码块 ${i} 没有任何文字（空白块）`)
        assert.ok(info.scrollHeight > 0, `代码块 ${i} 高度为 0`)
        assert.ok(info.hasRectInBox, `代码块 ${i} 的文字不在可见区域里`)
        assert.ok(
          info.firstTextLeft !== null && info.firstTextLeft >= info.left + 4,
          `代码块 ${i} 的文字从块外开始：${info.firstTextLeft} < ${info.left}`,
        )
        assert.ok(
          info.width <= paraWidth + 2,
          `代码块 ${i} 超出正文宽度：${Math.round(info.width)} > ${Math.round(paraWidth)}`,
        )
        assert.notEqual(info.color, info.bg, `代码块 ${i} 文字颜色与背景相同`)
      }
      // 长 PowerShell 行（真实会话里被裁成半截的那种）：在块内部横向滚动。
      const longCode = page.locator('.chat-code').filter({ hasText: 'sdkmanager.bat' }).first()
      const longMetrics = await longCode.locator('pre').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      assert.ok(longMetrics.scrollWidth > longMetrics.clientWidth, '长 PowerShell 行没有块内横向滚动')

      const tables = row.locator('.md-table-wrap')
      const tableCount = await tables.count()
      assert.ok(tableCount >= 1, '真实会话夹具缺少表格')
      for (let i = 0; i < tableCount; i += 1) {
        const info = await tables.nth(i).evaluate((el) => {
          const box = el.getBoundingClientRect()
          const cells = [...el.querySelectorAll('th,td')].map((cell) => {
            const rect = cell.getBoundingClientRect()
            return {
              text: (cell.textContent ?? '').trim(),
              left: rect.left,
              width: rect.width,
            }
          })
          return { width: box.width, left: box.left, cells }
        })
        assert.ok(info.width <= paraWidth + 2, `表格 ${i} 超出正文宽度：${Math.round(info.width)}`)
        assert.ok(info.cells.length > 0, `表格 ${i} 没有单元格`)
        for (const cell of info.cells) {
          assert.ok(cell.text.length > 0, `表格 ${i} 有空单元格（缺列）`)
          assert.ok(cell.width > 0, `表格 ${i} 有宽度为 0 的单元格`)
          assert.ok(
            cell.left >= Math.max(info.left, 0) - 1,
            `表格 ${i} 的单元格被推到表格左侧之外：${cell.left} < ${info.left}`,
          )
        }
      }

      // 存档整页与消息列截图，便于对照反馈里的元素截图。
      mkdirSync('/tmp/fb16-after', { recursive: true })
      await page.screenshot({ path: '/tmp/fb16-after/regression-codeblock.png' })
      await row.screenshot({ path: '/tmp/fb16-after/regression-codeblock-row.png' })
    })

    desktop('反馈1919#07：流式输出时在底部自动跟随，上滚后停止，回到底部后恢复', async (page) => {
      await openSession(page, 'scroll')
      const scroller = page.locator('.chat-scroll').filter({ has: page.locator('.msg-row') }).first()
      const distance = () =>
        scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
      const streaming = () => page.locator('.md.chat-md.is-streaming').count()
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.chat-scroll')
          return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
        },
        null,
        { timeout: 10_000 },
      )
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SCROLL_E2E 请长篇回答')
      await input.press('Enter')
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      // 在底部时：流式增长过程中始终贴底（距底部小于 PIN_THRESHOLD=80，即仍算贴底）。
      const following = []
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(400)
        following.push(await distance())
      }
      assert.ok(
        following.every((d) => d < 80),
        `在底部时流式输出没有跟随，距底部像素：${following.join(', ')}`,
      )
      // 用户滚轮上滚：停止跟随，内容继续增长也不能把视口拉回底部。
      const box = await scroller.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(300)
      assert.ok((await streaming()) > 0, '上滚时流式输出已经结束，无法验证不跟随')
      const scrolledUp = await distance()
      assert.ok(scrolledUp > 120, `滚轮上滚后距底部只有 ${scrolledUp}px，视口被拉回底部`)
      await page.waitForTimeout(800)
      assert.ok(
        (await distance()) > 120,
        `上滚后流式输出仍在把视口拉回底部：${scrolledUp}px → ${await distance()}px`,
      )
      // 点「回到底部」：恢复跟随，之后的增长继续贴底。
      await page.locator('.chat-jump').click()
      await page.waitForTimeout(700)
      assert.ok((await streaming()) > 0, '回到底部时流式输出已经结束，无法验证恢复跟随')
      const resumed = []
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(400)
        resumed.push(await distance())
      }
      assert.ok(
        resumed.every((d) => d < 80),
        `回到底部后没有恢复跟随，距底部像素：${resumed.join(', ')}`,
      )
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ state: 'detached', timeout: 20_000 })
      assert.ok((await distance()) < 80, '流式结束后没有停在底部')
    })

    fb2102('反馈2102#03：设置弹窗打开时，背景滚动条不压在弹窗之上；弹窗自己的滚动条在弹窗之上', async (page) => {
      await openSession(page, 'scroll')
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const probe = (axis) =>
        page.evaluate((axis) => {
          const bar = document.querySelector(`.overlay-scrollbar[data-axis="${axis}"][data-visible="true"]`)
          if (!bar) return null
          const r = bar.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return { own: hit === bar, tag: hit?.tagName ?? null, cls: String(hit?.className ?? '').slice(0, 60) }
        }, axis)
      // 背景聊天区在遮罩下方滚动，覆盖式滚动条会在它的右缘出现。
      await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        if (el) el.scrollTop = 160
      })
      await page.waitForSelector('.overlay-scrollbar[data-visible="true"]', { timeout: 3_000 })
      const background = await probe('y')
      assert.ok(background, '背景滚动后没有出现覆盖式滚动条')
      assert.ok(!background.own, `背景滚动条压在设置弹窗之上：命中 ${background.tag}.${background.cls}`)
      // 弹窗自己的滚动区域：滚动条应显示在弹窗之上。
      const scrolled = await page.evaluate(() => {
        const root = document.querySelector('[role="dialog"][aria-label="设置"]')
        const el = root
          ? [...root.querySelectorAll('*')].find((node) => {
              const style = getComputedStyle(node)
              return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40
            })
          : null
        if (!el) return false
        el.scrollTop = 60
        return true
      })
      if (scrolled) {
        // 背景滚动条还会淡出 800ms：等它改归属到弹窗区域（滚动事件异步派发）后再判定。
        await page
          .waitForFunction(
            () => {
              const bar = document.querySelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]')
              if (!bar) return false
              const r = bar.getBoundingClientRect()
              return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === bar
            },
            null,
            { timeout: 3_000 },
          )
          .catch(() => {})
        const own = await probe('y')
        assert.ok(own?.own, `弹窗自己的滚动条被遮挡：命中 ${own?.tag}.${own?.cls}`)
      }
      await page.screenshot({ path: '/tmp/fix-2102a/after-03.png' })
      await dialog.locator('button[aria-label="关闭"]').first().click().catch(() => page.keyboard.press('Escape'))
    })

    fb2102('反馈2102#06：新会话发送后直接进入会话并显示用户消息，发送请求未返回前不停留在空的新会话页', async (page) => {
      // 放慢创建会话请求，使「请求未返回」的时间窗口足够长，便于逐帧观察。
      await page.route('**/api/sessions', async (route) => {
        if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 900))
        await route.continue()
      })
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('FB2102_NEW 发送即进入会话')
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息')
        return button && !button.disabled
      })
      await page.evaluate(() => {
        window.__fb06 = { sent: false, frames: [], on: true }
        const greeting = () => [...document.querySelectorAll('h1')].some((h) => h.textContent.includes('今天想做点什么'))
        const message = () => (document.querySelector('.chat-scroll')?.textContent ?? '').includes('FB2102_NEW')
        const sample = () => {
          const state = window.__fb06
          if (!state.on) return
          if (state.sent) state.frames.push({ greeting: greeting(), message: message(), at: performance.now() })
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        // 只统计点击发送之后的帧（捕获阶段，早于 React 处理点击）。
        window.addEventListener(
          'click',
          (event) => {
            if (event.target instanceof Element && event.target.closest('button[aria-label="发送消息"]')) {
              window.__fb06.sent = true
            }
          },
          { capture: true },
        )
      })
      await page.locator('button[aria-label="发送消息"]').click()
      await page.waitForTimeout(300)
      // 创建请求仍在途（已放慢）：此时应已显示占位会话与用户消息。
      await page.screenshot({ path: '/tmp/fix-2102a/after-06.png' })
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 10_000 })
      await page.waitForTimeout(300)
      const result = await page.evaluate(() => {
        window.__fb06.on = false
        return window.__fb06.frames
      })
      await page.unroute('**/api/sessions')
      const stuck = result.filter((frame) => frame.greeting && !frame.message)
      assert.ok(result.length > 0, '没有采样到发送后的帧')
      assert.equal(
        stuck.length,
        0,
        `发送后有 ${stuck.length} 帧仍停在空的新会话页，用户消息尚未显示`,
      )
      assert.ok(
        result.some((frame) => frame.message),
        '发送后用户消息始终没有显示在会话里',
      )
    })

    fb2102('反馈2102#01：切换会话时主区不闪：旧会话画面保留到新会话就绪，不出现空白或骨架屏', async (page) => {
      await openSession(page, 'scroll')
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 10_000 })
      await page.evaluate(() => {
        const state = (window.__fb01 = { on: true, gaps: 0, samples: 0, skeleton: 0, empty: 0 })
        const scroller = () => document.querySelector('.chat-scroll')
        const inspect = () => {
          const el = scroller()
          if (!el) return
          state.samples += 1
          const rows = el.querySelectorAll('.msg-row').length
          const skeleton = !!el.querySelector('.skeleton')
          if (skeleton) state.skeleton += 1
          if (rows === 0 || skeleton) state.gaps += 1
        }
        state.observer = new MutationObserver(inspect)
        state.observer.observe(document.querySelector('main'), { childList: true, subtree: true })
        const sample = () => {
          if (!state.on) return
          inspect()
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const slow = page.locator('[data-session-row]').filter({ hasText: '慢速运行会话' }).first()
      await slow.waitFor({ timeout: 10_000 })
      await slow.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/slow'), null, { timeout: 10_000 })
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      const state = await page.evaluate(() => {
        window.__fb01.on = false
        window.__fb01.observer.disconnect()
        return { gaps: window.__fb01.gaps, samples: window.__fb01.samples, skeleton: window.__fb01.skeleton }
      })
      assert.ok(state.samples > 0, '切换期间没有采样到主区')
      await page.screenshot({ path: '/tmp/fix-2102a/after-01.png' })
      assert.equal(
        state.gaps,
        0,
        `切换会话时主区出现 ${state.gaps} 次空白或骨架屏（骨架屏 ${state.skeleton} 次）`,
      )
    })

    desktop('反馈1601#02：来回切换会话，消息区与右栏从新会话首帧起保持同一画面（R10 复发）', async (page) => {
      // 先各打开一次，让右栏的上下文/用量分组数据在测量前就绪。
      await openSession(page, 'huge')
      await page.waitForTimeout(600)
      await openSession(page, 'codeblock')
      await page.waitForTimeout(600)
      await page.evaluate(() => {
        const state = (window.__fb1601 = { on: true, frames: [] })
        const record = () => {
          const s = window.__fb1601
          if (!s.on) return
          const scroll = document.querySelector('.chat-scroll')
          const panelBody = document.querySelector('[data-panel-body]')
          const box = scroll.getBoundingClientRect()
          const rows = [...scroll.querySelectorAll('.msg-row')]
          const first = rows.find(
            (row) =>
              row.getAttribute('data-message-id') &&
              row.getBoundingClientRect().bottom > box.top + 1,
          )
          // 其他用例可能给会话追加过消息，按整个列表里任一已知夹具 id 归属会话。
          const ids = rows.map((row) => row.getAttribute('data-message-id') ?? '')
          const knows = (re) => ids.some((id) => re.test(id))
          s.frames.push({
            session: knows(/^h[ua]\d+/)
              ? 'huge'
              : knows(/^r16/)
                ? 'codeblock'
                : knows(/^sc\d/)
                  ? 'scroll'
                  : '',
            top: scroll.scrollTop,
            height: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
            rows: rows.length,
            skeleton: scroll.querySelectorAll('.skeleton').length,
            rowTop: first ? Math.round(first.getBoundingClientRect().top - box.top) : null,
            groups: panelBody
              ? [...panelBody.querySelectorAll('[data-group]')]
                  .map((g) => g.getAttribute('data-group'))
                  .join(',')
              : '',
            panelSkeleton: panelBody ? panelBody.querySelectorAll('.skeleton').length : 0,
            graphNodes: panelBody ? panelBody.querySelectorAll('[data-graph-turn-id]').length : 0,
            hasGraph: panelBody ? panelBody.textContent.includes('会话图') : false,
          })
          requestAnimationFrame(loop)
        }
        // 在绘制之后采样（rAF → 宏任务），看到的是这一帧真正画出来的画面。
        const loop = () => requestAnimationFrame(() => setTimeout(record, 0))
        loop()
      })
      const clickSession = async (title, sessionId, messagePrefix) => {
        const row = page.locator('[data-session-row]').filter({ hasText: title }).first()
        await row.waitFor({ timeout: 15_000 })
        await row.locator('[data-session-open], button').first().click()
        await page.waitForFunction(
          (id) => window.location.hash.includes(`/s/${id}`),
          sessionId,
          { timeout: 10_000 },
        )
        // 等目标会话的内容真正挂载（首屏快照异步到达），再看它之后的帧。
        await page
          .locator(`.msg-row[data-message-id^="${messagePrefix}"]`)
          .first()
          .waitFor({ timeout: 15_000 })
        await page.waitForTimeout(500)
      }
      await clickSession('超大会话 · 320 轮', 'huge', 'hu')
      await clickSession('代码块与表格会话', 'codeblock', 'r16u')
      // 首次打开的会话：目标视图还没有任何缓存，同样不能闪。
      await clickSession('流式跟随会话', 'scroll', 'sc0')
      const frames = await page.evaluate(() => {
        window.__fb1601.on = false
        return window.__fb1601.frames
      })
      if (process.env.FB1601_DEBUG) writeFileSync('/tmp/fix-1601a/frames-1601.json', JSON.stringify(frames, null, 1))
      assert.ok(frames.length > 30, `切换期间采样帧太少：${frames.length}`)
      // 任何一帧都不能把主区清空、显示骨架，或让右栏出现骨架。
      const blank = frames.filter((f) => f.rows === 0 || f.skeleton > 0 || f.panelSkeleton > 0)
      assert.equal(blank.length, 0, `切换会话时有 ${blank.length} 帧主区/右栏空白或骨架屏`)
      // 贴底：每一帧都应停在底部（切换后重新校准也不能先停在别处）。
      const notBottom = frames.filter(
        (f) => f.rows > 0 && f.height - f.top - f.clientHeight > 2,
      )
      assert.equal(notBottom.length, 0, `切换会话时有 ${notBottom.length} 帧不在底部（画面会跳动）`)
      // 同一会话显示期间，可见首行相对视口的位置必须保持不变：注入说明、代码块等
      // 后到的内容不能让画面先下移再回弹。
      const perSession = new Map()
      for (const f of frames) {
        if (!f.session || f.rowTop === null) continue
        const entry =
          perSession.get(f.session) ??
          { tops: new Set(), groups: new Set(), graphs: new Set(), groupSequence: [] }
        entry.tops.add(f.rowTop)
        entry.groups.add(f.groups)
        entry.graphs.add(f.graphNodes)
        if (entry.groupSequence.at(-1) !== f.groups) entry.groupSequence.push(f.groups)
        perSession.set(f.session, entry)
      }
      for (const session of ['huge', 'codeblock', 'scroll']) {
        assert.ok(perSession.has(session), `没有采样到会话 ${session} 的画面（采样到 ${[...perSession.keys()].join('/') || '无'}，共 ${frames.length} 帧）`)
        const entry = perSession.get(session)
        const tops = [...entry.tops]
        const spread = Math.max(...tops) - Math.min(...tops)
        assert.ok(
          spread <= 2,
          `会话 ${session} 切换后画面上下跳动 ${spread}px（可见首行位置 ${tops.join('/')}）`,
        )
        assert.equal(
          entry.graphs.size,
          1,
          `会话 ${session} 显示期间会话图节点数在变化：${[...entry.graphs].join('/')}`,
        )
        assert.ok([...entry.graphs][0] > 0, `会话 ${session} 的会话图卡片没有节点`)
        if (session === 'scroll') {
          // 首次打开的会话，上下文数据要多拉一次：只允许卡片晚出现一次，不能再消失。
          const sequence = [...entry.groupSequence]
          const last = new Set(sequence.at(-1)?.split(',') ?? [])
          for (const groups of sequence) {
            for (const id of groups.split(',')) {
              assert.ok(last.has(id), `会话 ${session} 显示期间右栏卡片 ${id} 出现后又消失了`)
            }
          }
        } else {
          assert.equal(
            entry.groups.size,
            1,
            `会话 ${session} 显示期间右栏卡片在跳动：${[...entry.groups].join(' | ')}`,
          )
        }
      }
      assert.ok(frames.every((f) => !f.session || f.hasGraph), '切换期间右栏缺少会话图卡片')
    })

    desktop('反馈1601#05：侧栏主机与项目文件夹的折叠状态会被记住，重开仍折叠（R10）', async (page) => {
      await openSession(page, 'long')
      // 主机分组只在多主机时出现：加一台空主机（同一地址），测完清理。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        if (hosts.length < 2) {
          localStorage.setItem(
            'tandem.hosts.v1',
            JSON.stringify([...hosts, { ...hosts[0], id: 'reg-host-2', name: '演示主机' }]),
          )
        }
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      await page.waitForTimeout(900)
      const project = page.locator('[data-project-row]').first()
      await project.waitFor({ timeout: 10_000 })
      const projectKey = await project.getAttribute('data-project-key')
      const projectToggle = project.locator('button[aria-expanded]').first()
      assert.equal(await projectToggle.getAttribute('aria-expanded'), 'true', '项目默认应展开')
      await projectToggle.click()
      assert.equal(await projectToggle.getAttribute('aria-expanded'), 'false', '点击后项目没有折叠')
      const hostGroup = page.locator('[data-host-group]').first()
      await hostGroup.waitFor({ timeout: 10_000 })
      const hostToggle = hostGroup.locator('button[aria-expanded]').first()
      assert.equal(await hostToggle.getAttribute('aria-expanded'), 'true', '主机默认应展开')
      await hostToggle.click()
      assert.equal(await hostToggle.getAttribute('aria-expanded'), 'false', '点击后主机没有折叠')
      const stored = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}').collapsedProjects ?? [],
      )
      // 主机按主机标识、项目按项目路径记（不再用显示名）。
      assert.ok(stored.some((key) => key.startsWith('host:')), `没有记住主机折叠：${stored.join(',')}`)
      assert.ok(
        stored.some((key) => /:[/\\]/.test(key)),
        `项目折叠没有按项目路径记住：${stored.join(',')}`,
      )
      // 重开（刷新）：两级都应保持折叠。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      await page.waitForTimeout(900)
      const hostAfter = page.locator('[data-host-group]').first()
      await hostAfter.waitFor({ timeout: 10_000 })
      assert.equal(
        await hostAfter.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),
        'false',
        '重开后主机分组又展开了',
      )
      const projectAfter = page.locator(`[data-project-row][data-project-key="${projectKey}"]`).first()
      await projectAfter.waitFor({ timeout: 10_000 })
      assert.equal(
        await projectAfter.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),
        'false',
        '重开后项目文件夹又展开了',
      )
      // 清理：移除测试主机与折叠状态，避免影响后续用例。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').filter(
          (h) => h.id !== 'reg-host-2',
        )
        localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
        const prefs = JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}')
        delete prefs.collapsedProjects
        localStorage.setItem('tandem.ui.v1', JSON.stringify(prefs))
      })
    })

    fb2102('反馈2102#02：会话图快速连点两个节点，最终停在第二个目标且滚动单调', async (page) => {
      await openSession(page, 'long')
      const nodes = page.locator('[data-group="graph"] [data-graph-turn-id]')
      await nodes.first().waitFor({ timeout: 10_000 })
      const count = await nodes.count()
      const firstId = await nodes.nth(Math.floor(count * 0.3)).getAttribute('data-graph-turn-id')
      const secondId = await nodes.nth(Math.floor(count * 0.6)).getAttribute('data-graph-turn-id')
      const scrollTop = () => page.evaluate(() => document.querySelector('.chat-scroll').scrollTop)
      // 跳转落点是目标轮居中（scrollIntoView block: center）：返回目标中心相对视口中心的偏移。
      const centerOffset = (id) =>
        page.evaluate((id) => {
          const root = document.querySelector('.chat-scroll')
          const el = root.querySelector(`[data-turn-id="${CSS.escape(id)}"]`)
          if (!el) return null
          const box = root.getBoundingClientRect()
          const target = el.getBoundingClientRect()
          return target.top + target.height / 2 - (box.top + box.height / 2)
        }, id)
      await page.evaluate(() => {
        window.__fb02 = { on: true, samples: [] }
        const sample = () => {
          const state = window.__fb02
          if (!state.on) return
          state.samples.push(document.querySelector('.chat-scroll').scrollTop)
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const beforeClicks = await scrollTop()
      await page.evaluate(() => {
        window.__fb02.clickedAt = window.__fb02.samples.length
      })
      await nodes.nth(Math.floor(count * 0.3)).click()
      await page.waitForTimeout(60)
      await nodes.nth(Math.floor(count * 0.6)).click()
      await page.waitForTimeout(1800)
      const { samples, clickedAt } = await page.evaluate(() => {
        window.__fb02.on = false
        return window.__fb02
      })
      const offset = await centerOffset(secondId)
      const final = await scrollTop()
      assert.ok(offset !== null, `找不到第二个目标 ${secondId}`)
      assert.ok(
        Math.abs(offset) < 60,
        `快速连点后第二个目标没有居中，偏移 ${Math.round(offset)}px（起点 ${Math.round(beforeClicks)}，停在 ${Math.round(final)}）`,
      )
      // 第二次点击之后，滚动只能朝第二个目标单调前进：不能先冲到第一个目标再回弹。
      const after = samples.slice(clickedAt ?? 0)
      const lowest = Math.min(...after)
      assert.ok(
        lowest >= final - 40,
        `滚动越过了第二个目标（最低 ${Math.round(lowest)}，最终 ${Math.round(final)}），快速连点时视口来回抖动`,
      )
      let rises = 0
      for (let i = 1; i < after.length; i++) if (after[i] > after[i - 1] + 2) rises += 1
      assert.ok(rises <= 2, `快速连点后滚动方向出现 ${rises} 次回弹`)
      await page.screenshot({ path: '/tmp/fix-2102a/after-02.png' })
    })

    desktop('反馈16#10：等首个 token / 工具运行时显示 spinner 与已运行时长', async (page) => {
      await openSession(page, 'slow')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 跑一个慢步骤')
      await input.press('Enter')
      // 首个 token 前：消息流末尾有「正在思考…」+ spinner。
      const activity = page.locator('[data-turn-activity]')
      await activity.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForFunction(
        () => (document.querySelector('[data-turn-activity]')?.textContent ?? '').includes('正在思考…'),
        null,
        { timeout: 5_000 },
      )
      // 首个 token 到达后：正文出现流式光标，活动行让位给流式输出。
      await page.locator('.md.chat-md.is-streaming').first().waitFor({ timeout: 8_000 })
      await activity.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
      // 工具执行中：工具行转圈 + 已运行时长，消息流末尾显示「正在运行 Bash…」。
      const elapsed = page.locator('[data-tool-elapsed]').first()
      await elapsed.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await elapsed.innerText(), /已运行 \d+s/, '工具运行中没有显示已运行时长')
      const toolRow = page.locator('.tool-row').filter({ hasText: '运行' }).first()
      assert.ok(
        await toolRow.locator('svg.lucide-loader-circle, svg.lucide-loader-2').count(),
        '工具运行中没有转圈动画',
      )
      await activity.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await activity.innerText(), /正在运行 Bash…/, '工具运行时没有「正在运行 Bash…」提示')
      // 回合结束后：活动行消失，工具行变成完成态（没有已运行时长）。
      await activity.waitFor({ state: 'detached', timeout: 20_000 })
      await page.locator('[data-tool-elapsed]').first().waitFor({ state: 'detached', timeout: 10_000 })
      assert.equal(await page.locator('[data-turn-activity]').count(), 0, '回合结束后活动行仍在')
      await page.screenshot({ path: '/tmp/fb16-after/regression-activity.png' }).catch(() => {})
    })

    desktop('反馈16#11：排队消息被读取后按原位置出现在对话流里', async (page) => {
      await openSession(page, 'slow2')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 先跑一轮')
      await input.press('Enter')
      // 等工具开始运行（这时再排队，旧实现会被随后的 tool_result 消息误删）。
      await page.locator('[data-tool-elapsed]').first().waitFor({ state: 'visible', timeout: 20_000 })
      await input.fill('排队中的第二条')
      await input.press('Enter')
      const queued = page.locator('.msg-row').filter({ hasText: '排队中的第二条' })
      await queued.first().waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await queued.first().innerText(), /已排队/, '排队消息没有排队提示')
      // 工具返回（user 角色的 tool_result 消息）后，排队气泡不能被删掉。
      await page.waitForTimeout(1200)
      assert.equal(await queued.count(), 1, '工具返回后排队消息从对话流里消失了')
      // 队列被 agent 读取后：作为普通用户消息留在流里，位置在下一条 assistant 回复之前。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.msg-row')].filter((row) =>
            row.textContent?.includes('排队中的第二条'),
          ).length === 1 &&
          ![...document.querySelectorAll('.msg-row')].some((row) =>
            row.textContent?.includes('已排队，当前回合结束后发送'),
          ),
        null,
        { timeout: 40_000 },
      )
      // 等这一轮（被读取的排队消息）也拿到回复，再检查位置。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.msg-row')].filter((row) =>
            row.textContent?.includes('慢速回复开始'),
          ).length >= 2,
        null,
        { timeout: 40_000 },
      )
      const rows = await page.locator('.msg-row').evaluateAll((els) =>
        els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
      )
      const queuedIndex = rows.findIndex((text) => text.includes('排队中的第二条'))
      assert.ok(queuedIndex >= 0, '排队消息被读取后没有出现在对话流里')
      assert.equal(
        rows.filter((text) => text.includes('排队中的第二条')).length,
        1,
        '排队消息被读取后出现了重复',
      )
      assert.ok(
        rows.slice(queuedIndex + 1).some((text) => text.includes('慢速回复开始')),
        '排队消息没有被放到本轮用户消息的正确位置',
      )
      const saved = await api(base, token, '/api/sessions/slow2')
      assert.ok(
        saved.messages.some((m) =>
          m.content?.some((block) => block.type === 'text' && block.text.includes('排队中的第二条')),
        ),
        '排队消息没有被持久化到会话里',
      )
    })

    desktop('反馈16#01：用量行默认隐藏、悬停显示、左缘一致、时间用相对格式', async (page) => {
      await openSession(page, 'codeblock')
      await page.locator('[data-message-id="r16a3"]').waitFor({ timeout: 15_000 })
      const metas = await page.evaluate(() =>
        [...document.querySelectorAll('.msg-row [data-usage-summary]')].map((el) => ({
          left: Math.round(el.getBoundingClientRect().left),
          opacity: getComputedStyle(el).opacity,
          text: (el.textContent ?? '').trim(),
        })),
      )
      assert.ok(metas.length >= 3, `assistant 用量行太少：${metas.length}`)
      const lefts = [...new Set(metas.map((m) => m.left))]
      assert.equal(lefts.length, 1, `用量行左缘不一致：${lefts.join(', ')}`)
      assert.ok(metas.every((m) => m.opacity === '0'), '用量行默认应隐藏（悬停才显示）')

      const target = page.locator('[data-message-id="r16a3"] .msg-group')
      await target.hover()
      await page.waitForTimeout(300)
      const shown = await page
        .locator('[data-message-id="r16a3"] [data-usage-summary]')
        .evaluate((el) => getComputedStyle(el).opacity)
      assert.equal(shown, '1', '悬停消息后用量行没有显示')

      const texts = metas.map((m) => m.text).join(' | ')
      assert.match(texts, /分钟前|小时前|刚刚/, `近期消息没有用相对时间：${texts}`)
      assert.match(texts, /\d{2}-\d{2} \d{2}:\d{2}/, `两天前的消息应显示 MM-DD HH:mm：${texts}`)
      assert.match(texts, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `去年的消息应带年份：${texts}`)

      await page.locator('[data-message-id="r16a3"] [data-msg-time]').first().hover()
      await page.waitForTimeout(900)
      const tip = await page.locator('[role="tooltip"]').last().innerText().catch(() => '')
      assert.match(tip, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `时间 tooltip 没有完整日期时间：${tip}`)
      mkdirSync('/tmp/fb16-after', { recursive: true })
      await page.locator('[data-message-id="r16a3"]').screenshot({ path: '/tmp/fb16-after/regression-usage-hover.png' })
    })

    desktop('反馈12#02：自动换行时行号与代码逐行对齐、工具条不压内容', async (page) => {
      // 打开文件预览前先开启自动换行，共享 CodeBlock 会直接走「行号 + 换行」grid。
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '1'))
      await openSession(page, 'links')
      const ref = page.locator('code.file-ref-inline').filter({ hasText: 'src/hello.ts' }).first()
      await ref.waitFor({ state: 'visible' })
      await ref.click()
      const grid = page.getByTestId('code-wrap-grid')
      await grid.waitFor({ timeout: 10_000 })
      const rows = grid.locator('.file-code-wrap-row')
      assert.ok((await rows.count()) >= 3, '换行后没有按行拆成 grid 行')
      const metrics = await grid.evaluate((el) =>
        [...el.querySelectorAll('.file-code-wrap-row')].map((row) => {
          const no = row.querySelector('.file-code-wrap-no')?.getBoundingClientRect()
          const content = row.querySelector('.file-code-wrap-code')?.getBoundingClientRect()
          return no && content
            ? { noRight: no.right, contentLeft: content.left, noTop: no.top, contentTop: content.top }
            : null
        }),
      )
      for (const row of metrics) {
        assert.ok(row, '行号或代码缺失')
        assert.ok(row.noRight <= row.contentLeft + 1, `行号与代码横向重叠：${row.noRight} > ${row.contentLeft}`)
        assert.ok(Math.abs(row.noTop - row.contentTop) <= 1, `行号与代码顶端未对齐：${row.noTop} vs ${row.contentTop}`)
      }
      await page.getByRole('button', { name: '关闭文件预览' }).click()
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))

      // 会话内代码块：自动换行时顶部工具条常显，必须为它留出空间，长行不被遮住。
      await openSession(page, 'wide')
      const code = page.locator('[data-message-id="w2"] .chat-code').first()
      await code.waitFor({ timeout: 10_000 })
      await code.getByTestId('code-wrap-toggle').click()
      await page.waitForTimeout(300)
      await page.waitForFunction(
        () => document.querySelector('[data-message-id="w2"] .chat-code')?.getAttribute('data-wrap') === 'true',
        null,
        { timeout: 5_000 },
      )
      const spacing = await code.evaluate((el) => {
        const tools = el.querySelector('.chat-code-tools')?.getBoundingClientRect()
        const pre = el.querySelector('pre')
        const box = pre?.getBoundingClientRect()
        const pad = pre ? Number.parseFloat(getComputedStyle(pre).paddingTop) : 0
        return {
          toolsBottom: tools?.bottom ?? 0,
          contentTop: (box?.top ?? 0) + pad,
          toolsAttr: el.getAttribute('data-tools'),
          wrapAttr: el.getAttribute('data-wrap'),
          pad,
        }
      })
      assert.ok(
        spacing.toolsBottom <= spacing.contentTop + 1,
        `工具条压住代码内容：${spacing.toolsBottom} > ${spacing.contentTop}（tools=${spacing.toolsAttr} wrap=${spacing.wrapAttr} pad=${spacing.pad}）`,
      )
      await page.evaluate(() => localStorage.setItem('tandem.codeWrap.v1', '0'))
    })

    desktop('消息用量只保留一行小字（#7-03）', async (page) => {
      await openSession(page, 'long')
      const summary = page.locator('[data-usage-summary]').last()
      await summary.scrollIntoViewIfNeeded()
      // 操作条平时 pointer-events:none，先把鼠标移进消息组再悬停用量。
      await summary.locator('xpath=ancestor::div[contains(@class,"msg-group")]').hover()
      const text = await summary.innerText()
      for (const label of ['输入', '输出', '缓存命中', '花费']) {
        assert.ok(text.includes(label), `用量缺少「${label}」标签：${text}`)
      }
      assert.ok(!text.includes('→'), `用量仍在使用裸箭头：${text}`)
      await summary.hover()
      await page.waitForTimeout(700)
      assert.equal(await summary.getAttribute('aria-label'), null, '用量行仍标注为可交互明细')
      await page.keyboard.press('Escape')
    })

    desktop('消息耗时显示在用量行末尾，轮次大纲汇总模型与工具耗时（A）', async (page) => {
      await openSession(page, 'long')
      const summary = page.locator('[data-message-id="a40"] [data-usage-summary]')
      await summary.scrollIntoViewIfNeeded()
      await summary.locator('xpath=ancestor::div[contains(@class,"msg-group")]').hover()
      const usageText = await summary.innerText()
      assert.match(
        usageText,
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · 输入 .+ · 输出 .+ · 缓存命中 .+ · 花费 .+ · 12\.3s$/,
        `消息用量行没有时间在最前或缺少耗时：${usageText}`,
      )

      const hoverTurnOne = async () => {
        await page.locator('.turn-hit').hover()
        await page.waitForFunction(
          () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
          null,
          { timeout: 5_000 },
        )
        await page.waitForTimeout(800)
        const target = await page.evaluate(() => {
          const clip = document.querySelector('.turn-clip')?.getBoundingClientRect()
          for (const item of document.querySelectorAll('.turn-item')) {
            if (!(item.getAttribute('title') ?? '').includes('耗时')) continue
            const r = item.getBoundingClientRect()
            if (!clip || r.top < clip.top - 1 || r.bottom > clip.bottom + 1) continue
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
          return null
        })
        assert.ok(target, '展开后的面板中找不到带耗时 tooltip 的轮次')
        await page.mouse.move(target.x, target.y)
        await page.waitForTimeout(150)
      }
      await hoverTurnOne()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      const tipText = await tip.innerText()
      assert.match(tipText, /耗时 12\.3s/, `轮次 tooltip 没有模型耗时：${tipText}`)
      assert.match(tipText, /首 token 0\.8s/, `轮次 tooltip 没有首 token 延迟：${tipText}`)
      assert.equal(await page.locator('[data-usage-summary][title], [data-usage-summary][data-tip]').count(), 0, '用量行不应新增悬停提示')

      // 含工具执行时间的一轮：12.3s 模型 + 40s 工具 = 52.3s。
      await openSession(page, 'turns4')
      await hoverTurnOne()
      const tipTool = page.locator('#tandem-tooltip[data-open]')
      await tipTool.waitFor({ timeout: 5_000 })
      assert.match(
        await tipTool.innerText(),
        /耗时 52\.3s，其中工具 40s/,
        '轮次 tooltip 没有汇总工具耗时',
      )
    })

    desktop('发送消息后服务端记录耗时、首 token 延迟并显示在消息下方（A）', async (page) => {
      await openSession(page, 'nockpt')
      const box = page.locator('[aria-label="消息输入框"]').first()
      await box.fill('测一下这一轮的耗时')
      await box.press('Enter')
      let assistant
      for (let attempt = 0; attempt < 80; attempt++) {
        const session = await api(base, token, '/api/sessions/nockpt')
        assistant = [...(session.messages ?? [])].reverse().find((m) => m.role === 'assistant')
        if (session.status === 'idle' && typeof assistant?.durationMs === 'number') break
        await sleep(250)
      }
      assert.ok(assistant, '没有生成 assistant 消息')
      assert.equal(typeof assistant.durationMs, 'number', '服务端没有记录消息耗时')
      assert.ok(assistant.durationMs >= 0, `消息耗时异常：${assistant.durationMs}`)
      assert.equal(typeof assistant.ttftMs, 'number', '服务端没有记录首 token 延迟')
      assert.ok(assistant.ttftMs >= 0, `首 token 延迟异常：${assistant.ttftMs}`)
      await page.getByText('回归回复。').last().waitFor({ timeout: 20_000 })
      const usage = page.locator('[data-usage-summary]').last()
      await usage.waitFor({ timeout: 10_000 })
      assert.match(await usage.innerText(), /· \d+(\.\d+)?s$/, '消息下方没有显示本次耗时')
    })

    desktop('用户消息：气泡紧贴内容、时间与输入估算（反馈14#05/#06 · 反馈16#01 悬停显示）', async (page) => {
      await openSession(page, 'long')
      const row = page.locator('[data-turn-id="u40"]')
      const bubble = row.locator('[data-msg-bubble]').first()
      await bubble.waitFor({ timeout: 10_000 })
      const box = await bubble.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const text = range.getBoundingClientRect()
        const rect = el.getBoundingClientRect()
        return {
          width: rect.width,
          textWidth: text.width,
          right: rect.right,
          rowRight: el.closest('.msg-row')?.getBoundingClientRect().right ?? 0,
        }
      })
      assert.ok(
        box.width <= box.textWidth + 40,
        `短消息气泡被撑宽：气泡 ${box.width}px，文本 ${box.textWidth}px`,
      )
      assert.ok(
        Math.abs(box.right - box.rowRight) <= 2,
        `用户气泡没有右对齐：气泡右缘 ${box.right}，消息行右缘 ${box.rowRight}`,
      )
      const userMeta = row.locator('[data-user-usage]').first()
      await userMeta.waitFor({ timeout: 5_000 })
      assert.match(
        await userMeta.innerText(),
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · ~\d+ tok$/,
        '用户消息下方没有「时间 · 输入估算」',
      )
      // 反馈16#01：用量行默认隐藏，悬停消息才显示。
      assert.equal(
        await userMeta.evaluate((el) => getComputedStyle(el).opacity),
        '0',
        '用户消息用量行默认应隐藏',
      )
      await row.locator('.msg-group').hover()
      await page.waitForTimeout(250)
      assert.equal(
        await userMeta.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '悬停用户消息后用量行没有显示',
      )
      const assistantMeta = page.locator('[data-message-id="a40"] [data-usage-summary]').first()
      assert.match(
        await assistantMeta.innerText(),
        /^(刚刚|\d+ 分钟前|\d+ 小时前|(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|\d{2}:\d{2}) · 输入 /,
        'assistant 用量行没有把时间放在最前',
      )

      // 有单价的模型：用户消息要同时显示金额（服务端按发送时的输入估算写入）。
      await openSession(page, 'priced')
      const boxInput = page.locator('[aria-label="消息输入框"]').first()
      await boxInput.fill('这条输入的费用也显示一下')
      await boxInput.press('Enter')
      await page.getByText('回归回复。').last().waitFor({ timeout: 20_000 })
      let stored
      for (let attempt = 0; attempt < 60; attempt++) {
        const session = await api(base, token, '/api/sessions/priced')
        stored = [...(session.messages ?? [])].reverse().find((m) => m.role === 'user')
        if (stored?.usage?.inputTokens > 0) break
        await sleep(250)
      }
      assert.ok(stored?.usage?.inputTokens > 0, '服务端没有记录用户消息的输入估算')
      assert.equal(typeof stored.usage.costUsd, 'number', '服务端没有按单价折算用户消息费用')
      const liveBubble = page.locator('[data-msg-bubble]').last()
      const liveMeta = liveBubble
        .locator('xpath=ancestor::div[@data-turn-id]')
        .first()
        .locator('[data-user-usage]')
        .first()
      await liveMeta.waitFor({ timeout: 10_000 })
      const liveCostText = await liveMeta.innerText()
      assert.match(
        liveCostText,
        /^(刚刚|\d+ 分钟前|\d+ 小时前|\d{2}:\d{2}) · ~\d+ tok · (?:<)?\$\d/,
        '用户消息下方缺少 token 或金额',
      )
      // 反馈1601#03：金额极小时显示「<$0.0001」，不能四舍五入成 $0.0000。
      assert.ok(!liveCostText.includes('$0.0000'), `用户消息金额显示成了 $0.0000：${liveCostText}`)

      // 预置的小额花费（Host 记录的输入估算）：直接检查行的格式。
      await openSession(page, 'tinycost')
      const tinyMeta = page.locator('[data-turn-id="tc1"] [data-user-usage]').first()
      await tinyMeta.waitFor({ timeout: 5_000 })
      assert.match(
        await tinyMeta.innerText(),
        /· <\$0\.0001$/,
        '用户消息的极小金额没有显示成 <$0.0001',
      )
    })

    desktop('文件夹弹层列出最近目录；浏览对话框首项为上一级，超长名称单行省略（R15 / 反馈1323#09）', async (page) => {
      const longName = 'a-very-long-folder-name-for-truncation-check-0123456789'
      const longDir = path.join(repo, longName)
      mkdirSync(longDir, { recursive: true })
      try {
        await openSession(page, 'long')
        await page.evaluate((dir) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          const hostId = hosts[0]?.id ?? 'local'
          localStorage.setItem('tandem.recentDirs.v1', JSON.stringify({ [hostId]: [dir] }))
        }, longDir)
        const trigger = page.locator(`button[data-tip="${repo}"]`).first()
        await trigger.click()
        const panel = page
          .locator('[data-portal-layer]')
          .filter({ has: page.locator('[data-folder-picker]') })
          .first()
        await panel.waitFor()
        assert.equal(
          await panel.getByText(longName, { exact: false }).count(),
          1,
          '文件夹弹层没有列出最近目录',
        )
        // 反馈1601#01：分组标题/分隔线/行都走 ui/Menu 原语，与其他下拉同一边距，
        // 不再出现手写 border-t 分隔造成的「内部边更厚」。
        assert.equal(await panel.getAttribute('data-portal-layer'), 'menu', '文件夹弹层没有改用 ui/Menu')
        const chrome = await panel.evaluate((el) => {
          const body = el.querySelector('[data-menu-body]')
          const rows = [...el.querySelectorAll('[role="menuitem"]')]
          const label = [...el.querySelectorAll('[role="menu"] div, [role="menu"] > div')].find((n) =>
            (n.textContent ?? '').trim() === '最近',
          )
          return {
            padding: body ? getComputedStyle(body.parentElement).paddingTop : '',
            borderTop: el.querySelectorAll('.border-t').length,
            rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
            labelSize: label ? getComputedStyle(label).fontSize : '',
          }
        })
        assert.equal(chrome.borderTop, 0, '文件夹弹层里仍有手写 border-t 分隔线')
        assert.equal(chrome.padding, '4px', `文件夹弹层内边距不是菜单统一值：${chrome.padding}`)
        assert.equal(chrome.labelSize, '12px', `分组标题字号不是菜单统一值：${chrome.labelSize}`)
        assert.ok(
          chrome.rowHeights.every((height) => height === 26),
          `文件夹弹层的行高不是菜单统一值：${chrome.rowHeights.join('/')}`,
        )
        await panel.getByRole('menuitem', { name: '打开文件夹…' }).click()
        const dialog = page.getByRole('dialog', { name: '打开文件夹' })
        await dialog.waitFor()
        const firstItem = dialog.getByRole('menuitem').first()
        assert.equal((await firstItem.innerText()).trim(), '..', '浏览对话框首项不是上一级目录')
        // 反馈 #7-06：行保持单行省略，只有溢出时才挂全文 title。
        const longRow = dialog.getByRole('menuitem').filter({ hasText: longName.slice(0, 20) }).first()
        await longRow.waitFor({ timeout: 10_000 })
        const label = longRow.locator('span.truncate').first()
        const info = await label.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          title: el.getAttribute('data-tip') ?? el.getAttribute('title'),
          whiteSpace: getComputedStyle(el).whiteSpace,
        }))
        assert.ok(info.scrollWidth > info.clientWidth, '超长文件夹名没有被单行截断')
        assert.equal(info.title, longName, `超长文件夹名缺少全名入口：${info.title}`)
        assert.notEqual(info.whiteSpace, 'normal', '文件夹行发生了换行')
        await page.keyboard.press('Escape')
      } finally {
        rmSync(longDir, { recursive: true, force: true })
      }
    })

    desktop('自动路由偏好点击即时切换且不闪回（R17）', async (page) => {
      const before = await api(base, token, '/api/settings')
      assert.equal(before.modelRouting, undefined, '用例前置：路由设置应为空')
      const dialog = await openSettings(page, '自动路由', 'desktop')
      const group = dialog.getByRole('group', { name: '取向默认' })
      await group.waitFor({ state: 'visible' })
      const clicked = async (label) => {
        const response = page.waitForResponse(
          (res) => res.url().includes('/api/settings') && res.request().method() === 'PUT',
          { timeout: 10_000 },
        )
        await group.getByRole('button', { name: label, exact: true }).click()
        await response
        await page.waitForTimeout(200)
      }

      await page.evaluate(() => {
        window.__routingPreferenceNode = document.querySelector('[data-setting-id="routing.preference"]')
      })
      await clicked('省钱')
      assert.equal(
        await group.getByRole('button', { name: '省钱', exact: true }).getAttribute('aria-pressed'),
        'true',
        '点击省钱后偏好没有保持选中',
      )
      assert.equal(
        await group.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '切换偏好时控件变灰闪烁',
      )
      assert.ok(
        await page.evaluate(
          () =>
            window.__routingPreferenceNode ===
            document.querySelector('[data-setting-id="routing.preference"]'),
        ),
        '保存设置后整页重新挂载',
      )
      const costSaved = await api(base, token, '/api/settings')
      assert.equal(costSaved.modelRouting?.preference, 'cost', '省钱偏好没有落库')

      await clicked('质量优先')
      assert.equal(
        await group.getByRole('button', { name: '质量优先', exact: true }).getAttribute('aria-pressed'),
        'true',
        '点击质量优先后偏好没有保持选中',
      )
      const qualitySaved = await api(base, token, '/api/settings')
      assert.equal(qualitySaved.modelRouting?.preference, 'quality', '质量优先偏好没有落库')

      await clicked('均衡')
      const reset = await api(base, token, '/api/settings')
      assert.equal(reset.modelRouting, undefined, '恢复均衡后设置应回到未配置')
      await closeSettings(page)
    })

    desktop('菜单项只有单行标题，多模型分组下列表可滚动且底部操作可见（#15/#16/#17 R01/R15）', async (page) => {
      await openSession(page, 'many')
      await waitModelReady(page)
      // 主菜单优先显示最近模型；清掉记录让当前分组的全部模型回退显示（滚动与长标签用例）。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      withinViewport(await menu.boundingBox(), DESKTOP, '多模型菜单')
      const model = await menu.evaluate((el) => {
        const footer = el.querySelector('[data-menu-footer]')
        const body = el.querySelector('[data-menu-body]')
        const rows = [...el.querySelectorAll('[role="menuitem"]')]
        const stacked = rows.some((row) =>
          [...row.querySelectorAll('span')].some((span) => {
            const cs = getComputedStyle(span)
            return cs.display === 'flex' && cs.flexDirection === 'column' && cs.display !== 'none'
          }),
        )
        return {
          footerText: footer?.textContent ?? '',
          footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
          bodyScroll: body?.scrollHeight ?? 0,
          bodyClient: body?.clientHeight ?? 0,
          heights: rows.map((row) => row.getBoundingClientRect().height),
          stacked,
        }
      })
      assert.ok(model.heights.every((height) => height <= 32), `菜单项高度 ${model.heights.join(',')}，出现第二行`)
      assert.equal(model.stacked, false, '菜单项里仍有纵向堆叠的说明文字')
      assert.match(model.footerText, /切换账号/, '底部操作缺少「切换账号」')
      assert.match(model.footerText, /管理账号/, '底部操作缺少「管理账号」')
      assert.ok(model.footerBottom <= DESKTOP.height, `底部操作被挤出视口：${model.footerBottom}`)
      assert.ok(model.bodyScroll > model.bodyClient, `模型列表没有独立滚动：${model.bodyScroll}/${model.bodyClient}`)
      // 超长模型名放进 tooltip：宽度按内容自适应、不会每行一个字。
      const longRow = menu.locator('[role="menuitem"]').filter({ hasText: /Many Extra Long/ }).first()
      await longRow.scrollIntoViewIfNeeded()
      await longRow.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ state: 'visible', timeout: 5_000 })
      const tipInfo = await tip.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        return { width: rect.width, text: el.textContent ?? '' }
      })
      assert.ok(tipInfo.width >= 72, `长标签 tooltip 宽度只有 ${tipInfo.width}px`)
      assert.match(tipInfo.text, /many-extra-long-model-name/, 'tooltip 没有显示完整模型 ID')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)

      for (const group of ['分工', '取向']) {
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const routeMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await routeMenu.waitFor()
        assert.match(
          (await routeMenu.locator('[data-menu-footer]').innerText()),
          /原生[\s\S]*分工[\s\S]*取向/,
          '模型菜单底部缺少原生/分工/取向',
        )
        await routeMenu.getByRole('menuitem', { name: new RegExp(`^${group}`) }).hover()
        const sub = page.locator(`[role="menu"][aria-label="${group}"]`).first()
        await sub.waitFor({ state: 'visible', timeout: 5_000 })
        const info = await sub.evaluate((el) => {
          const rows = [...el.querySelectorAll('[role="menuitemradio"]')]
          return {
            heights: rows.map((row) => row.getBoundingClientRect().height),
            stacked: rows.some((row) =>
              [...row.querySelectorAll('span')].some((span) => {
                const cs = getComputedStyle(span)
                return cs.display === 'flex' && cs.flexDirection === 'column' && cs.display !== 'none'
              }),
            ),
          }
        })
        assert.ok(info.heights.every((height) => height <= 32), `${group}菜单项高度 ${info.heights.join(',')}`)
        assert.equal(info.stacked, false, `${group}菜单仍有第二行说明`)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      await page.keyboard.press('Escape')
    })

    desktop('环境条下拉连续切换保持打开（#04 P0）', async (page) => {
      await openSession(page, 'long')
      const host = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      const folder = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      const branch = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-git-branch') }).first()
      const branchPanel = page.locator('[data-portal-layer]').filter({ hasText: '新建分支' }).first()
      const folderPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()

      await branch.click()
      await branchPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await folder.click()
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(
        await folderPanel.isVisible(),
        true,
        '从一个下拉直接切到另一个下拉后，新下拉被旧下拉的关闭事件收起',
      )
      assert.equal(await branchPanel.isVisible().catch(() => false), false, '旧的落点下拉没有关闭')

      await host.click()
      const hostMenu = page.locator('[role="menu"][aria-label="切换主机"]').first()
      await hostMenu.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(await hostMenu.isVisible(), true, '切到主机下拉后弹层又被收起')
      assert.equal(await folderPanel.isVisible().catch(() => false), false, '旧的文件夹下拉没有关闭')

      await branch.click()
      await branchPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(500)
      assert.equal(await branchPanel.isVisible(), true, '连续切换三个下拉后分支列表没有保持打开')
      await page.keyboard.press('Escape')
    })

    desktop('环境条「选择主机」可打开（#11 P0）', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      const host = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      await host.click()
      const menu = page.locator('[role="menu"][aria-label="选择主机"]').first()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(300)
      withinViewport(await menu.boundingBox(), DESKTOP, '选择主机菜单')
      assert.ok((await menu.locator('[role="menuitem"]').count()) >= 1, '选择主机菜单内容异常')
      await page.keyboard.press('Escape')
    })

    desktop('环境条换主机先选文件夹：待定状态、输入禁用、可取消（反馈13#02）', async (page) => {
      await openSession(page, 'long')
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        if (hosts.some((item) => item.id === 'host-second')) return
        const first = hosts[0]
        localStorage.setItem(
          'tandem.hosts.v1',
          JSON.stringify([first, { ...first, id: 'host-second', name: '第二台主机', addedAt: Date.now() + 1 }]),
        )
      })
      const hostsNow = await page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]'))
      if (hostsNow.length < 2) {
        throw new Error('没有造出第二台主机')
      }
      // 注入 localStorage 后必须重载，应用启动时才会把第二台主机连进 runtime。
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => {
        try {
          return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length >= 2
        } catch {
          return false
        }
      }, null, { timeout: 20_000 })
      await openSession(page, 'long')
      const hostPill = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-monitor') }).first()
      const folderPill = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      const textarea = page.locator('[aria-label="消息输入框"]').first()
      const folderPanel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()

      await hostPill.click()
      const menu = page.locator('[role="menu"][aria-label="切换主机"]').first()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      // 反馈14#04：当前主机行尾标「当前」，不要箭头。
      assert.match(
        await menu.locator('[data-host-tag="current"]').innerText(),
        /当前/,
        '当前主机没有「当前」标签',
      )
      await menu.getByRole('menuitem', { name: /第二台主机/ }).click()
      // 不立即切换：文件夹选择自动打开，输入框禁用并提示。
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(300)
      assert.equal(await textarea.getAttribute('aria-disabled'), 'true', '待选文件夹期间输入框没有禁用')
      assert.equal(
        await page.locator('.composer-card').first().getAttribute('data-disabled'),
        'true',
        '待选期间输入框外观没有变暗',
      )
      assert.equal(
        await textarea.getAttribute('data-placeholder'),
        '选择 第二台主机 上的文件夹后继续',
        '输入框占位提示文案不对',
      )
      assert.equal(
        (await hostPill.innerText()).trim(),
        '第二台主机',
        '主机胶囊应只显示目标主机，不要「原主机 → 目标主机」',
      )
      assert.match((await folderPill.innerText()).trim(), /^待选$/, '文件夹胶囊没有精简为「待选」')
      // 打开主机菜单确认当前/待切换两个标签。
      await page.keyboard.press('Escape')
      await hostPill.click()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(
        await menu.locator('[data-host-tag="current"]').innerText(),
        /当前/,
        '待切换时当前主机没有「当前」标签',
      )
      assert.match(
        await menu.locator('[data-host-tag="pending"]').innerText(),
        /待切换/,
        '目标主机没有「待切换」标签',
      )
      await page.keyboard.press('Escape')
      // 取消回到原主机。
      await page.locator('[data-env-pending-cancel="true"]').click()
      await page.waitForTimeout(300)
      assert.equal(await textarea.getAttribute('aria-disabled'), null, '取消后输入框仍然禁用')
      assert.doesNotMatch(await hostPill.innerText(), /第二台主机/, '取消后主机胶囊仍显示新主机')

      // 再选一次，选好文件夹才真正迁移。
      await hostPill.click()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.getByRole('menuitem', { name: /第二台主机/ }).click()
      await folderPanel.waitFor({ state: 'visible', timeout: 5_000 })
      await folderPanel.getByRole('menuitem', { name: '打开文件夹…' }).click()
      const folderDialog = page.getByRole('dialog', { name: '打开文件夹' })
      await folderDialog.waitFor()
      await folderDialog.getByRole('button', { name: '使用并迁移' }).click()
      await page.getByText(/会话已迁移到 第二台主机/).first().waitFor({ timeout: 20_000 })
      await page.waitForFunction(() => window.location.hash.includes('/h/host-second/'), null, { timeout: 20_000 })
      await page.locator('[aria-label="消息输入框"]').first().waitFor({ timeout: 20_000 })
      assert.equal(
        (await page.locator('[aria-label="消息输入框"]').first().getAttribute('aria-disabled')) === 'true',
        false,
        '迁移完成后输入框仍禁用',
      )
      // 还原宿主列表，避免影响后续用例的分组断言。
      await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.id !== 'host-second')))
      })
    })

    desktop('tooltip 按内容宽度换行，不会每行一个字（#01 R15）', async (page) => {
      await openSession(page, 'long')
      const folder = page.locator('main button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-folder-open') }).first()
      await folder.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ state: 'visible', timeout: 5_000 })
      const info = await tip.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          width: rect.width,
          height: rect.height,
          text: (el.textContent ?? '').trim(),
          lineHeight: parseFloat(cs.lineHeight),
        }
      })
      assert.ok(info.text.length > 0, 'tooltip 没有内容')
      assert.ok(info.width >= 72, `tooltip 宽度只有 ${info.width}px，可能退化成每行一个字`)
      assert.ok(info.height <= info.lineHeight * 4 + 4, `tooltip 异常高（${info.height}px），文字可能逐字换行`)
      await page.mouse.move(DESKTOP.width / 2, DESKTOP.height / 2)
    })

    desktop('轮次固定：命中区 ≥24px、一个视图两用（Alt/点击只看已固定）、阅读区不重排（#12/反馈6追加/反馈8#04）', async (page) => {
      await openSession(page, 'long')
      const hit = page.locator('.turn-hit')
      await hit.hover()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(700)
      const readOrder = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.turn-item')]
            .filter((el) => {
              const cs = getComputedStyle(el)
              return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
            .map((el) => el.dataset.turnNo),
        )
      const readPinnedLayout = () =>
        page.evaluate(() => {
          const clip = document.querySelector('.turn-clip')?.getBoundingClientRect()
          const first = [...document.querySelectorAll('.turn-item')]
            .filter((el) => {
              const cs = getComputedStyle(el)
              return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0]
          if (!clip || !first) return null
          return { gap: first.getBoundingClientRect().y - clip.y, height: clip.height }
        })
      const beforeOrder = await readOrder()
      const beforeClipHeight = (await readPinnedLayout())?.height ?? 0
      const beforeScroll = await page.locator('.chat-scroll').evaluate((el) => el.scrollTop)
      const target = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.turn-item')].filter((el) => {
          const cs = getComputedStyle(el)
          return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
        })
        const row = rows.find((el) => (el.querySelector('.turn-item-n')?.textContent ?? '').trim() === '30') ?? rows[0]
        const pin = row?.querySelector('.turn-item-p')
        if (!pin) return null
        const rect = pin.getBoundingClientRect()
        return {
          turn: row.querySelector('.turn-item-n')?.textContent ?? '',
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
        }
      })
      assert.ok(target, '找不到可固定的轮次')
      assert.ok(target.width >= 24 && target.height >= 24, `图钉命中区只有 ${target.width}×${target.height}`)
      await page.mouse.move(target.x, target.y)
      await page.waitForTimeout(250)
      await page.mouse.click(target.x, target.y)

      // 反馈8#04：固定状态只在原位显示小图钉。
      await page.waitForFunction(
        (turn) => document.querySelector(`[data-turn-no="${turn}"]`)?.getAttribute('data-pinned') === 'true',
        target.turn,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      const afterOrder = await readOrder()
      assert.deepEqual(afterOrder, beforeOrder, `固定后阅读区顺序变了：${beforeOrder} → ${afterOrder}`)
      assert.equal(
        await page.locator('.chat-scroll').evaluate((el) => el.scrollTop),
        beforeScroll,
        '固定轮次后对话滚动位置变了',
      )
      assert.ok(
        (await page.locator('[aria-label="已固定到轮次大纲"]').count()) >= 1,
        '消息流里没有图钉标记',
      )

      // 大纲下方的小字提示：按住 Alt 只看已固定，松开恢复全部。
      const hint = page.getByTestId('turn-pinned-hint')
      await hint.waitFor({ state: 'visible', timeout: 5_000 })
      assert.match(await hint.innerText(), /只看已固定/, '大纲下方没有 Alt 提示')
      await hint.hover()
      await page.waitForTimeout(250)
      assert.equal(
        await page.locator('.turn-rail').getAttribute('data-open'),
        'true',
        '指针移到大纲下方提示行时面板收起（反馈8#04 的空白间隙问题）',
      )
      // 输入框聚焦时单独按 Alt/Option 也要生效（用户常边打字边看大纲）。
      await page.locator('[aria-label="消息输入框"]').first().focus()
      await page.keyboard.down('Alt')
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(600)
      const filtered = await readOrder()
      assert.deepEqual(filtered, [target.turn], `Alt 只看已固定时显示了多余的轮次：${filtered}`)
      const pinnedLayout = await readPinnedLayout()
      assert.ok(pinnedLayout, '只看已固定时读不到大纲行')
      assert.ok(
        pinnedLayout.gap <= 24,
        `只看已固定时第一项离列表顶部 ${Math.round(pinnedLayout.gap)}px，应从列表顶部排列`,
      )
      assert.ok(
        pinnedLayout.height <= 70 && pinnedLayout.height < beforeClipHeight,
        `只看已固定时列表没有收缩到内容高度：${pinnedLayout.height}（全部轮次时 ${beforeClipHeight}）`,
      )
      await page.keyboard.up('Alt')
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') !== 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.ok((await readOrder()).length > 1, '松开 Alt 后没有恢复全部轮次')
      assert.ok((await readOrder()).includes(target.turn), '恢复全部后找不到刚固定的轮次')

      // 点提示行 = 鼠标/触屏也能切换；再点恢复全部。
      await hint.click()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') === 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.deepEqual(await readOrder(), [target.turn], '点击提示行没有切到只看已固定')
      const clickedLayout = await readPinnedLayout()
      assert.ok(clickedLayout, '点击提示行后读不到大纲行')
      assert.ok(
        clickedLayout.gap <= 24,
        `点击切到只看已固定后第一项离列表顶部 ${Math.round(clickedLayout.gap)}px，应从列表顶部排列`,
      )
      await hint.click()
      await page.waitForFunction(
        () => document.querySelector('.turn-rail')?.getAttribute('data-pinned-only') !== 'true',
        null,
        { timeout: 5_000 },
      )
      await page.waitForTimeout(500)
      assert.ok((await readOrder()).length > 1, '再次点击提示行没有恢复全部轮次')

      // 取消固定：原位图钉消失，提示行回到「暂无」。
      const row = page.locator(`.turn-item[data-turn-no="${target.turn}"]`)
      const rowBox = await row.boundingBox()
      assert.ok(rowBox, '找不到刚固定的行')
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
      await page.waitForTimeout(250)
      const pin = row.locator('.turn-item-p')
      const pinBox = await pin.boundingBox()
      assert.ok(pinBox, '找不到行尾图钉')
      await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2)
      await page.waitForFunction(
        (turn) => document.querySelector(`[data-turn-no="${turn}"]`)?.getAttribute('data-pinned') !== 'true',
        target.turn,
        { timeout: 5_000 },
      )
      assert.match(await hint.innerText(), /暂无/, '取消固定后提示行没有更新')
    })

    desktop('焦点环只在键盘导航时出现（自动聚焦的输入框没有橙色描边）', async (page) => {
      await openSession(page, 'long')
      const trigger = page.locator(`button[data-tip="${repo}"]`).first()
      await trigger.click()
      const panel = page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
      await panel.waitFor()
      await panel.getByRole('menuitem', { name: '打开文件夹…' }).click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      const input = dialog.locator('input[aria-label="筛选文件夹或输入路径"]')
      await input.waitFor()
      assert.equal(
        await input.evaluate((el) => el === document.activeElement),
        true,
        '文件夹路径输入框没有自动聚焦',
      )
      const pickerRing = await input.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { style: cs.outlineStyle, color: cs.outlineColor }
      })
      assert.equal(
        pickerRing.style,
        'none',
        `鼠标打开文件夹选择器后仍有焦点描边：${JSON.stringify(pickerRing)}`,
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' }).catch(() => {})

      // 命令面板同样由鼠标点开、程序化聚焦：不应出现橙色框。
      await page.locator('aside').getByRole('button', { name: /^搜索/ }).first().click()
      const paletteInput = page.locator('input[aria-label="搜索会话、命令与设置"]')
      await paletteInput.waitFor()
      const paletteRing = await paletteInput.evaluate((el) => getComputedStyle(el).outlineStyle)
      assert.equal(paletteRing, 'none', '命令面板搜索框出现了焦点描边')
      await page.keyboard.press('Escape')

      // 键盘 Tab 导航时焦点环必须仍然可见，且是中性色而不是强调橙。
      await page.locator('aside').getByRole('button', { name: '设置', exact: true }).focus()
      await page.keyboard.press('Tab')
      const keyboardRing = await page.evaluate(() => {
        const el = document.activeElement
        if (!el) return null
        const cs = getComputedStyle(el)
        return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, tag: el.tagName }
      })
      assert.ok(keyboardRing, '没有可聚焦元素')
      assert.equal(keyboardRing.style, 'solid', `键盘焦点环未显示：${JSON.stringify(keyboardRing)}`)
      assert.equal(keyboardRing.width, '2px', `键盘焦点环宽度异常：${JSON.stringify(keyboardRing)}`)
      const rgb = keyboardRing.color.match(/(\d+),\s*(\d+),\s*(\d+)/)
      assert.ok(rgb, `无法解析焦点环颜色：${keyboardRing.color}`)
      const [r, g, b] = rgb.slice(1, 4).map(Number)
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 30, `焦点环不是中性色：${keyboardRing.color}`)
    })

    desktop('粘贴一次同一张图片只生成一个附件', async (page) => {
      await openSession(page, 'long')
      const textarea = page.locator('[aria-label="消息输入框"]')
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
      const folderTrigger = page.locator(`button[data-tip="${repo}"]`).first()
      await folderTrigger.click()
      const popover = page.locator('[role="menu"]:has(> .popover-panel)').first()
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
      // 反馈 #15：设置单价只在行尾悬停时出现，模型行保持单行。
      const row = menu.locator('[role="menuitem"]').filter({ hasText: 'mock-1' }).first()
      await row.hover()
      const setup = row.getByRole('button', { name: /设置单价/ }).first()
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

    desktop('模型菜单：内置价格表命中时显示「参考价」（R08）', async (page) => {
      await openSession(page, 'priced')
      await waitModelReady(page)
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await menu.waitFor()
      // 反馈 #15：单价放 tooltip；悬停模型行后读取标准 tooltip。
      const row = menu.locator('[role="menuitem"]').filter({ hasText: 'O3' }).first()
      await row.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 10_000 })
      assert.match(await tip.innerText(), /参考价 · 输入 \$2 · 输出 \$8/, '内置参考价没有标注来源')
    })

    desktop('账号/分组倍率叠加并在模型菜单显示计算方式（#04）', async (page) => {
      const account = await api(wsBase, token, '/api/workstation/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: '倍率回归账号',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'reg-key-multiplier',
          models: ['gpt-4o-mini'],
          defaultModel: 'gpt-4o-mini',
          multiplier: 0.5,
          groups: [
            {
              name: '低价渠道',
              apiKey: 'reg-key-multiplier-group',
              models: ['gpt-4o-mini'],
              defaultModel: 'gpt-4o-mini',
              multiplier: 0.8,
            },
          ],
        }),
      })
      const groupId = account.groups?.[0]?.id
      assert.ok(groupId, '倍率账号没有创建分组')
      let session
      try {
        session = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: repo,
            profileId: account.id,
            groupId,
            model: 'gpt-4o-mini',
            permissionMode: 'bypassPermissions',
            title: '倍率回归会话',
          }),
        })
        // 账号是通过 API 新建的：刷新一次让客户端拉到最新账号列表。
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page
          .locator('[aria-label="消息输入框"], button:has-text("新会话")')
          .first()
          .waitFor({ timeout: 20_000 })
        const clientHostId = await page.evaluate(
          () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
        )
        await page.evaluate(
          (hash) => {
            window.location.hash = hash
          },
          `#/h/${clientHostId}/s/${session.id}`,
        )
        await page.waitForFunction(
          (id) => window.location.hash.includes(`/s/${id}`),
          session.id,
          { timeout: 10_000 },
        )
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        // 主菜单优先显示最近使用模型；清掉记录让当前分组的模型回退显示（价格 tooltip 用例）。
        await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
        await page.locator('button[aria-label^="选择模型"]').first().click()
        const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
        await menu.waitFor()
        const row = menu.locator('[role="menuitem"]').filter({ hasText: /4o/i }).first()
        await row.hover()
        const tip = page.locator('#tandem-tooltip[data-open]')
        await tip.waitFor({ timeout: 10_000 })
        const text = await tip.innerText()
        assert.match(
          text,
          /官方 \$0\.15\/M × 账号 0\.5 × 分组 0\.8 = \$0\.06\/M/,
          `模型菜单没有显示倍率计算方式：${text}`,
        )
        assert.match(text, /输出 \$0\.6\/M → \$0\.24\/M/, `模型菜单没有显示输出最终价：${text}`)
        assert.match(text, /缓存 \$0\.03/, `模型菜单没有显示最终缓存价：${text}`)
        await page.keyboard.press('Escape')
      } finally {
        if (session?.id) {
          await api(base, token, `/api/sessions/${session.id}?deleteWorktree=false`, {
            method: 'DELETE',
          }).catch(() => {})
        }
        await api(wsBase, token, `/api/workstation/profiles/${account.id}`, { method: 'DELETE' }).catch(() => {})
      }
    })

    desktop('新会话页环境条显示当前分支名而不是「分支」占位词', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      await page.locator('button:has(svg.lucide-folder-open)').first().click()
      await page
        .locator('[data-portal-layer]')
        .filter({ has: page.locator('[data-folder-picker]') })
        .first()
        .getByRole('menuitem', { name: '打开文件夹…' })
        .click()
      const dialog = page.getByRole('dialog', { name: '打开文件夹' })
      await dialog.waitFor()
      const input = dialog.getByRole('textbox', { name: '筛选文件夹或输入路径' })
      await input.waitFor()
      await input.fill(repo)
      await input.press('Enter')
      const branchButton = page.locator('button[data-tip="创建会话后可切换分支"]').first()
      await branchButton.waitFor()
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('button[data-tip="创建会话后可切换分支"]')].some(
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
      const link = page.locator('a[data-tip^="打开 D:/"]').first()
      await link.click()
      await page.getByText('windows drive file').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.locator('[data-tip*="D:/repo/demo.ts"]').count() > 0, true, '预览路径未归一化为 D:/repo/demo.ts')
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

    desktop('改动审阅：文件列表贴顶、diff 紧跟、自动换行无横向截断（R14）', async (page) => {
      await openSession(page, 'long')
      await page.getByRole('button', { name: '改动审阅' }).click()
      const panel = page.getByRole('complementary').filter({ hasText: '改动审阅' }).first()
      await panel.getByTestId('changes-file-list').waitFor({ timeout: 10_000 })
      await panel.getByText('hello.ts', { exact: true }).click()
      const diff = panel.getByTestId('changes-diff').locator('.chat-diff').first()
      await diff.waitFor({ timeout: 10_000 })

      const panelBox = await panel.boundingBox()
      const diffBox = await diff.boundingBox()
      assert.ok(panelBox && diffBox, '改动审阅面板或 diff 不可见')
      assert.ok(
        diffBox.y - panelBox.y < 320,
        `diff 仍从面板中段开始：diff y=${Math.round(diffBox.y)} panel y=${Math.round(panelBox.y)}`,
      )
      assert.equal(await panel.locator('[data-panel-bar]').count(), 1, '改动审阅没有统一面板工具条')
      assert.ok((await panel.locator('[data-panel-body]').count()) >= 1, '改动审阅没有统一内容区')

      const body = diff.locator('.chat-diff-body')
      const before = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
      assert.ok(before.sw > before.cw + 1, `长行没有产生横向溢出：${before.sw} / ${before.cw}`)
      await diff.getByTestId('diff-wrap-toggle').click()
      const after = await diff.evaluate((el) => {
        const body = el.querySelector('.chat-diff-body')
        return {
          wrap: el.getAttribute('data-wrap'),
          sw: body?.scrollWidth ?? 0,
          cw: body?.clientWidth ?? 0,
        }
      })
      assert.equal(after.wrap, 'true', '自动换行开关没有生效')
      assert.ok(after.sw <= after.cw + 1, `自动换行后仍横向溢出：${after.sw} > ${after.cw}`)
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

    desktop('编辑消息保持气泡宽度并随内容自适应（反馈11#07 R45）', async (page) => {
      await openSession(page, 'long')
      const rows = page.locator('.msg-row[data-turn-id][data-actions="true"]')
      const row = rows.nth(Math.min(3, (await rows.count()) - 1))
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      const before = await row.evaluate((el) => {
        const bubble = el.querySelector('.msg-group .bg-surface-2')
        return bubble ? Math.round(bubble.getBoundingClientRect().width) : 0
      })
      assert.ok(before > 0, '找不到用户气泡')
      await row.getByRole('button', { name: '编辑并重发' }).click()
      const editor = row.locator('textarea[aria-label="编辑并重发"]')
      await editor.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(120)
      const after = await row.evaluate((el) => {
        const box = el.querySelector('.bg-surface-2')
        return box ? Math.round(box.getBoundingClientRect().width) : 0
      })
      assert.ok(Math.abs(after - before) <= 2, `编辑前后宽度 ${before} → ${after}px`)
      const oneLine = await editor.evaluate((el) => el.getBoundingClientRect().height)
      await editor.fill(`${await editor.inputValue()}\n第二行\n第三行`)
      await page.waitForTimeout(150)
      const height = await editor.evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(height > oneLine + 20, `编辑框高度没有随内容增长：${oneLine} → ${height}`)
      await page.screenshot({ path: '/tmp/fb11-after/07.png' })
      await page.keyboard.press('Escape')
      await editor.waitFor({ state: 'hidden', timeout: 5_000 })
      const restored = await row.evaluate((el) => {
        const bubble = el.querySelector('.msg-group .bg-surface-2')
        return bubble ? Math.round(bubble.getBoundingClientRect().width) : 0
      })
      assert.ok(Math.abs(restored - before) <= 2, `取消编辑后宽度 ${restored} ≠ ${before}`)
    })

    desktop('回退对话框精简为单行引用/单选/一行警告（反馈11#08 R46）', async (page) => {
      await openSession(page, 'nockpt')
      const row = page.locator('[data-turn-id="n3"]').first()
      await row.hover()
      await row.getByRole('button', { name: '回退到此处' }).click()
      const dialog = page.getByRole('dialog', { name: '回退到此处' })
      await dialog.waitFor({ state: 'visible' })
      await page.waitForTimeout(300)
      const box = await dialog.boundingBox()
      assert.ok(box && box.height < 380, `回退对话框高度 ${box?.height}，没有精简`)
      const text = await dialog.innerText()
      assert.equal(
        (text.match(/没有可回退的文件改动/g) ?? []).length,
        1,
        '回退对话框仍重复说明文件改动',
      )
      const radios = dialog.getByRole('radio')
      assert.equal(await radios.count(), 3, '恢复范围不是三个单选项')
      for (let i = 0; i < 3; i++) {
        const r = await radios.nth(i).boundingBox()
        assert.ok(r && r.height <= 34, `第 ${i + 1} 个恢复范围高度 ${r?.height}，不是单行`)
      }
      const warning = dialog.locator('.text-warning').last()
      const w = await warning.boundingBox()
      assert.ok(w && w.height <= 32, `警告占到 ${w?.height}px，不是一行`)
      await page.screenshot({ path: '/tmp/fb11-after/08.png' })
    })

    desktop('工具行调高且工具-only 行收紧空白（反馈11#04 R47）', async (page) => {
      await openSession(page, 'secrets')
      const tool = page.locator('.tool-row').first()
      await tool.waitFor({ state: 'visible', timeout: 10_000 })
      const height = await tool.evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(height >= 32, `工具行高度 ${height}px，仍显扁平`)
      const margin = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.className = 'msg-row'
        probe.dataset.toolOnly = 'true'
        document.body.appendChild(probe)
        const value = parseFloat(getComputedStyle(probe).marginTop)
        probe.remove()
        return value
      })
      assert.ok(margin < 0, `工具-only 行没有收紧上下间距（${margin}px）`)
      await page.screenshot({ path: '/tmp/fb11-after/04.png' })

      const dialog = await openSettings(page, '外观', 'desktop')
      const preview = dialog.locator('[data-setting-id="appearance.theme"] button').first()
      const previewHeight = await preview
        .locator('div')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(previewHeight >= 90, `主题预览卡只有 ${previewHeight}px 高`)
      await page.keyboard.press('Escape')
    })

    desktop('会话信息面板不再提供删除会话（反馈11#02 R05）', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await panel.getByText('删除会话', { exact: true }).count(), 0, '会话信息面板仍有删除会话')
      await page.screenshot({ path: '/tmp/fb11-after/02.png' })
      const row = page.locator('[data-session-id="long"]').first()
      await row.hover()
      await row.getByRole('button', { name: '会话操作' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor()
      assert.ok(
        (await menu.getByRole('menuitem', { name: '删除', exact: true }).count()) === 1,
        '侧栏删除会话入口不见了',
      )
      await page.keyboard.press('Escape')
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
      const textarea = page.locator('[aria-label="消息输入框"]')
      await textarea.fill('第一段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.getAttribute('data-value'), '', '已在首页再点「新会话」没有清空草稿')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '消息输入框', '清空后没有聚焦输入框')
      await textarea.fill('第二段草稿')
      await page.locator('aside').getByRole('button', { name: /^新会话/ }).click()
      await page.waitForTimeout(500)
      assert.equal(await textarea.getAttribute('data-value'), '', '第二次点击「新会话」没有清空草稿')
    })

    desktop('新会话默认带上工作目录且双击发送只创建一次', async (page) => {
      await waitModelReady(page)
      await page.waitForFunction(
        () => {
          const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => /^\//.test(b.getAttribute('data-tip') ?? ''))
          return !!trigger
        },
        null,
        { timeout: 10_000 },
      )
      const folderTitle = await page.evaluate(() => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => /^\//.test(b.getAttribute('data-tip') ?? ''))
        return trigger?.getAttribute('data-tip') ?? ''
      })
      assert.ok(folderTitle.includes(path.sep), `默认工作目录为空：${folderTitle}`)

      let posts = 0
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/sessions')) posts += 1
      })
      await page.locator('[aria-label="消息输入框"]').fill('新会话双击发送回归')
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

    // 反馈2102：截图落到 /tmp/fix-2102b/，用于修复前后对比（深色 + 浅色，1912×914）。
    const shotDir = '/tmp/fix-2102b'
    const withViewport = async (page, fn) => {
      await page.setViewportSize({ width: 1912, height: 914 })
      try {
        await fn()
      } finally {
        await page.setViewportSize(DESKTOP)
      }
    }
    const setTheme = async (page, theme) => {
      await page.evaluate((next) => localStorage.setItem('tandem.theme.v1', next), theme)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
    }
    const clientHostIdOf = (page) =>
      page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null)

    desktop('反馈2102#05：新会话页选的账号/模型按主机记住，开会话后与刷新后仍保留，已不存在的模型回落默认', async (page) => {
      const chipLabel = () =>
        page.evaluate(() => document.querySelector('button[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? '')
      const expectChip = async (pattern, message) => {
        const ok = await page
          .waitForFunction(
            (source) => new RegExp(source, 'i').test(document.querySelector('button[aria-label^="选择模型"]')?.getAttribute('aria-label') ?? ''),
            pattern,
            { timeout: 5_000 },
          )
          .then(() => true, () => false)
        assert.ok(ok, `${message}（当前芯片：${await chipLabel()}）`)
      }
      const theme = await page.evaluate(() => localStorage.getItem('tandem.theme.v1'))
      await page.evaluate(() => localStorage.removeItem('tandem.newSessionPick.v1'))
      try {
        await page.evaluate(() => (window.location.hash = '#/'))
        await waitModelReady(page)
        const defaultLabel = await chipLabel()
        await page.locator('button[aria-label^="选择模型"]').first().click()
        await page.getByRole('menuitem', { name: /^切换账号/ }).hover()
        await page.getByRole('menuitem', { name: /^主力账号/ }).first().hover()
        await page.getByRole('menuitem', { name: /^生产/ }).first().hover()
        await page.getByRole('menuitem', { name: /^mock-2/ }).first().click()
        await expectChip('mock[ -]2', '选择模型后芯片没有更新')
        await page.locator('[aria-label="消息输入框"]').fill('反馈2102#05 模型记忆回归')
        await page.waitForFunction(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送消息')
          return !!b && !b.disabled
        })
        await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/sessions')),
          page.getByRole('button', { name: '发送消息' }).click(),
        ])
        await page.waitForFunction(() => window.location.hash.includes('/s/'), null, { timeout: 15_000 })
        await page.evaluate(() => (window.location.hash = '#/'))
        await waitModelReady(page)

        await withViewport(page, async () => {
          for (const next of ['dark', 'light']) {
            await setTheme(page, next)
            await waitModelReady(page)
            await page.screenshot({ path: path.join(shotDir, `05-新会话芯片-${next}.png`) })
          }
        })
        await expectChip('mock[ -]2', '开会话后回到新会话页，模型没有记住')

        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        await expectChip('mock[ -]2', '刷新后新会话页的模型没有记住')

        const hostId = await clientHostIdOf(page)
        await page.evaluate(
          (id) =>
            localStorage.setItem(
              'tandem.newSessionPick.v1',
              JSON.stringify({ [id]: { profileId: 'p-main', groupId: 'g1', model: '已删除的模型' } }),
            ),
          hostId,
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
        await waitModelReady(page)
        await page.waitForTimeout(300)
        assert.equal(await chipLabel(), defaultLabel, '记住的模型已不存在时没有回落到默认模型')
        assert.equal(await page.getByText('先选择账号与模型').count(), 0, '回落默认时不应报错')
      } finally {
        await page.evaluate((prev) => {
          if (prev) localStorage.setItem('tandem.theme.v1', prev)
          else localStorage.removeItem('tandem.theme.v1')
          localStorage.removeItem('tandem.newSessionPick.v1')
        }, theme)
      }
    })

    desktop('反馈2102#04：顶栏右侧不出现两个同图标的按钮', async (page) => {
      const panelToggle = page.locator('button[aria-label="切换信息面板"]')
      const ensurePanelOpen = async () => {
        if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click()
        await page.locator('button[aria-label="切换信息面板"][aria-pressed="true"]').waitFor({ timeout: 5_000 })
      }
      await openSession(page, 'links')
      const wasOpen = (await panelToggle.getAttribute('aria-pressed')) === 'true'
      try {
        await ensurePanelOpen()
        await withViewport(page, async () => {
          for (const next of ['dark', 'light']) {
            await setTheme(page, next)
            await openSession(page, 'links')
            await ensurePanelOpen()
            await page.screenshot({ path: path.join(shotDir, `04-顶栏-${next}.png`) })
          }
        })
        const dups = await page.evaluate(() => {
          const header = document.querySelector('header.relative.z-20')
          const seen = new Map()
          for (const button of header ? header.querySelectorAll('button') : []) {
            if (button.offsetParent === null) continue
            const icon = [...(button.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-'))
            if (!icon) continue
            const label = button.getAttribute('aria-label') || button.textContent?.trim() || ''
            seen.set(icon, [...(seen.get(icon) ?? []), label])
          }
          return [...seen].filter(([, labels]) => labels.length > 1)
        })
        assert.deepEqual(dups, [], `顶栏有同图标的按钮：${JSON.stringify(dups)}`)
      } finally {
        const pressed = (await panelToggle.getAttribute('aria-pressed')) === 'true'
        if (pressed !== wasOpen) await panelToggle.click().catch(() => {})
      }
    })

    desktop('反馈2102#08：环境条主机触发器用显示器图标，与文件夹触发器区分开', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 10_000 })
      await withViewport(page, async () => {
        for (const next of ['dark', 'light']) {
          await setTheme(page, next)
          await page.locator('[data-env-bar] button').first().waitFor({ timeout: 10_000 })
          await page.screenshot({ path: path.join(shotDir, `08-环境条-${next}.png`) })
        }
      })
      const hostTrigger = page.locator('[data-env-bar] button').first()
      assert.equal(await hostTrigger.locator('svg.lucide-monitor').count(), 1, '主机触发器不是显示器图标')
      assert.equal(await hostTrigger.locator('svg.lucide-folder, svg.lucide-folder-open').count(), 0, '主机触发器仍是文件夹图标')
      assert.equal(await page.locator('[data-env-bar] button:has(svg.lucide-folder-open)').count(), 1, '文件夹触发器缺少文件夹图标')
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

    desktop('会话信息面板左缘拖宽、记住宽度并可双击复位（#03 R01）', async (page) => {
      await page.evaluate(() => localStorage.removeItem('tandem.rightPanelWidth.v1'))
      await openSession(page, 'long')
      const toggle = page.getByRole('button', { name: '切换信息面板' }).first()
      const handle = page.getByRole('separator', { name: '调整会话信息面板宽度' })
      if (!(await handle.isVisible().catch(() => false))) await toggle.click()
      await handle.waitFor({ state: 'visible', timeout: 5_000 })
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      const before = (await panel.boundingBox())?.width ?? 0
      assert.ok(before >= 280 && before <= 600, `信息面板默认宽度异常：${before}`)
      const box = await handle.boundingBox()
      assert.ok(box, '找不到信息面板拖动手柄')
      await page.mouse.move(box.x + box.width / 2, box.y + 200)
      await page.mouse.down()
      await page.mouse.move(box.x - 140, box.y + 200, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      const widened = (await panel.boundingBox())?.width ?? 0
      assert.ok(widened >= 400, `向左拖动后信息面板未变宽：${widened}`)
      const stored = Number(await page.evaluate(() => localStorage.getItem('tandem.rightPanelWidth.v1')))
      assert.ok(stored >= 400 && stored <= 600, `信息面板宽度没有记住：${stored}`)
      // 关闭再打开仍使用记住的宽度。
      await toggle.click()
      await handle.waitFor({ state: 'hidden', timeout: 5_000 })
      await toggle.click()
      await handle.waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(200)
      const reopened = (await panel.boundingBox())?.width ?? 0
      assert.ok(Math.abs(reopened - stored) <= 2, `重开后面板宽度 ${reopened}，记住的是 ${stored}`)
      // 双击复位默认 300。
      await handle.dblclick()
      await page.waitForTimeout(200)
      const reset = (await panel.boundingBox())?.width ?? 0
      assert.ok(Math.abs(reset - 300) <= 2, `双击后没有恢复默认宽度：${reset}`)
    })

    desktop('会话信息面板：空分组默认隐藏、⋯ 菜单可显式显示（反馈9#06 / 10#03 R14）', async (page) => {
      const empty = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-main',
          groupId: 'g1',
          model: 'mock-1',
          permissionMode: 'default',
          title: '空分组回归',
        }),
      })
      await gotoSession(page, empty.id)
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      if (!(await panel.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      // 没有数据的分组与上下文卡片默认不渲染。
      for (const text of ['暂无待办', '暂无用量', '暂无记忆', '暂无上下文数据']) {
        assert.equal(await panel.getByText(text, { exact: true }).count(), 0, `空分组默认显示：${text}`)
      }
      assert.equal(await panel.locator('[data-group="context"]').count(), 0, '新会话无数据时仍显示上下文卡')
      assert.equal(await panel.locator('[data-group="details"]').count(), 1, '详情分组应始终显示')

      // 反馈10#03：空分组由顶部 ⋯ 菜单逐个勾选。
      const groupMenu = page.locator('[role="menu"][aria-label="显示分组"]').first()
      const toggleEmptyGroup = async (name) => {
        if (!(await groupMenu.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: '自定义信息面板' }).click()
          await groupMenu.waitFor({ timeout: 5_000 })
        }
        await groupMenu.getByRole('menuitemcheckbox', { name, exact: true }).click()
      }
      await toggleEmptyGroup('待办')
      await toggleEmptyGroup('用量')
      await toggleEmptyGroup('记忆')
      await page.keyboard.press('Escape')
      await panel.getByText('暂无待办', { exact: true }).waitFor({ timeout: 5_000 })
      await panel.getByText('暂无用量', { exact: true }).waitFor({ timeout: 5_000 })
      await panel.getByText('暂无记忆', { exact: false }).waitFor({ timeout: 5_000 })
      assert.equal(await panel.getByRole('button', { name: '编辑' }).count(), 1, '空记忆卡缺少编辑入口')
      const prefs = JSON.parse(await page.evaluate(() => localStorage.getItem('tandem.rightPanel.v1') ?? '{}'))
      for (const id of ['todos', 'usage', 'memory']) {
        assert.ok(prefs.shown?.includes(id), `「${id}」没有记住显示空分组`)
      }
      await toggleEmptyGroup('待办')
      await toggleEmptyGroup('用量')
      await toggleEmptyGroup('记忆')
      await page.keyboard.press('Escape')

      // 有数据后出现：刚创建的空会话没有用量；发送一条后用量分组淡入。
      assert.equal(await panel.locator('[data-group="usage"]').count(), 0, '无用量时仍显示用量卡')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('让用量分组出现')
      await input.press('Enter')
      await panel.locator('[data-group="usage"]').waitFor({ state: 'visible', timeout: 20_000 })
      assert.equal(await panel.getByText('暂无用量', { exact: true }).count(), 0, '有数据后仍显示空状态')
      assert.match(await panel.locator('[data-group="usage"]').innerText(), /输入[\s\S]*输出/, '用量卡出现后没有数据')
    })

    desktop('账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉（反馈10#04 #05 #06 R43/R42/R37）', async (page) => {
      const created = { id: 'p-versioned' }
      const dialog = await openSettings(page, '账号与模型')
      await dialog.getByRole('button', { name: '刷新账号' }).click()
      await page.waitForTimeout(600)
      await dialog.getByRole('button', { name: /编辑 多代模型账号/ }).first().click()
      await page.waitForTimeout(400)
      await page.getByRole('button', { name: /编辑分组 aws/ }).first().click()
      await page.waitForTimeout(300)
      const keyBox = dialog.locator('.setting-row').filter({ hasText: '分组 Key' }).first()
      const keyText = await keyBox.innerText()
      assert.match(keyText, /已保存 · ••••ghij/, `Key 没有显示掩码占位：${keyText}`)
      assert.match(keyText, /更换 Key/, '缺少「更换 Key」入口')
      assert.equal(
        await keyBox.locator('input[type="password"]').count(),
        0,
        '已有 Key 时仍渲染可编辑的密码输入框',
      )
      await page.screenshot({ path: '/tmp/fb10-after/05.png' })

      // 拉取模型：默认只勾选每个系列的最新一代（反馈10#04）。
      await page.getByRole('button', { name: /自动拉取模型/ }).click()
      await page.waitForTimeout(1200)
      const checked = await page.evaluate(() =>
        [...document.querySelectorAll('label')]
          .filter((label) => label.querySelector('input[type="checkbox"]')?.checked)
          .map((label) => label.innerText.replace(/\s*默认.*/, '').trim())
          .filter((text) => text.startsWith('claude-')),
      )
      assert.deepEqual(
        checked,
        ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
        `拉取后默认勾选不对：${checked.join(', ')}`,
      )
      await page.screenshot({ path: '/tmp/fb10-after/04.png' })

      // 改分组倍率后保存，Key 不能被清空。
      await dialog.locator('[id^="group-multiplier-"]').fill('0.5')
      await page.getByRole('button', { name: '保存分组' }).click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /下一步/ }).click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /保存账号/ }).click()
      await page.waitForTimeout(1200)
      const stored = (await api(wsBase, token, '/api/workstation/profiles')).profiles.find((p) => p.id === created.id)
      assert.equal(stored?.groups?.[0]?.apiKeyMasked, 'sk-r****ghij', '编辑后 Key 被清空或改写')
      assert.equal(stored?.groups?.[0]?.multiplier, 0.5, '分组倍率没有保存')

      // 原生下拉全部迁移：页面里不能出现 select / datalist / input[list]。
      const native = await page.evaluate(() => ({
        select: document.querySelectorAll('select').length,
        datalist: document.querySelectorAll('datalist').length,
        list: document.querySelectorAll('input[list]').length,
      }))
      assert.deepEqual(native, { select: 0, datalist: 0, list: 0 }, `仍有浏览器自带下拉：${JSON.stringify(native)}`)
      // 单价模型输入是可输入的候选列表（ui/Combobox）。
      await dialog.getByRole('button', { name: /编辑 多代模型账号/ }).first().click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: /下一步/ }).click()
      await page.waitForTimeout(400)
      const priceInput = page.getByRole('combobox', { name: '自定义单价模型' })
      await priceInput.focus()
      await page.waitForTimeout(400)
      assert.equal(await priceInput.getAttribute('aria-expanded'), 'true', '单价候选列表没有打开')
      assert.ok((await page.getByRole('menuitem').count()) > 0, '单价候选列表为空')
      await page.screenshot({ path: '/tmp/fb10-after/06.png' })
      await page.keyboard.press('Escape')
      await closeSettings(page)
    })

    desktop('菜单行文字行高不被裁切（反馈10#07 R44）', async (page) => {
      await openSession(page, 'long')
      await page.locator('button[aria-label^="选择模型"]').first().click()
      const modelMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
      await modelMenu.waitFor()
      await modelMenu.getByRole('menuitem', { name: /切换账号|切换分组|全部模型/ }).first().hover()
      const submenu = page.locator('[role="menu"][aria-label="切换账号"]').first()
      await submenu.waitFor({ timeout: 5_000 })
      const clipped = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menuitemradio"]')]
        return rows
          .map((el) => {
            const text = el.querySelector('span.truncate') ?? el
            return {
              label: (text.textContent ?? '').trim(),
              scroll: text.scrollHeight,
              client: text.clientHeight,
              lineHeight: getComputedStyle(text).lineHeight,
            }
          })
          .filter((row) => row.label && row.scroll > row.client + 1)
      })
      assert.deepEqual(clipped, [], `菜单/选项卡文字被裁切：${JSON.stringify(clipped)}`)
      await page.screenshot({ path: '/tmp/fb10-after/07.png' })
      await page.keyboard.press('Escape')
    })

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

    mobile('手机收件箱审批卡任务描述默认两行，点按展开全文（R15）', async (page) => {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.getByRole('button', { name: /收件箱/ }).first().click().catch(() => {})
      const card = page
        .getByTestId('inbox-pending')
        .filter({ hasText: '在 taskcli 项目里运行' })
        .first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      const title = card.locator('button[aria-expanded]').first()
      const before = await title.boundingBox()
      const label = await title.getAttribute('data-tip')
      assert.ok(
        label?.includes('点击展开全文') || label?.includes('等待审批'),
        '审批卡任务描述没有全文提示',
      )
      await title.click()
      const after = await title.boundingBox()
      assert.ok(before && after, '审批卡任务描述不可见')
      assert.ok(after.height > before.height + 6, `任务描述没有展开：${before.height} → ${after.height}`)
      assert.equal(await title.getAttribute('aria-expanded'), 'true')
    })

    mobile('手机反馈工具栏移入顶部，不遮住底部环境条', async (page) => {
      await openSession(page, 'long')
      await page.keyboard.press('Control+Shift+F')
      const toolbar = page.getByRole('region', { name: '反馈模式工具栏' })
      await toolbar.waitFor({ state: 'visible', timeout: 8_000 })
      const bar = await toolbar.boundingBox()
      const envTrigger = page.locator(`button[data-tip="${repo}"]`).first()
      await envTrigger.waitFor({ state: 'visible', timeout: 5_000 })
      const env = await envTrigger.boundingBox()
      assert.ok(bar && env, '反馈工具栏或环境条不可见')
      assert.ok(bar.y < 120, `反馈工具栏仍在底部：y=${Math.round(bar.y)}`)
      assert.ok(bar.y + bar.height <= env.y, '反馈工具栏遮住了环境条')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

    mobile('手机环境条不越界、容器透明、触控 44px', async (page) => {
      await openSession(page, 'long')
      const info = await page.evaluate((cwd) => {
        const trigger = [...document.querySelectorAll('button[data-tip]')].find((b) => b.getAttribute('data-tip') === cwd)
        const wrap = trigger?.closest('.flex-wrap')
        if (!wrap) return null
        const rect = wrap.getBoundingClientRect()
        const children = [...wrap.children].map((child) => {
          const r = child.getBoundingClientRect()
          return { width: r.width, right: r.right, height: r.height }
        })
        return {
          bg: getComputedStyle(wrap).backgroundColor,
          overflowX: getComputedStyle(wrap).overflowX,
          text: wrap.innerText,
          scrollWidth: wrap.scrollWidth,
          clientWidth: wrap.clientWidth,
          left: rect.left,
          right: rect.right,
          children,
        }
      }, repo)
      assert.ok(info, '找不到手机环境条')
      assert.match(info.bg, /rgba?\(0, 0, 0, 0\)|transparent/, `手机环境条容器不透明：${info.bg}`)
      assert.ok(['auto', 'scroll'].includes(info.overflowX), `手机环境条不可横向滚动：${info.overflowX}`)
      assert.ok(info.scrollWidth >= info.clientWidth, '手机环境条滚动宽度异常')
      assert.ok(info.right <= MOBILE.width + 1, `环境条右缘 ${info.right} 越界`)
      assert.ok(info.text.includes(path.basename(repo)), `手机环境条看不到文件夹名：${info.text}`)
      assert.match(info.text, /main/, '手机环境条看不到分支名')
      assert.match(info.text, /Worktree/, '手机环境条 Worktree 开关没有文字')
      for (const child of info.children) {
        assert.ok(child.width > 0, '环境条存在不可见子项')
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
      const editor = dialog.locator('[data-setting-id="prompts.editor"]').first()
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
      await page.locator(`button[data-tip="${repo}"]`).first().click()
      const popover = page.locator('[role="menu"]:has(> .popover-panel)').first()
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

    small('360 小屏：内联审批卡的拒绝/允许按钮触控 44px（反馈14#07）', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor()
      for (const selector of ['[data-permission-deny]', '[data-permission-allow]']) {
        const button = card.locator(selector).first()
        const box = await button.boundingBox()
        assert.ok(box, `${selector} 不可见`)
        assert.ok(box.height >= 43, `${selector} 高度 ${Math.round(box.height)}px`)
        const cardBox = await card.boundingBox()
        assert.ok(
          box.x >= cardBox.x - 1 && box.x + box.width <= cardBox.x + cardBox.width + 1,
          `${selector} 超出卡片`,
        )
      }
    })

    desktop('反馈12#03/#05：子代理卡片定位子会话、层级不用子/孙、可跳转只读视图', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = demo.scenarios.find((item) => item.id === 'subagents')
      const [mainId, childId] = scenario.sessionIds
      await openSession(page, mainId)

      const taskRow = page.locator('.tool-row').filter({ hasText: '子代理' }).first()
      await taskRow.waitFor({ timeout: 10_000 })
      // 反馈2108#02：点子代理行直接进入子代理会话；没有关联到子会话时不会跳转，等待即超时。
      await taskRow.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.ok((await page.locator('[data-turn-id]').count()) > 0, '子代理只读视图没有消息')
      assert.ok((await page.locator('nav[aria-label="会话列表"]').count()) === 1, '只读视图破坏侧栏')
      // 子会话里的 Task 卡片继续跳到下一层（面包屑三层）。
      const nested = page.locator('.tool-row').filter({ hasText: '子代理' }).first()
      await nested.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '竞品文案' }).waitFor({ timeout: 10_000 })
      const crumbText = await page.locator('[data-agent-breadcrumb]').innerText()
      assert.match(crumbText, /价格页前端/, `面包屑缺少上一级：${crumbText}`)
      assert.match(crumbText, /竞品文案/, `面包屑缺少当前层：${crumbText}`)
      await page.locator('button[data-tip^="返回主会话"]').first().click()
      await page.locator('[data-turn-id]').first().waitFor()

      // 右侧代理树：统一叫子代理，用缩进 + 竖引导线，不出现「孙」。
      if (!(await page.locator('[data-group="agents"]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      const agents = page.locator('[data-group="agents"]')
      await agents.waitFor({ timeout: 10_000 })
      const treeText = await agents.innerText()
      assert.equal(/孙代理|孙\b/.test(treeText), false, `代理树仍出现孙代理：${treeText}`)
      assert.ok((await agents.locator('.agent-guide').count()) >= 1, '代理树没有层级引导线')
      await agents.getByRole('button').filter({ hasText: '价格页前端' }).first().click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.ok(childId, '演示场景缺少子代理会话')
    })

    desktop('反馈2108#02：子代理工具行点击直接进入子代理会话，不展开卡片', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const taskRow = page.locator('button.tool-row').filter({ hasText: '子代理' }).first()
      await taskRow.waitFor({ timeout: 10_000 })
      await taskRow.click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.equal(await page.locator('.tool-detail').count(), 0, '点击子代理行仍展开了卡片')
      assert.equal(await taskRow.getAttribute('aria-expanded'), null, '子代理行仍是展开按钮')
      await page.locator('button[data-tip^="返回主会话"]').first().click()
      await page.locator('[data-turn-id]').first().waitFor()
    })

    desktop('反馈2108#03：点会话图子代理节点进入子代理会话', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const [mainId, childId] = demo.scenarios.find((item) => item.id === 'subagents').sessionIds
      await openSession(page, mainId)
      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      await graph.locator(`div[data-kind="subagent-turn"][data-subagent-id="${childId}"]`).first().click()
      await page.locator('[data-agent-breadcrumb] [aria-current="page"]').filter({ hasText: '价格页前端' }).waitFor({ timeout: 10_000 })
      assert.match(await page.locator('[data-agent-breadcrumb]').innerText(), /只读/, '子代理节点没有打开只读子会话')
    })

    desktop('反馈2108#04：分叉会话的「查看」回到来源会话', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const [mainId, , , forkId] = demo.scenarios.find((item) => item.id === 'subagents').sessionIds
      await openSession(page, mainId)
      // 从会话图点分叉节点打开分叉会话（不经过地址栏的链接），再点横幅「查看」。
      await page.locator('[data-session-graph] div[data-kind="fork"]').first().click()
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), forkId, { timeout: 10_000 })
      await page.getByRole('button', { name: '查看', exact: true }).click()
      await page.waitForFunction((id) => window.location.hash.includes(`/s/${id}`), mainId, { timeout: 10_000 })
      await page.getByRole('button', { name: '查看', exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
    })

    desktop('反馈12#06/#07：会话信息无顶栏、分组可收起并记住', async (page) => {
      let demo = await api(base, token, '/api/demo')
      if (!demo.active) demo = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const mainId = demo.scenarios.find((item) => item.id === 'subagents').sessionIds[0]
      await openSession(page, mainId)
      const panel = page.locator('aside').filter({ has: page.locator('[data-group]') }).first()
      if (!(await panel.count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      await page.locator('[data-group]').first().waitFor({ timeout: 10_000 })
      assert.equal(await panel.getByText('会话信息', { exact: true }).count(), 0, '面板仍有顶栏标题')
      assert.equal(await panel.getByRole('button', { name: '关闭信息面板' }).count(), 0, '面板仍有 × 按钮')
      assert.ok(
        (await page.getByRole('button', { name: '自定义信息面板' }).count()) > 0,
        '顶栏没有自定义信息面板按钮',
      )

      const details = page.locator('[data-group="details"]')
      await details.waitFor()
      const before = await details.boundingBox()
      await details.locator('[data-card-toggle]').click()
      await page.waitForTimeout(250)
      assert.equal(await details.getAttribute('data-collapsed'), 'true', '分组没有收起')
      const after = await details.boundingBox()
      assert.ok(after.height < before.height - 10, `收起后高度未变化：${before.height} → ${after.height}`)
      const stored = await page.evaluate(() => localStorage.getItem('tandem.rightPanelCollapsed.v1') ?? '')
      assert.match(stored, /details/, '收起状态没有记住')
      await page.reload()
      await openSession(page, mainId)
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).click()
      }
      await page.locator('[data-group="details"]').waitFor({ timeout: 10_000 })
      assert.equal(
        await page.locator('[data-group="details"]').getAttribute('data-collapsed'),
        'true',
        '重开后收起状态丢失',
      )
    })

    desktop('反馈16#06：会话信息面板与卡片宽度不随展开/折叠变化', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      await page.locator('[data-group]').first().waitFor({ timeout: 10_000 })
      const measure = () =>
        page.evaluate(() => {
          const aside = [...document.querySelectorAll('aside')].find((el) =>
            el.querySelector('[data-group]'),
          )
          return {
            aside: aside ? aside.getBoundingClientRect().width : 0,
            cards: [...document.querySelectorAll('[data-group]')].map((el) => ({
              id: el.getAttribute('data-group'),
              width: el.getBoundingClientRect().width,
            })),
          }
        })
      const sameWidth = (a, b, label) => {
        assert.ok(Math.abs(a.aside - b.aside) <= 0.5, `${label}：面板宽度变化 ${a.aside} → ${b.aside}`)
        assert.equal(a.cards.length, b.cards.length, `${label}：卡片数量变化`)
        for (let i = 0; i < a.cards.length; i += 1) {
          assert.equal(a.cards[i].id, b.cards[i].id, `${label}：卡片顺序变化`)
          assert.ok(
            Math.abs(a.cards[i].width - b.cards[i].width) <= 0.5,
            `${label}：卡片 ${a.cards[i].id} 宽度变化 ${a.cards[i].width} → ${b.cards[i].width}`,
          )
        }
      }

      const before = await measure()
      const toggles = page.locator('[data-group] [data-card-toggle]')
      const count = await toggles.count()
      assert.ok(count > 0, '会话信息面板没有可收起的分组')
      for (let i = 0; i < count; i += 1) {
        await toggles.nth(i).click()
        await page.waitForTimeout(220)
        sameWidth(before, await measure(), `第 ${i + 1} 张卡片收起`)
        await toggles.nth(i).click()
        await page.waitForTimeout(220)
        sameWidth(before, await measure(), `第 ${i + 1} 张卡片展开`)
      }

    })

    desktop('反馈16#07/#08：卡片折叠箭头与拖动手柄在标题右侧且常显', async (page) => {
      // 前序用例可能把 details 卡折叠状态写进偏好；本用例要求展开态，先清掉再打开。
      await page.evaluate(() => localStorage.removeItem('tandem.rightPanelCollapsed.v1'))
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const card = page.locator('[data-group="details"]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      if ((await card.getAttribute('data-collapsed')) === 'true') {
        await card.locator('[data-card-toggle]').first().click()
        await page.waitForTimeout(220)
      }
      const title = card.locator('[data-card-toggle] h3').first()
      const toggle = card.locator('[data-card-toggle]').first()
      const chevron = toggle.locator('svg').last()
      const handle = card.locator('[aria-label^="拖动排序"]').first()
      const [titleBox, chevronBox, handleBox] = await Promise.all([
        title.boundingBox(),
        chevron.boundingBox(),
        handle.boundingBox(),
      ])
      assert.ok(titleBox && chevronBox && handleBox, '标题/折叠箭头/拖动手柄缺少布局')
      assert.ok(
        chevronBox.x >= titleBox.x + titleBox.width - 1,
        `折叠箭头不在标题文字右侧：title ${titleBox.x}+${titleBox.width}, chevron ${chevronBox.x}`,
      )
      assert.ok(
        handleBox.x > chevronBox.x,
        `拖动手柄不在标题行右侧：chevron ${chevronBox.x}, handle ${handleBox.x}`,
      )
      assert.equal(
        await chevron.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '折叠箭头不是常显',
      )
      assert.equal(
        await handle.evaluate((el) => getComputedStyle(el).opacity),
        '1',
        '拖动手柄只有 hover 才显示',
      )
      // 点击标题行（非箭头/手柄）仍可折叠。
      await title.click()
      await page.waitForTimeout(220)
      assert.equal(await card.getAttribute('data-collapsed'), 'true', '点击标题行没有折叠')
      await title.click()
      await page.waitForTimeout(220)
      assert.equal(await card.getAttribute('data-collapsed'), null, '再次点击标题行没有展开')
    })

    desktop('反馈16#03/#09：会话图高度按轮数自适应并封顶', async (page) => {
      const graphHeight = async () => {
        const el = page.locator('[data-group="graph"] [data-graph-height]').first()
        await el.waitFor({ state: 'attached', timeout: 10_000 })
        return Number(await el.getAttribute('data-graph-height'))
      }
      await openSession(page, 'nockpt')
      assert.equal(await graphHeight(), 84, '2 轮时会话图高度不是最小高度（3 行）')

      await openSession(page, 'turns4')
      assert.equal(await graphHeight(), 112, '4 轮时会话图高度没有随轮数增长')

      await openSession(page, 'huge')
      assert.equal(await graphHeight(), 336, '30 轮以上会话图高度没有封顶到 12 行 / 336px')
      const scrollable = await page.evaluate(() => {
        const el = document.querySelector('[data-group="graph"] [data-graph-height]')
        return el ? { client: el.clientHeight, scroll: el.scrollHeight } : null
      })
      assert.ok(scrollable && scrollable.scroll > scrollable.client, '封顶后会话图内部不能滚动')
    })

    desktop('反馈12#08：侧栏项目与会话缩进收紧、标题左对齐', async (page) => {
      await openSession(page, 'long')
      const project = page
        .locator('[data-project-row]')
        .filter({ has: page.locator('[data-session-row]') })
        .first()
      await project.waitFor({ timeout: 10_000 })
      const projectPad = await project
        .locator('button')
        .first()
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft))
      assert.ok(projectPad <= 8, `项目行缩进 ${projectPad}px，超过 8px`)
      const metrics = await project.evaluate((el) => {
        const projectTitle = [...el.querySelectorAll('button span')].find(
          (span) => span.className.includes('truncate') && span.textContent?.trim(),
        )
        const row = el.querySelector('[data-session-row]')
        // 标题只在溢出时才挂 data-tip，取标题文本节点（truncate span）更稳。
        const sessionTitle = [...(row?.querySelectorAll('span') ?? [])].find(
          (span) => span.className.includes('truncate') && span.textContent?.trim(),
        )
        const box = (node) => (node ? node.getBoundingClientRect().left : null)
        return { project: box(projectTitle), session: box(sessionTitle) }
      })
      assert.ok(metrics.project != null && metrics.session != null, '找不到项目/会话标题')
      assert.ok(
        Math.abs(metrics.project - metrics.session) <= 2,
        `会话标题与项目标题没有左对齐：${metrics.project} vs ${metrics.session}`,
      )
    })

    desktop('反馈14#01/#02：所有菜单首次与再次打开，位置与尺寸稳定（15 帧 ≤1px）', async (page) => {
      // 真实按下/松开鼠标：触发器按下缩放会带着 Radix 定位的面板一起动（R52 复发根因）。
      const sampleOnce = async (trigger) => {
        const box = await trigger.boundingBox()
        assert.ok(box, '菜单触发器不可见')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(120)
        await page.mouse.down()
        const frames = await page.evaluate(async () => {
          const out = []
          for (let i = 0; i < 15; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const panels = [...document.querySelectorAll('.popover-panel')].filter(
              (el) => el.getClientRects().length > 0,
            )
            const panel = panels[panels.length - 1]
            if (!panel) continue
            const rect = panel.getBoundingClientRect()
            out.push([rect.x, rect.y, rect.width, rect.height])
          }
          return out
        })
        await page.mouse.up()
        const after = await page.evaluate(async () => {
          const out = []
          for (let i = 0; i < 20; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const panels = [...document.querySelectorAll('.popover-panel')].filter(
              (el) => el.getClientRects().length > 0,
            )
            const panel = panels[panels.length - 1]
            if (!panel) continue
            const rect = panel.getBoundingClientRect()
            out.push([rect.x, rect.y, rect.width, rect.height])
          }
          return out
        })
        return [...frames, ...after]
      }
      const assertStable = (frames, label) => {
        assert.ok(frames.length >= 8, `${label} 打开后采样帧数不足：${frames.length}`)
        const spread = (index) =>
          Math.max(...frames.map((frame) => frame[index])) -
          Math.min(...frames.map((frame) => frame[index]))
        const [dx, dy, dw, dh] = [spread(0), spread(1), spread(2), spread(3)]
        assert.ok(
          dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1,
          `${label} 打开时抖动：位置 ${dx.toFixed(1)}×${dy.toFixed(1)}px，尺寸 ${dw.toFixed(1)}×${dh.toFixed(1)}px`,
        )
      }
      const checkMenu = async (trigger, label) => {
        assertStable(await sampleOnce(trigger), `${label}（首次）`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(280)
        assertStable(await sampleOnce(trigger), `${label}（再次）`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }

      // 新会话页输入框底栏。
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.waitForTimeout(600)
      const newComposer = page.locator('[aria-label="消息输入框"]').first()
      await newComposer.waitFor({ timeout: 10_000 })
      await checkMenu(page.locator('button[aria-label^="选择模型"]').first(), '模型芯片（新会话页）')

      // 会话页：输入框菜单、环境条三个胶囊、窗口 ⋯ 菜单、权限模式。
      await openSession(page, 'long')
      await checkMenu(page.locator('button[aria-label^="选择模型"]').first(), '模型芯片')
      await checkMenu(page.locator('button[aria-label^="权限模式"]').first(), '权限模式')
      const envTriggers = page.locator('[data-env-bar] button[aria-haspopup]')
      const envCount = await envTriggers.count()
      assert.ok(envCount >= 3, `环境条弹层触发器只有 ${envCount} 个`)
      await checkMenu(envTriggers.nth(0), '主机胶囊')
      await checkMenu(envTriggers.nth(1), '文件夹胶囊')
      await checkMenu(envTriggers.nth(2), '分支胶囊')
      await checkMenu(page.locator('button[aria-label="更多"]').first(), '窗口 ⋯ 菜单')

      // 设置里的下拉（共享 MenuSelect）。
      await page.getByRole('button', { name: '设置', exact: true }).last().click()
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible', timeout: 10_000 })
      await settings.locator('[data-settings-page="permissions"]').click()
      await page.waitForTimeout(300)
      let select = settings.locator('button[aria-label="工具"]').first()
      if ((await select.count()) === 0) select = settings.locator('button[aria-haspopup="menu"]').first()
      assert.ok((await select.count()) > 0, '设置页没有下拉菜单')
      await checkMenu(select, '设置下拉')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
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

    desktop('反馈14#07：审批是对话流里的一条消息，样式参考 Claude Code Desktop', async (page) => {
      await openSession(page, 'approve')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      // 卡片在对话流里（随消息滚动），不在输入框上方停靠。
      assert.ok(await card.evaluate((el) => !!el.closest('.chat-scroll')), '审批卡没有渲染在对话流里')
      assert.equal(
        await page.locator('[data-composer-anchor] .permission-card').count(),
        0,
        '审批卡仍停靠在输入框上方',
      )
      const row = page.locator('[data-message-id="ap2"]').first()
      const rowBox = await row.boundingBox()
      const cardBox = await card.boundingBox()
      assert.ok(rowBox && cardBox && cardBox.y >= rowBox.y, '审批卡不在触发它的工具调用之后')
      const text = await card.innerText()
      assert.match(text, /允许运行/)
      assert.match(text, /npm test/)
      assert.match(text, /批准后本条命令会立即执行/)
      // 不再有编号列表与大代码块，只有两个动作按钮 + 更多。
      assert.equal(await card.locator('[role="radiogroup"], [role="radio"]').count(), 0, '审批卡仍是编号列表')
      assert.equal(await card.locator('pre, .code-block').count(), 0, '审批卡里还有大代码块')
      assert.equal(await card.locator('[data-permission-deny]').count(), 1, '缺少拒绝按钮')
      assert.equal(await card.locator('[data-permission-allow]').count(), 1, '缺少允许一次按钮')
      assert.match(await card.locator('[data-permission-allow]').innerText(), /Ctrl/)
      // 输入框保持可用。
      const composer = page.locator('[aria-label="消息输入框"]').first()
      assert.ok(await composer.isEnabled(), '有待审批时输入框被禁用')
      // 更多菜单：本会话总是允许 / 添加为规则。
      await card.getByRole('button', { name: '更多' }).click()
      const menu = page.locator('[role="menu"]').last()
      await menu.waitFor({ timeout: 5_000 })
      const menuText = await menu.innerText()
      for (const item of ['本会话总是允许', '添加为规则']) {
        assert.ok(menuText.includes(item), `更多菜单缺少「${item}」：${menuText}`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      // Ctrl+Enter（焦点在空输入框）允许一次，卡片收成一行结果留在流里。
      await composer.click()
      await page.keyboard.press('Control+Enter')
      const result = page.locator('[data-permission-result]').first()
      await result.waitFor({ timeout: 10_000 })
      const resultText = await result.innerText()
      assert.match(resultText, /已允许/)
      assert.match(resultText, /npm test/)
      assert.equal(await page.locator('.permission-card').count(), 0, '允许后审批卡没有收起')
      assert.ok(await result.evaluate((el) => !!el.closest('.chat-scroll')), '审批结果不在对话流里')
    })

    desktop('反馈14#07：Esc 拒绝、发送消息视为拒绝并说明', async (page) => {
      await openSession(page, 'danger')
      const card = page.locator('.permission-card').first()
      await card.waitFor({ timeout: 10_000 })
      const composer = page.locator('[aria-label="消息输入框"]').first()
      await composer.click()
      await page.keyboard.press('Escape')
      const result = page.locator('[data-permission-result]').first()
      await result.waitFor({ timeout: 10_000 })
      assert.match(await result.innerText(), /已拒绝/)
      assert.equal(await page.locator('.permission-card').count(), 0, 'Esc 后审批卡没有收起')

      await openSession(page, 'learn')
      const learnCard = page.locator('.permission-card').first()
      await learnCard.waitFor({ timeout: 10_000 })
      await composer.fill('先别跑，改成 dry-run')
      await composer.press('Enter')
      const learnResult = page.locator('[data-permission-result]').first()
      await learnResult.waitFor({ timeout: 10_000 })
      assert.match(await learnResult.innerText(), /已拒绝/)
      await page.getByText('先别跑，改成 dry-run').first().waitFor({ timeout: 10_000 })
    })

    small('手机长按用户消息打开操作菜单', async (page) => {
      await openSession(page, 'long')
      const bubble = page.locator('.msg-group [data-msg-bubble]').last()
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

    desktop('评测：对比表字号 ≥12px、时间中文化、轨迹与并排可开', async (page) => {
      const dialog = await openSettings(page, '评测', 'desktop')
      await dialog.getByText('回归用例 A').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      const text = await dialog.innerText()
      assert.ok(!/\b(AM|PM)\b/.test(text), '运行时间仍是 12 小时制英文格式')
      // 徽标是 P05 允许的 11px（U3-B 描边标签），表格正文/数据仍要求 ≥12px。
      const minFont = await dialog.evaluate((el) => {
        const nodes = [...el.querySelectorAll('tbody td *')]
          .filter((n) => (n.textContent ?? '').trim())
          .filter((n) => !n.closest('[data-badge]'))
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
      await panel.locator('[data-tip="手机 390×844"]').click()
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
      const textarea = page.locator('[aria-label="消息输入框"]')
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
      await page.locator('[aria-label="消息输入框"]').fill('INBOX_MULTI')
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

      // 右侧独立箭头只负责展开；行主体点击打开会话并定位到该回合。
      await group.first().getByTestId('aggregate-toggle').click()
      const details = group.first().getByTestId('inbox-history-details')
      await details.waitFor({ state: 'visible', timeout: 5_000 })
      const detailText = await details.innerText()
      assert.equal(
        (detailText.match(/已允许 · Bash/g) ?? []).length,
        2,
        `明细条数不对：${detailText}`,
      )
      assert.match(detailText, /打开会话/, '展开明细后没有打开会话入口')

      // 明细里的命令也可点：跳到会话中对应的工具卡并定位。
      const firstDetail = details.getByTestId('aggregate-detail').first()
      await firstDetail.click()
      await page.waitForFunction(() => window.location.hash.includes('/s/inboxmulti'), null, {
        timeout: 15_000,
      })
      await page.locator('[data-tool-use-id]').first().waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后工具卡仍被高亮')
      assert.equal(
        await page.locator('.tool-card, [data-tool-use-id]').first().isVisible(),
        true,
        '跳转后没有看到工具卡',
      )

      // 重新打开收件箱，点击行主体：打开会话（而不是展开明细）。
      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const groupAgain = dialog
        .getByTestId('inbox-history-group')
        .filter({ hasText: '收件箱聚合用例' })
        .filter({ hasText: '回合完成' })
        .first()
      await groupAgain.waitFor({ state: 'visible', timeout: 10_000 })
      await groupAgain.getByTestId('aggregate-open').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/inboxmulti'), null, {
        timeout: 15_000,
      })
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

    desktop('设置分组：6 组、合并页与高级折叠', async (page) => {
      const dialog = await openSettings(page, '通用', 'desktop')
      const nav = dialog.locator('nav').first()
      for (const group of ['基础', '模型与账号', '权限与安全', 'Agent 与自动化', '外观与辅助', '高级']) {
        assert.equal(
          await nav.locator(`[data-settings-group] > button`).filter({ hasText: group }).count(),
          1,
          `设置导航缺少分组「${group}」`,
        )
      }
      for (const pageName of ['用量与预算', 'Agent 能力', '分享']) {
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
      await page.locator('[aria-label="消息输入框"]').first().waitFor({ timeout: 20_000 })
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

    desktop('反馈2156#02：打开会话后重新加载，未读点不再出现', async (page) => {
      const row = (id) => page.locator(`[data-session-row][data-session-id="${id}"]`)
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
      await row('unreadopen').waitFor({ state: 'visible', timeout: 15_000 })
      assert.equal(
        await row('unreadopen').locator('[data-unread-dot="true"]').count(),
        1,
        '未读会话缺少未读点',
      )
      await row('unreadopen').locator('[data-session-open="true"]').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/unreadopen'), null, {
        timeout: 10_000,
      })
      await row('unreadopen').locator('[data-unread-dot="true"]').waitFor({
        state: 'detached',
        timeout: 10_000,
      })
      // 切到别的会话再重新加载：路由不再自动打开 unreadopen，能验证服务端已读是否落库。
      await openSession(page, 'long')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await row('unreadopen').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(800)
      assert.equal(
        await row('unreadopen').locator('[data-unread-dot="true"]').count(),
        0,
        '重新加载后未读点又出现了（已读没有写回服务端）',
      )
    })

    checks.push({
      name: '侧栏按主机分组显示全部会话，无主机切换按钮；离线仍可浏览（#02）',
      viewport: 'desktop',
      // 独立 context：本用例会临时添加第二台主机，不影响其他用例。
      context: 'win32',
      fn: async (page) => {
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
        const firstName = await page.evaluate(
          ({ base, token }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            const first = hosts[0]
            const second = {
              ...first,
              id: 'host-second',
              name: '第二台主机',
              addedAt: Date.now() + 1,
            }
            localStorage.setItem('tandem.hosts.v1', JSON.stringify([first, second]))
            return first?.name ?? '本机'
          },
          { base, token },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        const hostGroups = page.locator('[data-host-group]')
        await hostGroups.first().waitFor({ state: 'visible', timeout: 20_000 })
        await page.waitForTimeout(600)

        // 反馈6#02：去掉「本机 ⌄」主机切换按钮，会话列表一次显示所有主机。
        assert.equal(
          await page.getByRole('button', { name: '切换主机' }).count(),
          0,
          '侧栏仍存在主机切换按钮',
        )
        assert.equal(await hostGroups.count(), 2, '会话列表没有按两台主机分组')
        const headings = await hostGroups.allInnerTexts()
        assert.match(headings[0] ?? '', new RegExp(firstName), `第一台主机分组标题不对：${headings[0]}`)
        assert.match(headings[1] ?? '', /第二台主机/, `第二台主机分组标题不对：${headings[1]}`)
        assert.equal(
          await page.locator('[data-host-group] [data-project-row]').count() > 0,
          true,
          '主机分组下没有项目分组',
        )

        // 离线：分组标题标出离线状态，缓存的会话仍可浏览。
        await page.evaluate(() => window.dispatchEvent(new Event('offline')))
        await page.getByText('离线', { exact: true }).first().waitFor({ timeout: 5_000 })
        await page
          .locator('[data-session-row][data-session-id="long"]')
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 })
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await page.waitForTimeout(300)

        // 筛选菜单里保留「按主机筛选」。
        await page.getByRole('button', { name: '筛选会话' }).click()
        await page.getByRole('menuitem', { name: '主机' }).click()
        const sub = page.locator('[aria-label="按主机筛选"]')
        await sub.waitFor({ state: 'visible', timeout: 5_000 })
        const subText = await sub.innerText()
        assert.match(subText, /全部主机/, '筛选菜单缺少全部主机')
        assert.match(subText, /第二台主机/, '筛选菜单缺少按主机筛选的选项')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
      },
    })

    desktop('全文搜索：命中片段、打开会话并定位消息', async (page) => {
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
        () => {
          const el = document.querySelector('[data-message-id="s2"]')
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        null,
        { timeout: 12_000 },
      )
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '搜索跳转后消息仍被高亮')
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
      await paneB.locator('[aria-label="消息输入框"]').fill('分屏 B 测试')
      await paneB.locator('[aria-label="消息输入框"]').press('Enter')
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
      await paneA.locator('[aria-label="消息输入框"]').fill('分屏 A 测试')
      await paneA.locator('[aria-label="消息输入框"]').press('Enter')
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
      await page.locator('aside').getByRole('button', { name: /^任务看板/ }).first().click()
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
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: /^选择模型：自动/ }).first().waitFor({ timeout: 15_000 })

      const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
      const sendTurn = async (text, expected) => {
        const before = (await sessionOf()).messages.length
        await page.locator('[aria-label="消息输入框"]').fill(text)
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

      // 菜单展示参考单价与「自动」项；清掉最近模型记录，让菜单回退列出当前分组全部模型。
      await page.evaluate(() => localStorage.removeItem('tandem.recentModels.v1'))
      await page.getByRole('button', { name: /^选择模型：/ }).first().click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuText = await menu.innerText()
      assert.match(menuText, /自动/, '模型菜单缺少「自动」')
      // 反馈 #15：单价放在行 tooltip 里，行本身只显示单行模型名。
      // 先等异步单价读入（tooltip/隐藏说明里出现价格），再悬停读取标准 tooltip。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="menu"]')].some((m) =>
            (m.textContent ?? '').includes('输入 $0.1'),
          ),
        null,
        { timeout: 10_000 },
      )
      const routeRow = menu.getByRole('menuitem', { name: /Route Mini/ }).first()
      await routeRow.hover()
      const priceTip = page.locator('#tandem-tooltip[data-open]')
      await priceTip.waitFor({ timeout: 5_000 })
      const priceText = await priceTip.innerText()
      assert.match(priceText, /输入 \$0\.1 · 输出 \$0\.2/, '模型菜单缺少参考单价')
      assert.match(priceText, /缓存 \$0\.05/, '模型菜单缺少缓存命中价')
      await page.keyboard.press('Escape')
    })

      desktop('分工路由：原生不注入且 Task 可用、分工关闭零派发、取向省钱整单交执行者、分工积极协作、确认卡与学到的偏好', async (page) => {
        const shotsDir = '/tmp/route2-shots'
        mkdirSync(shotsDir, { recursive: true })
        const divisionSettings = {
          preference: 'balanced',
          candidates: [
            { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
            { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
            { profileId: 'p-route', model: 'route-kimi', tier: 'balanced' },
            { profileId: 'p-route', model: 'route-power', tier: 'power' },
          ],
          division: {
            planner: { profileId: 'p-route', model: 'route-power', tier: 'power' },
            executor: { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
            domains: [
              { profileId: 'p-route', model: 'route-kimi', domain: 'ui', minComplexity: 35, note: '前端强项' },
            ],
            planThreshold: 35,
            confirm: 'never',
          },
        }
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ resumeOnRestart: 'auto', modelRouting: divisionSettings }),
        })
        const session = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: repo,
            profileId: 'p-route',
            model: 'route-power',
            permissionMode: 'bypassPermissions',
            title: '多代理协作回归',
          }),
        })
        assert.equal(session.delegation, 'less', '新会话分工默认适度')
        assert.equal(session.routeBias, undefined, '新会话取向未设置时跟随全局设置')

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
        await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
        await page.getByRole('button', { name: /^选择模型：/ }).first().waitFor({ timeout: 15_000 })
        await page.getByRole('button', { name: /^选择模型：/ }).first().click()
        const modelMenu = page.getByRole('menu')
        await modelMenu.waitFor()
        const modelMenuText = await modelMenu.innerText()
        assert.match(modelMenuText, /自动/, '模型菜单缺少自动')
        await page.screenshot({ path: path.join(shotsDir, 'model-menu-division.png') })
        await page.keyboard.press('Escape')

        const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
        const childrenOf = async () => {
          const list = await api(base, token, '/api/sessions')
          return list.filter((item) => item.parentId === session.id)
        }
        const sendTurn = async (text, expected) => {
          const before = (await sessionOf()).messages.length
          await page.locator('[aria-label="消息输入框"]').fill(text)
          await page.getByRole('button', { name: '发送消息' }).click()
          await waitUntil(`分工回复：${text.slice(0, 8)}`, async () => {
            const current = await sessionOf()
            return (
              current.status === 'idle' &&
              current.messages.length > before &&
              JSON.stringify(current.messages).includes(expected)
            )
          })
          return sessionOf()
        }
        const planCount = async () => (await sessionOf()).messages.filter((m) => m.routePlan).length
        // 1601#04：选择即写入会话（后续消息都用），没有「记住为会话偏好」。
        const pickRoute = async (group, label) => {
          await page.getByRole('button', { name: /^选择模型：/ }).first().click()
          const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
          await menu.waitFor()
          await menu.getByRole('menuitem', { name: new RegExp(`^${group}`) }).hover()
          const sub = page.locator(`[role="menu"][aria-label="${group}"]`).first()
          await sub.waitFor({ state: 'visible', timeout: 5_000 })
          await sub.getByRole('menuitemradio', { name: label, exact: true }).click()
          await page.waitForTimeout(200)
        }
        const pickNative = async (expectChecked = false) => {
          await page.getByRole('button', { name: /^选择模型：/ }).first().click()
          const menu = page.locator('[role="menu"][aria-label="选择模型"]').first()
          await menu.waitFor()
          const box = menu.getByRole('menuitemcheckbox', { name: '原生' })
          await box.waitFor()
          if (expectChecked) {
            // 刷新后会话摘要稍后才到：等菜单反映出会话里的原生状态再点，避免点成「开」。
            await page.waitForFunction(
              () => document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]'),
              null,
              { timeout: 10_000 },
            )
          }
          await box.click()
          await page.waitForTimeout(200)
          await page.keyboard.press('Escape')
        }

        // 0. 原生：不注入任何分工/取向/路由说明，工具不减（Task 仍可用）；选择即写入会话，下一条与再下一条都用它。
        await pickNative()
        assert.equal((await sessionOf()).routeNative, true, '原生开关没有写入会话')
        for (const round of [1, 2]) {
          const start = provider.routeSeen.length
          const native = await sendTurn('解释一下这个函数的作用', '路由模型 route-power 已回复。')
          const calls = provider.routeSeen.slice(start)
          assert.equal(calls.length, 1, `原生第 ${round} 条消息不应额外请求模型`)
          assert.ok(calls[0].toolNames.includes('Task'), `原生第 ${round} 条消息 Task 不可用`)
          assert.ok(!calls[0].systemText.includes('# 分工：'), `原生第 ${round} 条消息仍注入分工说明`)
          assert.ok(
            !calls[0].systemText.includes('多代理协作 · 本轮'),
            `原生第 ${round} 条消息仍注入规划说明`,
          )
          const plan = native.messages.filter((m) => m.routePlan).at(-1)?.routePlan
          assert.equal(plan?.mode, 'native', `原生第 ${round} 条消息提示行不是原生`)
          assert.equal((plan?.injected ?? []).length, 0, '原生不应有注入原文')
          assert.match(JSON.stringify(native.messages), /原生（未注入）/, '提示行没有标注原生（未注入）')
        }
        // 原生打开时分工与取向两组置灰并注明。
        await page.getByRole('button', { name: /^选择模型：/ }).first().click()
        await page.locator('[role="menu"][aria-label="选择模型"]').first().waitFor()
        await page.getByRole('menuitem', { name: /^分工/ }).hover()
        const nativeDelegation = page.locator('[role="menu"][aria-label="分工"]').first()
        await nativeDelegation.waitFor({ state: 'visible', timeout: 5_000 })
        assert.match(await nativeDelegation.innerText(), /原生模式下不生效/, '原生时分工分组的说明缺失')
        assert.equal(
          await nativeDelegation.getByRole('menuitemradio', { name: '适度', exact: true }).getAttribute('aria-disabled'),
          'true',
          '原生时分工选项没有置灰',
        )
        await page.screenshot({ path: path.join(shotsDir, 'model-menu-native.png') })
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        // 反馈1601#04 截图：深/浅色模型菜单，原生打开时分工/取向置灰并注明。
        const fixDir = '/tmp/fix-1601b'
        mkdirSync(fixDir, { recursive: true })
        for (const theme of ['dark', 'light']) {
          await page.evaluate((next) => localStorage.setItem('tandem.theme.v1', next), theme)
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
          await page.getByRole('button', { name: /^选择模型：/ }).first().click()
          const themedMenu = page.locator('[role="menu"][aria-label="选择模型"]').first()
          await themedMenu.waitFor()
          await page.waitForFunction(
            () => document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]'),
            null,
            { timeout: 10_000 },
          )
          await page.screenshot({ path: path.join(fixDir, `model-menu-native-${theme}.png`) })
          await themedMenu.getByRole('menuitem', { name: /^分工/ }).hover()
          const themedSub = page.locator('[role="menu"][aria-label="分工"]').first()
          await themedSub.waitFor({ state: 'visible', timeout: 5_000 })
          assert.equal(
            await themedSub.getByRole('menuitemradio', { name: '适度', exact: true }).getAttribute('aria-disabled'),
            'true',
            `${theme} 原生时分工选项没有置灰`,
          )
          assert.match(await themedSub.innerText(), /原生模式下不生效/, `${theme} 原生时缺少「原生模式下不生效」`)
          await page.screenshot({ path: path.join(fixDir, `model-menu-native-disabled-${theme}.png`) })
          await page.keyboard.press('Escape')
          await page.keyboard.press('Escape')
        }
        await pickNative(true)
        await waitUntil('关闭原生写回会话', async () => (await sessionOf()).routeNative === undefined)
        assert.equal((await sessionOf()).routeNative, undefined, '关闭原生没有写回会话')

        // 1. 分工关闭：主会话自己完成，零 Task 子代理，也不出提示行；下一条与再下一条都用它。
        await pickRoute('分工', '关闭')
        assert.equal((await sessionOf()).delegation, 'none', '分工关闭没有写入会话')
        const plansBeforeOff = await planCount()
        for (const round of [1, 2]) {
          const directStart = provider.routeSeen.length
          await sendTurn('解释一下这个函数的作用', '路由模型 route-power 已回复。')
          const directCalls = provider.routeSeen.slice(directStart)
          assert.equal(directCalls.length, 1, `分工关闭第 ${round} 条不应产生额外模型请求`)
          assert.equal(directCalls[0].model, 'route-power', `分工关闭第 ${round} 条应由主会话模型处理`)
          assert.equal((await childrenOf()).length, 0, `分工关闭第 ${round} 条不应派发子代理`)
          assert.equal(await planCount(), plansBeforeOff, `分工关闭第 ${round} 条不应出现提示行`)
        }
        assert.equal((await sessionOf()).delegation, 'none', '分工关闭在后续消息中没有保留')

        // 2. 分工适度 + 取向省钱：机械任务整单交给执行者子代理，主会话模型不参与。
        await pickRoute('分工', '适度')
        await pickRoute('取向', '省钱')
        assert.equal((await sessionOf()).delegation, 'less', '分工适度没有写入会话')
        assert.equal((await sessionOf()).routeBias, 'cost', '取向省钱没有写入会话')
        const cheapStart = provider.routeSeen.length
        const cheap = await sendTurn('安装依赖并跑通构建', '便宜执行完成：依赖已安装，构建通过。')
        const cheapCalls = provider.routeSeen.slice(cheapStart)
        assert.deepEqual(cheapCalls.map((item) => item.model), ['route-mini'], '省钱应只调用执行模型')
        const cheapChildren = await childrenOf()
        assert.equal(cheapChildren.length, 1, '省钱应创建一个执行子代理')
        assert.equal(cheap.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.mode, 'cheap')

        // 3. 分工关闭：长任务也不派发。
        await pickRoute('分工', '关闭')
        const manualStart = provider.routeSeen.length
        const manualText =
          '请帮我完成前端批量改造：批量修改所有组件的按钮间距与布局样式，然后跑一遍 lint 和测试，最后整理结果。请注意不要改动后端接口，保持现有样式变量不变，完成后说明改了哪些文件。'
        const childCountBefore = (await childrenOf()).length
        await sendTurn(manualText, '路由模型 route-power 已回复。')
        assert.equal((await childrenOf()).length, childCountBefore, '分工关闭不应派发子代理')
        assert.ok(
          provider.routeSeen.slice(manualStart).every((item) => item.model === 'route-power'),
          '分工关闭不应调用执行模型',
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-direct.png') })

        // 4. 分工积极：规划者 Task → Kimi 前端 + DeepSeek 测试 → 规划者收尾。
        await pickRoute('分工', '积极')
        const divisionStart = provider.routeSeen.length
        const division = await sendTurn(
          manualText,
          '多代理协作完成：已审查执行结果，样式与测试均通过。',
        )
        const divisionCalls = provider.routeSeen.slice(divisionStart)
        assert.ok(divisionCalls.some((item) => item.model === 'route-power'), '多代理协作应调用规划者')
        assert.ok(divisionCalls.some((item) => item.model === 'route-kimi'), '前端子任务未调用专长模型')
        assert.ok(divisionCalls.some((item) => item.model === 'route-mini'), '测试子任务未调用执行模型')
        const divisionChildren = await childrenOf()
        const titles = divisionChildren.map((item) => item.title)
        assert.ok(titles.includes('改组件样式'), '缺少前端子代理')
        assert.ok(titles.includes('跑 lint 测试'), '缺少测试子代理')
        const plannerUsage = division.messages.filter((m) => m.model === 'route-power')
        assert.ok(
          plannerUsage.some((m) => (m.usage?.cacheReadTokens ?? 0) > 0),
          '主会话第二次请求应命中 prompt 缓存',
        )
        assert.ok(
          (division.routeSavings?.byRole?.specialist?.calls ?? 0) > 0 ||
            (division.routeSavings?.byRole?.executor?.calls ?? 0) > 0,
          '按角色节省统计未累计',
        )
        assert.match(
          division.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.reason ?? '',
          /前端|多代理协作/,
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-roles.png') })

        // 4b. 多代理协作前确认：卡片改模型 + 删除子任务 + 收件箱事件（分工回到适度）。
        await pickRoute('分工', '适度')
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: { ...divisionSettings.division, confirm: 'always' },
            },
          }),
        })
        const childCountBeforeCard = (await childrenOf()).length
        await page.locator('[aria-label="消息输入框"]').fill(manualText)
        await page.getByRole('button', { name: '发送消息' }).click()
        const card = page.locator('[data-division-plan]').last()
        await card.waitFor({ timeout: 15_000 })
        const inbox = await wsInboxSnapshot(base, token)
        assert.ok(
          inbox.events.some((event) => event.kind === 'division_plan'),
          '多代理协作计划没有进入收件箱',
        )
        await page.screenshot({ path: path.join(shotsDir, 'division-confirm-card.png') })
        const confirmStart = provider.routeSeen.length
        await card.locator('button[aria-label*="使用的模型"]').first().click()
        await page.getByRole('menuitemradio', { name: /route-mid/ }).click()
        await card.getByRole('button', { name: '删除子任务' }).nth(1).click()
        await card.getByRole('button', { name: '开始', exact: true }).click()
        await waitUntil('确认卡执行完成', async () => {
          const current = await sessionOf()
          return current.status === 'idle' && JSON.stringify(current.messages).includes('多代理协作完成')
        })
        const confirmCalls = provider.routeSeen.slice(confirmStart)
        assert.ok(confirmCalls.some((item) => item.model === 'route-mid'), '改模型后未按新模型执行')
        assert.ok(!confirmCalls.some((item) => item.model === 'route-kimi'), '删除的专长子任务仍被派发')
        assert.ok(!confirmCalls.some((item) => item.model === 'route-mini'), '删除的测试子任务仍被派发')
        assert.equal((await childrenOf()).length, childCountBeforeCard + 1, '应只执行剩余的一个子任务')
        await page.screenshot({ path: path.join(shotsDir, 'division-confirm-card-done.png') })

        // 设置页与用量页按角色统计
        const routingDialog = await openSettings(page, '自动路由', 'desktop')
        await routingDialog.getByText('多代理协作').first().waitFor({ timeout: 10_000 })
        assert.match(await routingDialog.innerText(), /领域专长/, '设置页缺少领域映射')
        await page.screenshot({ path: path.join(shotsDir, 'settings-division.png') })
        await closeSettings(page)
        const usageDialog = await openSettings(page, '用量', 'desktop')
        const roleTable = usageDialog.locator('[data-setting-id="usage.roles"]')
        await roleTable.waitFor({ timeout: 10_000 })
        await roleTable.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(shotsDir, 'usage-by-role.png') })
        await closeSettings(page)

        // 5. 成本上限（只对积极生效）：首轮规划请求触顶后不再继续请求强模型。
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: {
                ...divisionSettings.division,
                confirm: 'never',
                costCapUsdPerTurn: 0.0001,
              },
            },
          }),
        })
        await pickRoute('分工', '积极')
        const capStart = provider.routeSeen.length
        const capped = await sendTurn(manualText, '本轮花费已达上限')
        assert.match(
          JSON.stringify(capped.messages),
          /本轮花费已达上限/,
          '成本上限触发后没有提示',
        )
        assert.equal(
          provider.routeSeen.slice(capStart).filter((item) => item.model === 'route-power').length,
          1,
          '成本上限触发后仍继续请求规划者',
        )

        // 6. 学习偏好：分工前确认卡里两次选「改为单代理」，同类任务默认单代理（即使开着确认）。
        await api(base, token, '/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            resumeOnRestart: 'auto',
            modelRouting: {
              ...divisionSettings,
              division: { ...divisionSettings.division, confirm: 'always', costCapUsdPerTurn: undefined },
            },
          }),
        })
        for (let i = 0; i < 2; i++) {
          await page.locator('[aria-label="消息输入框"]').fill(manualText)
          await page.getByRole('button', { name: '发送消息' }).click()
          const learnCard = page.locator('[data-division-plan]').last()
          await learnCard.waitFor({ timeout: 15_000 })
          await learnCard.getByRole('button', { name: '改为单代理', exact: true }).click()
          await waitUntil(`确认卡改为单代理第 ${i + 1} 次`, async () => {
            const current = await sessionOf()
            const cardIndex = current.messages.map((m) => !!m.divisionPlan).lastIndexOf(true)
            const last = current.messages.at(-1)
            return (
              current.status === 'idle' &&
              cardIndex >= 0 &&
              current.messages.length - 1 > cardIndex &&
              last?.role === 'assistant' &&
              !last.notice
            )
          })
        }
        const learnStart = provider.routeSeen.length
        const childCountBeforeLearned = (await childrenOf()).length
        const learned = await sendTurn(manualText, '路由模型 route-power 已回复。')
        assert.equal((await childrenOf()).length, childCountBeforeLearned, '学到的单代理仍派发了子代理')
        assert.ok(
          provider.routeSeen
            .slice(learnStart)
            .every((item) => item.model === 'route-power'),
          '学到的单代理仍调用了执行模型',
        )
        assert.match(
          learned.messages.filter((m) => m.routePlan).at(-1)?.routePlan?.reason ?? '',
          /同类任务/,
          '学到的偏好理由未展示',
        )

        const learnedDialog = await openSettings(page, '自动路由', 'desktop')
        const learnedLabel = learnedDialog.getByText('学到的偏好').first()
        await learnedLabel.waitFor({ timeout: 10_000 })
        await learnedLabel.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(shotsDir, 'settings-learned.png') })
        await closeSettings(page)
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
        await mergeDialog.getByText(/conflict\.txt/).first().waitFor({ timeout: 10_000 })
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

      // R13：看板卡片的回合结束也要进入收件箱聚合组，不能长期停在「回合进行中」。
      await page.getByRole('button', { name: /^收件箱/ }).first().click()
      const inbox = page.getByRole('dialog', { name: '收件箱' })
      await inbox.waitFor({ state: 'visible', timeout: 10_000 })
      const cardGroup = inbox
        .getByTestId('inbox-history-group')
        .filter({ hasText: '确认卡 改文件' })
        .filter({ hasText: '回合完成' })
        .first()
      await cardGroup.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await inbox
          .getByTestId('inbox-history-group')
          .filter({ hasText: '确认卡 改文件' })
          .filter({ hasText: '回合进行中' })
          .count(),
        0,
        '看板完成卡仍显示回合进行中',
      )
      await cardGroup.getByTestId('aggregate-open').click()
      await page.waitForFunction(() => window.location.hash.includes('/s/'), null, {
        timeout: 15_000,
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
      await diffDialog.getByText(/hello-check/).first().waitFor({ timeout: 10_000 })
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
      await nestedDiff.getByText(/hello-check/).first().waitFor({ timeout: 10_000 })
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
      // 反馈13#01：阅读列固定宽度，切换页面时不得随内容收缩/抖动。
      const readWidth = () =>
        page.evaluate(() => {
          const el = document.querySelector('[role="dialog"][aria-label="项目 Wiki"] .wiki-markdown')
          return el ? el.getBoundingClientRect().width : 0
        })
      const readWidths = []
      for (const name of ['项目概览', 'src', '术语表', '项目概览']) {
        await dialog.getByRole('button', { name, exact: true }).first().click()
        await page.waitForTimeout(220)
        readWidths.push(await readWidth())
      }
      const minWidth = Math.min(...readWidths)
      const maxWidth = Math.max(...readWidths)
      assert.ok(
        maxWidth - minWidth <= 1,
        `Wiki 阅读列宽度随页面变化：${readWidths.map((width) => Math.round(width)).join(' / ')}`,
      )
      const samples = []
      for (let i = 0; i < 12; i += 1) {
        samples.push(await readWidth())
        await page.waitForTimeout(80)
      }
      assert.ok(
        Math.max(...samples) - Math.min(...samples) <= 1,
        `Wiki 阅读列在 1 秒内仍在抖动：${samples.map((width) => Math.round(width)).join(' / ')}`,
      )
      await dialog.getByRole('button', { name: '项目概览', exact: true }).first().click()
      await page.waitForTimeout(200)
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
      // 前面的设备/演示用例可能已经打开演示工作区；先清掉，基线才代表真实数据。
      await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' }).catch(() => undefined)
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

      const profiles = (await api(wsBase, token, '/api/workstation/profiles')).profiles
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
      const composer = page.locator('[aria-label="消息输入框"]').first()
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
      assert.ok(!(await api(wsBase, token, '/api/workstation/profiles')).profiles.some((profile) => profile.kind === 'demo'), '演示账号未清除')
      assert.ok(!(await api(base, token, '/api/boards')).some((board) => board.id === 'demo-board'), '演示看板未清除')
      assert.ok(!(await api(base, token, '/api/evals/runs')).some((run) => run.id === 'demo-eval-run'), '演示评测未清除')
      assert.ok(!(await api(base, token, '/api/tasks')).some((task) => task.cwd?.startsWith(state.root)), '演示后台任务未清除')
      assert.equal(existsSync(state.root), false, '演示目录未删除')
      const search = await api(base, token, `/api/search?q=${encodeURIComponent('演示 · 基础对话')}`)
      assert.equal(search.hits.length, 0, '演示会话仍留在搜索索引')
      const wikiAfter = await api(base, token, `/api/wiki?project=${encodeURIComponent(state.project)}`)
      assert.equal(wikiAfter.exists, false, '演示 Wiki 未清除')
    })

    desktop('会话图：时间倒序、子代理始终展开、悬停会话线高亮、子代理视图回主会话', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/孙代理/分叉会话')
      const [mainId, childId, , forkId] = scenario.sessionIds
      const mainTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)).title
      const titles = new Map()
      for (const id of scenario.sessionIds) {
        titles.set(id, (await api(base, token, `/api/sessions/${encodeURIComponent(id)}`)).title)
      }
      await openSession(page, mainId)

      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const group = page.locator('[data-group="graph"]').first()
      const scroller = graph.locator('[data-graph-height]').first()

      // 反馈1926#01：卡片不再显示「N 轮 · N 子代理 · N 分叉」汇总行。
      assert.doesNotMatch(
        await group.innerText(),
        /\d+\s*轮\s*·\s*\d+\s*子代理/,
        '会话图仍显示汇总描述行',
      )
      // 反馈1926#08：不再有「结果已返回」行。
      assert.equal(
        await graph.getByText('结果已返回', { exact: true }).count(),
        0,
        '会话图仍有「结果已返回」行',
      )
      // 反馈1926#02/#04：没有展开/收起按钮与标记，子代理直接展开。
      assert.equal(
        await graph.locator('[data-expand-subagent]').count(),
        0,
        '会话图仍有子代理展开按钮',
      )
      assert.doesNotMatch(await graph.innerText(), /[▸└]/, '会话图仍有展开/收起标记')
      assert.ok(
        (await graph.locator('div[data-kind="subagent-turn"]').count()) >= 2,
        '子代理没有直接展开成自己的轮次',
      )
      // 反馈1926#05：主线节点没有轮次序号（文字以用户发言开头）。
      const turnTexts = await graph.locator('div[data-kind="turn"]').allInnerTexts()
      assert.ok(turnTexts.length > 3, `会话图主线轮次太少：${turnTexts.length}`)
      assert.ok(
        turnTexts.every((text) => !/^\s*\d/.test(text)),
        `主线节点仍带轮次序号：${turnTexts.find((text) => /^\s*\d/.test(text))}`,
      )
      // 反馈1926#09：行内与 tooltip 都不显示 token/耗时等用量。
      const graphText = await graph.innerText()
      assert.doesNotMatch(graphText, /tok|token/i, '会话图仍在显示 token')
      assert.doesNotMatch(graphText, /\b\d+(?:\.\d+)?k\b/, '会话图仍在显示用量数字')
      const tips = await graph
        .locator('div[data-kind]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-tip') ?? ''))
      assert.ok(
        tips.every((tip) => !/tok|token|耗时|\$\d/i.test(tip)),
        `节点 tooltip 仍带用量：${tips.find((tip) => /tok|token|耗时|\$\d/i.test(tip))}`,
      )

      // 反馈1926#06：时间倒序，最新一轮在最上，越早越下。
      const showTop = async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        await page.waitForFunction(
          () => {
            const root = document.querySelector('[data-session-graph]')
            return (
              !!root?.querySelector('div[data-kind="fork"]') &&
              [...root.querySelectorAll('div[data-kind="turn"]')].some((el) =>
                el.textContent?.includes('收到，先按这个做'),
              )
            )
          },
          null,
          { timeout: 5_000 },
        )
      }
      await showTop()
      assert.match(
        (await graph.locator('div[data-kind="turn"]').first().innerText()).trim(),
        /收到，先按这个做/,
        '会话图最上面不是最新一轮',
      )
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-session-graph] div[data-kind="turn"]')].some((el) =>
            el.textContent?.includes('我们先把价格页'),
          ),
        null,
        { timeout: 5_000 },
      )
      assert.match(
        (await graph.locator('div[data-kind="turn"]').last().innerText()).trim(),
        /我们先把价格页/,
        '会话图最下面不是最早一轮',
      )
      await showTop()

      // 泳道色与节点形状仍按 2026-11-09 决定：所有节点同一 8px 圆，主线/子代理/分叉颜色不同。
      assert.ok((await graph.locator('[data-marker="circle"]').count()) >= 3, '会话图节点不足')
      assert.equal(
        await graph.locator('[data-marker]:not([data-marker="circle"])').count(),
        0,
        '存在非圆形节点',
      )
      const colors = await graph.evaluate((root) => {
        const color = (kind) => {
          const el = root.querySelector(`div[data-kind="${kind}"] [data-marker="circle"]`)
          return el ? getComputedStyle(el).backgroundColor : ''
        }
        return { main: color('turn'), sub: color('subagent-turn'), fork: color('fork') }
      })
      assert.ok(colors.main && colors.sub && colors.fork, `缺少主线/子代理/分叉节点 ${JSON.stringify(colors)} kinds=${await graph.locator('div[data-kind]').evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')).join(','))}`)
      assert.notEqual(colors.main, colors.sub, '子代理泳道与主线同色')
      assert.notEqual(colors.sub, colors.fork, '子代理与分叉泳道同色')
      // 子代理有汇回父会话的线；分叉线不汇回，节点行尾有「分叉」标签。
      assert.ok(
        (await graph.locator('path[data-kind="subagent"][data-merge="1"]').count()) > 0,
        '子代理分支没有汇回线',
      )
      assert.ok((await graph.locator('path[data-kind="fork"]').count()) > 0, '分叉没有连线')
      assert.equal(
        await graph.locator('path[data-kind="fork"][data-merge]').count(),
        0,
        '分叉不应汇回主线',
      )
      assert.match(await graph.locator('div[data-kind="fork"]').first().innerText(), /分叉/)

      // 几何：连线落在泳道中心/行中心；汇回线从分支最后一行接回父泳道；主线贯穿首尾轮。
      const geometry = await graph.evaluate((root) => {
        const rootBox = root.getBoundingClientRect()
        const center = (el) => {
          const box = el.getBoundingClientRect()
          return {
            x: box.left - rootBox.left + box.width / 2,
            y: box.top - rootBox.top + box.height / 2,
          }
        }
        const nodes = [...root.querySelectorAll('div[data-kind]')].map((el) => {
          const marker = el.querySelector('[data-marker="circle"]')
          return {
            kind: el.getAttribute('data-kind'),
            lane: Number(el.getAttribute('data-lane')),
            row: Number(el.getAttribute('data-row')),
            ...(marker ? center(marker) : { x: -999, y: -999 }),
          }
        })
        const laneX = new Map()
        for (const node of nodes) laneX.set(node.lane, node.x)
        const svg = root.querySelector('[data-session-graph-edges]')
        const svgBox = svg.getBoundingClientRect()
        const paths = [...svg.querySelectorAll('path[data-kind]')].map((path) => {
          const start = path.getPointAtLength(0)
          const end = path.getPointAtLength(path.getTotalLength())
          return {
            kind: path.getAttribute('data-kind'),
            owner: path.getAttribute('data-edge-owner'),
            merge: path.getAttribute('data-merge') === '1',
            fromLane: Number(path.getAttribute('data-from-lane')),
            toLane: Number(path.getAttribute('data-to-lane')),
            fromRow: Number(path.getAttribute('data-from-row')),
            toRow: Number(path.getAttribute('data-to-row')),
            start: { x: start.x + svgBox.left - rootBox.left, y: start.y + svgBox.top - rootBox.top },
            end: { x: end.x + svgBox.left - rootBox.left, y: end.y + svgBox.top - rootBox.top },
          }
        })
        return { nodes, paths, laneX: [...laneX] }
      })
      const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= 1
      const laneXOf = (lane) => geometry.laneX.find(([id]) => id === lane)?.[1]
      const onLane = (point, lane) => Math.abs(point.x - (laneXOf(lane) ?? -999)) <= 0.8
      const onRowCenter = (y) => Math.abs(((y - 14) % 28 + 28) % 28) <= 0.8
      const nodeAt = (lane, row) =>
        geometry.nodes.find((node) => node.lane === lane && node.row === row)
      const mainNodes = geometry.nodes.filter((node) => node.kind === 'turn')
      assert.ok(mainNodes.length >= 6, `演示会话主线轮次太少：${mainNodes.length}`)
      for (const path of geometry.paths) {
        assert.ok(path.owner, '连线缺少归属会话')
        assert.ok(onLane(path.start, path.fromLane), `连线起点不在泳道中心：${JSON.stringify(path.start)}`)
        assert.ok(onLane(path.end, path.toLane), `连线终点不在泳道中心：${JSON.stringify(path.end)}`)
        assert.ok(onRowCenter(path.start.y), `连线起点不在行中心：${path.start.y}`)
        assert.ok(onRowCenter(path.end.y), `连线终点不在行中心：${path.end.y}`)
      }
      const mainPath = geometry.paths.find((path) => path.kind === 'main')
      assert.ok(mainPath, '缺少主线竖线')
      assert.ok(
        mainNodes.every((node) => Math.abs(node.x - mainNodes[0].x) <= 0.5),
        '主线节点圆心 x 不一致',
      )
      assert.ok(
        mainNodes.every((node) => node.y >= mainPath.start.y - 1 && node.y <= mainPath.end.y + 1),
        '主线节点不在竖线范围内',
      )
      const branchOut = geometry.paths.filter(
        (path) => path.kind === 'subagent' && path.fromLane === 0 && path.toLane > 0,
      )
      const branchBack = geometry.paths.filter(
        (path) => path.kind === 'subagent' && path.fromLane > 0 && path.toLane === 0,
      )
      assert.ok(branchOut.length >= 2, '演示会话应有多个子代理分出线')
      assert.ok(branchBack.length >= 2, '子代理没有汇回父会话')
      for (const path of branchOut) {
        const parent = nodeAt(path.fromLane, path.fromRow)
        assert.ok(parent && near(path.start, parent), '子代理分出线起点不是父轮节点')
        assert.ok(onLane(path.end, path.toLane), '子代理分出线终点不在子泳道')
      }
      for (const path of branchBack) {
        const out = branchOut.find((item) => item.owner === path.owner)
        assert.ok(out && near(path.start, out.end), '汇回线起点没有接上分支最后一行')
        assert.ok(onLane(path.end, 0), '汇回线终点不在主线泳道')
        const target = nodeAt(0, path.toRow)
        if (!target) {
          // 父会话最后一轮派出的子代理：汇回主线轨道上的空行（在主线竖线范围内）。
          assert.ok(
            path.end.y >= mainPath.start.y - 1 && path.end.y <= mainPath.end.y + 1,
            '汇回线终点既不在父轮节点也不在主线轨道上',
          )
        }
      }
      const matchNode = (point, kind) =>
        geometry.nodes.some((node) => (!kind || node.kind === kind) && near(point, node))
      const forkPath = geometry.paths.find((path) => path.kind === 'fork')
      assert.ok(forkPath, '缺少分叉线')
      assert.ok(matchNode(forkPath.start, 'turn'), '分叉线起点不是主线节点')
      assert.ok(matchNode(forkPath.end, 'fork'), '分叉线终点不是分支节点')
      assert.equal(
        geometry.paths.some((path) => path.kind === 'fork' && path.toLane === 0),
        false,
        '分叉线不应汇回主线',
      )

      // 反馈1926#10：悬停主线时整条线高亮、其余线降亮，tooltip 显示会话名。
      const mainHover = await page.evaluate(() => {
        const scroller = document.querySelector('[data-session-graph] [data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const hit of document.querySelectorAll('[data-session-graph-edges] [data-edge-hit]')) {
          const total = hit.getTotalLength()
          const box = hit.ownerSVGElement.getBoundingClientRect()
          for (let i = 1; i <= 9; i += 1) {
            const point = hit.getPointAtLength((total * i) / 10)
            const x = box.left + point.x
            const y = box.top + point.y
            if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
              const top = document.elementFromPoint(x, y)
              if (!top?.hasAttribute?.('data-edge-hit')) continue
              return {
                x,
                y,
                owner: hit.getAttribute('data-edge-owner'),
                label: hit.getAttribute('data-tip'),
              }
            }
          }
        }
        return null
      })
      assert.ok(mainHover, '主线没有可悬停的命中区')
      await page.mouse.move(mainHover.x, mainHover.y)
      await page.waitForTimeout(700)
      const hoverState = await graph.evaluate((root, owner) => {
        const paths = [...root.querySelectorAll('path[data-kind]')]
        const mine = paths.filter((path) => path.getAttribute('data-edge-owner') === owner)
        const others = paths.filter((path) => path.getAttribute('data-edge-owner') !== owner)
        return {
          mine: mine.length,
          marked: mine.every((path) => path.getAttribute('data-hovered') === 'true'),
          mineOpacity: Math.min(...mine.map((path) => Number(getComputedStyle(path).opacity))),
          otherOpacity: others.length
            ? Math.max(...others.map((path) => Number(getComputedStyle(path).opacity)))
            : 0,
        }
      }, mainHover.owner)
      assert.ok(hoverState.mine > 0, '悬停线没有归属高亮')
      assert.ok(hoverState.marked, '悬停的线没有被标记高亮')
      assert.ok(hoverState.mineOpacity > 0.9, `悬停线没有保持全亮：${hoverState.mineOpacity}`)
      assert.ok(hoverState.otherOpacity <= 0.3, `其他线没有降亮：${hoverState.otherOpacity}`)
      assert.equal(mainHover.label, mainTitle, '主线 tooltip 不是当前会话名')
      assert.equal(
        (await page.locator('#tandem-tooltip[data-open]').innerText()).trim(),
        mainTitle,
        '悬停主线的 tooltip 没有显示会话名',
      )
      await page.mouse.move(4, 4)
      await page.waitForTimeout(200)

      // 悬停子代理线：tooltip 为该子代理会话名。
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(300)
      const subHover = await page.evaluate(() => {
        const scroller = document.querySelector('[data-session-graph] [data-graph-height]')
        const rect = scroller.getBoundingClientRect()
        for (const hit of document.querySelectorAll(
          '[data-session-graph-edges] [data-edge-hit][data-edge-kind="subagent"]',
        )) {
          const total = hit.getTotalLength()
          const box = hit.ownerSVGElement.getBoundingClientRect()
          for (let i = 1; i <= 9; i += 1) {
            const point = hit.getPointAtLength((total * i) / 10)
            const x = box.left + point.x
            const y = box.top + point.y
            if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
              const top = document.elementFromPoint(x, y)
              if (!top?.hasAttribute?.('data-edge-hit')) continue
              return {
                x,
                y,
                owner: hit.getAttribute('data-edge-owner'),
                label: hit.getAttribute('data-tip'),
              }
            }
          }
        }
        return null
      })
      assert.ok(subHover, '子代理线没有可悬停的命中区')
      await page.mouse.move(subHover.x, subHover.y)
      await page.waitForTimeout(700)
      assert.equal(subHover.label, titles.get(subHover.owner), '子代理线 tooltip 不是该会话名')
      assert.equal(
        (await page.locator('#tandem-tooltip[data-open]').innerText()).trim(),
        titles.get(subHover.owner),
        '悬停子代理线没有 tip 出会话名',
      )
      assert.ok(
        (await graph.locator(`path[data-edge-owner="${subHover.owner}"][data-hovered="true"]`).count()) > 0,
        '悬停子代理线没有高亮该会话轨道',
      )
      await page.mouse.move(4, 4)

      // 反馈1926#07：覆盖式滚动条让位到卡片外，不挡卡片头部的全高展开控件。
      await scroller.evaluate((el) => {
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, 60)
      })
      await page.waitForSelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]', { timeout: 3_000 })
      const gutter = await page.evaluate(() => {
        const bar = document.querySelector('.overlay-scrollbar[data-axis="y"][data-visible="true"]')
        const card = document.querySelector('[data-group="graph"]')
        const control = card?.querySelector('[aria-label="全高显示会话图"]')
        const barBox = bar.getBoundingClientRect()
        const cardBox = card.getBoundingClientRect()
        const controlBox = control.getBoundingClientRect()
        const hit = document.elementFromPoint(
          controlBox.left + controlBox.width / 2,
          controlBox.top + controlBox.height / 2,
        )
        return {
          barLeft: barBox.left,
          cardRight: cardBox.right,
          hitControl: !!hit?.closest?.('[aria-label="全高显示会话图"]'),
          hitBar: hit === bar,
        }
      })
      assert.ok(
        gutter.barLeft >= gutter.cardRight - 0.5,
        `覆盖滚动条压住卡片：${gutter.barLeft} < ${gutter.cardRight}`,
      )
      assert.ok(gutter.hitControl && !gutter.hitBar, '覆盖滚动条挡住了卡片头部控件')

      // 反馈1926#03：在子代理只读视图里点会话图主线节点，回到主会话并定位该轮。
      await graph.locator('div[data-kind="subagent-turn"]').first().click()
      const breadcrumb = page.locator('[data-agent-breadcrumb]')
      await breadcrumb.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await breadcrumb.innerText(), /只读/, '子代理节点没有打开只读子会话')
      await showTop()
      await graph.locator('div[data-kind="turn"]').first().click()
      await breadcrumb.waitFor({ state: 'detached', timeout: 10_000 })
      await page.locator('[data-turn-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '从子代理视图返回后消息仍被高亮')

      // 卡片右上角可全高展开，顶部返回恢复面板；全高页头不再有汇总。
      await group.locator('[aria-label="全高显示会话图"]').click()
      const full = page.locator('[data-graph-full]')
      await full.waitFor({ state: 'visible', timeout: 10_000 })
      assert.doesNotMatch(await full.innerText(), /\d+\s*轮\s*·\s*\d+\s*子代理/, '全高会话图仍有汇总行')
      await full.getByRole('button', { name: /返回/ }).click()
      await full.waitFor({ state: 'detached', timeout: 5_000 })

      // 点分叉节点打开那个分叉会话。
      await showTop()
      const forkTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)).title
      await graph.locator('div[data-kind="fork"]').first().click()
      await page.getByText(forkTitle, { exact: true }).first().waitFor({ timeout: 10_000 })
    })

    desktop('反馈2156#01：会话图跳转只定位，目标消息没有高亮背景', async (page) => {
      await openSession(page, 'long')
      if (!(await page.locator('[data-group]').count())) {
        await page.getByRole('button', { name: '切换信息面板' }).first().click()
      }
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      const node = graph.locator('div[data-kind="turn"]').nth(2)
      const messageId = await node.getAttribute('data-graph-turn-id')
      assert.ok(messageId, '会话图节点没有携带目标消息 id')
      await node.click()
      await page.waitForFunction(
        (id) => {
          const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        },
        messageId,
        { timeout: 12_000 },
      )
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.msg-jump-hit').count(), 0, '跳转后消息仍被加上高亮类')
      const style = await page.evaluate((id) => {
        const row = document
          .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
          ?.closest('.msg-row')
        if (!row) return null
        const computed = getComputedStyle(row)
        return { background: computed.backgroundColor, shadow: computed.boxShadow }
      }, messageId)
      assert.ok(style, '跳转后找不到目标消息行')
      assert.ok(
        style.background === 'rgba(0, 0, 0, 0)' || style.background === 'transparent',
        `目标消息仍有高亮背景：${style.background}`,
      )
      assert.equal(style.shadow, 'none', `目标消息仍有高亮描边：${style.shadow}`)
    })

    desktop('反馈2156#03：正在输出的轮次节点有与侧栏一致的呼吸动画', async (page) => {
      await openSession(page, 'slow')
      const input = page.locator('[aria-label="消息输入框"]')
      await input.fill('SLOW_E2E 展示运行中节点动画')
      await input.press('Enter')
      const running = page.locator('[data-session-graph] [data-running="true"]').first()
      await running.waitFor({ state: 'visible', timeout: 10_000 })
      const ring = running.locator('[data-marker-ring="running"]')
      await ring.waitFor({ state: 'visible', timeout: 5_000 })
      const style = await ring.evaluate((el) => ({
        className: el.className,
        animation: getComputedStyle(el).animationName,
      }))
      assert.ok(style.className.includes('running-dot'), `运行中节点没有复用 running-dot：${style.className}`)
      assert.equal(style.animation, 'tandem-breathe', `运行中节点动画不对：${style.animation}`)
      const sidebarDot = page.locator('[data-session-row] .running-dot').first()
      await sidebarDot.waitFor({ state: 'attached', timeout: 5_000 })
      assert.equal(
        await sidebarDot.evaluate((el) => getComputedStyle(el).animationName),
        style.animation,
        '会话图运行中动画与侧栏运行中不一致',
      )
      await running.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
    })

    desktop('会话图泳道线 tooltip 以指针定位并完整显示在视口内（反馈1926#10）', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 4, '演示子代理场景缺少子代理/孙代理/分叉会话')
      await openSession(page, scenario.sessionIds[0])
      const graph = page.locator('[data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })

      // 返回最左/最右一条可见泳道线的可悬停点（线是细长目标，包围盒不能代表指针位置）。
      const edgeHoverPoint = (side, root = '[data-group="graph"]') =>
        page.evaluate(({ edgeSide, rootSel }) => {
          const scope = document.querySelector(rootSel)
          const scroller = scope?.querySelector('[data-graph-height]')
          if (!scope || !scroller) return null
          const rect = scroller.getBoundingClientRect()
          const hits = [...scope.querySelectorAll('[data-session-graph-edges] [data-edge-hit]')]
            .map((hit) => ({ hit, box: hit.getBoundingClientRect() }))
            .sort((a, b) => (edgeSide === 'left' ? a.box.left - b.box.left : b.box.right - a.box.right))
          for (const { hit } of hits) {
            const total = hit.getTotalLength()
            const box = hit.ownerSVGElement.getBoundingClientRect()
            for (let i = 1; i <= 9; i += 1) {
              const point = hit.getPointAtLength((total * i) / 10)
              const x = box.left + point.x
              const y = box.top + point.y
              if (x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4) {
                const top = document.elementFromPoint(x, y)
                if (!top?.hasAttribute?.('data-edge-hit')) continue
                return { x, y, label: hit.getAttribute('data-tip') }
              }
            }
          }
          return null
        }, { edgeSide: side, rootSel: root })

      const assertTipVisible = async (hover, where) => {
        await page.mouse.move(hover.x, hover.y)
        await page.waitForFunction(
          () => document.getElementById('tandem-tooltip')?.hasAttribute('data-open'),
          null,
          { timeout: 5_000 },
        )
        const tip = await page.evaluate(() => {
          const el = document.getElementById('tandem-tooltip')
          const r = el.getBoundingClientRect()
          return {
            text: el.textContent,
            inBody: el.parentElement === document.body,
            inCard: !!el.closest('[data-group="graph"]'),
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            viewport: { w: window.innerWidth, h: window.innerHeight },
          }
        })
        assert.equal(tip.text, hover.label, `${where} tooltip 不是该泳道线归属会话名`)
        // 必须渲染在 body 直接子树，否则会被卡片的 overflow 裁切。
        assert.ok(tip.inBody && !tip.inCard, `${where} tooltip 不在 document.body 直接子树`)
        assert.ok(
          tip.left >= 0 && tip.top >= 0 && tip.right <= tip.viewport.w && tip.bottom <= tip.viewport.h,
          `${where} tooltip 超出视口：${JSON.stringify(tip)}`,
        )
        // 细长连线按指针锚定，而不是整条线包围盒的中心；贴边时按视口 8px 边距夹紧。
        const half = (tip.right - tip.left) / 2
        const edge = 8
        const expectedX = Math.min(
          Math.max(hover.x, edge + half),
          Math.max(edge + half, tip.viewport.w - edge - half),
        )
        assert.ok(
          Math.abs((tip.left + tip.right) / 2 - expectedX) <= 2,
          `${where} tooltip 没有按指针锚定：${JSON.stringify(tip)} @${hover.x}`,
        )
        await page.mouse.move(4, 4)
        await page.waitForTimeout(250)
      }

      // 右栏卡片（约 280px 宽）：最左、最右两条泳道线。
      for (const side of ['left', 'right']) {
        const hover = await edgeHoverPoint(side)
        assert.ok(hover, `卡片内${side === 'left' ? '最左' : '最右'}侧泳道线没有可悬停的命中区`)
        await assertTipVisible(hover, `卡片${side === 'left' ? '左' : '右'}缘`)
      }

      // 全屏尺寸：同样验证最左/最右泳道线。
      const group = page.locator('[data-group="graph"]').first()
      await group.locator('[aria-label="全高显示会话图"]').click()
      const full = page.locator('[data-graph-full]')
      await full.waitFor({ state: 'visible', timeout: 10_000 })
      await full.locator('[data-graph-height]').first().evaluate((el) => {
        el.scrollTop = 0
      })
      await page.waitForTimeout(300)
      for (const side of ['left', 'right']) {
        const hover = await edgeHoverPoint(side, '[data-graph-full]')
        assert.ok(hover, `全屏${side === 'left' ? '最左' : '最右'}侧泳道线没有可悬停的命中区`)
        await assertTipVisible(hover, `全屏${side === 'left' ? '左' : '右'}缘`)
      }
      await full.getByRole('button', { name: /返回/ }).click()
      await full.waitFor({ state: 'detached', timeout: 5_000 })
    })

    desktop('侧栏分叉并入原会话行、悬停拓扑图、右栏切分支', async (page) => {
      let state = await api(base, token, '/api/demo')
      if (!state.active) state = await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
      const scenario = state.scenarios.find((item) => item.id === 'subagents')
      assert.ok(scenario?.sessionIds?.length >= 6, '演示子代理场景缺少子代理/孙代理/分叉会话')
      const [mainId, , , forkId] = scenario.sessionIds
      const mainTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)).title
      const forkTitle = (await api(base, token, `/api/sessions/${encodeURIComponent(forkId)}`)).title

      await openSession(page, mainId)
      const mainRow = page.locator(`[data-session-row][data-session-id="${mainId}"]`).first()
      await mainRow.waitFor({ state: 'visible', timeout: 15_000 })

      // 分叉不占新行：演示分叉没有自己的侧栏行，树行数 = 1。
      assert.equal(
        await page.locator(`[data-session-row][data-session-id="${forkId}"]`).count(),
        0,
        '分叉仍单独占一行',
      )
      assert.equal(await page.locator(`[data-session-row][data-session-id="${mainId}"]`).count(), 1, '树行重复')

      // 新建分叉后侧栏行数不增加。
      const detail = await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}`)
      const messageId = [...detail.messages].reverse().find((message) => message.role === 'user')?.id
      assert.ok(messageId, '主会话没有用户消息，无法分叉')
      const rowsBefore = await page.locator('[data-session-row]').count()
      const extra = await api(base, token, `/api/sessions/${encodeURIComponent(mainId)}/fork`, {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      })
      await page.waitForTimeout(800)
      assert.equal(
        await page.locator('[data-session-row]').count(),
        rowsBefore,
        '分叉后侧栏行数增加了',
      )
      assert.equal(
        await page.locator(`[data-session-row][data-session-id="${extra.id}"]`).count(),
        0,
        '新分叉占用了单独一行',
      )
      await api(base, token, `/api/sessions/${encodeURIComponent(extra.id)}`, {
        method: 'DELETE',
        body: '{}',
      })
      await page.waitForTimeout(500)

      // 悬停会话行：右侧弹出拓扑图，节点 = 会话（主 + 分叉 + 子代理），没有轮次文字。
      await mainRow.hover()
      const topology = page.locator('[data-hover-card] [data-session-topology]').first()
      await topology.waitFor({ state: 'visible', timeout: 10_000 })
      const nodes = topology.locator('div[data-session-id]')
      const expectedNodes = 6 // 主会话 + 4 个子代理/孙代理 + 1 个分叉
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-hover-card] [data-session-topology] div[data-session-id]').length === count,
        expectedNodes,
        { timeout: 5_000 },
      )
      assert.equal(await nodes.count(), expectedNodes, '拓扑图节点数不等于树内会话数')
      assert.equal(await topology.locator('div[data-kind="turn"]').count(), 0, '拓扑图出现了轮次节点')
      assert.equal(await topology.locator('div[data-kind="session"]').count(), 1, '拓扑图缺少根会话节点')
      assert.ok((await topology.locator('div[data-kind="fork"]').count()) >= 1, '拓扑图缺少分叉节点')
      assert.ok((await topology.locator('div[data-kind="subagent"]').count()) >= 2, '拓扑图缺少子代理节点')
      const topologyText = await topology.innerText()
      assert.doesNotMatch(topologyText, /收到，先按这个做|我们先把价格页/, '拓扑图仍在显示轮次文字')
      assert.doesNotMatch(topologyText, /tok|token/i, '拓扑图显示了 token')
      assert.ok(
        (await topology.locator('[data-session-graph-edges] [data-edge-hit][data-tip]').count()) > 0,
        '拓扑图的连线没有会话名 tooltip',
      )

      // 点分叉节点打开该分叉会话；侧栏同一行内小字标出所在分叉名。
      await topology.locator(`div[data-kind="fork"][data-fork-id="${forkId}"]`).click()
      await page.waitForFunction(
        (id) => window.location.hash.includes(`/s/${id}`),
        forkId,
        { timeout: 10_000 },
      )
      const branch = mainRow.locator('[data-session-branch]').first()
      await branch.waitFor({ state: 'visible', timeout: 10_000 })
      const branchLabel = forkTitle.split('·').map((part) => part.trim()).filter(Boolean).pop()
      assert.equal((await branch.innerText()).trim(), branchLabel, '行内没有标出当前分叉名')

      // 右栏会话图切分支：在分叉里，主线是当前分叉；来源会话作为分支泳道并写「原会话」。
      const graph = page.locator('[data-group="graph"] [data-session-graph]').first()
      await graph.waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-group="graph"] path[data-kind="main"]')
            ?.getAttribute('data-edge-owner') === id,
        forkId,
        { timeout: 10_000 },
      )
      const source = graph.locator(`div[data-kind="fork"][data-fork-id="${mainId}"]`).first()
      await source.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await source.innerText(), /原会话/, '来源会话没有标成「原会话」')
      assert.match(await source.innerText(), new RegExp(mainTitle.slice(0, 6)), '来源会话节点不是原会话标题')

      // 回到主会话：主线切回主会话本身。
      await openSession(page, mainId)
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-group="graph"] path[data-kind="main"]')
            ?.getAttribute('data-edge-owner') === id,
        mainId,
        { timeout: 10_000 },
      )
      assert.equal(await mainRow.locator('[data-session-branch]').count(), 0, '主会话行仍显示分叉名')
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

      // 新包格式：.tfb（zip 容器），解包后是正常文件；导出不再弹清空确认。
      const downloadPromise = page.waitForEvent('download')
      await bar.getByRole('button', { name: '导出', exact: true }).click()
      const download = await downloadPromise
      assert.match(
        download.suggestedFilename(),
        /^tandem-feedback-\d{8}-\d{4}\.tfb$/,
        '导出文件名不是 .tfb',
      )
      const downloadFile = path.join(home, 'feedback-export.tfb')
      await download.saveAs(downloadFile)
      const unpacked = mkdtempSync(path.join(home, 'feedback-unpack-'))
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/feedback-unpack.mjs'), downloadFile, unpacked], { encoding: 'utf8' })
      const exported = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
      assert.equal(exported.format, 'tfb', 'manifest 缺少 tfb 版本标记')
      assert.ok(Array.isArray(exported.featureGroups), '导出 manifest 缺少 featureGroups')
      assert.ok(exported.featureGroups.some((group) => group.name === '任务看板'), '导出未按功能分组')
      assert.equal(exported.items[0].featureName, '任务看板', '反馈条目没有功能标签')
      assert.equal(exported.checklist, '体验清单.md', '导出未附带体验清单报告')
      assert.ok(existsSync(path.join(unpacked, '01-元素截图.png')), '解包里没有条目截图文件')
      assert.ok(existsSync(path.join(unpacked, 'by-feature', '任务看板.md')), '缺少 by-feature 分组文件')
      assert.ok(existsSync(path.join(unpacked, '体验清单.md')), '缺少体验清单报告')
      const feedbackMd = readFileSync(path.join(unpacked, 'feedback.md'), 'utf8')
      assert.ok(feedbackMd.includes('## 功能：任务看板'), 'feedback.md 未按功能分组')
      assert.ok(feedbackMd.includes('`01-元素截图.png`'), 'feedback.md 没有引用截图文件')
      // 导出后条目清空、草稿标记为已导出（保留 7 天）。
      await bar.waitFor({ state: 'visible' })
      assert.equal(await bar.getByText('已记录 0 条', { exact: false }).count(), 1, '导出后条目没有清空')

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

    desktop('反馈草稿实时保存：刷新后条目与截图恢复，可手动删除草稿', async (page) => {
      await openSession(page, 'long')
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      const bar = page.getByRole('region', { name: '反馈模式工具栏' })
      await bar.waitFor({ state: 'visible' })
      await page.mouse.click(900, 300)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      await editor.locator('textarea').fill('刷新恢复测试：这条不导出')
      await editor.locator('textarea').press('Enter')
      await page.getByText(/已记录第 \d+ 条反馈/).first().waitFor({ timeout: 15_000 })
      const countBefore = (await bar.getByText(/已记录 \d+ 条/).first().textContent()) ?? ''
      // 等 IndexedDB 写完再刷新，避免把「还没落盘」当成草稿丢失。
      await page.waitForFunction(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('tandem-feedback', 1)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const record = await new Promise((resolve) => {
          const tx = db.transaction('state', 'readonly')
          const req = tx.objectStore('state').get('current')
          req.onsuccess = () => resolve(req.result)
        })
        db.close()
        return (record?.items?.length ?? 0) > 0 && !record?.draft?.exportedAt
      }, { timeout: 10_000 })

      // 不导出直接刷新：IndexedDB 里的条目与截图应恢复。
      await page.reload()
      await page.waitForSelector('html.feedback-mode', { state: 'detached', timeout: 10_000 }).catch(() => {})
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 8_000 })
      await page.getByText(/已恢复 \d+ 条未导出的反馈/).first().waitFor({ timeout: 10_000 })
      const barAfter = page.getByRole('region', { name: '反馈模式工具栏' })
      assert.equal(
        (await barAfter.getByText(countBefore.trim(), { exact: true }).count()) > 0,
        true,
        '刷新后条目数没有恢复',
      )
      await barAfter.getByRole('button', { name: /条目 \d+/ }).click()
      const drawer = page.locator('aside[aria-label="反馈条目"]')
      await drawer.getByText('刷新恢复测试：这条不导出', { exact: false }).first().waitFor({ timeout: 8_000 })
      assert.ok(
        (await drawer.locator('img').count()) > 0,
        '刷新后截图没有恢复（条目缩略图为空）',
      )
      await drawer.getByText(/草稿已保存到本机/).first().waitFor({ timeout: 5_000 })

      // 手动删除草稿：确认后条目清空。
      page.once('dialog', (dialog) => dialog.accept())
      await drawer.getByRole('button', { name: '删除草稿' }).click()
      await page.getByText('已删除草稿').first().waitFor({ timeout: 5_000 })
      await drawer.waitFor({ state: 'hidden' }).catch(() => {})
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

    desktop('反馈截图：长会话点选/框选/整页不卡且内容非空（R48）', async (page) => {
      await openSession(page, 'huge')
      // 滚到底部：截图应截当前可见的最后几轮，而不是会话开头。
      await page.evaluate(() => {
        const el = document.querySelector('.chat-scroll')
        if (el) el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(400)
      const perf = await page.evaluate(async () => {
        const api = window.__feedbackPerfCapture
        if (!api) return null
        const time = async (fn) => {
          const started = performance.now()
          const value = await fn()
          return { ms: Math.round(performance.now() - started), value }
        }
        const pageShot = await time(() => api.page())
        const element = await time(() => api.element('.chat-scroll'))
        const region = await time(() => api.region({ x: 700, y: 260, width: 700, height: 520, pageX: 700, pageY: 260 }))
        const records = api.records().slice(-3)
        const decode = (src) =>
          new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
            img.onerror = () => resolve(null)
            img.src = src
          })
        return {
          pageShot: { ...pageShot, size: await decode(pageShot.value?.dataURL ?? '') },
          element: { ...element, size: await decode(element.value ?? '') },
          region: { ...region, size: await decode(region.value ?? '') },
          records,
        }
      })
      assert.ok(perf, '缺少调试截图性能入口（__feedbackPerfCapture）')
      // 宽松阈值：只为防「整页 DOM 克隆」级退化，正常机器远低于此。
      assert.ok(perf.pageShot.ms < 2500, `整页截图过慢：${perf.pageShot.ms}ms`)
      assert.ok(perf.element.ms < 1500, `会话区元素截图过慢：${perf.element.ms}ms`)
      assert.ok(perf.region.ms < 1500, `区域截图过慢：${perf.region.ms}ms`)
      assert.ok(perf.pageShot.value?.dataURL?.length > 2000, '整页截图为空')
      assert.ok(perf.element.value?.length > 2000, '元素截图为空')
      assert.ok(perf.region.value?.length > 2000, '区域截图为空')
      assert.ok(perf.element.size?.width > 100 && perf.element.size?.height > 100, '元素截图尺寸异常')
      assert.ok(
        Math.abs((perf.region.size?.width ?? 0) - 700) <= 2 &&
          Math.abs((perf.region.size?.height ?? 0) - 520) <= 2,
        `区域截图尺寸不对：${perf.region.size?.width}×${perf.region.size?.height}`,
      )
      assert.ok(perf.pageShot.size?.width > 0 && perf.pageShot.size?.height > 0, '整页截图尺寸异常')
      const [pageRecord, elementRecord, regionRecord] = perf.records
      assert.equal(pageRecord?.kind, 'page', '整页截图缺少耗时记录')
      assert.ok((pageRecord?.pruned ?? 0) > 0, '长会话整页截图没有跳过视口外的行')
      assert.ok((elementRecord?.nodes ?? 9999) < 800, `会话区元素截图克隆了过多节点：${elementRecord?.nodes}`)
      assert.ok((regionRecord?.nodes ?? 9999) < 800, `区域截图克隆了过多节点：${regionRecord?.nodes}`)

      // 真实点击链路：点选会话区后输入浮窗要在可接受时间内可用。
      await page.keyboard.press('Control+Shift+F')
      await page.waitForSelector('html.feedback-mode', { timeout: 5_000 })
      const started = Date.now()
      await page.mouse.click(1276, 900)
      const editor = page.getByRole('dialog', { name: '反馈输入' })
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      const clickMs = Date.now() - started
      assert.ok(clickMs < 1200, `点选到输入浮窗过慢：${clickMs}ms`)
      assert.ok((await editor.locator('img').count()) > 0, '输入浮窗缺少截图缩略图')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await page.locator('html.feedback-mode').count()) await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.documentElement.classList.contains('feedback-mode'))
    })

    desktop('工作站：跨主机 ADB/串口挂载、审批与终端', async (page) => {
      const hostIdA = randomUUID()
      const hostA = startHost({
        home: path.join(home, 'host-a'),
        token: randomUUID(),
        hostId: hostIdA,
        extraEnv: { FAKE_ADB_SERIAL: 'REG_A_01', FAKE_ADB_DEVICE: 'RegBoard' },
      })
      let sessionId
      let logTask
      try {
        const accountA = await hostA.session
        const baseA = accountA.base
        const tokenA = accountA.token
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
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-a', accountId: 'reg-account', name: '设备主机 A', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseA, token: tokenA, accountUrl: accountA.wsBase, hostId: accountA.hostId, hostFingerprint: accountA.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openSession(page, sessionId)
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByText('设备主机 A', { exact: true }).waitFor({ timeout: 10_000 })
        await dialog.getByText(/REG_A_01/).first().waitFor({ timeout: 10_000 })
        await waitForValue(
          async () => ((await dialog.getByText(/Tandem Mock/).count()) >= 2 ? true : null),
          15_000,
          '两台主机的串口未同时列出',
        )
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

    desktop('工作站：主机没装 adb 时显示说明而不报错', async (page) => {
      const hostIdA = randomUUID()
      const hostA = startHost({
        home: path.join(home, 'host-noadb'),
        token: randomUUID(),
        hostId: hostIdA,
        extraEnv: { TANDEM_ADB_BIN: path.join(home, 'no-such-adb') },
      })
      try {
        const accountA = await hostA.session
        const baseA = accountA.base
        const tokenA = accountA.token
        const devicesA = await api(baseA, tokenA, '/api/devices')
        assert.equal(devicesA.adb.available, false, '不存在的 adb 不应被当作可用')
        assert.equal(devicesA.adb.missing, true, '缺少 adb 时应返回结构化 missing 状态')
        assert.ok(!/spawn adb ENOENT/.test(devicesA.adb.hint ?? ''), '给用户的说明里不应出现原始 ENOENT')
        assert.equal(devicesA.serial.available, true, '串口不应受 adb 缺失影响')

        await page.evaluate(
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-noadb', accountId: 'reg-account', name: '无 adb 主机', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseA, token: tokenA, accountUrl: accountA.wsBase, hostId: accountA.hostId, hostFingerprint: accountA.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openSession(page, 'long')
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        const section = dialog.locator('section', { hasText: baseA }).first()
        await section.waitFor({ timeout: 10_000 })
        await section.getByText('未检测到 adb', { exact: true }).waitFor({ timeout: 10_000 })
        assert.equal(await section.getByText('如何安装 / 设置路径').count(), 1, '缺少 adb 时应给安装说明入口')
        assert.equal(await section.locator('.text-danger').count(), 0, '缺少 adb 不应显示为错误')
        assert.equal(await section.getByText(/spawn adb ENOENT/).count(), 0, '界面上不应出现原始 adb 异常')
        await section.getByText('如何安装 / 设置路径').click()
        await section.getByText(/devices\.adbPath/).first().waitFor({ timeout: 5_000 })
        // 反馈9#02：顶部横向系统分段（默认 Host 平台）+ 编号步骤 + 可复制代码块。
        for (const label of ['Windows', 'macOS', 'Linux']) {
          assert.equal(
            await section.getByRole('button', { name: label, exact: true }).count(),
            1,
            `安装说明缺少 ${label} 分段`,
          )
        }
        await section.getByText('安装 adb 与 udev 规则', { exact: true }).waitFor({ timeout: 5_000 })
        await section.getByText(/apt install adb android-sdk-platform-tools-common/).waitFor({ timeout: 5_000 })
        assert.ok(
          await section.getByRole('button', { name: '复制代码' }).count(),
          '代码块缺少复制按钮',
        )
        // Linux 发行版二级分段：Arch / Fedora 命令随之切换。
        await section.getByRole('button', { name: 'Arch', exact: true }).click()
        await section.getByText('sudo pacman -S android-tools', { exact: true }).waitFor({ timeout: 5_000 })
        await section.getByRole('button', { name: 'Fedora', exact: true }).click()
        await section.getByText('sudo dnf install android-tools', { exact: true }).waitFor({ timeout: 5_000 })
        // 顶部系统分段可切换；路径与命令都用等宽字体。
        await section.getByRole('button', { name: 'Windows', exact: true }).click()
        await section.getByText('winget install --id Google.PlatformTools -e', { exact: true }).waitFor({ timeout: 5_000 })
        assert.ok(
          await section.locator('code', { hasText: 'devices.adbPath' }).count(),
          '设置路径没有用等宽字体',
        )
        await section.getByRole('button', { name: 'macOS', exact: true }).click()
        await section.getByText('brew install --cask android-platform-tools', { exact: true }).waitFor({ timeout: 5_000 })
        await dialog.getByRole('button', { name: '完成' }).click()
        await page.evaluate((url) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.url !== url)))
        }, baseA)
      } finally {
        hostA.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostA.child.once('exit', resolve)),
          sleep(3000).then(() => hostA.child.kill('SIGKILL')),
        ])
      }
    })

    // 反馈 8#06：设备列表单行紧凑、名称与路径相同不重复、板载串口折叠、无权限可修复。
    desktop('工作站：设备单行密度、板载串口折叠、无权限修复说明', async (page) => {
      const hostIdB = randomUUID()
      const hostB = startHost({
        home: path.join(home, 'host-serial-access'),
        token: randomUUID(),
        hostId: hostIdB,
        extraEnv: {
          TANDEM_MOCK_SERIAL_BUILTIN: '1',
          TANDEM_MOCK_SERIAL_DENIED: 'mock://ttyUSB0',
        },
      })
      try {
        const accountB = await hostB.session
        const baseB = accountB.base
        const tokenB = accountB.token
        let list
        for (let i = 0; i < 20; i += 1) {
          list = await api(baseB, tokenB, '/api/devices')
          if ((list.devices ?? []).filter((device) => device.kind === 'serial').length >= 5) break
          await sleep(200)
        }
        const usb = list.devices.find((device) => device.id === 'serial:mock://ttyUSB0')
        assert.equal(usb?.access?.state, 'denied', '串口无权限状态没有返回给客户端')
        assert.ok((usb?.access?.commands ?? []).includes('sudo usermod -aG dialout $USER'), '缺少修复命令')
        assert.equal(list.devices.filter((device) => device.builtin).length, 4, '板载串口未标记 builtin')
        const deep = await api(
          baseB,
          tokenB,
          `/api/devices/${encodeURIComponent('serial:mock://ttyUSB0')}/access-check`,
          { method: 'POST', body: JSON.stringify({}) },
        )
        assert.equal(deep.state, 'denied', '重新检测应保持无权限结论')

        await page.evaluate(
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-serial', accountId: 'reg-account', name: '串口权限主机', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseB, token: tokenB, accountUrl: accountB.wsBase, hostId: accountB.hostId, hostFingerprint: accountB.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        const section = dialog.locator('section[data-host-section]').filter({ hasText: baseB }).first()
        await section.getByText('Tandem Mock').waitFor({ timeout: 10_000 })

        // 单行：真实设备只占一行（与侧栏列表行同为 32px），不再两行。
        const usbRow = section.locator('[data-device-row="serial:mock://ttyUSB0"]')
        const box = await usbRow.boundingBox()
        assert.ok(box && box.height <= 34, `设备行不够紧凑：${box?.height}px`)
        assert.equal(await section.getByText(/^SERIAL$/).count(), 1, '类型应是行内小标签')

        // 板载串口默认折叠；名称与路径相同时不重复显示路径。
        assert.equal(await section.getByText('mock://ttyS0').count(), 0, '板载串口不应默认展开')
        const builtinToggle = section.getByRole('button', { name: /另有 4 个板载串口/ })
        await builtinToggle.waitFor({ timeout: 5_000 })
        await builtinToggle.click()
        const builtinRow = section.locator('[data-device-row="serial:mock://ttyS0"]')
        await builtinRow.waitFor({ timeout: 5_000 })
        const builtinText = await builtinRow.innerText()
        assert.equal((builtinText.match(/mock:\/\/ttyS0/g) ?? []).length, 1, '名称与路径相同时重复显示了路径')

        // 无权限：标签 + 修复说明（命令可复制、Host 不自动执行 sudo、可重新检测）。
        assert.equal(await usbRow.getByText('无权限', { exact: true }).count(), 1, '缺少无权限标签')
        await usbRow.getByRole('button', { name: '修复权限' }).click()
        await section.getByText('sudo usermod -aG dialout $USER', { exact: true }).waitFor({ timeout: 5_000 })
        assert.ok(await section.getByRole('button', { name: '复制命令' }).count(), '缺少一键复制命令')
        assert.equal(
          await section.getByText('Host 不会自动执行 sudo，请在终端里执行上面的命令。', { exact: true }).count(),
          1,
          '应说明 Host 不会自动执行 sudo',
        )
        assert.equal(await section.getByRole('button', { name: '我已处理，重新检测' }).count(), 1, '缺少重新检测入口')

        // 没打开会话时挂载按钮禁用，并在 tooltip 说明原因。
        const mountBtn = usbRow.getByRole('button', { name: '挂到当前会话' })
        assert.equal(await mountBtn.isDisabled(), true, '未打开会话时挂载按钮应禁用')
        assert.equal(
          await usbRow.getByText('先打开一个会话，再挂载设备', { exact: true }).count(),
          1,
          '禁用时应说明原因',
        )

        await dialog.getByRole('button', { name: '完成' }).click()
        await openSession(page, 'long')
        await openWorkstationPanel(page)
        const dialog2 = page.getByRole('dialog', { name: '设备' })
        await dialog2.waitFor({ state: 'visible' })
        const section2 = dialog2.locator('section[data-host-section]').filter({ hasText: baseB }).first()
        await section2.getByText('Tandem Mock').waitFor({ timeout: 10_000 })
        assert.equal(
          await section2.locator('[data-device-row="serial:mock://ttyUSB0"]').getByRole('button', { name: '挂到当前会话' }).isDisabled(),
          false,
          '打开会话后应能挂载',
        )
        await dialog2.getByRole('button', { name: '完成' }).click()
        await page.evaluate((url) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.url !== url)))
        }, baseB)
      } finally {
        hostB.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostB.child.once('exit', resolve)),
          sleep(3000).then(() => hostB.child.kill('SIGKILL')),
        ])
      }
    })

    desktop('演示设备：演示工作区提供可挂载的安卓/串口设备', async (page) => {
      const before = await api(base, token, '/api/demo')
      const createdHere = !before.active
      let sessionId
      try {
        const state = createdHere
          ? await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
          : before
        sessionId = state.scenarios.find((item) => item.id === 'chat-tools')?.sessionIds?.[0]
        assert.ok(sessionId, '演示场景没有会话')

        let list
        for (let i = 0; i < 20; i += 1) {
          list = await api(base, token, '/api/devices')
          if (list.devices.some((device) => device.id === 'adb:demo-pixel-8')) break
          await sleep(200)
        }
        const demoAdb = list.devices.find((device) => device.id === 'adb:demo-pixel-8')
        const demoSerial = list.devices.find((device) => device.id === 'serial:demo-board')
        assert.ok(demoAdb?.demo, '缺少演示安卓设备')
        assert.ok(demoSerial?.demo, '缺少演示串口设备')

        const serialMount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'serial:demo-board', name: demoSerial.name }),
        })
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200 }),
        })
        await sleep(700)
        const boot = await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`)
        assert.ok(boot.data.includes('[board] ESP32 demo board'), `演示串口没有启动日志：${boot.data}`)
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/write`, {
          method: 'POST',
          body: JSON.stringify({ data: 'help\n' }),
        })
        await sleep(200)
        const echoed = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=${boot.cursor}`,
        )
        assert.ok(echoed.data.includes('[board] commands: help'), `演示串口没有回显 help：${echoed.data}`)

        const adbMount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'adb:demo-pixel-8', name: demoAdb.name }),
        })
        assert.equal(adbMount.deviceId, 'adb:demo-pixel-8', '演示安卓设备未挂载')
        const shell = await api(base, token, `/api/devices/${encodeURIComponent('adb:demo-pixel-8')}/exec`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'shell', command: 'getprop ro.product.model' }),
        })
        assert.equal(shell.ok, true, '演示 adb shell 失败')
        assert.ok(shell.output.includes('Pixel 8'), `演示 adb 返回异常：${shell.output}`)

        // 反馈 #7-01：挂载后在会话里能看到演示画面（安卓模拟画面 + 串口滚动日志）。
        await openSession(page, sessionId)
        const stage = page.locator('[data-demo-stage]')
        await stage.waitFor({ state: 'visible', timeout: 15_000 })
        assert.match(await stage.innerText(), /演示画面/, '会话里没有演示画面卡片')
        assert.match(await stage.innerText(), /Pixel 8（演示）/, '演示画面缺少安卓设备')
        await stage.locator('[data-demo-phone]').waitFor({ timeout: 5_000 })
        const serialBox = stage.locator('[data-demo-serial]')
        await serialBox.waitFor({ timeout: 5_000 })
        const serialBefore = (await serialBox.innerText()).length
        await page.waitForTimeout(1800)
        const serialAfter = (await serialBox.innerText()).length
        assert.ok(serialAfter > serialBefore, '演示串口日志没有自动滚动')

        // 工作站界面标注「演示设备」。
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByText('演示设备', { exact: true }).first().waitFor({ timeout: 10_000 })
        assert.ok((await dialog.getByText('演示设备', { exact: true }).count()) >= 2, '演示设备没有全部标注')
        await dialog.getByRole('button', { name: '完成' }).click()
      } finally {
        // 本用例是最后一条：无论演示工作区是否由本用例创建，都清干净，
        // 避免残留设备影响后续轮次与真实数据。
        const nowState = await api(base, token, '/api/demo').catch(() => null)
        if (nowState?.active) await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' }).catch(() => {})
      }
      const after = await api(base, token, '/api/devices')
      assert.equal(
        after.devices.some((device) => device.demo),
        false,
        '清除演示数据后仍残留演示设备',
      )
    })

    desktop('调试版手机预览：弹窗按移动布局渲染并可打开侧栏抽屉（B）', async (page) => {
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: '命令面板' })
      await palette.waitFor({ timeout: 10_000 })
      await palette.getByPlaceholder(/命令|搜索/).first().fill('手机预览')
      const row = palette.getByText('打开手机预览', { exact: true }).first()
      await row.waitFor({ timeout: 10_000 })
      const popupPromise = page.waitForEvent('popup', { timeout: 10_000 })
      await row.click()
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      const bar = popup.locator('[data-mobile-preview-bar]')
      await bar.waitFor({ state: 'visible', timeout: 20_000 })
      const barText = await bar.innerText()
      assert.ok(barText.includes('手机预览 · 模拟'), `预览窗口没有模拟顶栏：${barText}`)
      assert.ok(barText.includes('无触摸模拟'), `浏览器版没有提示无法触摸模拟：${barText}`)
      assert.equal(
        await popup.evaluate(() => document.documentElement.dataset.mobilePreview),
        '1',
        '预览页面没有标记为手机预览',
      )
      // 平板预设也强制移动端布局；这里至少确认没有桌面侧栏、存在移动端「打开侧栏」。
      assert.equal(
        await popup.locator('aside[aria-label="侧栏"]').count(),
        0,
        '预览窗口仍是桌面布局（渲染了固定侧栏）',
      )
      await popup.getByRole('button', { name: '打开侧栏' }).first().click()
      const drawer = popup.locator('aside[aria-label="侧栏"]')
      await drawer.waitFor({ state: 'visible', timeout: 5_000 })
      // 模拟条独占顶部区域：抽屉标题「Tandem」必须完整露在它下方，不能与工具栏相交。
      const barBox = await bar.boundingBox()
      const title = drawer.getByText('Tandem', { exact: true }).first()
      await title.waitFor({ state: 'visible', timeout: 5_000 })
      const titleBox = await title.boundingBox()
      assert.ok(barBox && titleBox, '取不到模拟条或抽屉标题的位置')
      const overlap =
        titleBox.y < barBox.y + barBox.height &&
        titleBox.y + titleBox.height > barBox.y &&
        titleBox.x < barBox.x + barBox.width &&
        titleBox.x + titleBox.width > barBox.x
      assert.equal(overlap, false, `抽屉标题被手机预览工具栏遮挡：标题 ${JSON.stringify(titleBox)}，工具栏 ${JSON.stringify(barBox)}`)
      assert.ok(
        titleBox.y >= barBox.y + barBox.height - 0.5,
        `抽屉标题没有从工具栏下方开始：标题 ${JSON.stringify(titleBox)}，工具栏 ${JSON.stringify(barBox)}`,
      )
      const drawerBox = await drawer.boundingBox()
      assert.ok(
        drawerBox && titleBox.y + titleBox.height <= drawerBox.y + drawerBox.height + 0.5 && titleBox.y >= drawerBox.y - 0.5,
        '抽屉标题超出抽屉范围（被裁掉）',
      )
      await popup.close()
    })

    // 登录门：未登录先登录；登录后没有主机不能开会话，添加这台电脑后进入会话界面。
    checks.push({
      name: '登录门：未登录先登录、无主机空状态、添加这台电脑后可开会话',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        // 程序即工作站：页面由工作站自己托管，登录门在页面上创建工作站。
        const station = startWorkstation({ home: path.join(home, 'gate-station') })
        const gateHostId = randomUUID()
        try {
          const port = await station.ready
          const base = `http://127.0.0.1:${port}`
          await page.goto(`${base}/#/h/${gateHostId}`, { waitUntil: 'domcontentloaded' })
          await page.locator('[data-testid="login-gate"]').waitFor({ state: 'visible', timeout: 60_000 })
          // 深链保留在地址栏：登录前不处理路由，登录后回到原地址。
          assert.match(page.url(), /#\/h\/[0-9a-f-]+/, '登录前不应清掉深链')
          assert.equal(await page.locator('[data-testid="no-hosts"]').count(), 0, '未登录不应显示无主机空状态')
          assert.equal(await page.locator('[aria-label="消息输入框"]').count(), 0, '未登录不应进入会话界面')

          // 页面本身就是工作站：首次使用是「创建工作站」。
          const name = page.locator('[data-testid="login-workspace-name"]')
          await name.waitFor({ state: 'visible', timeout: 60_000 })
          await name.fill('回归登录门工作站')
          await page.locator('[data-testid="login-username"]').fill('gate-admin')
          await page.locator('[data-testid="login-password"]').fill('gate-pass-123')
          await page.locator('[data-testid="login-submit"]').click()

          // 登录后账号下没有主机：空状态引导添加主机，新会话入口禁用。
          await page.locator('[data-testid="no-hosts"]').waitFor({ state: 'visible', timeout: 30_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '登录后不应再显示登录页')
          assert.equal(
            await page.locator('[data-testid="sidebar-new-session"]').isDisabled(),
            true,
            '没有主机时新会话入口应禁用',
          )

          // 唯一的「添加主机」对话框里有「添加这台电脑」，直接在页面上登记本机。
          await page.locator('[data-testid="no-hosts-add"]').click()
          const addDialog = page.getByRole('dialog', { name: '添加主机' })
          await addDialog.waitFor({ state: 'visible', timeout: 15_000 })
          await addDialog.locator('[data-testid="addhost-local"]').click()
          // 登记成功后对话框显示「已连接」；关掉后回到工作台，空状态消失。
          await addDialog
            .locator('[data-testid="addhost-status"]')
            .filter({ hasText: '已连接' })
            .waitFor({ state: 'visible', timeout: 60_000 })
          await addDialog.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addDialog.waitFor({ state: 'hidden', timeout: 10_000 })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="no-hosts"]').count(), 0, '添加主机后空状态应消失')
          assert.equal(
            await page.locator('[data-testid="sidebar-new-session"]').isDisabled(),
            false,
            '有主机后新会话入口应可用',
          )
        } finally {
          station.child.kill('SIGTERM')
        }
      },
    })

    // 2026-11-11 用户要求：工作站与主机管理重新整理，只留一个主机列表、一个添加对话框。
    checks.push({
      name: '主机管理：唯一主机列表与详情抽屉、唯一添加入口、工作站页仅管理员',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const station = startWorkstation({ home: path.join(home, 'host-ia-station') })
        let ownContext
        try {
          const stationPort = await station.ready
          const stationUrl = `http://127.0.0.1:${stationPort}`
          const setup = await (
            await fetch(`${stationUrl}/api/workstation/setup`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: '回归工作站', username: 'ia-admin', password: 'ia-pass-123' }),
            })
          ).json()
          assert.ok(setup.accessToken, '工作站管理员创建失败')
          // 程序即工作站：本机作为进程内主机上下文登记（「添加这台电脑」）。
          const local = await api(stationUrl, setup.accessToken, '/api/workstation/hosts/local', { method: 'POST' })
          assert.ok(local.id, '登记本机失败')
          const hostName = local.name
          await waitForValue(async () => {
            const res = await fetch(`${stationUrl}/api/workstation/hosts`, {
              headers: { authorization: `Bearer ${setup.accessToken}` },
            })
            const list = await res.json()
            return list.some((item) => item.id === local.id && item.online) ? list : null
          }, 60_000, '本机主机应登记上线')

          // 独立上下文：页面由工作站托管，登录门直接登录。
          ownContext = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
          const p = await ownContext.newPage()
          p.setDefaultTimeout(15_000)
          await p.goto(`${stationUrl}/#/h/${local.id}`, { waitUntil: 'domcontentloaded' })
          await p.locator('[data-testid="login-gate"]').waitFor({ state: 'visible', timeout: 60_000 })
          await p.locator('[data-testid="login-username"]').waitFor({ state: 'visible', timeout: 30_000 })
          await p.locator('[data-testid="login-username"]').fill('ia-admin')
          await p.locator('[data-testid="login-password"]').fill('ia-pass-123')
          await p.locator('[data-testid="login-submit"]').click()
          await p.locator('[data-sidebar-footer]').waitFor({ timeout: 30_000 })

          // 唯一主机列表：我的徽标、行点击打开详情。
          const dialog = await openSettings(p, '主机', 'desktop')
          const rows = dialog.locator('[data-host-row]')
          await rows.first().waitFor({ timeout: 30_000 })
          assert.equal(await rows.count(), 1, '主机列表应只有登记的那一台')
          assert.ok((await rows.first().innerText()).includes(hostName), '主机列表缺少登记的主机')
          assert.ok((await rows.first().getByText('我的', { exact: true }).count()) >= 1, '主机列表缺少归属徽标')

          // 设置页的添加按钮打开唯一对话框。
          await dialog.getByRole('button', { name: '添加主机', exact: true }).click()
          const addDialog = p.getByRole('dialog', { name: '添加主机' })
          await addDialog.waitFor({ state: 'visible', timeout: 10_000 })
          await addDialog.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addDialog.waitFor({ state: 'hidden', timeout: 5_000 })

          // 点行打开详情：改名、设备、诊断、授权都在这里。
          await rows.first().click()
          const detail = p.getByRole('dialog', { name: '主机详情' })
          await detail.waitFor({ state: 'visible', timeout: 10_000 })
          for (const action of ['设备', '诊断', '重新连接', '授权']) {
            assert.equal(
              await detail.getByRole('button', { name: action, exact: true }).count(),
              1,
              `主机详情缺少「${action}」`,
            )
          }
          await detail.locator('input').first().fill(`${hostName}-改名`)
          await detail.getByRole('button', { name: '保存', exact: true }).click()
          await detail.getByRole('button', { name: '授权', exact: true }).click()
          const grant = p.getByRole('dialog', { name: new RegExp(`^授权「${hostName}`) })
          await grant.waitFor({ state: 'visible', timeout: 10_000 })
          assert.ok(await grant.getByText('账号', { exact: true }).count(), '授权弹层缺少账号选择')
          await grant.getByRole('button', { name: '取消', exact: true }).click()
          await grant.waitFor({ state: 'hidden', timeout: 5_000 })
          await detail.getByRole('button', { name: '完成', exact: true }).click()
          await detail.waitFor({ state: 'hidden', timeout: 5_000 })
          await rows.first().waitFor({ timeout: 5_000 })
          assert.ok((await rows.first().innerText()).includes(`${hostName}-改名`), '改名后列表没有立即更新')
          await closeSettings(p)

          // 环境条主机菜单：固定两项「管理主机…」「添加主机…」，后者打开同一对话框。
          await p.locator('[data-env-bar-row] button[aria-haspopup="menu"]').first().click()
          const hostMenu = p.getByRole('menu').filter({ hasText: '管理主机' }).first()
          await hostMenu.waitFor({ timeout: 5_000 })
          assert.ok(await hostMenu.getByRole('menuitem', { name: '管理主机…', exact: true }).count(), '主机菜单缺少管理主机')
          await hostMenu.getByRole('menuitem', { name: '添加主机…', exact: true }).click()
          const addFromEnv = p.getByRole('dialog', { name: '添加主机' })
          await addFromEnv.waitFor({ state: 'visible', timeout: 10_000 })
          await addFromEnv.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addFromEnv.waitFor({ state: 'hidden', timeout: 5_000 })

          // 命令面板只有一条「添加主机…」，打开的是同一个对话框。
          await p.keyboard.press('Control+k')
          const palette = p.getByRole('dialog', { name: '命令面板' })
          await palette.waitFor({ state: 'visible', timeout: 10_000 })
          await palette.getByPlaceholder(/命令|搜索/).first().fill('添加主机')
          await p.waitForTimeout(500)
          const addCommands = palette.getByText('添加主机…', { exact: true })
          assert.equal(await addCommands.count(), 1, '命令面板里「添加主机」应只有一条')
          await addCommands.first().click()
          const addFromPalette = p.getByRole('dialog', { name: '添加主机' })
          await addFromPalette.waitFor({ state: 'visible', timeout: 10_000 })
          await addFromPalette.getByRole('button', { name: /关闭|完成/ }).first().click()

          // 设置 → 工作站：管理员可见，只放工作站级设置，不再有主机列表。
          const workstation = await openSettings(p, '工作站', 'desktop')
          const wsText = await workstation.locator('[data-settings-page-content="workstation"]').innerText()
          assert.match(wsText, /工作站名称/, '工作站页缺少名称设置')
          assert.match(wsText, /注册与邀请/, '工作站页缺少注册与邀请')
          assert.match(wsText, /成员/, '工作站页缺少成员列表')
          assert.doesNotMatch(wsText, /我的主机|添加主机/, `工作站页仍出现主机管理：${wsText.slice(0, 120)}`)
          await closeSettings(p)

          // 非管理员：导航里没有「工作站」。
          await p.evaluate(() => {
            const raw = localStorage.getItem('tandem.account.v1')
            if (!raw) return
            const session = JSON.parse(raw)
            session.account = { ...session.account, role: 'member' }
            localStorage.setItem('tandem.account.v1', JSON.stringify(session))
          })
          await p.reload({ waitUntil: 'domcontentloaded' })
          await p.locator('[data-sidebar-footer]').waitFor({ timeout: 30_000 })
          await p.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
          const memberSettings = p.getByRole('dialog', { name: '设置' })
          await memberSettings.waitFor({ state: 'visible', timeout: 10_000 })
          assert.equal(
            await memberSettings.locator('[data-settings-page="workstation"]').count(),
            0,
            '非管理员不应看到设置 → 工作站',
          )
        } finally {
          await ownContext?.close().catch(() => undefined)
          station.child.kill('SIGTERM')
        }
      },
    })

    // 调试版：回环地址自动登录调试账号（本机 + 演示主机），一行命令添加主机并实时显示已连接。
    checks.push({
      name: '登录门：调试版自动登录带演示主机，一行命令添加主机后显示已连接',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const gateToken = `gate-${randomUUID()}`
        const debugHome = path.join(home, 'gate-debug-host')
        // 不传 TANDEM_DEBUG_ACCOUNT（显式 undefined 让调试版默认值生效）：自动拉起工作站、登记本机与演示主机。
        const debugHost = startHost({
          home: debugHome,
          token: gateToken,
          hostId: randomUUID(),
          extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined },
        })
        let installHome = ''
        let installer
        try {
          const port = await debugHost.ready
          const debugBase = `http://127.0.0.1:${port}`
          await page.goto(`${debugBase}/`, { waitUntil: 'domcontentloaded' })
          // 自动登录完成前不闪登录页；完成后直接进入主界面。
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '调试版回环地址应自动登录')
          const names = await waitForValue(async () => {
            const list = await page.evaluate(() => {
              try {
                return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
              } catch {
                return []
              }
            })
            return list.length >= 2 ? list : null
          }, 60_000, '调试账号应看到本机与演示主机')
          assert.ok(names.some((h) => h.name === '演示主机'), `主机列表缺少演示主机：${names.map((h) => h.name)}`)
          assert.ok(names.some((h) => h.name !== '演示主机'), '主机列表缺少本机')
          await page.getByText('演示主机', { exact: true }).first().waitFor({ timeout: 15_000 })

          // 打开「添加主机」：命令里是一次性令牌；在 WSL 里执行真实 install.sh 模拟目标机器。
          await page.keyboard.press('Control+K')
          const input = page.getByPlaceholder(/命令|搜索/).first()
          await input.waitFor({ state: 'visible' })
          await input.fill('添加主机')
          await page.waitForTimeout(500)
          // 命令面板里点结果（Enter 在搜索防抖未完成时可能选中别的分组）。
          await page.locator('[data-palette-kind]').filter({ hasText: '添加主机' }).first().click()
          const commandBox = page.locator('[data-testid="addhost-command"]')
          await commandBox.waitFor({ state: 'visible', timeout: 15_000 })
          const commandText = await commandBox.innerText()
          const token = commandText.match(/ach_[A-Za-z0-9_.-]+/)?.[0]
          assert.ok(token, `添加主机命令里没有注册令牌：${commandText}`)
          // 命令里的地址就是登录的工作站地址（回环时其他机器不可访问，但本机 WSL 可以）。
          const shareUrl = await page.evaluate(() => {
            try {
              return JSON.parse(localStorage.getItem('tandem.account.v1') ?? 'null')?.centerUrl ?? ''
            } catch {
              return ''
            }
          })
          assert.match(shareUrl, /^https?:\/\/[^/]+/, `宿主地址不对：${shareUrl}`)
          assert.ok(commandText.includes(shareUrl), `命令里的工作站地址与登录地址不一致：${commandText}`)

          installHome = path.join(home, 'gate-install', 'home')
          const env = {
            ...process.env,
            HOME: installHome,
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          }
          // 安装脚本前台连接工作站、不会自行退出：等输出出现「已登记并连接工作站」后再看对话框。
          installer = spawn('sh', ['-c', `curl -fsSL ${shareUrl}/install.sh | sh -s -- --token ${token}`], {
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let installOut = ''
          installer.stdout.setEncoding('utf8')
          installer.stdout.on('data', (chunk) => (installOut += chunk))
          installer.stderr.setEncoding('utf8')
          installer.stderr.on('data', (chunk) => (installOut += chunk))
          await waitForValue(
            () => (/已登记并连接工作站/.test(installOut) || installer.exitCode !== null ? true : null),
            120_000,
            '安装脚本应前台连接工作站',
          )
          assert.match(installOut, /已登记并连接工作站/, `安装脚本应完成登记并保持前台连接：${installOut}`)

          const status = page.locator('[data-testid="addhost-status"]')
          await page.waitForFunction(
            () => document.querySelector('[data-testid="addhost-status"]')?.textContent?.includes('已连接'),
            null,
            { timeout: 60_000 },
          )
          assert.match(await status.innerText(), /已连接/, '对话框应实时显示已连接')
        } finally {
          if (installer?.pid) {
            try {
              process.kill(-installer.pid, 'SIGTERM')
            } catch {
              // 安装脚本已退出
            }
          }
          killExecutorsUnder(installHome)
          debugHost.child.kill('SIGTERM')
        }
      },
    })

    // 调试版：工作站重启后本机与演示主机仍在线（数据在同一目录），界面不出现「重新连接中…」。
    checks.push({
      name: '登录门：工作站重启后本机与演示主机仍在线、能开会话',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const debugHome = path.join(home, 'gate-restart-ws')
        const first = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: randomUUID(),
        })
        const firstInfo = await first.session
        first.child.kill('SIGTERM')
        await new Promise((resolve) => first.child.once('exit', resolve))

        const second = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: firstInfo.hostId,
        })
        try {
          const info = await second.session
          const hosts = await api(info.wsBase, info.token, '/api/workstation/hosts')
          const local = hosts.find((item) => item.id === info.hostId)
          const demo = hosts.find((item) => item.name === '演示主机')
          assert.ok(local?.online, '重启后本机主机应在线')
          assert.ok(demo?.online, '重启后演示主机应在线')

          await page.goto(`${info.wsBase}/`, { waitUntil: 'domcontentloaded' })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '调试版回环地址应自动登录')

          const dialog = await openSettings(page, '主机', 'desktop')
          await dialog.getByText('在线', { exact: true }).first().waitFor({ timeout: 30_000 })
          await dialog.getByRole('button', { name: '关闭' }).click()
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
          assert.equal(
            await page.getByText('主机未连上工作站').filter({ visible: true }).count(),
            0,
            '主机被误报为未连上工作站',
          )
          assert.equal(
            await page.getByText('重新连接中…').filter({ visible: true }).count(),
            0,
            '主机在线时仍显示重新连接中',
          )

          await page.locator('[data-testid="sidebar-new-session"]').click()
          const textarea = page.locator('[aria-label="消息输入框"]')
          await textarea.waitFor({ state: 'visible', timeout: 10_000 })
          await textarea.fill('工作站重启后新建会话')
          const send = page.getByRole('button', { name: '发送消息' })
          await send.waitFor({ timeout: 10_000 })
          assert.equal(await send.isDisabled(), false, '新会话不能发送')
        } finally {
          second.child.kill('SIGTERM')
        }
      },
    })

    // 调试版：直接打开工作站地址自动登录，且不在状态接口上反复收到 401。
    checks.push({
      name: '登录门：调试版不带 token 打开回环地址自动进入，且不循环请求 401',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const debugHome = path.join(home, 'gate-debug-bare-host')
        const debugHost = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: randomUUID(),
          extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined },
        })
        const statusCodes = []
        page.on('response', (res) => {
          if (res.url().includes('/api/workstation/status')) statusCodes.push(res.status())
        })
        try {
          const port = await debugHost.ready
          await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '打开调试版工作站地址应自动登录')
          const unauthorized = statusCodes.filter((code) => code === 401).length
          assert.equal(unauthorized, 0, `Host 页面不应反复请求工作站状态得到 401：${statusCodes.join(',')}`)
        } finally {
          debugHost.child.kill('SIGTERM')
        }
      },
    })

    // ---------------------------------------------------- 反馈1323（2026-11-11）
    const fix1323Shots = '/tmp/fix-1323c'
    const shot1323 = (name) => path.join(fix1323Shots, name)
    /** 截图用：把页面切到浅色（主题由 root 的 dark 类控制）。 */
    const useLightTheme = async (page) => {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark')
        document.documentElement.style.colorScheme = 'light'
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#faf9f5')
        localStorage.setItem('tandem.theme.v1', 'light')
      })
      await page.waitForTimeout(120)
    }

    fb2102('反馈1323#04：侧栏底部一行账号 + 齿轮，账号菜单只放账号与工作站设置', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      // 工作区账号只存在 localStorage；主机仍用已连上的直连地址，不新增网络依赖。
      await page.evaluate(() => {
        const now = Date.now()
        localStorage.setItem(
          'tandem.account.v1',
          JSON.stringify({
            centerUrl: 'http://127.0.0.1:9',
            accessToken: 'reg-access',
            refreshToken: 'reg-refresh',
            accessExpiresAt: now + 86_400_000,
            refreshExpiresAt: now + 30 * 86_400_000,
            account: { id: 'acc-reg', name: '调试账号', username: 'debug', role: 'admin', debug: true },
            workspace: { id: 'ws-reg', name: '调试' },
          }),
        )
      })
      await page.reload()
      const footer = page.locator('aside [data-sidebar-footer]')
      await footer.waitFor({ timeout: 20_000 })
      const controls = await footer.locator('button').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { y: r.y, h: r.height, w: r.width, x: r.x }
        }),
      )
      assert.equal(controls.length, 2, `侧栏底部应只有账号与齿轮两个控件：${controls.length}`)
      assert.ok(
        Math.abs(controls[0].y + controls[0].h / 2 - (controls[1].y + controls[1].h / 2)) <= 1,
        '账号与齿轮不在同一行',
      )
      assert.ok(controls[0].w > controls[1].w && controls[0].x < controls[1].x, '账号在左、齿轮在右')
      const footerText = await footer.innerText()
      assert.match(footerText, /调试账号/, '底部没有显示账号名')
      assert.doesNotMatch(footerText, /工作站/, `底部不应再有整行「工作站」：${footerText}`)
      assert.doesNotMatch(footerText, /^设置$/m, `底部不应再有整行「设置」：${footerText}`)

      // 齿轮是唯一设置入口。
      await footer.getByRole('button', { name: '设置', exact: true }).click()
      const settingsDialog = page.getByRole('dialog', { name: '设置' })
      await settingsDialog.waitFor({ timeout: 5_000 })
      await settingsDialog.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await settingsDialog.waitFor({ state: 'hidden', timeout: 5_000 })

      const accountTrigger = footer.getByRole('button', { name: /调试账号/ })
      await accountTrigger.click()
      const menu = page.getByRole('menu')
      await menu.waitFor({ timeout: 5_000 })
      const items = (await menu.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())
      assert.ok(items.includes('账号设置'), `账号菜单缺少账号设置：${items.join(' / ')}`)
      assert.ok(items.includes('工作站设置'), `账号菜单缺少工作站设置：${items.join(' / ')}`)
      assert.ok(items.some((text) => text.includes('退出')), `账号菜单缺少退出登录：${items.join(' / ')}`)
      assert.ok(!items.includes('工作站'), `账号菜单不应再有设备入口：${items.join(' / ')}`)
      assert.ok(!items.includes('设备'), `账号菜单不应再有设备入口：${items.join(' / ')}`)
      assert.ok(!items.some((text) => text.includes('工作站管理')), `旧「工作站管理」应已改名：${items.join(' / ')}`)
      await page.waitForTimeout(200)
      await page.screenshot({ path: shot1323('04-sidebar-account-menu-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('04-sidebar-account-menu-light.png') })

      // 账号设置与工作站设置都直达唯一设置入口。
      await menu.getByRole('menuitem', { name: '账号设置', exact: true }).click()
      const accountSettings = page.getByRole('dialog', { name: '设置' })
      await accountSettings.waitFor({ timeout: 5_000 })
      await accountSettings.locator('[data-settings-page-content="profiles"]').waitFor({ timeout: 5_000 })
      await accountSettings.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await accountSettings.waitFor({ state: 'hidden', timeout: 5_000 })

      await accountTrigger.click()
      await menu.waitFor({ timeout: 5_000 })
      await menu.getByRole('menuitem', { name: '工作站设置', exact: true }).click()
      const workstationDialog = page.getByRole('dialog', { name: '设置' })
      await workstationDialog.waitFor({ timeout: 5_000 })
      await workstationDialog.locator('[data-settings-page-content="workstation"]').waitFor({ timeout: 5_000 })
      await workstationDialog.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await page.getByRole('menu').waitFor({ state: 'detached', timeout: 2_000 }).catch(() => {})
      assert.equal(await page.getByRole('menu').count(), 0, '选中菜单项后账号菜单应收起')

      await page.evaluate(() => localStorage.removeItem('tandem.account.v1'))
    })

    fb2102('反馈1323#01：新功能提示条 30 秒未点开自动收起，本版本不再弹', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const closePill = page.getByRole('button', { name: '暂时关闭新功能提示' })
      // 假时钟：页面里的 30 秒计时由 page.clock 控制，不真等 30 秒。
      await page.clock.install({ time: new Date(today) })
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload()
      await closePill.waitFor({ timeout: 20_000 })
      await page.screenshot({ path: shot1323('01-tour-pill-visible-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('01-tour-pill-visible-light.png') })

      await page.clock.fastForward(29_000)
      assert.equal(await closePill.count(), 1, '不到 30 秒提示条不应收起')
      await page.clock.fastForward(2_000)
      assert.equal(await closePill.count(), 0, '30 秒没点开，提示条应自动收起')
      const seen = await page.evaluate(() => localStorage.getItem('tandem.changelogSeen.v1'))
      assert.ok(seen, '收起后应记为本版本已读')

      await page.reload()
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
      assert.equal(await closePill.count(), 0, '同一版本内不应再弹出')

      // 点开过就按现有逻辑：导览面板不会因为 30 秒到点被自动收起。
      await page.evaluate(() => localStorage.removeItem('tandem.changelogSeen.v1'))
      await page.reload()
      const openPill = page.getByRole('button', { name: /^新功能 · \d+ 项/ })
      await openPill.waitFor({ timeout: 20_000 })
      await openPill.click()
      const panel = page.getByRole('region', { name: '新功能导览' })
      await panel.waitFor({ timeout: 5_000 })
      await page.clock.fastForward(31_000)
      assert.equal(await panel.count(), 1, '点开后的导览不应被自动收起')
    })

    fb2102('反馈1323#02：分组只显示一个 Key，无拖动/故障切换/轮询/添加 Key', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const dialog = await openSettings(page, '账号与模型', 'desktop')
      const accountRow = dialog.locator('button[aria-expanded]').filter({ hasText: '主力账号' }).first()
      await accountRow.waitFor({ timeout: 10_000 })
      if ((await accountRow.getAttribute('aria-expanded')) !== 'true') await accountRow.click()
      const card = dialog.locator('[data-group-card="g1"]')
      await card.waitFor({ timeout: 10_000 })
      const cardText = await card.innerText()
      assert.doesNotMatch(cardText, /拖动 Key|故障切换|轮询|添加 Key/, `分组卡仍有旧 Key 管理文案：${cardText}`)
      assert.doesNotMatch(cardText, /\d+ 个? ?Key|\d+ 个模型/, `分组卡仍显示 Key/模型数量：${cardText}`)
      const keys = card.locator('[data-key-masked]')
      assert.equal(await keys.count(), 1, '每个分组只应显示一个 Key')
      assert.match((await keys.first().innerText()).trim(), /^reg-\*{4}/, 'Key 掩码不对')
      assert.match(cardText, /可用/, 'Key 状态没有显示')
      const cardBox = await card.boundingBox()
      assert.ok(cardBox && cardBox.height <= 40, `分组卡不是单行紧凑排版：${cardBox?.height}`)
      await page.screenshot({ path: shot1323('02-group-single-key-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('02-group-single-key-light.png') })

      const groupOf = async () => {
        const profiles = (await api(wsBase, token, '/api/workstation/profiles')).profiles
        return profiles.find((item) => item.id === 'p-main')?.groups?.find((item) => item.id === 'g1')
      }
      assert.equal((await groupOf())?.keys?.length, 2, '夹具应有两个旧 Key')

      // 更换 Key：只改显示的那个，旧数据里另一个 Key 保留（不显示也不删除）。
      await card.locator('[data-key-replace]').click()
      await card.locator('[data-key-input]').fill('sk-new-reg-key-1234')
      await card.getByRole('button', { name: '保存', exact: true }).click()
      await waitUntil('分组 Key 更换生效', async () => {
        const group = await groupOf()
        return group?.keys?.[0]?.id === 'k-g1-a' && /^sk-n/.test(group?.keys?.[0]?.apiKeyMasked ?? '')
      })
      const replaced = await groupOf()
      assert.equal(replaced.keys.length, 2, '更换 Key 不应删除旧数据里的其他 Key')
      assert.equal(replaced.keys[1].id, 'k-g1-b', '隐藏的旧 Key 被改动')
      await card.locator('[data-key-masked]').first().waitFor({ timeout: 5_000 })
      assert.equal(await card.locator('[data-key-masked]').count(), 1, '更换后仍只显示一个 Key')

      // 删除显示的 Key 后，下一个旧 Key 接着显示。
      await card.locator('[data-key-delete]').click()
      await waitUntil('删除 Key 后显示下一个', async () => {
        const group = await groupOf()
        return group?.keys?.length === 1 && group.keys[0].id === 'k-g1-b'
      })
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-group-card="g1"] [data-key-masked]')
          return !!el && (el.textContent ?? '').startsWith('reg-')
        },
        null,
        { timeout: 5_000 },
      )
      assert.equal(await card.locator('[data-key-masked]').count(), 1, '删除后仍只显示一个 Key')
      assert.match((await card.locator('[data-key-masked]').first().innerText()).trim(), /^reg-\*{4}/, '删除后没有显示剩下的旧 Key')
      await closeSettings(page)
    })

    fb2102('反馈1323#03：路由提示行可展开看本轮注入，未注入时说明', async (page) => {
      mkdirSync(fix1323Shots, { recursive: true })
      const divisionSettings = {
        preference: 'balanced',
        candidates: [
          { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
          { profileId: 'p-route', model: 'route-mid', tier: 'balanced' },
          { profileId: 'p-route', model: 'route-kimi', tier: 'balanced' },
          { profileId: 'p-route', model: 'route-power', tier: 'power' },
        ],
        division: {
          planner: { profileId: 'p-route', model: 'route-power', tier: 'power' },
          executor: { profileId: 'p-route', model: 'route-mini', tier: 'fast' },
          domains: [
            { profileId: 'p-route', model: 'route-kimi', domain: 'ui', minComplexity: 35, note: '前端强项' },
          ],
          planThreshold: 35,
          confirm: 'never',
        },
      }
      await api(base, token, '/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ resumeOnRestart: 'auto', modelRouting: divisionSettings }),
      })
      const session = await api(base, token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          cwd: repo,
          profileId: 'p-route',
          model: 'route-power',
          permissionMode: 'bypassPermissions',
          delegation: 'more',
          title: '提示行透明回归',
        }),
      })
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
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      const sessionOf = () => api(base, token, `/api/sessions/${session.id}`)
      const sendTurn = async (text, expected) => {
        const before = (await sessionOf()).messages.length
        await page.locator('[aria-label="消息输入框"]').fill(text)
        await page.getByRole('button', { name: '发送消息' }).click()
        await waitUntil(`提示行回归：${text.slice(0, 8)}`, async () => {
          const current = await sessionOf()
          return (
            current.status === 'idle' &&
            current.messages.length > before &&
            JSON.stringify(current.messages).includes(expected)
          )
        })
        return sessionOf()
      }

      // 单代理直接问答：没有注入，悬停说明只用于选择分工与模型。
      const direct = await sendTurn('解释一下这个函数的作用', '路由模型 route-power 已回复。')
      const directPlan = direct.messages.filter((message) => message.routePlan).at(-1)?.routePlan
      assert.equal(directPlan?.mode, 'direct', '问答回合应为单代理')
      assert.equal(directPlan?.injected, undefined, '单代理回合不应记录注入文本')
      const directLine = page.locator('[data-route-plan="direct"]').last()
      await directLine.waitFor({ timeout: 10_000 })
      assert.equal(await directLine.getAttribute('data-route-injected'), null, '无注入时不应出现展开按钮')
      await directLine.hover()
      const tip = page.locator('#tandem-tooltip[data-open]')
      await tip.waitFor({ timeout: 5_000 })
      assert.match(await tip.innerText(), /未向模型注入内容/, '无注入时没有说明')
      await page.screenshot({ path: shot1323('03-route-line-no-injection-dark.png') })

      // 多代理协作：提示行展开就是本轮实际注入的原文。
      const divisionText =
        '请帮我完成前端批量改造：批量修改所有组件的按钮间距与布局样式，然后跑一遍 lint 和测试，最后整理结果。请注意不要改动后端接口，保持现有样式变量不变，完成后说明改了哪些文件。'
      const division = await sendTurn(divisionText, '多代理协作完成：已审查执行结果，样式与测试均通过。')
      const plan = division.messages.filter((message) => message.routePlan).at(-1)?.routePlan
      assert.equal(plan?.mode, 'division', '任务应为多代理协作')
      assert.ok((plan?.injected?.length ?? 0) >= 2, '多代理协作应记录注入段落')
      assert.match(plan.injected[0].content, /分工：积极/, '缺少分工系统提示段')
      assert.match(plan.injected[1].content, /\[多代理协作 · 本轮\]/, '缺少本轮规划者说明')
      const line = page.locator('[data-route-plan="division"]').last()
      await line.waitFor({ timeout: 10_000 })
      assert.equal(await line.getAttribute('data-route-injected'), 'true', '有注入时提示行应可展开')
      assert.match(await line.innerText(), /本轮注入 2 段/, '提示行没有标明注入段数')
      await page.screenshot({ path: shot1323('03-route-line-collapsed-dark.png') })
      await line.getByRole('button').click()
      const injection = line.locator('[data-route-injection]')
      await injection.waitFor({ timeout: 5_000 })
      const shown = await injection.innerText()
      assert.match(shown, /分工：积极/, '展开后看不到分工注入原文')
      assert.match(shown, /\[多代理协作 · 本轮\]/, '展开后看不到规划者注入原文')
      assert.match(shown, /分类理由：/, '展开后看不到分类理由')
      await page.screenshot({ path: shot1323('03-route-line-expanded-dark.png') })
      await useLightTheme(page)
      await page.screenshot({ path: shot1323('03-route-line-expanded-light.png') })
    })

    // 工作站客户端-服务：只跑工作站 + 两台主机，注册/绑定/授权/E2E 流式（API 级，独立进程）。
    checks.push({
      name: '工作站客户端-服务（注册/添加主机/授权/E2E 流式）',
      viewport: 'desktop',
      fn: async () => {
        await runWorkstationCheck(home)
      },
    })

    // 远端执行器：一行命令安装（假 HOME）→ 浏览器登录 → 主机在线 → 远端会话 Write 写入、Bash 读回。
    checks.push({
      name: '远端执行器：一行命令安装、主机在线、远端会话写入并读回文件',
      viewport: 'desktop',
      fn: async () => {
        await runExecutorCheck(home)
      },
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
      if (check.gate) {
        // 登录门用例用独立 context：前面的用例可能通过 context 级 init script / 登录状态污染共享存储。
        ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
        ownContext = true
      } else if (check.context === 'offline') {
        ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
        ownContext = true
      } else if (check.context === 'win32') {
        ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
        await ctx.addInitScript(() => {
          window.tandemDesktop = { isDesktop: true, platform: 'win32' }
        })
        ownContext = true
      } else if (check.context === 'fb2102') {
        ctx = await browser.newContext({ viewport: { width: 1912, height: 914 }, deviceScaleFactor: 1 })
        await ctx.addInitScript(() => {
          localStorage.setItem('tandem.theme.v1', 'dark')
        })
        ownContext = true
      }
      const page = await newPage(ctx, check.viewport, { gate: !!check.gate })
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
