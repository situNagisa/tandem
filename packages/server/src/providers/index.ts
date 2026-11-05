// provider 统一入口。
import type { StreamRequest, StreamResult } from './types.js';
import { streamAnthropic, testAnthropic } from './anthropic.js';
import { streamOpenAI, testOpenAI } from './openai.js';
import type { StoredProfile } from '../types.js';
import { truncateEnd } from '../util/text.js';

export type { StreamRequest, StreamResult } from './types.js';
export { completeText } from './complete.js';
export { listModels } from './models.js';
export type { ListModelsResult } from './models.js';

export async function streamChat(req: StreamRequest): Promise<StreamResult> {
  switch (req.profile.kind) {
    case 'anthropic':
      return streamAnthropic(req);
    case 'openai':
    case 'openai-compatible':
    case 'gemini':
      return streamOpenAI(req);
    default:
      throw new Error(`不支持的 provider 类型: ${(req.profile as StoredProfile).kind}`);
  }
}

/** 用一条极小请求验证账号 key 是否可用。 */
export async function testProfile(
  profile: StoredProfile,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  if (!profile.apiKey) return { ok: false, error: '未配置 API Key' };
  const model = profile.defaultModel || profile.models[0] || '';
  if (!model) return { ok: false, error: '未配置模型' };
  try {
    if (profile.kind === 'anthropic') {
      return await testAnthropic(profile.baseUrl, profile.apiKey, model, signal);
    }
    return await testOpenAI(profile.baseUrl, profile.kind, profile.apiKey, model, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: truncateEnd(message, 500) };
  }
}
