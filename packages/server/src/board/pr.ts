// 看板 PR 聚合：把若干已完成卡按依赖顺序合到一个集成分支，再复用会话的 PR 能力（gh/glab）开 PR。
// 集成分支在临时 worktree 里构建，不碰用户主工作区；失败/成功后都清理 worktree，分支保留。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Board, BoardCard, BoardPrResult, BoardPrState } from '@tandem/protocol';
import { createPullRequest, getVcsState } from '../vcs.js';
import { errorMessage } from '../util/text.js';
import type { Host } from '../host.js';
import { topoOrder } from './graph.js';
import { currentHead } from './git.js';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.message ?? ''),
    };
  }
}

function shortOf(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

async function conflictsIn(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return out.stdout
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function bodyOf(board: Board, cards: BoardCard[]): string {
  const lines = [
    `看板「${board.name}」的 ${cards.length} 张卡片按依赖顺序合并。`,
    '',
    '## 卡片',
  ];
  let total = 0;
  for (const card of cards) {
    const result = card.result;
    total += result?.costUsd ?? 0;
    lines.push(`- **${card.title}**${result?.branch ? `（\`${result.branch}\`）` : ''}`);
    if (result?.summary) lines.push(`  ${truncate(result.summary, 500)}`);
    if (result) lines.push(`  改动 ${result.files} 个文件 +${result.additions} −${result.deletions} · ${formatUsd(result.costUsd)}`);
  }
  lines.push('', `合计花费 ${formatUsd(total)}。`, '', '由 Tandem 任务看板自动汇总。');
  return lines.join('\n');
}

function formatUsd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]);
  if (existsSync(dir)) await git(repo, ['worktree', 'prune']);
}

/**
 * 打开聚合 PR。调用方负责确认（UI 二次确认）；此处只做本地分支、push 与 CLI。
 * 任何失败都返回 ok:false + 可读 error，不改动看板卡片的合并状态。
 */
export async function openBoardPr(
  host: Host,
  board: Board,
  cardIds: unknown,
  baseInput?: unknown,
): Promise<BoardPrResult> {
  if (!board.isGit) return { ok: false, error: '不是 git 仓库，无法开 PR' };
  const wanted = new Set(
    (Array.isArray(cardIds) ? cardIds : []).filter((id): id is string => typeof id === 'string'),
  );
  if (wanted.size === 0) return { ok: false, error: '请选择至少一张已完成的卡' };
  const selected = board.cards.filter((card) => wanted.has(card.id));
  if (selected.length !== wanted.size) return { ok: false, error: '有卡片不存在' };
  for (const card of selected) {
    if (card.status !== 'done') return { ok: false, error: `「${card.title}」尚未完成` };
    if (!card.result?.branch) return { ok: false, error: `「${card.title}」没有可合并的分支（需要 worktree）` };
  }
  const ordered = topoOrder(board.cards).filter((card) => wanted.has(card.id));
  const base = typeof baseInput === 'string' && baseInput.trim()
    ? baseInput.trim()
    : board.baseBranch || (await currentHead(board.cwd));
  if (!base) return { ok: false, error: '无法确定目标分支' };

  for (const card of ordered) {
    const exists = await git(board.cwd, ['rev-parse', '--verify', `refs/heads/${card.result!.branch}`]);
    if (exists.code !== 0) return { ok: false, error: `分支不存在：${card.result!.branch}` };
  }

  const branch = `tandem/board-${shortOf(board.id)}-pr-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const dir = path.join(os.tmpdir(), `tandem-board-pr-${shortOf(board.id)}-${randomUUID().slice(0, 8)}`);
  const added = await git(board.cwd, ['worktree', 'add', '-b', branch, dir, base]);
  if (added.code !== 0) {
    return { ok: false, error: `创建集成分支失败：${(added.stderr || added.stdout).trim() || base}` };
  }
  let created = false;
  try {
    for (const card of ordered) {
      const merge = await git(dir, ['merge', '--no-ff', '--no-edit', card.result!.branch!]);
      if (merge.code !== 0) {
        const files = await conflictsIn(dir);
        await git(dir, ['merge', '--abort']);
        return {
          ok: false,
          error: `按依赖顺序合并「${card.title}」时冲突，已中止：${truncate((merge.stderr || merge.stdout).trim(), 600)}`,
          ...(files.length > 0 ? { conflictFiles: files } : {}),
        };
      }
    }
    const title = `看板「${board.name}」：${ordered.length} 张卡片`;
    const result = await createPullRequest(dir, `board-pr-${board.id}`, {
      title,
      body: bodyOf(board, ordered),
      base,
    });
    if (!result.ok) return { ok: false, error: result.error ?? '创建 PR 失败' };
    created = true;
    const pr = result.state?.pr;
    const state: BoardPrState = {
      branch,
      cardIds: ordered.map((card) => card.id),
      ...(pr?.url ? { url: pr.url } : {}),
      ...(pr?.number ? { number: pr.number } : {}),
      ...(pr?.state ? { state: pr.state } : {}),
      ...(pr?.checksState ? { checksState: pr.checksState } : {}),
      ...(pr?.checks ? { checks: pr.checks } : {}),
      updatedAt: Date.now(),
    };
    return { ok: true, branch, pr: state };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    await removeWorktree(board.cwd, dir);
    if (!created) console.warn('[tandem] 看板 PR 未创建，集成分支保留：', branch);
  }
}

/** 用 gh/glab 刷新聚合 PR 的状态与 CI 结果。 */
export async function refreshBoardPr(board: Board): Promise<BoardPrState | undefined> {
  const current = board.pr;
  if (!current?.branch) return undefined;
  try {
    const state = await getVcsState(board.cwd, undefined, current.branch);
    const pr = state.pr;
    if (!pr) return { ...current, updatedAt: Date.now() };
    return {
      ...current,
      ...(pr.url ? { url: pr.url } : {}),
      ...(pr.number ? { number: pr.number } : {}),
      state: pr.state,
      checksState: pr.checksState,
      checks: pr.checks,
      updatedAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}
