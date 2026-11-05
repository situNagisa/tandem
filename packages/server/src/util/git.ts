// 检测会话 cwd 所属的 git 仓库与当前分支，供侧栏按 项目/分支 归类。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SessionEnv } from '@tandem/protocol';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** 非 git 仓库、git 不可用或超时都返回 undefined，不影响会话本身。 */
export async function detectSessionEnv(cwd: string): Promise<SessionEnv | undefined> {
  let repoRoot: string;
  try {
    repoRoot = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
  if (!repoRoot) return undefined;

  const env: SessionEnv = {
    repoRoot,
    repoName: path.basename(repoRoot),
  };
  try {
    // detached HEAD 时输出为空，此时不写 branch
    const branch = await git(cwd, ['branch', '--show-current']);
    if (branch) env.branch = branch;
  } catch {
    // 分支查询失败只丢失分支信息
  }
  return env;
}
