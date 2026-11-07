// 看板用到的 git 小工具：自动提交、改动统计、把依赖分支合进卡片 worktree。全部参数数组调用。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitErrorText } from '../worktree.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout ?? '');
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  commit?: string;
}

/** 把 worktree 里的所有改动提交到卡片分支（没有改动时不产生提交），返回相对基准分支的统计。 */
export async function commitAndStat(worktreePath: string, baseRef: string, message: string): Promise<DiffStat> {
  const status = (await git(worktreePath, ['status', '--porcelain'])).trim();
  if (status) {
    await git(worktreePath, ['add', '-A']);
    await git(worktreePath, [
      '-c', 'user.name=Tandem',
      '-c', 'user.email=tandem@localhost',
      'commit', '-m', message.slice(0, 200) || 'board card',
    ]);
  }
  const commit = (await git(worktreePath, ['rev-parse', '--short', 'HEAD'])).trim();
  let files = 0;
  let additions = 0;
  let deletions = 0;
  try {
    const out = await git(worktreePath, ['diff', '--numstat', `${baseRef}..HEAD`]);
    for (const line of out.split('\n')) {
      const [add, del] = line.split('\t');
      if (add === undefined || del === undefined || !line.trim()) continue;
      files += 1;
      additions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
  } catch {
    // 基准分支不存在时只丢统计
  }
  return { files, additions, deletions, ...(commit ? { commit } : {}) };
}

/** 在卡片 worktree 内合入依赖卡的分支；冲突时中止并返回错误。 */
export async function mergeBranchInto(
  worktreePath: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await git(worktreePath, [
      '-c', 'user.name=Tandem',
      '-c', 'user.email=tandem@localhost',
      'merge', '--no-edit', branch,
    ]);
    return { ok: true };
  } catch (err) {
    const conflicts = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'], 10_000).catch(() => '');
    await git(worktreePath, ['merge', '--abort'], 10_000).catch(() => '');
    return {
      ok: false,
      error: conflicts.trim()
        ? `依赖分支冲突（${branch}）：${conflicts.trim().split('\n').slice(0, 5).join('、')}`
        : `合入依赖分支失败（${branch}）：${gitErrorText(err)}`,
    };
  }
}

export async function currentHead(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'], 10_000)).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['branch', '--show-current'], 10_000)).trim() || undefined;
  } catch {
    return undefined;
  }
}
