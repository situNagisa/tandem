// 评测：把真实会话存成回归用例，在独立临时目录中按多个配置重跑并对比结果。
// 用例 ~/.tandem/evals/<suite>/<case>.json；快照：git 记录 commit（运行时临时 worktree 检出），
// 非 git 目录复制为快照（限 50MB）。运行使用 bypassPermissions，仅允许在 Host 临时目录中。
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ContentBlock,
  EvalCase,
  EvalCheckResult,
  EvalConfig,
  EvalResult,
  EvalReviewResult,
  EvalReviewer,
  EvalRun,
  EvalRunSummary,
  EvalSnapshot,
  Message,
  ReasoningEffort,
  SaveEvalCaseInput,
  StartEvalRunInput,
} from '@tandem/protocol';
import { countTurns } from '@tandem/protocol';
import { effectiveProfile, writePrivateFile } from './config.js';
import { completeText } from './providers/index.js';
import type { Host } from './host.js';
import { EFFORTS } from './host/helpers.js';
import { normalizeDelegation } from './routing-settings.js';
import { EDITABLE_PROMPTS } from './prompts/registry.js';
import type { SessionRecord } from './types.js';
import { cmdUtf8Command, decodeProcessOutput } from './util/encoding.js';
import { isSubPath } from './util/path.js';
import { errorMessage, truncateEnd } from './util/text.js';
import { gitErrorText, gitRepoRoot } from './worktree.js';

const exec = promisify(execFile);
const GIT_TIMEOUT = 60_000;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 180_000;
const CHECK_OUTPUT_LIMIT = 8_000;
const MAX_CONCURRENCY = 8;
const MAX_RUNS = 50;

interface Workspace {
  root: string;
  dir: string;
  repoPath?: string;
}

interface CellTask {
  result: EvalResult;
  testCase: EvalCase;
  config: EvalConfig;
}

function safeSegment(input: unknown, fallback: string): string {
  const raw = String(input ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return raw || fallback;
}

function userTextOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function lastAssistantText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(stdout ?? '');
}

function isTempWorkspace(dir: string): boolean {
  const parent = path.dirname(path.resolve(dir));
  return (
    isSubPath(path.resolve(os.tmpdir()), parent) &&
    path.basename(parent).startsWith('tandem-eval-') &&
    path.basename(path.resolve(dir)) === 'ws'
  );
}

function skipCopy(src: string): boolean {
  try {
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && path.basename(src) === '.git') return true;
    return false;
  } catch {
    return true;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      total += 0;
    } else if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      const stat = lstatSync(full);
      total += stat.size;
    }
    if (total > MAX_SNAPSHOT_BYTES) return total;
  }
  return total;
}

function runCheck(command: string, cwd: string): Promise<EvalCheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdUtf8Command(command)], {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/bash', ['-lc', command], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (bytes > CHECK_OUTPUT_LIMIT * 4) return;
      chunks.push(chunk);
      bytes += chunk.length;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已退出
      }
    }, CHECK_TIMEOUT_MS);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      let output = truncateEnd(decodeProcessOutput(Buffer.concat(chunks)), CHECK_OUTPUT_LIMIT);
      if (timedOut) output += `\n[检查命令超时，已终止（${CHECK_TIMEOUT_MS / 1000}s）]`;
      resolve({
        command,
        exitCode: timedOut ? null : code,
        ok: !timedOut && code === 0,
        output,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        ok: false,
        output: `[无法启动检查命令: ${err.message}]`,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', finish);
  });
}

export class EvalManager {
  private readonly dir: string;
  private readonly runsDir: string;
  private readonly runs = new Map<string, EvalRun>();
  private readonly cancelled = new Set<string>();
  /** runId -> 正在运行的会话 id，取消时逐个中断。 */
  private readonly activeSessions = new Map<string, Set<string>>();

  constructor(private readonly host: Host) {
    this.dir = path.join(host.home, 'evals');
    this.runsDir = path.join(this.dir, 'runs');
    mkdirSync(this.runsDir, { recursive: true });
    this.loadRuns();
  }

  listSuites(): string[] {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'runs')
      .filter((entry) => {
        try {
          return readdirSync(path.join(this.dir, entry.name)).some((file) => file.endsWith('.json'));
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  listCases(suite?: string): EvalCase[] {
    const suites = suite ? [safeSegment(suite, 'default')] : this.listSuites();
    const cases: EvalCase[] = [];
    for (const name of suites) {
      const dir = path.join(this.dir, name);
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as EvalCase;
          if (
            parsed &&
            typeof parsed.name === 'string' &&
            typeof parsed.title === 'string' &&
            typeof parsed.initialPrompt === 'string' &&
            parsed.snapshot &&
            (parsed.snapshot.mode === 'git' || parsed.snapshot.mode === 'copy')
          ) {
            cases.push(parsed);
          }
        } catch {
          // 损坏的用例忽略
        }
      }
    }
    return cases.sort((a, b) => b.createdAt - a.createdAt);
  }

  async saveCase(input: SaveEvalCaseInput): Promise<EvalCase> {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!sessionId) throw new Error('sessionId 不能为空');
    const rec = this.host.store.get(sessionId);
    if (!rec) throw new Error('会话不存在');
    const userMessages = rec.messages.filter((m) => m.role === 'user' && userTextOf(m));
    if (userMessages.length === 0) throw new Error('该会话还没有可截取的用户消息');
    const start = input.messageId
      ? userMessages.find((m) => m.id === input.messageId)
      : userMessages[0];
    if (!start) throw new Error('指定的用户消息不存在');
    const initialPrompt = userTextOf(start);
    if (!initialPrompt) throw new Error('该消息没有文本内容，无法作为评测输入');

    const title = initialPrompt.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 60) ?? '评测用例';
    const suite = safeSegment(input.suite, 'default');
    const baseName = safeSegment(input.name || title, 'case');
    const suiteDir = path.join(this.dir, suite);
    mkdirSync(suiteDir, { recursive: true });
    let name = baseName;
    for (let i = 2; existsSync(path.join(suiteDir, `${name}.json`)); i++) {
      name = `${baseName}-${i}`;
    }

    const snapshot = await this.createSnapshot(rec.cwd, suite, name);
    const testCase: EvalCase = {
      suite,
      name,
      title,
      startMessageId: start.id,
      initialPrompt,
      snapshot,
      ...(input.passCriteria?.trim() ? { passCriteria: input.passCriteria.trim() } : {}),
      ...(input.checkCommand?.trim() ? { checkCommand: input.checkCommand.trim() } : {}),
      sourceSession: { id: rec.id, title: rec.title },
      createdAt: Date.now(),
    };
    writePrivateFile(path.join(suiteDir, `${name}.json`), JSON.stringify(testCase, null, 2));
    return testCase;
  }

  deleteCase(suite: string, name: string): boolean {
    const safeSuite = safeSegment(suite, 'default');
    const safeName = safeSegment(name, 'case');
    const file = path.join(this.dir, safeSuite, `${safeName}.json`);
    if (!isSubPath(this.dir, file) || !existsSync(file)) return false;
    try {
      rmSyncCompat(file);
      rmSyncCompat(path.join(this.dir, safeSuite, `${safeName}.files`));
      return true;
    } catch {
      return false;
    }
  }

  private async createSnapshot(cwd: string, suite: string, name: string): Promise<EvalSnapshot> {
    const root = await gitRepoRoot(cwd);
    if (root) {
      let commit = '';
      try {
        commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
      } catch (err) {
        throw new Error(`无法读取仓库提交：${gitErrorText(err)}`);
      }
      if (!commit) throw new Error('仓库还没有任何提交，无法用 commit 作为快照');
      const dirty = (await git(root, ['status', '--porcelain']).catch(() => '')).trim().length > 0;
      return {
        mode: 'git',
        cwd,
        repoPath: root,
        commit,
        ...(dirty ? { dirty: true } : {}),
      };
    }

    const sizeBytes = await dirSize(cwd);
    if (sizeBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(
        `目录大小超过 50MB（${(sizeBytes / 1024 / 1024).toFixed(1)}MB），无法保存为目录快照。请改用 git 仓库或减少目录内容。`,
      );
    }
    const snapshotPath = path.join(this.dir, suite, `${name}.files`);
    if (isSubPath(cwd, snapshotPath)) throw new Error('快照目录不能位于源目录内部');
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    try {
      await cp(cwd, snapshotPath, { recursive: true, force: true, filter: (src) => !skipCopy(src) });
    } catch (err) {
      throw new Error(`复制目录快照失败：${errorMessage(err)}`);
    }
    return { mode: 'copy', cwd, snapshotPath, sizeBytes };
  }

  listRuns(): EvalRunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => this.summarize(run));
  }

  getRun(id: string): EvalRun | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  /** 演示工作区：写入一份已完成的对比运行与用例，不触发模型调用。 */
  seedDemoRun(run: EvalRun, cases: EvalCase[] = []): void {
    this.runs.set(run.id, run);
    this.persist(run);
    for (const testCase of cases) {
      const suiteDir = path.join(this.dir, safeSegment(testCase.suite, 'default'));
      mkdirSync(suiteDir, { recursive: true });
      writePrivateFile(
        path.join(suiteDir, `${safeSegment(testCase.name, 'case')}.json`),
        JSON.stringify(testCase, null, 2),
      );
    }
    this.host.hub.broadcastAll({ type: 'eval_run_updated', run: this.summarize(run) });
  }

  /** 演示清理：删除演示运行与用例文件。 */
  removeDemoRuns(ids: string[], suite?: string): void {
    for (const id of ids) {
      if (!this.runs.delete(id)) continue;
      try {
        rmSyncCompat(path.join(this.runsDir, `${id}.json`));
      } catch {
        // 忽略清理失败
      }
    }
    if (!suite) return;
    const dir = path.join(this.dir, safeSegment(suite, 'default'));
    try {
      rmSyncCompat(dir);
    } catch {
      // 忽略清理失败
    }
  }

  start(input: StartEvalRunInput): EvalRun {
    const suite = safeSegment(input.suite, 'default');
    const all = this.listCases(suite);
    const wanted = Array.isArray(input.caseNames) && input.caseNames.length > 0
      ? new Set(input.caseNames.map((name) => String(name)))
      : undefined;
    const cases = wanted ? all.filter((item) => wanted.has(item.name)) : all;
    if (cases.length === 0) throw new Error('该用例集下没有可运行的用例');
    const configs = this.normalizeConfigs(input.configs);
    const reviewer = this.normalizeReviewer(input.reviewer);
    const concurrency = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, Math.floor(Number(input.concurrency) || 2)),
    );
    const now = Date.now();
    const results: EvalResult[] = [];
    for (const testCase of cases) {
      for (const config of configs) {
        results.push({
          caseName: testCase.name,
          caseTitle: testCase.title,
          configId: config.id,
          configName: config.name,
          status: 'queued',
          completed: false,
          passed: false,
          turns: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        });
      }
    }
    const run: EvalRun = {
      id: `run_${randomUUID().slice(0, 8)}`,
      suite,
      status: 'running',
      startedAt: now,
      configs,
      ...(reviewer ? { reviewer } : {}),
      concurrency,
      total: results.length,
      finished: 0,
      results,
    };
    this.runs.set(run.id, run);
    this.persist(run);
    this.broadcast(run);
    this.host.pushInbox(
      this.host.inbox.recordEval({
        runId: run.id,
        suite,
        status: 'running',
        finished: 0,
        total: run.total,
        text: `评测开始：${suite} · ${cases.length} 个用例 × ${configs.length} 个配置（共 ${run.total} 次运行）`,
      }),
    );
    const tasks: CellTask[] = [];
    for (const testCase of cases) {
      for (const config of configs) {
        const result = run.results.find(
          (item) => item.caseName === testCase.name && item.configId === config.id,
        );
        if (result) tasks.push({ result, testCase, config });
      }
    }
    void this.execute(run, tasks).catch((err) => {
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      for (const result of run.results) {
        if (result.status === 'queued' || result.status === 'running') result.status = 'cancelled';
      }
      this.persist(run);
      this.broadcast(run);
      console.warn('[tandem] 评测运行失败:', errorMessage(err));
    });
    return structuredClone(run);
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return false;
    this.cancelled.add(id);
    run.status = 'cancelled';
    for (const result of run.results) {
      if (result.status === 'queued') result.status = 'cancelled';
    }
    for (const sessionId of this.activeSessions.get(id) ?? []) this.host.interrupt(sessionId);
    this.persist(run);
    this.broadcast(run);
    this.host.pushInbox(
      this.host.inbox.recordEval({
        runId: run.id,
        suite: run.suite,
        status: 'cancelled',
        finished: run.finished,
        total: run.total,
        text: `评测已取消：${run.suite}（${run.finished}/${run.total} 已完成）`,
      }),
    );
    return true;
  }

  private normalizeConfigs(input: unknown): EvalConfig[] {
    if (!Array.isArray(input) || input.length === 0) throw new Error('至少需要一个评测配置');
    const configs: EvalConfig[] = [];
    const seen = new Set<string>();
    input.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 个配置格式无效`);
      const item = raw as Partial<EvalConfig>;
      const profileId = String(item.profileId ?? '').trim();
      const profile = profileId ? this.host.profiles.get(profileId) : undefined;
      if (!profile) throw new Error(`配置「${item.name || index + 1}」的账号不存在`);
      const groupId = typeof item.groupId === 'string' && item.groupId.trim() ? item.groupId.trim() : undefined;
      if (groupId && !profile.groups?.some((group) => group.id === groupId)) {
        throw new Error(`配置「${item.name || index + 1}」的分组不存在`);
      }
      const effective = effectiveProfile(profile, groupId);
      const model =
        (typeof item.model === 'string' && item.model.trim()) ||
        effective.defaultModel ||
        effective.models[0] ||
        '';
      if (!model) throw new Error(`配置「${item.name || index + 1}」没有可用模型`);
      let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `c${index + 1}`;
      while (seen.has(id)) id = `${id}-${index + 1}`;
      seen.add(id);
      const effort =
        typeof item.effort === 'string' && EFFORTS.has(item.effort as ReasoningEffort)
          ? (item.effort as ReasoningEffort)
          : undefined;
      const delegation = normalizeDelegation(item.delegation);
      const promptOverrides: Partial<Record<string, string>> = {};
      if (item.promptOverrides && typeof item.promptOverrides === 'object') {
        for (const [key, text] of Object.entries(item.promptOverrides)) {
          if (key in EDITABLE_PROMPTS && typeof text === 'string' && text.trim()) {
            promptOverrides[key] = text;
          }
        }
      }
      configs.push({
        id,
        name:
          (typeof item.name === 'string' && item.name.trim()) ||
          `${profile.name}${groupId ? ` / ${profile.groups?.find((g) => g.id === groupId)?.name ?? ''}` : ''} · ${model}`,
        profileId,
        ...(groupId ? { groupId } : {}),
        model,
        ...(effort ? { effort } : {}),
        ...(delegation ? { delegation } : {}),
        ...(Object.keys(promptOverrides).length
          ? { promptOverrides: promptOverrides as EvalConfig['promptOverrides'] }
          : {}),
      });
    });
    return configs;
  }

  private normalizeReviewer(input: unknown): EvalReviewer | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const item = input as Partial<EvalReviewer>;
    const profileId = String(item.profileId ?? '').trim();
    const profile = profileId ? this.host.profiles.get(profileId) : undefined;
    if (!profile) throw new Error('评审模型账号不存在');
    const groupId = typeof item.groupId === 'string' && item.groupId.trim() ? item.groupId.trim() : undefined;
    const effective = effectiveProfile(profile, groupId);
    const model =
      (typeof item.model === 'string' && item.model.trim()) ||
      effective.defaultModel ||
      effective.models[0] ||
      '';
    if (!model) throw new Error('评审模型不能为空');
    return { profileId, ...(groupId ? { groupId } : {}), model };
  }

  private async execute(run: EvalRun, tasks: CellTask[]): Promise<void> {
    this.activeSessions.set(run.id, new Set());
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        const task = tasks[index]!;
        await this.runCell(run, task);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(run.concurrency, tasks.length) }, () => worker()),
    );
    if (this.cancelled.has(run.id)) run.status = 'cancelled';
    else run.status = 'done';
    run.finishedAt = Date.now();
    this.persist(run);
    this.broadcast(run);
    const passed = run.results.filter((result) => result.passed).length;
    this.host.pushInbox(
      this.host.inbox.recordEval({
        runId: run.id,
        suite: run.suite,
        status: run.status === 'cancelled' ? 'cancelled' : 'done',
        finished: run.finished,
        total: run.total,
        text:
          run.status === 'cancelled'
            ? `评测已取消：${run.suite}（${run.finished}/${run.total} 已完成）`
            : `评测完成：${run.suite} · ${passed}/${run.total} 通过`,
      }),
    );
    this.cancelled.delete(run.id);
    this.activeSessions.delete(run.id);
  }

  private async runCell(run: EvalRun, task: CellTask): Promise<void> {
    const { result, testCase, config } = task;
    if (this.cancelled.has(run.id)) {
      result.status = 'cancelled';
      this.cellDone(run);
      return;
    }
    result.status = 'running';
    this.broadcast(run);
    const started = Date.now();
    let workspace: Workspace | undefined;
    let rec: SessionRecord | undefined;
    try {
      workspace = await this.materialize(testCase);
      if (!isTempWorkspace(workspace.dir)) {
        throw new Error('评测只允许在 Host 临时目录中运行，已拒绝该工作目录');
      }
      rec = await this.host.createSession({
        cwd: workspace.dir,
        profileId: config.profileId,
        groupId: config.groupId,
        model: config.model,
        permissionMode: 'bypassPermissions',
        effort: config.effort,
        delegation: config.delegation,
        title: `[评测] ${testCase.title} · ${config.name}`,
      });
      rec.archived = true;
      rec.evalRun = { runId: run.id, caseName: testCase.name, configId: config.id };
      if (config.promptOverrides && Object.keys(config.promptOverrides).length > 0) {
        rec.promptOverrides = structuredClone(config.promptOverrides);
      }
      this.host.store.markDirty(rec.id, false);
      this.host.broadcastSummary(rec);
      this.activeSessions.get(run.id)?.add(rec.id);

      await this.host.send(rec.id, [{ type: 'text', text: testCase.initialPrompt }]);
      const turn = this.lastTurnEnd(rec.id);
      if (this.cancelled.has(run.id) || turn === 'interrupted') {
        result.status = 'cancelled';
      } else if (turn === 'done') {
        result.status = 'done';
        result.completed = true;
      } else {
        result.status = 'failed';
        result.error = this.lastTurnError(rec.id) ?? 'agent 运行失败';
      }
    } catch (err) {
      result.status = this.cancelled.has(run.id) ? 'cancelled' : 'failed';
      result.completed = false;
      result.error = truncateEnd(errorMessage(err), 2000);
    } finally {
      if (rec) this.fillMetrics(result, rec);
      if (workspace && existsSync(workspace.dir) && testCase.checkCommand && !this.cancelled.has(run.id)) {
        try {
          result.check = await runCheck(testCase.checkCommand, workspace.dir);
        } catch (err) {
          result.check = {
            command: testCase.checkCommand,
            exitCode: null,
            ok: false,
            output: `[检查命令执行失败: ${errorMessage(err)}]`,
            durationMs: 0,
          };
        }
      }
      if (run.reviewer && testCase.passCriteria && result.status === 'done' && !this.cancelled.has(run.id)) {
        try {
          result.review = await this.review(run.reviewer, testCase, result);
        } catch (err) {
          result.review = {
            verdict: 'fail',
            reason: `评审模型调用失败：${errorMessage(err)}`,
            model: run.reviewer.model,
          };
        }
      }
      result.passed =
        result.status === 'done' &&
        result.completed &&
        result.check?.ok !== false &&
        result.review?.verdict !== 'fail';
      result.durationMs = Date.now() - started;
      if (rec) {
        await this.host.deleteSession(rec.id, true).catch((err) => {
          console.warn('[tandem] 清理评测会话失败:', errorMessage(err));
        });
        this.activeSessions.get(run.id)?.delete(rec.id);
      }
      if (workspace) await this.cleanup(workspace);
      this.cellDone(run);
    }
  }

  private fillMetrics(result: EvalResult, rec: SessionRecord): void {
    const assistants = rec.messages.filter((message) => message.role === 'assistant');
    // 轮次按真实用户消息统计，纯 tool_result 的 user 消息不算一轮（与压缩确认/大纲一致）。
    result.turns = countTurns(rec.messages);
    result.toolCalls = assistants.reduce(
      (count, message) => count + message.content.filter((block) => block.type === 'tool_use').length,
      0,
    );
    result.usage = { ...rec.usage };
    if (rec.usage.costUsd !== undefined) result.costUsd = rec.usage.costUsd;
    const finalAnswer = lastAssistantText(rec.messages);
    if (finalAnswer) result.finalAnswer = finalAnswer;
    result.messages = structuredClone(rec.messages);
  }

  private async review(
    reviewer: EvalReviewer,
    testCase: EvalCase,
    result: EvalResult,
  ): Promise<EvalReviewResult> {
    const profile = this.host.profileFor(reviewer.profileId, reviewer.groupId);
    if (!profile?.apiKey) throw new Error('评审账号未配置 API Key');
    const checkText = result.check
      ? `命令 \`${result.check.command}\` 退出码 ${result.check.exitCode ?? 'null'}（${result.check.ok ? '通过' : '失败'}）`
      : '未配置自动检查';
    const prompt = this.host.promptTemplates.render('evalReview', {
      prompt: testCase.initialPrompt,
      criteria: testCase.passCriteria ?? '',
      answer: result.finalAnswer ?? '（无最终回答）',
      check: checkText,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const raw = await completeText({
        profile,
        model: reviewer.model,
        prompt,
        maxTokens: 600,
        signal: controller.signal,
      });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('评审模型没有返回 JSON');
      const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
      const verdict = parsed.verdict === 'pass' ? 'pass' : 'fail';
      return {
        verdict,
        reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : '（无理由）',
        model: reviewer.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async materialize(testCase: EvalCase): Promise<Workspace> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-eval-'));
    const dir = path.join(root, 'ws');
    const snapshot = testCase.snapshot;
    if (snapshot.mode === 'git') {
      const repoPath = snapshot.repoPath ?? '';
      const commit = snapshot.commit ?? '';
      if (!repoPath || !isSubPath(path.parse(repoPath).root, path.resolve(repoPath))) {
        throw new Error('用例的仓库路径无效');
      }
      if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
        throw new Error('用例的 commit hash 无效');
      }
      if (!existsSync(repoPath)) throw new Error(`仓库不存在：${repoPath}`);
      try {
        await git(repoPath, ['worktree', 'add', '--detach', '--force', dir, commit]);
      } catch (err) {
        throw new Error(`创建临时 worktree 失败：${gitErrorText(err)}`);
      }
      return { root, dir, repoPath };
    }
    const snapshotPath = snapshot.snapshotPath ?? '';
    if (!snapshotPath || !existsSync(snapshotPath)) {
      throw new Error('用例的目录快照不存在，请重新保存用例');
    }
    if (!isSubPath(this.dir, path.resolve(snapshotPath))) {
      throw new Error('用例快照路径不在 Tandem 评测目录内');
    }
    await cp(snapshotPath, dir, { recursive: true, force: true });
    return { root, dir };
  }

  private async cleanup(workspace: Workspace): Promise<void> {
    if (workspace.repoPath) {
      await git(workspace.repoPath, ['worktree', 'remove', '--force', workspace.dir]).catch(() => undefined);
    }
    await rm(workspace.root, { recursive: true, force: true }).catch(() => undefined);
    if (workspace.repoPath) {
      await git(workspace.repoPath, ['worktree', 'prune']).catch(() => undefined);
    }
  }

  private lastTurnEnd(sessionId: string): 'done' | 'interrupted' | 'error' | undefined {
    const events = this.host.hub.replay(sessionId, 0);
    if (!events) return undefined;
    let reason: 'done' | 'interrupted' | 'error' | undefined;
    for (const event of events) {
      if (event.type === 'turn_end' && event.sessionId === sessionId) reason = event.reason;
    }
    return reason;
  }

  private lastTurnError(sessionId: string): string | undefined {
    const events = this.host.hub.replay(sessionId, 0);
    if (!events) return undefined;
    let error: string | undefined;
    for (const event of events) {
      if (event.type === 'turn_end' && event.sessionId === sessionId && event.error) {
        error = event.error;
      }
    }
    return error;
  }

  private cellDone(run: EvalRun): void {
    run.finished = run.results.filter(
      (result) => result.status !== 'queued' && result.status !== 'running',
    ).length;
    this.persist(run);
    this.broadcast(run);
    const passed = run.results.filter((result) => result.passed).length;
    this.host.pushInbox(
      this.host.inbox.recordEval({
        runId: run.id,
        suite: run.suite,
        status: run.status === 'cancelled' ? 'cancelled' : 'running',
        finished: run.finished,
        total: run.total,
        text: `评测运行中：${run.suite} · ${run.finished}/${run.total} 完成（${passed} 通过）`,
      }),
    );
  }

  private broadcast(run: EvalRun): void {
    this.host.hub.broadcastAll({ type: 'eval_run_updated', run: this.summarize(run) });
  }

  private summarize(run: EvalRun): EvalRunSummary {
    return {
      id: run.id,
      suite: run.suite,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      configs: run.configs.map((config) => ({
        id: config.id,
        name: config.name,
        model: config.model,
      })),
      ...(run.reviewer ? { reviewer: { ...run.reviewer } } : {}),
      concurrency: run.concurrency,
      total: run.total,
      finished: run.finished,
      results: run.results.map(({ messages: _messages, ...result }) => ({ ...result })),
    };
  }

  private persist(run: EvalRun): void {
    try {
      writePrivateFile(path.join(this.runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
    } catch (err) {
      console.warn('[tandem] 保存评测结果失败:', errorMessage(err));
    }
  }

  private loadRuns(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.runsDir).filter((file) => file.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const run = JSON.parse(readFileSync(path.join(this.runsDir, file), 'utf8')) as EvalRun;
        if (!run?.id || !Array.isArray(run.results)) continue;
        if (run.status === 'running') {
          run.status = 'cancelled';
          run.finishedAt = run.finishedAt ?? Date.now();
          for (const result of run.results) {
            if (result.status === 'queued' || result.status === 'running') {
              result.status = 'cancelled';
              result.error = result.error ?? 'Host 重启，评测运行已中断';
            }
          }
        }
        this.runs.set(run.id, run);
      } catch {
        // 损坏的结果文件忽略
      }
    }
    const sorted = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const run of sorted.slice(MAX_RUNS)) {
      this.runs.delete(run.id);
      try {
        rmSyncCompat(path.join(this.runsDir, `${run.id}.json`));
      } catch {
        // 忽略清理失败
      }
    }
  }
}

/** 同步删除（结果文件/快照目录），失败交给调用方决定是否忽略。 */
function rmSyncCompat(target: string): void {
  rmSync(target, { recursive: true, force: true });
}
