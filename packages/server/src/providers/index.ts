// provider 统一入口。
import type { StreamRequest, StreamResult } from './types.js';
import { streamAnthropic, testAnthropic } from './anthropic.js';
import { streamOpenAI, testOpenAI } from './openai.js';
import { streamViaWorkstation } from './workstation.js';
import type { StoredProfile } from '../types.js';
import { IS_DEBUG_FLAVOR } from '../flavor.js';
import { truncateEnd } from '../util/text.js';

export type { StreamRequest, StreamResult } from './types.js';
export { completeText } from './complete.js';
export { listModels } from './models.js';
export type { ListModelsResult } from './models.js';

export async function streamChat(req: StreamRequest): Promise<StreamResult> {
  // 账号级模型账号：主机没有 Key，一律交给工作站代理（个人模式走进程内直连）。
  if (req.profile.proxied) {
    if (!req.proxy) throw new Error('账号级模型账号需要通过工作站代理，但主机未连接工作站');
    return streamViaWorkstation(req);
  }
  switch (req.profile.kind) {
    case 'anthropic':
      return streamAnthropic(req);
    case 'openai':
    case 'openai-compatible':
    case 'gemini':
    case 'tandem-gateway':
      return streamOpenAI(req);
    case 'demo': {
      if (!IS_DEBUG_FLAVOR) throw new Error(`不支持的 provider 类型: demo`);
      const { streamBuiltInModel } = await import('../debug/demoProvider.js');
      return streamBuiltInModel(req);
    }
    default:
      throw new Error(`不支持的 provider 类型: ${(req.profile as StoredProfile).kind}`);
  }
}

/** 用一条极小请求验证账号 key 是否可用。 */
export async function testProfile(
  profile: StoredProfile,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  if (profile.kind === 'demo') return { ok: IS_DEBUG_FLAVOR };
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
    // undici 的 fetch 只给出 "fetch failed"，真正原因（ECONNREFUSED 等）在 cause 里
    const cause = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined;
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string'
          ? (cause as { message: string }).message
          : '';
    const detail = causeMessage && causeMessage !== message ? `${message}（${causeMessage}）` : message;
    return { ok: false, error: truncateEnd(detail, 500) };
  }
}
