// 会话树拓扑：整棵树（根 + 递归分叉 + 所有子代理）共用一张轮次图。
// 只回轮次 id / 首行摘要与会话接入关系，不下发消息体；客户端据此按当前会话切主线。
import type {
  SessionGraphSession,
  SessionGraphTree,
  SessionGraphTurn,
} from '@tandem/protocol';
import { isUserTurnMessage } from '@tandem/protocol';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';

const PREVIEW_LENGTH = 160;
const MAX_TREE_SESSIONS = 200;

interface TurnMark extends SessionGraphTurn {
  /** 该轮在 messages 里的起始下标。 */
  start: number;
}

function firstLine(rec: SessionRecord, start: number): string {
  const message = rec.messages[start];
  if (!message) return '';
  const texts: string[] = [];
  let image = false;
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'image') image = true;
  }
  const line =
    texts
      .join('\n')
      .split('\n')
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  const preview = line || (image ? '图片' : '');
  return preview.length > PREVIEW_LENGTH ? `${preview.slice(0, PREVIEW_LENGTH)}…` : preview;
}

/** 用户轮：与轮次大纲、会话图共用 isUserTurnMessage 口径（注入内容不算轮）。 */
function turnsOf(rec: SessionRecord): TurnMark[] {
  const pinned = new Set(rec.pinnedTurns ?? []);
  const turns: TurnMark[] = [];
  for (let i = 0; i < rec.messages.length; i += 1) {
    const message = rec.messages[i]!;
    if (!isUserTurnMessage(message)) continue;
    turns.push({
      id: message.id,
      no: turns.length + 1,
      preview: firstLine(rec, i),
      start: i,
      ...(pinned.has(message.id) ? { pinned: true } : {}),
    });
  }
  return turns;
}

/** 每条消息所属的轮次（分叉点可能落在 assistant 消息上）。 */
function turnOfMessage(rec: SessionRecord, turns: TurnMark[]): Map<string, TurnMark> {
  const map = new Map<string, TurnMark>();
  let cursor = -1;
  for (let i = 0; i < rec.messages.length; i += 1) {
    while (cursor + 1 < turns.length && turns[cursor + 1]!.start <= i) cursor += 1;
    if (cursor >= 0) map.set(rec.messages[i]!.id, turns[cursor]!);
  }
  return map;
}

interface TaskIndex {
  byToolUseId: Map<string, TurnMark>;
  byTitle: Map<string, TurnMark>;
}

/** Task 工具 tool_use id / description → 发起它的轮次。 */
function taskIndex(rec: SessionRecord, turns: TurnMark[]): TaskIndex {
  const byToolUseId = new Map<string, TurnMark>();
  const byTitle = new Map<string, TurnMark>();
  const owner = turnOfMessage(rec, turns);
  for (const message of rec.messages) {
    if (message.role !== 'assistant') continue;
    const turn = owner.get(message.id);
    if (!turn) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Task') continue;
      byToolUseId.set(block.id, turn);
      const input = block.input as Record<string, unknown> | undefined;
      if (typeof input?.description === 'string' && input.description.trim()) {
        const key = input.description.trim().slice(0, 120);
        if (!byTitle.has(key)) byTitle.set(key, turn);
      }
    }
  }
  return { byToolUseId, byTitle };
}

function upId(rec: SessionRecord): string | undefined {
  return rec.parentId ?? rec.forkedFrom?.sessionId;
}

/** 树根：沿 parentId / forkedFrom 一路向上，成环或父会话缺失时当前会话即根。 */
function rootOf(start: SessionRecord, byId: Map<string, SessionRecord>): SessionRecord {
  let current = start;
  const seen = new Set<string>([start.id]);
  for (let depth = 0; depth < 64; depth += 1) {
    const parentId = upId(current);
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

/** 整棵树：根 + 递归分叉/子代理（按父会话展开，超过上限截断）。 */
function treeMembers(root: SessionRecord, byId: Map<string, SessionRecord>): SessionRecord[] {
  const out: SessionRecord[] = [root];
  const seen = new Set<string>([root.id]);
  for (let i = 0; i < out.length && out.length < MAX_TREE_SESSIONS; i += 1) {
    const current = out[i]!;
    for (const rec of byId.values()) {
      if (seen.has(rec.id)) continue;
      if (upId(rec) !== current.id) continue;
      seen.add(rec.id);
      out.push(rec);
    }
  }
  return out;
}

function kindOf(rec: SessionRecord): SessionGraphSession['kind'] {
  if (rec.forkedFrom) return 'fork';
  if (rec.parentId) return 'subagent';
  return 'root';
}

/**
 * 一棵会话树的拓扑：所有会话的独有轮次 + 接入关系。
 * 分叉复制来的祖先轮次不重复计入（消息 id 在复制时保留），由接入点指向祖先的轮次。
 * 调用方需先按可见性过滤会话列表。
 */
export function sessionGraph(
  host: Host,
  id: string,
  canSee: (rec: SessionRecord) => boolean = () => true,
): SessionGraphTree | undefined {
  const all = host.store.list();
  const byId = new Map(all.map((rec) => [rec.id, rec]));
  const start = byId.get(id);
  if (!start) return undefined;
  const root = rootOf(start, byId);
  const members = treeMembers(root, byId).filter(canSee);

  const fullTurns = new Map<string, TurnMark[]>();
  for (const rec of members) fullTurns.set(rec.id, turnsOf(rec));

  // 分叉的独有轮次 = 自己的轮次去掉来源会话已有的轮次（复制时消息 id 保留）。
  const ownTurns = new Map<string, TurnMark[]>();
  for (const rec of members) {
    const full = fullTurns.get(rec.id) ?? [];
    const sourceId = rec.forkedFrom?.sessionId;
    const source = sourceId ? fullTurns.get(sourceId) : undefined;
    if (!source) {
      ownTurns.set(rec.id, full);
      continue;
    }
    const copied = new Set(source.map((turn) => turn.id));
    ownTurns.set(rec.id, full.filter((turn) => !copied.has(turn.id)));
  }

  const ownerOfTurn = new Map<string, string>();
  for (const rec of members) {
    for (const turn of ownTurns.get(rec.id) ?? []) ownerOfTurn.set(turn.id, rec.id);
  }

  const sessions: SessionGraphSession[] = members.map((rec) => {
    const turns = ownTurns.get(rec.id) ?? [];
    const base: SessionGraphSession = {
      id: rec.id,
      title: rec.title || '未命名会话',
      kind: kindOf(rec),
      ...(rec.status === 'running' ? { running: true } : {}),
      turns: turns.map(({ start: _start, ...turn }) => turn),
    };
    if (rec.forkedFrom) {
      const sourceId = rec.forkedFrom.sessionId;
      const full = fullTurns.get(rec.id) ?? [];
      const at = rec.forkedFrom.messageId
        ? turnOfMessage(rec, full).get(rec.forkedFrom.messageId)
        : undefined;
      let turn = at;
      let owner = turn ? ownerOfTurn.get(turn.id) : undefined;
      // 分叉点可能落在来源会话（或更上面的祖先）的历史里：演示/迁移出来的分叉不带复制历史。
      if (!turn || !owner) {
        const source = byId.get(sourceId);
        if (source) {
          const sourceFull = fullTurns.get(sourceId) ?? turnsOf(source);
          fullTurns.set(sourceId, sourceFull);
          const hit = rec.forkedFrom.messageId
            ? turnOfMessage(source, sourceFull).get(rec.forkedFrom.messageId)
            : sourceFull[sourceFull.length - 1];
          if (hit) {
            turn = hit;
            owner = ownerOfTurn.get(hit.id) ?? sourceId;
          }
        }
      }
      if (!turn) turn = full[full.length - 1];
      base.parentId = sourceId;
      if (turn) {
        base.attachTurnId = turn.id;
        base.attachSessionId = owner ?? ownerOfTurn.get(turn.id) ?? sourceId;
      }
      return base;
    }
    if (rec.parentId) {
      const parent = byId.get(rec.parentId);
      base.parentId = rec.parentId;
      if (parent) {
        const parentFull = fullTurns.get(parent.id) ?? turnsOf(parent);
        fullTurns.set(parent.id, parentFull);
        const index = taskIndex(parent, parentFull);
        const byTool = rec.parentToolUseId ? index.byToolUseId.get(rec.parentToolUseId) : undefined;
        const byTitle = rec.title ? index.byTitle.get(rec.title.trim().slice(0, 120)) : undefined;
        const parentOwn = ownTurns.get(parent.id) ?? parentFull;
        const turn = byTool ?? byTitle ?? parentOwn[parentOwn.length - 1];
        if (turn) {
          base.attachTurnId = turn.id;
          base.attachSessionId = ownerOfTurn.get(turn.id) ?? parent.id;
        }
      }
      return base;
    }
    return base;
  });

  return { rootId: root.id, sessionId: id, sessions };
}
