import { describe, expect, it } from 'vitest'
import type { Message } from '@tandem/protocol'
import { countTurns, isUserTurnMessage, userTurnMessages } from '@tandem/protocol'

const text = (id: string, role: 'user' | 'assistant', value: string, extra: Partial<Message> = {}): Message => ({
  id,
  role,
  createdAt: 0,
  content: [{ type: 'text', text: value }],
  ...extra,
})

const toolResult = (id: string): Message => ({
  id,
  role: 'user',
  createdAt: 0,
  content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'ok' }],
})

describe('轮次统计口径', () => {
  it('tool_result 的 user 消息不算一轮', () => {
    const messages = [
      text('u1', 'user', '第一轮'),
      toolResult('tr1'),
      text('a1', 'assistant', '回复'),
      text('u2', 'user', '第二轮'),
      toolResult('tr2'),
      text('u3', 'user', '第三轮'),
      text('u4', 'user', '第四轮'),
    ]
    expect(countTurns(messages)).toBe(4)
    expect(userTurnMessages(messages).map((message) => message.id)).toEqual(['u1', 'u2', 'u3', 'u4'])
  })

  it('压缩摘要、分页缺口与空文本不计轮次', () => {
    const messages = [
      text('u1', 'user', '真实消息'),
      text('s1', 'user', '压缩摘要', { summary: true }),
      { ...text('g1', 'user', '缺口占位'), gap: { beforeId: 'x' } },
      text('u2', 'user', '   '),
      text('a1', 'assistant', '回复'),
      { ...text('u3', 'user', ''), content: [{ type: 'image', mediaType: 'image/png', dataBase64: '' }] },
    ]
    expect(countTurns(messages)).toBe(2)
    expect(isUserTurnMessage(messages[1]!)).toBe(false)
    expect(isUserTurnMessage(messages[2]!)).toBe(false)
    expect(isUserTurnMessage(messages[3]!)).toBe(false)
    expect(isUserTurnMessage(messages[5]!)).toBe(true)
  })
})

describe('外部会话注入内容不算用户轮（反馈16#05 / R07）', () => {
  it('developer/system 注入、skills 与 multi_agent_role 不冒充用户发言', () => {
    const messages = [
      text('i1', 'user', 'You are Codex, an agent based on GPT-6. You and the user share one workspace.'),
      text('i2', 'user', '<skills_instructions>\n## Skills\nA skill is a set of local instructions.'),
      text('i3', 'user', '<multi_agent_role>You are `/root`, the primary agent in a team of agents.'),
      text('i4', 'user', '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>使用 pnpm。</INSTRUCTIONS>'),
      text('i5', 'user', '<multi_agent_mode>Any earlier instruction enabling proactive delegation'),
      text('u1', 'user', '真实第一轮：看一下构建'),
      text('a1', 'assistant', '好的。'),
      text('u2', 'user', '真实第二轮：继续'),
    ]
    expect(countTurns(messages)).toBe(2)
    expect(userTurnMessages(messages).map((message) => message.id)).toEqual(['u1', 'u2'])
  })

  it('注入文本与真实文本混在同一条消息时仍按用户轮处理', () => {
    const message: Message = {
      id: 'mixed',
      role: 'user',
      createdAt: 0,
      content: [
        { type: 'text', text: '<system-reminder>环境</system-reminder>' },
        { type: 'text', text: '请修复登录页 401' },
      ],
    }
    expect(isUserTurnMessage(message)).toBe(true)
  })
})
