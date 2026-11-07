// 协调者（规划器）：一次性把一句目标拆成任务卡草稿。只返回草稿，由用户确认后才创建。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Board, BoardPlanDraft } from '@tandem/protocol';
import { completeText } from '../providers/index.js';
import { errorMessage } from '../util/text.js';
import type { Host } from '../host.js';
import { MAX_PLAN_CARDS, parsePlan } from './graph.js';

export const PLANNER_SYSTEM = '你是任务看板规划器。把用户的目标拆成若干可由编程 agent 独立完成的任务卡，只输出 JSON，不要解释。';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);

function listTree(root: string, depth: number, limit: number): string[] {
  const lines: string[] = [];
  const walk = (dir: string, level: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (lines.length >= limit) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${'  '.repeat(level)}${name}${isDir ? '/' : ''}`);
      if (isDir && level + 1 < depth) walk(full, level + 1);
    }
  };
  walk(root, 0);
  return lines;
}

function readHead(file: string, limit: number): string {
  try {
    return readFileSync(file, 'utf8').slice(0, limit);
  } catch {
    return '';
  }
}

/** 项目轻量上下文：目录前两层 + README / AGENTS.md 开头，只读。 */
export function projectContext(cwd: string): string {
  const parts = [`目录（前两层）：\n${listTree(cwd, 2, 60).join('\n') || '（空）'}`];
  for (const name of ['README.md', 'AGENTS.md']) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    const head = readHead(file, 4000);
    if (head.trim()) parts.push(`${name} 开头：\n${head}`);
  }
  return parts.join('\n\n');
}

export function plannerPrompt(host: Host, board: Board, goal: string): string {
  const presets = host.subagentPresets.list(board.cwd).map((preset) => preset.name);
  return [
    `目标：${goal}`,
    '',
    projectContext(board.cwd),
    '',
    `可用的子代理预设：${presets.length > 0 ? presets.join('、') : '（无）'}。`,
    '',
    `请输出 JSON 数组（最多 ${MAX_PLAN_CARDS} 张卡），每项字段：`,
    '- ref：草稿内的唯一短名，如 "c1"',
    '- title：卡片标题（≤40 字）',
    '- prompt：交给 agent 的完整任务说明，写清范围与验收标准',
    '- deps：必须先完成的草稿 ref 数组（没有则 []；只在确有先后依赖时填写，能并行就并行）',
    '- preset：可选，上面预设之一',
    '- gate：可选，true 表示完成后需人工确认才放行下游（高风险变更用）',
  ].join('\n');
}

export async function planCards(host: Host, board: Board, goal: string): Promise<BoardPlanDraft[]> {
  const profileId = board.defaults.profileId || host.profiles.list()[0]?.id || '';
  const groupId = board.defaults.groupId;
  const selection = host.keyCandidates(profileId, groupId);
  const candidate = selection.candidates[0];
  const profile = candidate?.profile ?? host.profileFor(profileId, groupId);
  const model = board.defaults.model || profile?.defaultModel || '';
  if (!profile?.apiKey || !model) throw new Error('没有可用的账号或模型，请先在设置里配置账号');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let raw: string;
  try {
    raw = await completeText({
      profile,
      model,
      system: PLANNER_SYSTEM,
      prompt: plannerPrompt(host, board, goal),
      maxTokens: 4000,
      signal: controller.signal,
    });
    host.markKeySuccess(profileId, groupId, candidate?.keyId);
  } catch (err) {
    host.markKeyFailure(profileId, groupId, candidate?.keyId, err);
    throw new Error(controller.signal.aborted ? '规划超时，请重试或缩小目标' : errorMessage(err));
  } finally {
    clearTimeout(timer);
  }
  return parsePlan(raw);
}
