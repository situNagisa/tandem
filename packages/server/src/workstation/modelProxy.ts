// 账号级模型代理：工作站用该账号自己的 Key 调上游，流式事件经 NDJSON 回传主机。
// 主机只发 profileId/模型/消息，从不接触 Key；用量按账号记账后随 done 事件回传。
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
  orderedAvailableKeys,
  profileWithKey,
} from '../key-rotation.js';
import { costOfUsage, resolvePriceForModel } from '../usage.js';
import { errorMessage } from '../util/text.js';
import type { StoredProfile, StoredProfileGroup, StoredProfileKey } from '../types.js';
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

function candidateKeys(
  profile: StoredProfile,
  group: StoredProfileGroup | undefined,
  rotation: Map<string, number> | undefined,
  key: string,
): Array<StoredProfileKey | undefined> {
  const keys = group?.keys ?? [];
  if (!group || keys.length === 0) return [undefined];
  const rotate = rotation?.get(key) ?? 0;
  const available = orderedAvailableKeys(keys, group.keyStrategy, rotate);
  if (group.keyStrategy === 'round_robin' && available.length > 0) {
    rotation?.set(key, rotate + 1);
  }
  return available.map((item) => item);
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
  const candidates = candidateKeys(profile, group, rotation, `${ctx.accountId}:${input.profileId}:${input.groupId ?? ''}`);
  if (candidates.length === 0) {
    throw Object.assign(
      new Error(groupUnavailableError(group!, new Map()) || '当前账号没有可用的 API Key'),
      { statusCode: 400 },
    );
  }

  const errors = new Map<string, string>();
  for (const key of candidates) {
    const callProfile = key ? profileWithKey(effective, key) : effective;
    if (callProfile.kind !== 'demo' && !callProfile.apiKey) {
      throw Object.assign(new Error('当前账号未配置 API Key'), { statusCode: 400 });
    }
    const blocks: ContentBlock[] = [];
    let emitted = false;
    const send = (event: WorkspaceModelProxyEvent) => {
      emitted = true;
      emit(event);
    };
    try {
      const result = await streamChat({
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
      const costUsd = costOfUsage(price?.price, result.usage, callProfile.kind);
      ctx.usage.record({
        at: Date.now(),
        accountId: ctx.accountId,
        hostId: ctx.hostId,
        profileId: input.profileId,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(key ? { keyId: key.id } : {}),
        model,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        costUsd,
      });
      emit({
        type: 'done',
        usage: result.usage satisfies Usage,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(key ? { keyId: key.id } : {}),
        costUsd,
      });
      return;
    } catch (err) {
      updateKeyFailure(ctx.profiles, ctx.accountId, input.profileId, input.groupId, key, err);
      if (emitted || signal.aborted) throw err;
      errors.set(key?.id ?? '', errorMessage(err));
    }
  }
  throw new Error(
    group
      ? groupUnavailableError(group, errors) || '所有 Key 都不可用'
      : '当前账号没有可用的 API Key',
  );
}
