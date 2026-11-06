// Worktree 并行会话：创建/合并/清理；全部使用 execFile 参数数组，避免 shell 注入。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSubPath } from './util/path.js';

const exec = promisify(execFile);
const GIT_TIMEOUT = 60_000;

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout ?? '');
}

export async function gitRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

/** 在仓库中创建 worktree；branch 缺省 tandem/<shortId>。 */
export async function createWorktree(
  home: string,
  cwd: string,
  branchInput: string | undefined,
  shortId: string,
): Promise<WorktreeInfo> {
  const repoRoot = await gitRepoRoot(cwd);
  if (!repoRoot) throw new Error('当前目录不在 git 仓库中，无法创建 worktree');
  const gitDir = (await git(repoRoot, ['rev-parse', '--git-dir'])).trim();
  if (gitDir && path.resolve(repoRoot, gitDir) !== path.join(repoRoot, '.git')) {
    throw new Error('worktree 会话需要在主仓库中创建，不能在另一个 worktree 里创建');
  }

  const baseBranch = (await git(repoRoot, ['branch', '--show-current'])).trim();
  if (!baseBranch) throw new Error('仓库处于 detached HEAD，无法确定基准分支');

  const branch = (branchInput ?? '').trim() || `tandem/${shortId}`;
  try {
    await git(repoRoot, ['check-ref-format', '--branch', branch], 5_000);
  } catch {
    throw new Error(`无效的分支名: ${branch}`);
  }

  const repoName = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  const root = path.join(home, 'worktrees', repoName);
  const target = path.resolve(root, branch);
  if (!isSubPath(root, target) || target === root) throw new Error(`无效的 worktree 路径: ${branch}`);
  if (existsSync(target)) throw new Error(`worktree 目录已存在: ${target}`);

  // branch 已存在时 git 会报错；给出更明确的中文提示
  try {
    await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], 5_000);
    throw new Error(`分支已存在: ${branch}`);
  } catch (err) {
    if ((err as Error).message.startsWith('分支已存在')) throw err;
  }

  try {
    await git(repoRoot, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  } catch (err) {
    throw new Error(`创建 worktree 失败: ${gitErrorText(err)}`);
  }
  return { path: target, branch, baseBranch, repoRoot };
}

export interface MergeResult {
  ok: boolean;
  error?: string;
}

/** 把 worktree 分支合回 baseBranch；冲突时 abort 并返回错误。 */
export async function mergeWorktree(
  repoRoot: string,
  baseBranch: string,
  branch: string,
  strategy: 'merge' | 'squash',
): Promise<MergeResult> {
  if (!existsSync(repoRoot)) return { ok: false, error: `原仓库不存在: ${repoRoot}` };

  try {
    const current = (await git(repoRoot, ['branch', '--show-current'])).trim();
    if (current !== baseBranch) {
      await git(repoRoot, ['checkout', baseBranch]);
    }

    if (strategy === 'squash') {
      await git(repoRoot, ['merge', '--squash', branch]);
      // squash 只暂存改动，需要补一次提交；没有改动时视为已完成
      const staged = (await git(repoRoot, ['diff', '--cached', '--name-only'])).trim();
      if (staged) {
        await git(repoRoot, ['commit', '-m', `Squash merge ${branch}`]);
      }
    } else {
      await git(repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
    }
    return { ok: true };
  } catch (err) {
    const conflicted = await hasConflicts(repoRoot);
    if (conflicted) {
      await abortMerge(repoRoot);
      return { ok: false, error: `合并冲突，已中止（请先解决 ${branch} 与 ${baseBranch} 的差异）` };
    }
    return { ok: false, error: `合并失败: ${gitErrorText(err)}` };
  }
}

async function hasConflicts(repoRoot: string): Promise<boolean> {
  try {
    const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U'], 5_000);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function abortMerge(repoRoot: string): Promise<void> {
  try {
    await git(repoRoot, ['merge', '--abort'], 10_000);
  } catch {
    // squash 合并没有 MERGE_HEAD，用 reset --merge 清理冲突状态
    try {
      await git(repoRoot, ['reset', '--merge'], 10_000);
    } catch {
      // ignore
    }
  }
}

export interface WorktreeCleanliness {
  dirty: boolean;
  detail?: string;
}

/** 检查 worktree 是否有未提交改动（含未跟踪文件）。 */
export async function worktreeCleanliness(worktreePath: string): Promise<WorktreeCleanliness> {
  if (!existsSync(worktreePath)) return { dirty: false };
  try {
    const out = (await git(worktreePath, ['status', '--porcelain'], 10_000)).trim();
    return { dirty: out.length > 0, detail: out.slice(0, 2000) };
  } catch (err) {
    return { dirty: false, detail: gitErrorText(err) };
  }
}

/** 删除 worktree 并删除分支；force=false 时若目录缺失仅清理登记。 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  force: boolean,
): Promise<void> {
  if (!existsSync(repoRoot)) return;
  if (existsSync(worktreePath)) {
    try {
      await git(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
    } catch (err) {
      if (!force) throw new Error(`删除 worktree 失败: ${gitErrorText(err)}`);
      // force 时目录可能被占用，尝试 prune 登记
    }
  }
  try {
    await git(repoRoot, ['worktree', 'prune'], 10_000);
  } catch {
    // ignore
  }
  try {
    await git(repoRoot, ['branch', '-D', branch], 10_000);
  } catch {
    // 分支可能已被合并/删除，忽略
  }
}

/** 列出 cwd 所在仓库的本地分支（git branch --format）。 */
export async function listBranches(
  cwd: string,
): Promise<{ current?: string; branches: string[] }> {
  const repoRoot = await gitRepoRoot(cwd);
  if (!repoRoot) return { branches: [] };
  const current = (await git(cwd, ['branch', '--show-current'])).trim() || undefined;
  const out = await git(repoRoot, ['branch', '--format=%(refname:short)']);
  const branches = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { ...(current ? { current } : {}), branches };
}

/** 切换分支；有未提交改动（含未跟踪文件）时拒绝，抛 409。 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
  create: boolean,
): Promise<void> {
  const name = branch.trim();
  if (!name) throw new Error('分支名不能为空');
  try {
    await git(cwd, ['check-ref-format', '--branch', name], 5_000);
  } catch {
    throw new Error(`无效的分支名: ${name}`);
  }
  const state = await worktreeCleanliness(cwd);
  if (state.dirty) {
    const err = new Error('有未提交改动，请先提交或暂存后再切换分支') as Error & {
      statusCode?: number;
    };
    err.statusCode = 409;
    throw err;
  }
  try {
    await git(cwd, create ? ['checkout', '-b', name] : ['checkout', name]);
  } catch (err) {
    throw new Error(`切换分支失败: ${gitErrorText(err)}`);
  }
}

export function gitErrorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return (stderr || e.message || String(err)).slice(0, 2000);
}
