// 看板的纯逻辑：依赖环检测、调度选择、规划草稿解析。无副作用，便于单测。
import type { BoardCard, BoardPlanDraft } from '@tandem/protocol';

/** 给 cardId 设置 deps 后是否会形成环（cards 里 cardId 的旧 deps 被忽略；cardId 不在 cards 里时当新卡）。 */
export function wouldCycle(cards: Pick<BoardCard, 'id' | 'deps'>[], cardId: string, deps: string[]): boolean {
  const depsOf = new Map(cards.map((card) => [card.id, card.deps] as const));
  depsOf.set(cardId, deps);
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === cardId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(depsOf.get(id) ?? []));
  }
  return false;
}

/** 依赖拓扑序（依赖在前）；同层按 order。成环的节点被丢到最后。 */
export function topoOrder<T extends Pick<BoardCard, 'id' | 'deps' | 'order'>>(cards: T[]): T[] {
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const done = new Set<string>();
  const result: T[] = [];
  const visiting = new Set<string>();
  const visit = (card: T) => {
    if (done.has(card.id) || visiting.has(card.id)) return;
    visiting.add(card.id);
    for (const dep of card.deps) {
      const next = byId.get(dep);
      if (next) visit(next);
    }
    visiting.delete(card.id);
    done.add(card.id);
    result.push(card);
  };
  for (const card of [...cards].sort((a, b) => a.order - b.order)) visit(card);
  return result;
}

export interface ScheduleInput {
  cards: Pick<BoardCard, 'id' | 'deps' | 'status' | 'order' | 'retryAt'>[];
  now: number;
  /** 本看板允许同时运行的卡数。 */
  maxParallel: number;
  /** 本看板当前计入并发的运行中卡数（approval 不计）。 */
  running: number;
  /** Host 全局还剩几个槽。 */
  globalFree: number;
  /** 不用 worktree 的卡：同目录是否已有卡在跑，以及这张卡是否需要独占目录。 */
  dirBusy: boolean;
  exclusive: (cardId: string) => boolean;
}

export interface ScheduleDecision {
  launch: string[];
  blocked: Map<string, NonNullable<BoardCard['blocked']>>;
}

/** 在 queued 卡里挑出本 tick 可启动的卡，并给出其余卡的阻塞原因。 */
export function decideSchedule(input: ScheduleInput): ScheduleDecision {
  const byId = new Map(input.cards.map((card) => [card.id, card] as const));
  const queued = input.cards.filter((card) => card.status === 'queued').sort((a, b) => a.order - b.order);
  const launch: string[] = [];
  const blocked = new Map<string, NonNullable<BoardCard['blocked']>>();
  let running = input.running;
  let free = input.globalFree;
  let dirBusy = input.dirBusy;
  for (const card of queued) {
    if (card.retryAt && card.retryAt > input.now) continue;
    const deps = card.deps.map((id) => byId.get(id)).filter((dep): dep is NonNullable<typeof dep> => !!dep);
    if (deps.some((dep) => dep.status === 'failed')) {
      blocked.set(card.id, 'upstream_failed');
      continue;
    }
    if (deps.some((dep) => dep.status !== 'done')) {
      blocked.set(card.id, 'waiting');
      continue;
    }
    if (running >= input.maxParallel || free <= 0) {
      blocked.set(card.id, 'slot');
      continue;
    }
    if (input.exclusive(card.id) && dirBusy) {
      blocked.set(card.id, 'dir');
      continue;
    }
    launch.push(card.id);
    running += 1;
    free -= 1;
    if (input.exclusive(card.id)) dirBusy = true;
  }
  return { launch, blocked };
}

/** 从模型输出里取出 JSON 数组（容忍 ```json 围栏与前后说明文字）。 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced?.[1] ?? raw).trim();
  const start = Math.min(...['[', '{'].map((ch) => (text.indexOf(ch) < 0 ? Infinity : text.indexOf(ch))));
  if (!Number.isFinite(start)) throw new Error('规划结果不是 JSON');
  const open = text[start]!;
  const end = text.lastIndexOf(open === '[' ? ']' : '}');
  if (end <= start) throw new Error('规划结果不是完整的 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export const MAX_PLAN_CARDS = 12;

/** 解析并校验规划草稿：ref 唯一、deps 指向已有 ref、无环、数量受限。 */
export function parsePlan(raw: string): BoardPlanDraft[] {
  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (err) {
    throw new Error(err instanceof Error && err.message.startsWith('规划结果') ? err.message : '规划结果无法解析为 JSON');
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { cards?: unknown })?.cards) ? (data as { cards: unknown[] }).cards : undefined;
  if (!list || list.length === 0) throw new Error('规划结果里没有任务卡');
  if (list.length > MAX_PLAN_CARDS) throw new Error(`规划出 ${list.length} 张卡，超过上限 ${MAX_PLAN_CARDS}，请缩小目标`);
  const drafts: BoardPlanDraft[] = list.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 120) : '';
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
    if (!title || !prompt) throw new Error(`第 ${index + 1} 张卡缺少标题或提示词`);
    const ref = typeof row.ref === 'string' && row.ref.trim() ? row.ref.trim() : `c${index + 1}`;
    return {
      ref,
      title,
      prompt,
      deps: Array.isArray(row.deps) ? row.deps.filter((dep): dep is string => typeof dep === 'string') : [],
      ...(typeof row.preset === 'string' && row.preset.trim() ? { preset: row.preset.trim() } : {}),
      ...(row.gate === true ? { gate: true } : {}),
    };
  });
  validateDrafts(drafts);
  return drafts;
}

export function validateDrafts(drafts: BoardPlanDraft[]): void {
  const refs = new Set<string>();
  for (const draft of drafts) {
    if (refs.has(draft.ref)) throw new Error(`草稿引用重复：${draft.ref}`);
    refs.add(draft.ref);
  }
  const asCards = drafts.map((draft, index) => ({ id: draft.ref, deps: draft.deps, order: index }));
  for (const draft of drafts) {
    for (const dep of draft.deps) {
      if (!refs.has(dep)) throw new Error(`「${draft.title}」依赖了不存在的草稿：${dep}`);
      if (dep === draft.ref) throw new Error(`「${draft.title}」不能依赖自己`);
    }
    if (wouldCycle(asCards, draft.ref, draft.deps)) throw new Error(`「${draft.title}」的依赖形成了环`);
  }
}
