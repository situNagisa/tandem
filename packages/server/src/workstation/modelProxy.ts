// 账号级模型代理：工作站用该账号自己的 Key 调上游，流式事件经 NDJSON 回传主机。
// 主机只发 profileId/模型/消息，从不接触 Key；用量按账号记账后随 done 事件回传。
// 上游请求 / SSE / usage 解析走 ../providers 与 ../upstream；Key 换用规则与网关共用。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ContentBlock, Usage, WorkspaceModelProxyEvent, WorkspaceModelProxyInput } from '@tandem/protocol';
import { effectiveProfile, writePrivateFile } from '../config.js';
import { streamChat } from '../providers/index.js';
import type { ProviderRateLimit } from '../providers/types.js';
import {
  classifyKeyFailure,
  cooldownMsFor,
  groupUnavailableError,
  profileWithKey,
  rotateKeyCandidates,
} from '../key-rotation.js';
import { costOfUsage, resolvePriceForModel } from '../usage.js';
import { runKeyRotation, type UpstreamCandidate } from '../upstream/keys.js';
import type { StoredProfileKey } from '../types.js';
import type { AccountProfileStore } from './profiles.js';

interface UsageRow {
  at: number;
  accountId: string;
  hostId: string;
  profileId: string;
  groupId?: string;
  keyId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface UsageFile {
  version: number;
  rows: UsageRow[];
}

/** 工作站按账号记账（token / 花费）；只保留最近 5000 条，主机侧仍按会话显示耗时与用量。 */
export class WorkstationUsageStore {
  private readonly file: string;
  private data: UsageFile;

  constructor(home: string) {
    this.file = path.join(home, 'model-usage.json');
    let rows: UsageRow[] = [];
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<UsageFile>;
        rows = Array.isArray(raw.rows) ? (raw.rows as UsageRow[]) : [];
      } catch {
        rows = [];
      }
    }
    this.data = { version: 1, rows };
  }

  record(row: UsageRow): void {
    this.data.rows.push(row);
    if (this.data.rows.length > 5000) this.data.rows = this.data.rows.slice(-5000);
    writePrivateFile(this.file, JSON.stringify(this.data, null, 2));
  }

  rowsFor(accountId: string): UsageRow[] {
    return this.data.rows.filter((row) => row.accountId === accountId);
  }

  totalsFor(accountId: string): { calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const rows = this.rowsFor(accountId);
    return {
      calls: rows.length,
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      costUsd: Math.round(rows.reduce((sum, row) => sum + row.costUsd, 0) * 1e8) / 1e8,
    };
  }
}

export interface ModelProxyContext {
  profiles: AccountProfileStore;
  usage: WorkstationUsageStore;
  accountId: string;
  hostId: string;
  /** 按 key 组记录轮询游标（进程内）。 */
  rotation?: Map<string, number>;
}

export type ProxyEmitter = (event: WorkspaceModelProxyEvent) => void;

function rateLimitToJson(info: ProviderRateLimit): Record<string, unknown> {
  return { ...info };
}

function updateKeySuccess(store: AccountProfileStore, accountId: string, profileId: string, groupId: string | undefined, keyId: string | undefined): void {
  if (!keyId) return;
  store.forAccount(accountId).updateKeyState(profileId, groupId, keyId, {
    disabled: undefined,
    cooldownUntil: undefined,
    failures: undefined,
    lastError: undefined,
    lastErrorAt: undefined,
  });
}

function updateKeyFailure(
  store: AccountProfileStore,
  accountId: string,
  profileId: string,
  groupId: string | undefined,
  key: StoredProfileKey | undefined,
  err: unknown,
): void {
  if (!key || !groupId) return;
  const failure = classifyKeyFailure(err);
  if (failure.kind === 'none') return;
  const patch: Partial<StoredProfileKey> = {
    lastError: failure.message.slice(0, 300),
    lastErrorAt: Date.now(),
  };
  if (failure.kind === 'disable') {
    patch.disabled = true;
  } else {
    const failures = (key.failures ?? 0) + 1;
    patch.failures = failures;
    patch.cooldownUntil = Date.now() + cooldownMsFor(failures);
    patch.rateLimitHits = (key.rateLimitHits ?? 0) + (failure.status === 429 ? 1 : 0);
  }
  store.forAccount(accountId).updateKeyState(profileId, groupId, key.id, patch);
}

/**
 * 执行一次账号级模型请求并流式回传。调用方已校验 accountId 属于该主机。
 * 同组多 Key：仅在还没有任何事件输出时换下一个 Key；一旦开始输出就只透传错误。
 */
export async function streamAccountModel(
  ctx: ModelProxyContext,
  input: WorkspaceModelProxyInput,
  emit: ProxyEmitter,
  signal: AbortSignal,
): Promise<void> {
  const store = ctx.profiles.forAccount(ctx.accountId);
  const profile = store.get(input.profileId);
  if (!profile) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
  const group = input.groupId ? profile.groups?.find((item) => item.id === input.groupId) : undefined;
  if (input.groupId && !group) throw Object.assign(new Error('分组不存在'), { statusCode: 404 });
  const effective = effectiveProfile(profile, input.groupId);
  const model = input.model || effective.defaultModel;
  if (!model) throw Object.assign(new Error('未配置模型'), { statusCode: 400 });

  const rotation = (ctx.rotation ??= new Map());
  const groupKeys = group?.keys ?? [];
  const candidates: UpstreamCandidate[] =
    !group || groupKeys.length === 0
      ? [{ profile: effective }]
      : rotateKeyCandidates(groupKeys, group.keyStrategy, rotation, `${ctx.accountId}:${input.profileId}:${input.groupId ?? ''}`).map(
          (key) => ({
            keyId: key.id,
            ...(key.label ? { label: key.label } : {}),
            key,
            profile: profileWithKey(effective, key),
          }),
        );
  if (candidates.length === 0) {
    throw Object.assign(
      new Error(groupUnavailableError(group!, new Map()) || '当前账号没有可用的 API Key'),
      { statusCode: 400 },
    );
  }

  const errors = new Map<string, string>();
  let emitted = false;
  const result = await runKeyRotation({
    candidates,
    signal,
    // 任何错误都换下一个 Key（状态更新由 updateKeyFailure 按错误分类决定），
    // 只有“Key 缺失”这类不可重试的配置错误直接抛出。
    canRetry: (failure) => (failure.error as { retryable?: unknown } | undefined)?.retryable !== false,
    shouldRethrow: () => emitted || signal.aborted,
    onFailure: (failure) => {
      updateKeyFailure(ctx.profiles, ctx.accountId, input.profileId, input.groupId, failure.candidate.key, failure.error);
      errors.set(failure.keyId ?? '', failure.message);
    },
    attempt: async (candidate) => {
      const key = candidate.key;
      const callProfile = candidate.profile;
      if (callProfile.kind !== 'demo' && !callProfile.apiKey) {
        throw Object.assign(new Error('当前账号未配置 API Key'), { statusCode: 400, retryable: false });
      }
      const blocks: ContentBlock[] = [];
      const send = (event: WorkspaceModelProxyEvent) => {
        emitted = true;
        emit(event);
      };
      const response = await streamChat({
        profile: callProfile,
        model,
        system: input.system ?? '',
        messages: input.messages ?? [],
        tools: (input.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          readOnly: false,
          requiresApproval: false,
        })),
        blocks,
        signal,
        idleTimeoutSec: input.idleTimeoutSec ?? 180,
        maxTokens: input.maxTokens || 8192,
        ...(input.effort ? { effort: input.effort } : {}),
        onRateLimit: (info) => send({ type: 'rate_limit', info: rateLimitToJson(info) }),
        onEffortDropped: () => send({ type: 'effort_dropped' }),
        onBlockStart: (index, block) => send({ type: 'block_start', index, block: structuredClone(block) }),
        onText: (index, text) => send({ type: 'text', index, text }),
        onToolInput: (index, partialJson) => send({ type: 'tool_input', index, partialJson }),
      });
      if (signal.aborted) return;
      if (key) updateKeySuccess(ctx.profiles, ctx.accountId, input.profileId, input.groupId, key.id);
      const price = resolvePriceForModel(effective, model);
      const costUsd = costOfUsage(price?.price, response.usage, callProfile.kind);
      ctx.usage.record({
        at: Date.now(),
        accountId: ctx.accountId,
        hostId: ctx.hostId,
        profileId: input.profileId,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(key ? { keyId: key.id } : {}),
        model,
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        costUsd,
      });
      emit({
        type: 'done',
        usage: response.usage satisfies Usage,
        ...(response.stopReason ? { stopReason: response.stopReason } : {}),
        ...(key ? { keyId: key.id } : {}),
        costUsd,
      });
    },
  });

  if (result.ok) return;
  if (result.rethrown && result.last) throw result.last.error;
  if (result.fatal) throw result.fatal.error;
  throw new Error(
    group
      ? groupUnavailableError(group, errors) || '所有 Key 都不可用'
      : '当前账号没有可用的 API Key',
  );
}
