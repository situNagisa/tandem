// VCS / PR / CI：只调用本机 git 与已登录的 gh / glab，不接触任何托管平台令牌。
// 所有外部命令都用 execFile 参数数组，绝不拼 shell 字符串；remote URL 只在 Host 内解析，
// 对外只返回主机名与托管类型。
import { execFile } from 'node:child_process';
import type {
  CreatePrInput,
  PrCheck,
  PrChecksState,
  PrCheckStatus,
  PrMergeMethod,
  PrState,
  PullRequestInfo,
  VcsCapability,
  VcsProvider,
  VcsState,
} from '@tandem/protocol';
import type { Host } from './host.js';
import { repoRootOf } from './changes.js';
import { truncateEnd } from './util/text.js';

const GIT_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 25_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_LOG_CHARS = 40_000;
const MAX_BUFFER = 16 * 1024 * 1024;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

function run(bin: string, args: string[], cwd: string, timeout = CLI_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: unknown; stderr?: unknown };
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : (e.message ?? ''),
          ...(e.code === 'ENOENT' ? { notFound: true } : {}),
        });
      },
    );
  });
}

function gitArgs(args: string[]): string[] {
  return ['-c', 'core.quotepath=false', ...args];
}

function cliBin(provider: VcsProvider): string {
  if (provider === 'gitlab') return process.env.TANDEM_GLAB_PATH?.trim() || 'glab';
  return process.env.TANDEM_GH_PATH?.trim() || 'gh';
}

function docUrl(provider: VcsProvider): string {
  return provider === 'gitlab'
    ? 'https://gitlab.com/gitlab-org/cli'
    : 'https://cli.github.com/manual/';
}

/** 从 remote URL 提取主机名；不在日志/接口中暴露完整 URL。 */
function hostOfRemote(url: string): string | undefined {
  const value = url.trim();
  if (!value) return undefined;
  const scp = value.match(/^[^@/\s]+@([^:/\s]+):/);
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase();
  } catch {
    const m = value.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)/i);
    return m?.[1]?.toLowerCase();
  }
}

function providerOfHost(host: string | undefined): VcsProvider {
  if (!host) return 'none';
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return 'other';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** gh auth status / glab auth status 输出里取用户名；只返回用户名。 */
function parseCliUser(output: string): string | undefined {
  const patterns = [
    /Logged in to \S+ (?:account|as) (\S+)/i,
    /已登录到 \S+ (?:账号|账户) (\S+)/i,
    /Logged in as (\S+)/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m?.[1]) return m[1].replace(/[(),，。].*$/, '');
  }
  return undefined;
}

function mapCheckState(state: string): PrCheckStatus {
  switch (state.toUpperCase()) {
    case 'SUCCESS':
    case 'PASSED':
      return 'success';
    case 'FAILURE':
    case 'FAILED':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failure';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'NEUTRAL':
      return 'neutral';
    case 'PENDING':
    case 'EXPECTED':
    case 'WAITING':
    case 'REQUESTED':
      return 'pending';
    case 'IN_PROGRESS':
    case 'RUNNING':
      return 'in_progress';
    case 'QUEUED':
    case 'CREATED':
      return 'queued';
    default:
      return 'unknown';
  }
}

function mapGhCheck(raw: Record<string, unknown>): PrCheck {
  const typename = str(raw.__typename);
  const url = str(raw.detailsUrl) || str(raw.targetUrl);
  const runId = url.match(/\/actions\/runs\/(\d+)/)?.[1];
  const startedAt = str(raw.startedAt);
  const completedAt = str(raw.completedAt);
  const durationMs =
    startedAt && completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
      : undefined;
  if (typename === 'StatusContext' || (!raw.name && raw.context)) {
    return {
      name: str(raw.context) || '检查',
      status: mapCheckState(str(raw.state)),
      ...(url ? { url } : {}),
      ...(runId ? { runId } : {}),
    };
  }
  const run = raw.checkSuite && typeof raw.checkSuite === 'object'
    ? (raw.checkSuite as Record<string, unknown>).workflowRun
    : undefined;
  const workflowRun = run && typeof run === 'object' ? (run as Record<string, unknown>) : undefined;
  const workflow = workflowRun?.workflow && typeof workflowRun.workflow === 'object'
    ? str((workflowRun.workflow as Record<string, unknown>).name)
    : str(raw.workflowName);
  const conclusion = str(raw.conclusion);
  const status = conclusion ? mapCheckState(conclusion) : mapCheckState(str(raw.status));
  return {
    name: str(raw.name) || '检查',
    status,
    ...(conclusion ? { conclusion } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(url ? { url } : {}),
    ...(workflow ? { workflow } : {}),
    ...(runId ? { runId } : {}),
  };
}

function checksStateOf(checks: PrCheck[]): PrChecksState {
  if (checks.length === 0) return 'none';
  if (checks.some((check) => check.status === 'failure')) return 'failure';
  if (checks.some((check) => ['pending', 'in_progress', 'queued', 'unknown'].includes(check.status))) {
    return 'pending';
  }
  return 'success';
}

function mapPrState(state: string, isDraft: boolean): PrState {
  if (isDraft && state.toUpperCase() === 'OPEN') return 'DRAFT';
  const upper = state.toUpperCase();
  if (upper === 'OPEN' || upper === 'CLOSED' || upper === 'MERGED') return upper;
  return 'UNKNOWN';
}

async function readUpstream(root: string): Promise<string | undefined> {
  const result = await run('git', gitArgs(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), root, GIT_TIMEOUT_MS);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function readAheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
  const result = await run(
    'git',
    gitArgs(['-C', root, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    root,
    GIT_TIMEOUT_MS,
  );
  if (result.code !== 0) return { ahead: 0, behind: 0 };
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

async function detectCli(provider: VcsProvider): Promise<{
  cli: VcsCapability['cli'];
  cliInstalled: boolean;
  authenticated: boolean;
  cliUser?: string;
}> {
  if (provider !== 'github' && provider !== 'gitlab') {
    return { cli: 'none', cliInstalled: false, authenticated: false };
  }
  const bin = cliBin(provider);
  const version = await run(bin, ['--version'], process.cwd(), 10_000);
  if (version.notFound || version.code !== 0) {
    return { cli: provider === 'gitlab' ? 'glab' : 'gh', cliInstalled: false, authenticated: false };
  }
  const auth = await run(bin, ['auth', 'status'], process.cwd(), 15_000);
  const user = parseCliUser(`${auth.stdout}\n${auth.stderr}`);
  return {
    cli: provider === 'gitlab' ? 'glab' : 'gh',
    cliInstalled: true,
    authenticated: !!user,
    ...(user ? { cliUser: user } : {}),
  };
}

async function readCapability(root: string): Promise<VcsCapability> {
  const [branchOut, remoteOut, remoteRaw] = await Promise.all([
    run('git', gitArgs(['-C', root, 'branch', '--show-current']), root, GIT_TIMEOUT_MS),
    run('git', gitArgs(['-C', root, 'remote', 'get-url', 'origin']), root, GIT_TIMEOUT_MS),
    // 配置里的原始 URL：url.<local>.insteadOf 会把 get-url 展开成本地路径，展示与平台识别仍应以原始地址为准
    run('git', gitArgs(['-C', root, 'config', '--get', 'remote.origin.url']), root, GIT_TIMEOUT_MS),
  ]);
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : '';
  const remoteUrl = remoteRaw.code === 0 && remoteRaw.stdout.trim() ? remoteRaw.stdout : remoteOut.stdout;
  const remoteHost = (remoteRaw.code === 0 || remoteOut.code === 0) ? hostOfRemote(remoteUrl) : undefined;
  const provider = providerOfHost(remoteHost);
  const [upstream, aheadBehind, cli] = await Promise.all([
    readUpstream(root),
    readAheadBehind(root),
    detectCli(provider),
  ]);
  return {
    isRepo: true,
    root,
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ...aheadBehind,
    provider,
    ...(remoteHost ? { remoteHost } : {}),
    ...cli,
    ...(provider === 'github' || provider === 'gitlab' ? { docUrl: docUrl(provider) } : {}),
  };
}

async function readGhPr(root: string, ref?: string): Promise<PullRequestInfo | undefined> {
  const result = await run(
    cliBin('github'),
    [
      'pr',
      'view',
      ...(ref ? [ref] : []),
      '--json',
      'number,title,state,url,isDraft,reviewDecision,statusCheckRollup,mergeable,baseRefName,headRefName,updatedAt',
    ],
    root,
  );
  if (result.code !== 0) {
    // 没有 PR 是正常状态；其他错误（未登录/非 GitHub 仓库）由能力检测给出指引
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const number = num(raw.number);
  const url = str(raw.url);
  if (!number || !url) return undefined;
  const isDraft = raw.isDraft === true;
  const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
  const checks = rollup
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(mapGhCheck);
  const updatedAt = str(raw.updatedAt);
  return {
    number,
    title: str(raw.title),
    state: mapPrState(str(raw.state), isDraft),
    url,
    isDraft,
    ...(str(raw.reviewDecision) ? { reviewDecision: str(raw.reviewDecision) } : {}),
    ...(str(raw.mergeable) ? { mergeable: str(raw.mergeable) } : {}),
    ...(str(raw.baseRefName) ? { baseRefName: str(raw.baseRefName) } : {}),
    ...(str(raw.headRefName) ? { headRefName: str(raw.headRefName) } : {}),
    ...(updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? { updatedAt: Date.parse(updatedAt) } : {}),
    checks,
    checksState: checksStateOf(checks),
  };
}

async function readGlabMr(root: string, ref?: string): Promise<PullRequestInfo | undefined> {
  const result = await run(cliBin('gitlab'), ['mr', 'view', ...(ref ? [ref] : []), '--output', 'json'], root);
  if (result.code !== 0) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const number = num(raw.iid) ?? num(raw.number);
  const url = str(raw.web_url) ?? str(raw.webUrl);
  if (!number || !url) return undefined;
  const isDraft = raw.draft === true || raw.work_in_progress === true;
  const checks: PrCheck[] = [];
  const pipeline = raw.head_pipeline && typeof raw.head_pipeline === 'object'
    ? (raw.head_pipeline as Record<string, unknown>)
    : undefined;
  if (pipeline) {
    const status = str(pipeline.status);
    checks.push({
      name: 'Pipeline',
      status: mapCheckState(status),
      ...(str(pipeline.web_url) ? { url: str(pipeline.web_url) } : {}),
      ...(num(pipeline.id) !== undefined ? { runId: String(pipeline.id) } : {}),
    });
  }
  const state = mapPrState(str(raw.state), isDraft);
  return {
    number,
    title: str(raw.title),
    state,
    url,
    isDraft,
    ...(str(raw.merge_status) ? { mergeable: str(raw.merge_status) } : {}),
    ...(str(raw.source_branch) ? { headRefName: str(raw.source_branch) } : {}),
    ...(str(raw.target_branch) ? { baseRefName: str(raw.target_branch) } : {}),
    checks,
    checksState: checksStateOf(checks),
  };
}

async function readPr(root: string, provider: VcsProvider, ref?: string): Promise<PullRequestInfo | undefined> {
  if (provider === 'github') return readGhPr(root, ref);
  if (provider === 'gitlab') return readGlabMr(root, ref);
  return undefined;
}

const prCache = new Map<string, PullRequestInfo | undefined>();

/** 读当前会话的 VCS 能力与 PR；sessionId 用于轮询缓存。 */
export async function getVcsState(cwd: string, sessionId?: string, ref?: string): Promise<VcsState> {
  const root = await repoRootOf(cwd);
  if (!root) {
    return {
      vcs: {
        isRepo: false,
        ahead: 0,
        behind: 0,
        provider: 'none',
        cli: 'none',
        cliInstalled: false,
        authenticated: false,
      },
    };
  }
  const vcs = await readCapability(root);
  let pr: PullRequestInfo | undefined;
  if (vcs.authenticated && (vcs.provider === 'github' || vcs.provider === 'gitlab')) {
    pr = await readPr(root, vcs.provider, ref);
  }
  if (sessionId) prCache.set(sessionId, pr);
  return { vcs, ...(pr ? { pr } : {}) };
}

function prSignature(pr: PullRequestInfo | undefined): string {
  if (!pr) return 'none';
  return JSON.stringify({
    n: pr.number,
    s: pr.state,
    c: pr.checksState,
    checks: pr.checks.map((check) => `${check.name}:${check.status}`).sort(),
  });
}

/** 创建 PR：先 push 当前分支，再走平台 CLI。调用方负责让用户确认。 */
export async function createPullRequest(
  cwd: string,
  sessionId: string,
  input: CreatePrInput,
): Promise<{ ok: boolean; error?: string; state?: VcsState }> {
  const title = str(input.title);
  if (!title) return { ok: false, error: 'PR 标题不能为空' };
  const root = await repoRootOf(cwd);
  if (!root) return { ok: false, error: '当前目录不是 git 仓库' };
  const vcs = await readCapability(root);
  if (vcs.provider !== 'github' && vcs.provider !== 'gitlab') {
    return { ok: false, error: '远程仓库不是 GitHub / GitLab，暂不支持创建 PR' };
  }
  if (!vcs.cliInstalled) {
    return { ok: false, error: `未安装 ${vcs.cli}，请先安装并登录` };
  }
  if (!vcs.authenticated) {
    return { ok: false, error: `${vcs.cli} 未登录，请先运行 ${vcs.cli} auth login` };
  }

  const push = await run('git', gitArgs(['-C', root, 'push', '-u', 'origin', 'HEAD']), root, PUSH_TIMEOUT_MS);
  if (push.code !== 0) {
    const detail = (push.stderr || push.stdout).trim();
    return { ok: false, error: detail ? `推送分支失败：${truncateEnd(detail, 1200)}` : '推送分支失败' };
  }

  const base = str(input.base);
  const body = typeof input.body === 'string' ? input.body : '';
  let created: RunResult;
  if (vcs.provider === 'github') {
    const args = ['pr', 'create', '--title', title, '--body', body];
    if (base) args.push('--base', base);
    if (input.draft) args.push('--draft');
    created = await run(cliBin('github'), args, root, PUSH_TIMEOUT_MS);
  } else {
    const args = ['mr', 'create', '--title', title, '--description', body, '--yes'];
    if (base) args.push('--target-branch', base);
    if (input.draft) args.push('--draft');
    created = await run(cliBin('gitlab'), args, root, PUSH_TIMEOUT_MS);
  }
  if (created.code !== 0) {
    const detail = (created.stderr || created.stdout).trim();
    return { ok: false, error: detail ? truncateEnd(detail, 2000) : '创建 PR 失败' };
  }
  prCache.delete(sessionId);
  const state = await getVcsState(cwd, sessionId);
  return { ok: true, state };
}

/** 合并当前分支的 PR（squash / merge / rebase）。调用方负责二次确认。 */
export async function mergePullRequest(
  cwd: string,
  sessionId: string,
  method: PrMergeMethod,
): Promise<{ ok: boolean; error?: string; state?: VcsState }> {
  const root = await repoRootOf(cwd);
  if (!root) return { ok: false, error: '当前目录不是 git 仓库' };
  const vcs = await readCapability(root);
  if (!vcs.authenticated) return { ok: false, error: `${vcs.cli} 未登录` };
  let result: RunResult;
  if (vcs.provider === 'github') {
    const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge';
    result = await run(cliBin('github'), ['pr', 'merge', flag], root, PUSH_TIMEOUT_MS);
  } else if (vcs.provider === 'gitlab') {
    const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge';
    result = await run(cliBin('gitlab'), ['mr', 'merge', flag, '--yes'], root, PUSH_TIMEOUT_MS);
  } else {
    return { ok: false, error: '远程仓库不是 GitHub / GitLab' };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, error: detail ? truncateEnd(detail, 2000) : '合并失败' };
  }
  prCache.delete(sessionId);
  const state = await getVcsState(cwd, sessionId);
  return { ok: true, state };
}

/** 读取失败检查的日志（gh run view --log-failed / glab ci trace），并生成交给 agent 的消息。 */
export async function failedCheckPrompt(
  cwd: string,
  check: { checkName?: unknown; runId?: unknown; url?: unknown },
  renderPrompt?: (name: string, log: string) => string,
): Promise<{ ok: boolean; error?: string; message?: string; checkName?: string }> {
  const name = str(check.checkName) || 'CI 检查';
  const root = await repoRootOf(cwd);
  if (!root) return { ok: false, error: '当前目录不是 git 仓库' };
  const vcs = await readCapability(root);
  if (!vcs.authenticated) return { ok: false, error: `${vcs.cli} 未登录，无法读取失败日志` };
  const url = str(check.url);
  const runId = str(check.runId) || url.match(/\/actions\/runs\/(\d+)/)?.[1] || url.match(/\/pipelines\/(\d+)/)?.[1] || '';
  let log: RunResult;
  if (vcs.provider === 'github') {
    if (!runId) return { ok: false, error: '该检查没有可用的运行 id，无法读取日志' };
    log = await run(cliBin('github'), ['run', 'view', runId, '--log-failed'], root, 60_000);
  } else if (vcs.provider === 'gitlab') {
    log = await run(cliBin('gitlab'), ['ci', 'trace'], root, 60_000);
  } else {
    return { ok: false, error: '远程仓库不是 GitHub / GitLab' };
  }
  const text = (log.stdout || log.stderr).trim();
  if (!text) return { ok: false, error: '没有取到失败日志' };
  const clipped = truncateEnd(text, MAX_LOG_CHARS);
  return {
    ok: true,
    checkName: name,
    message:
      renderPrompt?.(name, clipped) ??
      `CI 检查「${name}」失败。失败日志如下：\n\n\`\`\`\n${clipped}\n\`\`\`\n\n请定位失败原因并修复；修复后说明改了哪些文件。`,
  };
}

/**
 * 每 60s 轮询“已打开（有 WS 订阅）且有 PR”的会话；变化时广播 vcs_updated 并写入收件箱。
 * 首次发现 PR 由客户端 GET /vcs 填充缓存。
 */
export function startPrPolling(host: Host, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const [sessionId, prev] of [...prCache]) {
        if (!prev || !host.hub.hasSubscribers(sessionId)) continue;
        const rec = host.store.get(sessionId);
        if (!rec) {
          prCache.delete(sessionId);
          continue;
        }
        let state: VcsState;
        try {
          state = await getVcsState(rec.cwd, sessionId);
        } catch {
          continue;
        }
        const next = state.pr;
        if (prSignature(prev) === prSignature(next)) continue;
        host.hub.broadcastAll({ type: 'vcs_updated', sessionId, state });
        if (next) {
          const failed = next.checks.filter((check) => check.status === 'failure').map((c) => c.name);
          let text: string | undefined;
          if (next.checksState === 'failure' && prev.checksState !== 'failure') {
            text = `PR #${next.number} CI 失败${failed.length ? `：${failed.join('、')}` : ''}`;
          } else if (next.state === 'MERGED' && prev.state !== 'MERGED') {
            text = `PR #${next.number} 已合并`;
          } else if (next.state === 'CLOSED' && prev.state !== 'CLOSED') {
            text = `PR #${next.number} 已关闭`;
          }
          if (text) {
            host.recordCi(sessionId, rec.title, {
              prNumber: next.number,
              prUrl: next.url,
              checksState: next.checksState,
              ...(failed[0] ? { checkName: failed[0] } : {}),
              text,
            });
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
