import type { ProviderKind } from '@tandem/protocol'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  defaultModel: string
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
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
    defaultModel: 'gpt-5',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
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
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen3', 'llama3.3', 'deepseek-r1'],
    defaultModel: 'qwen3',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    defaultModel: 'kimi-k2',
  },
  {
    id: 'qwen',
    name: '通义千问',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    defaultModel: 'qwen-plus',
  },
]
