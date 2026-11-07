/** 模型 ID → 面向用户的友好名称。 */
export function prettyModel(id: string): string {
  if (!id) return '选择模型'
  const known: Record<string, string> = {
    'claude-opus-4-1': 'Claude Opus 4.1',
    'claude-opus-4': 'Claude Opus 4',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-3-7-sonnet': 'Claude Sonnet 3.7',
    'gpt-5': 'GPT-5',
    'gpt-4o': 'GPT-4o',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
  }
  if (known[id]) return known[id]
  const family = /^claude-(\d+)-(\d+)-(sonnet|opus|haiku)/.exec(id)
  if (family) {
    return `Claude ${family[3][0].toUpperCase()}${family[3].slice(1)} ${family[1]}.${family[2]}`
  }
  const family2 = /^claude-(sonnet|opus|haiku)-(\d+)-(\d+)/.exec(id)
  if (family2) {
    return `Claude ${family2[1][0].toUpperCase()}${family2[1].slice(1)} ${family2[2]}.${family2[3]}`
  }
  const family3 = /^claude-(\d+)-(sonnet|opus|haiku)/.exec(id)
  if (family3) {
    return `Claude ${family3[2][0].toUpperCase()}${family3[2].slice(1)} ${family3[1]}`
  }
  let s = id.replace(/^claude-/, 'Claude ')
  s = s.replace(/-\d{8}$/, '')
  s = s.replace(/-(\d+)-(\d+)$/, ' $1.$2')
  s = s.replace(/-(\d+)$/, ' $1')
  if (!/^claude/i.test(s)) s = s.replace(/[-_]/g, ' ')
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 手机底栏窄，去掉「Claude」前缀，把宽度让给权限与发送。 */
export function shortModelName(id: string): string {
  return prettyModel(id).replace(/^Claude\s+/i, '')
}
