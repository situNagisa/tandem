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

const envCache = new Map<string, { at: number; env?: SessionEnv }>();
const envPending = new Map<string, Promise<SessionEnv | undefined>>();
const ENV_TTL_MS = 2_500;

/** 同一 cwd 的并发检测合并成一次；2.5s 内复用结果，避免侧栏首屏为同一仓库拉起上百个 git。 */
export async function detectSessionEnv(cwd: string): Promise<SessionEnv | undefined> {
  const hit = envCache.get(cwd);
  if (hit && Date.now() - hit.at < ENV_TTL_MS) return hit.env ? { ...hit.env } : undefined;
  const pending = envPending.get(cwd);
  if (pending) return pending;
  const task = detectSessionEnvUncached(cwd)
    .then((env) => {
      envCache.set(cwd, { at: Date.now(), env });
      return env ? { ...env } : undefined;
    })
    .finally(() => envPending.delete(cwd));
  envPending.set(cwd, task);
  return task;
}

async function detectSessionEnvUncached(cwd: string): Promise<SessionEnv | undefined> {
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
