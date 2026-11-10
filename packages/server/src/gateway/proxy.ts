// 网关转发：鉴权 → 成员限额/速率 → 按模型找路由 → Key 轮换 → 透传 SSE/JSON → 记账。
// 只在上游请求里替换为真实 Key；调用者的网关令牌不会到达上游。
// 上游请求/SSE/usage 解析共用 ../upstream/；本文件只保留入口、鉴权、限流、路由与记账落点。
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayLogEntry, Usage } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { StoredProfile } from '../types.js';
import { costOfUsage, priceForModel } from '../usage.js';
import { memberSpend } from './stats.js';
import { redactGatewayText } from './redact.js';
import type { StoredGatewayToken } from './store.js';
import { createSseUsageTracker } from '../upstream/sse.js';
import { applyAnthropicUsage, applyOpenAiUsage } from '../upstream/usage.js';
import {
  UpstreamAttemptError,
  buildPassthroughRequest,
  extractUpstreamError,
  postWithBodyFallbacks,
  retryableStatus,
} from '../upstream/request.js';
import { runKeyRotation } from '../upstream/keys.js';

export type GatewayProtocol = 'openai' | 'anthropic';

type AnyRecord = Record<string, any>;

const MAX_UPSTREAM_MS = 10 * 60_000;

function errorBody(protocol: GatewayProtocol, status: number, message: string): AnyRecord {
  if (protocol === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'gateway_error',
        message,
      },
    };
  }
  return { error: { message, type: 'gateway_error', code: status } };
}

export function sendGatewayError(
  reply: FastifyReply,
  protocol: GatewayProtocol,
  status: number,
  message: string,
  retryAfterSec?: number,
): FastifyReply {
  if (retryAfterSec) reply.header('retry-after', String(Math.max(1, Math.round(retryAfterSec))));
  return reply.code(status).send(errorBody(protocol, status, message));
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return token;
  }
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return undefined;
}

interface GatewayCaller {
  grant: StoredGatewayToken;
  memberId: string;
  memberName: string;
}

/** 校验网关令牌与成员状态；失败时已写响应，返回 undefined。 */
function authenticate(host: Host, req: FastifyRequest, reply: FastifyReply, protocol: GatewayProtocol): GatewayCaller | undefined {
  const settings = host.gateway.settingsView();
  if (!settings.enabled) {
    sendGatewayError(reply, protocol, 503, '网关模式未开启：请联系网关管理员在「设置 → 网关」中启用');
    return undefined;
  }
  const token = tokenFrom(req);
  if (!token) {
    sendGatewayError(reply, protocol, 401, '缺少网关令牌：请使用 Authorization: Bearer tgw_… 或 x-api-key');
    return undefined;
  }
  // 工作区账号令牌可直接调用网关（按账号记账）；tgw_ 令牌保持兼容。
  if (token.startsWith('acw_')) {
    const account = host.accounts.authenticate(token);
    if (!account) {
      sendGatewayError(reply, protocol, 401, '工作区账号令牌无效或已被吊销');
      return undefined;
    }
    const grant: StoredGatewayToken = {
      id: `acct:${account.accountId}`,
      memberId: account.accountId,
      memberName: account.name,
      createdAt: 0,
      rpm: 60,
      allowedModels: [] as string[],
      tokenHash: '',
    };
    const retryAfter = host.gateway.checkRate(grant);
    if (retryAfter > 0) {
      sendGatewayError(reply, protocol, 429, `请求过于频繁：${account.name} 的网关速率为 60 RPM，请 ${retryAfter} 秒后重试`, retryAfter);
      return undefined;
    }
    return { grant, memberId: account.accountId, memberName: account.name };
  }
  const grant = host.gateway.authenticate(token);
  if (!grant) {
    sendGatewayError(reply, protocol, 401, '网关令牌无效或已被吊销');
    return undefined;
  }
  const member = host.team.getMember(grant.memberId);
  if (!member || member.revokedAt) {
    sendGatewayError(reply, protocol, 401, '成员已被吊销，网关令牌同时失效');
    return undefined;
  }
  const retryAfter = host.gateway.checkRate(grant);
  if (retryAfter > 0) {
    sendGatewayError(reply, protocol, 429, `请求过于频繁：${member.name} 的网关速率限制为 ${grant.rpm} RPM，请 ${retryAfter} 秒后重试`, retryAfter);
    return undefined;
  }
  return { grant, memberId: member.id, memberName: member.name };
}

function whiteListed(grant: StoredGatewayToken, model: string): boolean {
  if (grant.allowedModels.length === 0) return true;
  const lower = model.toLowerCase();
  return grant.allowedModels.some((item) => item.toLowerCase() === lower);
}

function findRoute(host: Host, model: string) {
  const lower = model.toLowerCase();
  const settings = host.gateway.settingsView();
  return settings.routes.find((route) => route.models.some((item) => item.toLowerCase() === lower));
}

function protocolOfKind(kind: string): GatewayProtocol | undefined {
  if (kind === 'anthropic') return 'anthropic';
  if (kind === 'openai' || kind === 'openai-compatible' || kind === 'gemini') return 'openai';
  return undefined;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 0.01 ? 2 : 4)}`;
}

/** 成员每日/每月额度：按 UsageStore 中该成员的累计花费判定。 */
function checkMemberLimits(host: Host, caller: GatewayCaller, reply: FastifyReply, protocol: GatewayProtocol): boolean {
  const spend = memberSpend(host.usage, caller.memberId);
  const daily = caller.grant.dailyLimitUsd;
  if (daily && spend.todayUsd >= daily) {
    sendGatewayError(reply, protocol, 429, `成员「${caller.memberName}」今日网关额度已用完（${formatUsd(spend.todayUsd)} / ${formatUsd(daily)}），请联系网关管理员`);
    return false;
  }
  const monthly = caller.grant.monthlyLimitUsd;
  if (monthly && spend.monthUsd >= monthly) {
    sendGatewayError(reply, protocol, 429, `成员「${caller.memberName}」本月网关额度已用完（${formatUsd(spend.monthUsd)} / ${formatUsd(monthly)}），请联系网关管理员`);
    return false;
  }
  return true;
}

interface CompletionMeta {
  host: Host;
  caller: GatewayCaller;
  profile: StoredProfile;
  model: string;
  protocol: GatewayProtocol;
  stream: boolean;
  startedAt: number;
  routeLabel: string;
  keyId?: string;
  groupId?: string;
  debugRequest?: string;
}

function recordCompletion(meta: CompletionMeta, status: number, usage: Usage, error?: string, debugResponse?: string): void {
  const price = priceForModel(meta.profile, meta.model);
  const costUsd = costOfUsage(price, usage, meta.profile.kind);
  if (status >= 200 && status < 300) {
    meta.host.usage.record({
      hostId: meta.host.config.hostId,
      profileId: meta.profile.id,
      model: meta.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      ...(meta.keyId ? { keyId: meta.keyId } : {}),
      ...(meta.groupId ? { groupId: meta.groupId } : {}),
      memberId: meta.caller.memberId,
      memberName: meta.caller.memberName,
    });
  }
  const entry: GatewayLogEntry = {
    at: meta.startedAt,
    memberId: meta.caller.memberId,
    memberName: meta.caller.memberName,
    model: meta.model,
    protocol: meta.protocol,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    durationMs: Date.now() - meta.startedAt,
    status,
    stream: meta.stream,
    route: meta.routeLabel,
    ...(error ? { error: error.slice(0, 300) } : {}),
  };
  meta.host.gateway.recordRequest(entry);
  if (meta.host.gateway.settingsView().debugBodies && meta.debugRequest !== undefined && debugResponse !== undefined) {
    meta.host.gateway.recordDebug({
      memberId: meta.caller.memberId,
      memberName: meta.caller.memberName,
      model: meta.model,
      protocol: meta.protocol,
      request: meta.debugRequest,
      response: debugResponse,
    });
  }
}

/** /gateway/v1/models：只返回路由配置且令牌白名单允许的模型。 */
export function handleGatewayModels(host: Host, req: FastifyRequest, reply: FastifyReply): unknown {
  const caller = authenticate(host, req, reply, 'openai');
  if (!caller) return reply;
  const settings = host.gateway.settingsView();
  const ids = new Set<string>();
  for (const route of settings.routes) {
    for (const model of route.models) {
      if (whiteListed(caller.grant, model)) ids.add(model);
    }
  }
  const data = [...ids].sort().map((id) => ({ id, object: 'model', owned_by: 'tandem-gateway' }));
  return { object: 'list', data };
}

async function sendBody(
  host: Host,
  reply: FastifyReply,
  res: Response,
  meta: CompletionMeta,
  controller: AbortController,
): Promise<void> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const contentType = res.headers.get('content-type') ?? 'application/json';
  const isStream = contentType.includes('text/event-stream');
  const debugChunks: string[] = [];
  let debugChars = 0;
  const collectDebug = (text: string) => {
    if (!host.gateway.settingsView().debugBodies) return;
    if (debugChars >= 200_000) return;
    debugChunks.push(text);
    debugChars += text.length;
  };

  if (isStream) {
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.raw.setHeader('access-control-allow-origin', '*');
    const parser = createSseUsageTracker(meta.protocol, usage);
    const decoder = new TextDecoder();
    const reader = res.body?.getReader();
    if (!reader) {
      reply.raw.end();
      recordCompletion(meta, 502, usage, '上游没有返回响应体');
      return;
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          reply.raw.write(Buffer.from(value));
          const text = decoder.decode(value, { stream: true });
          parser.push(text);
          collectDebug(text);
        }
      }
      parser.push(decoder.decode());
      parser.end();
      recordCompletion(meta, 200, usage, undefined, redactGatewayText(debugChunks.join('')));
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        recordCompletion(meta, 200, usage, `流中断：${message}`, redactGatewayText(debugChunks.join('')));
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return;
  }

  const text = await res.text();
  collectDebug(text);
  try {
    const data = JSON.parse(text) as AnyRecord;
    if (meta.protocol === 'openai') applyOpenAiUsage(data.usage, usage, { merge: 'max', inputAliases: true, outputAliases: true, cachedAlias: true });
    else applyAnthropicUsage(data.usage, usage);
  } catch {
    /* 非 JSON 原样透传 */
  }
  reply.code(res.status).header('content-type', contentType).send(text);
  recordCompletion(meta, res.status, usage, undefined, redactGatewayText(debugChunks.join('')));
}

/** OpenAI / Anthropic 兼容转发入口。 */
export async function handleGatewayChat(
  host: Host,
  req: FastifyRequest,
  reply: FastifyReply,
  protocol: GatewayProtocol,
): Promise<void> {
  const caller = authenticate(host, req, reply, protocol);
  if (!caller) return;
  const body = req.body && typeof req.body === 'object' ? { ...(req.body as AnyRecord) } : {};
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    sendGatewayError(reply, protocol, 400, '请求缺少 model 字段');
    return;
  }
  if (!whiteListed(caller.grant, model)) {
    sendGatewayError(reply, protocol, 403, `模型「${model}」不在你的网关白名单中`);
    return;
  }
  const route = findRoute(host, model);
  if (!route) {
    sendGatewayError(reply, protocol, 404, `网关没有为模型「${model}」配置路由，请联系网关管理员`);
    return;
  }
  const profile = host.profileFor(route.profileId, route.groupId);
  if (!profile) {
    sendGatewayError(reply, protocol, 503, `模型「${model}」的路由账号不存在，请联系网关管理员`);
    return;
  }
  const upstreamProtocol = protocolOfKind(profile.kind);
  if (!upstreamProtocol) {
    sendGatewayError(reply, protocol, 503, `模型「${model}」的路由账号协议不支持转发`);
    return;
  }
  if (upstreamProtocol !== protocol) {
    sendGatewayError(
      reply,
      protocol,
      409,
      `模型「${model}」的上游分组使用 ${upstreamProtocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} 协议，请改用对应的网关接口`,
    );
    return;
  }
  const blocked = host.budgets.blockingRule({ profileId: route.profileId, groupId: route.groupId, model });
  if (blocked) {
    sendGatewayError(
      reply,
      protocol,
      429,
      `网关预算已阻止本次请求：${host.budgets.describe(blocked)}（已用 ${formatUsd(blocked.spentUsd)} / ${formatUsd(blocked.limitUsd)}）`,
    );
    return;
  }
  if (!checkMemberLimits(host, caller, reply, protocol)) return;

  const { candidates } = host.keyCandidates(route.profileId, route.groupId);
  const group = host.groupFor(route.profileId, route.groupId);
  const routeLabel = `${profile.name}${group ? ` / ${group.name}` : ''}`;
  if (candidates.length === 0) {
    sendGatewayError(reply, protocol, 503, host.keysUnavailableMessage(route.profileId, route.groupId) ?? '网关上游账号没有可用 Key');
    return;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_UPSTREAM_MS);
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);

  const debugRequest = host.gateway.settingsView().debugBodies
    ? redactGatewayText(JSON.stringify(body))
    : undefined;
  const metaFor = (candidateProfile: StoredProfile, keyId?: string): CompletionMeta => ({
    host,
    caller,
    profile: candidateProfile,
    model,
    protocol,
    stream: body.stream === true,
    startedAt,
    routeLabel,
    ...(keyId ? { keyId } : {}),
    ...(route.groupId ? { groupId: route.groupId } : {}),
    ...(debugRequest !== undefined ? { debugRequest } : {}),
  });

  try {
    const result = await runKeyRotation({
      candidates,
      signal: controller.signal,
      canRetry: (failure) => failure.retryable,
      onFailure: (failure) => {
        const setup = failure.error instanceof UpstreamAttemptError && failure.error.setup;
        if (!setup && failure.retryable && failure.candidate.keyId && failure.status > 0) {
          host.markKeyFailure(route.profileId, route.groupId, failure.candidate.keyId, {
            status: failure.status,
            message: failure.message,
          });
        }
      },
      attempt: async (candidate) => {
        const request = buildPassthroughRequest({
          profile: candidate.profile,
          protocol,
          body,
          model,
          signal: controller.signal,
          clientHeaders: {
            ...(typeof req.headers['anthropic-version'] === 'string'
              ? { anthropicVersion: req.headers['anthropic-version'] }
              : {}),
            ...(typeof req.headers['anthropic-beta'] === 'string'
              ? { anthropicBeta: req.headers['anthropic-beta'] }
              : {}),
          },
        });
        const sent = await postWithBodyFallbacks({
          body: request.body,
          send: async (payload) => {
            try {
              return await fetch(request.url, { ...request.init, body: JSON.stringify(payload) });
            } catch (err) {
              if ((err as Error)?.name === 'AbortError') {
                throw new UpstreamAttemptError('请求已取消', { status: 499, retryable: false });
              }
              const message = err instanceof Error ? err.message : String(err);
              throw new UpstreamAttemptError(`连接上游失败：${message}`, { status: 0, retryable: true });
            }
          },
          fallbacks: request.addedStreamOptions
            ? [
                {
                  applies: (res) => res.status === 400 && /stream_options|include_usage/i.test(res.text),
                  drop: (payload) => {
                    const next = { ...payload };
                    delete next.stream_options;
                    return next;
                  },
                },
              ]
            : [],
        });
        if (!sent.res.ok) {
          throw new UpstreamAttemptError(extractUpstreamError(sent.text, sent.res.status), {
            status: sent.res.status,
            retryable: retryableStatus(sent.res.status),
          });
        }
        host.markKeySuccess(route.profileId, route.groupId, candidate.keyId);
        await sendBody(host, reply, sent.res, metaFor(candidate.profile, candidate.keyId), controller);
        return candidate;
      },
    });

    if (result.ok) return;
    if (controller.signal.aborted) return;
    if (result.fatal) {
      const failure = result.fatal;
      if (failure.error instanceof UpstreamAttemptError && failure.error.setup) {
        sendGatewayError(reply, protocol, failure.status || 503, failure.message);
        return;
      }
      // 客户端参数错误等：不换 Key，直接回传可读信息。
      const status = failure.status >= 400 ? failure.status : 502;
      sendGatewayError(reply, protocol, status, `上游拒绝请求：${failure.message}`);
      recordCompletion(metaFor(failure.candidate.profile, failure.keyId), status, { inputTokens: 0, outputTokens: 0 }, failure.message);
      return;
    }
    const errors = new Map<string, string>();
    for (const failure of result.failures) {
      if (failure.keyId) errors.set(failure.keyId, failure.message);
    }
    const lastMessage = result.last?.message ?? '';
    const unavailable = host.keysUnavailableMessage(route.profileId, route.groupId, errors);
    sendGatewayError(reply, protocol, 502, unavailable ?? `网关上游不可用：${lastMessage || '所有 Key 均失败'}`);
    recordCompletion(metaFor(profile), 502, { inputTokens: 0, outputTokens: 0 }, lastMessage || '所有 Key 均失败');
  } finally {
    clearTimeout(timer);
    reply.raw.off('close', onClose);
  }
}
