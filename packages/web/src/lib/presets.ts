import type { ProviderKind } from '@tandem/protocol'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  defaultModel: string
  /** 品牌色，仅用于服务商标识，不进入主题体系 */
  color: string
}

/** 新建账号的常用预设。模型列表只是候选项，可随时手改。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    color: '#D97757',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
    defaultModel: 'gpt-5',
    color: '#10A37F',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    color: '#4D6BFE',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-chat',
    ],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    color: '#6366F1',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen3', 'llama3.3', 'deepseek-r1'],
    defaultModel: 'qwen3',
    color: '#7A7468',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-2.5-flash',
    color: '#4285F4',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    defaultModel: 'kimi-k2',
    color: '#3B3B3B',
  },
  {
    id: 'qwen',
    name: '通义千问',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    defaultModel: 'qwen-plus',
    color: '#615CED',
  },
]

/** 根据账号的 Base URL / 接口类型推断对应的服务商预设，用于品牌标识与推荐模型。 */
export function presetForProfile(profile: {
  kind: ProviderKind
  baseUrl?: string
}): ProviderPreset | undefined {
  const normalize = (u?: string) => (u ?? '').trim().replace(/\/+$/, '').toLowerCase()
  const baseUrl = normalize(profile.baseUrl)
  if (baseUrl) {
    const byUrl = PROVIDER_PRESETS.find((p) => normalize(p.baseUrl) === baseUrl)
    if (byUrl) return byUrl
  }
  return PROVIDER_PRESETS.find((p) => p.kind === profile.kind)
}
