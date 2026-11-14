/**
 * 假 OpenAI 兼容端点：各用例按请求内容返回固定回复，不访问外网。
 */
import http from 'node:http'
import { sleep } from './common.mjs'

export function createMockProvider() {
  // 配额交接用例：主分组第一次成功、之后 429；备用分组始终可用。
  let quotaHits = 0
  // 反馈0220#02：继续使用当前分组（第 1、3 次 429，其余成功）与关闭交接（第 1 次 429）用例。
  let quotaContinueHits = 0
  let quotaOffHits = 0
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
    if (body.model === 'quota-continue-model') {
      quotaContinueHits += 1
      // 第 1 次：交接卡；第 3 次：验证继续后同类提醒不再拦截（直接重试成功）。
      if (quotaContinueHits === 1 || quotaContinueHits === 3) {
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
      quotaStream(res, quotaContinueHits === 2 ? '继续使用当前分组后完成。' : '继续后第三轮完成。')
      return
    }
    if (body.model === 'quota-off-model') {
      quotaOffHits += 1
      if (quotaOffHits === 1) {
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
      quotaStream(res, '关闭交接后本轮完成。')
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

