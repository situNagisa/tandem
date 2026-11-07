// 会话的 git 环境检测、分支切换与 worktree 生命周期。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionRecord } from '../types.js';
import { checkoutBranch, createWorktree, gitRepoRoot, listBranches, mergeWorktree } from '../worktree.js';
import { detectSessionEnv } from '../util/git.js';
import type { Host } from '../host.js';
import { httpError } from './helpers.js';

export async function refreshEnv(host: Host, id: string): Promise<void> {
  const rec = host.store.get(id);
  if (!rec) return;
  // worktree 内跑 git 会把 worktree 目录当成仓库根，项目名变成分支目录名。
  // 统一用原仓库根 + worktree 分支，保证侧栏/顶栏与主仓库一致。
  const env =
    rec.worktree && rec.worktreeRepoRoot
      ? {
          repoRoot: rec.worktreeRepoRoot,
          repoName: path.basename(rec.worktreeRepoRoot),
          branch: rec.worktree.branch,
        }
      : await detectSessionEnv(rec.cwd);
  const before = JSON.stringify(rec.env ?? null);
  const after = JSON.stringify(env ?? null);
  if (before === after) return;
  if (env) rec.env = env;
  else delete rec.env;
  host.store.markDirty(rec.id, false);
  host.broadcastSummary(rec);
}

export async function mergeSessionWorktree(host: Host, id: string,
    strategy: 'merge' | 'squash',): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
  const rec = host.store.get(id);
  if (!rec) throw httpError('会话不存在', 404);
  if (!rec.worktree) return { ok: false, error: '该会话不是 worktree 会话' };
  if (host.isRunning(id)) return { ok: false, error: '会话正在运行，无法合并' };
  const repoRoot = rec.worktreeRepoRoot ?? (await gitRepoRoot(rec.worktree.path));
  if (!repoRoot) return { ok: false, error: '找不到 worktree 所属的原仓库' };
  const result = await mergeWorktree(
    repoRoot,
    rec.worktree.baseBranch,
    rec.worktree.branch,
    strategy,
  );
  if (result.ok) void host.refreshEnv(id);
  return result;
}

export async function sessionBranches(host: Host, id: string): Promise<{ current?: string; branches: string[] }> {
  const rec = host.store.get(id);
  if (!rec) throw httpError('会话不存在', 404);
  return listBranches(rec.cwd);
}

export async function checkoutSessionBranch(host: Host, id: string, branch: string, create: boolean): Promise<SessionRecord> {
  const rec = host.store.get(id);
  if (!rec) throw httpError('会话不存在', 404);
  if (host.isRunning(id)) throw httpError('会话正在运行，无法切换分支', 409);
  await checkoutBranch(rec.cwd, branch, create);
  await host.refreshEnv(id);
  return rec;
}

export async function enterSessionWorktree(host: Host, id: string, branch?: string): Promise<SessionRecord> {
  const rec = host.store.get(id);
  if (!rec) throw httpError('会话不存在', 404);
  if (host.isRunning(id)) throw httpError('会话正在运行，无法创建 worktree', 409);
  if (rec.worktree) throw new Error('该会话已在 worktree 中');
  const info = await createWorktree(host.home, rec.cwd, branch, randomUUID().slice(0, 8));
  rec.cwd = info.path;
  rec.worktree = { path: info.path, branch: info.branch, baseBranch: info.baseBranch };
  rec.worktreeRepoRoot = info.repoRoot;
  rec.env = {
    repoRoot: info.repoRoot,
    repoName: path.basename(info.repoRoot),
    branch: info.branch,
  };
  host.store.markDirty(rec.id, false);
  host.broadcastSummary(rec);
  return rec;
}
