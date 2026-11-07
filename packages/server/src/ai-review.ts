// 提交前 AI 评审：后台开一个只读子会话，按文件分批把工作区 diff 交给评审模型，
// 结果按新文件行号挂到改动审阅；非法行号直接丢弃并计数。
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AiReviewFinding,
  AiReviewRun,
  AiReviewSeverity,
  AiReviewVerdict,
  Message,
  ReasoningEffort,
  Usage,
} from '@tandem/protocol';
import { runTurn } from './agent/loop.js';
import { getChanges, getFileDiff, repoRootOf } from './changes.js';
import { effectiveProfile } from './config.js';
import { bodyOfMemory } from './memory.js';
import { subagentConfig } from './host/subagents.js';
import { errorMessage } from './util/text.js';
import type { SessionRecord } from './types.js';
import type { Host } from './host.js';

const REVIEW_PRESET = '审查';
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep'];
const MAX_CHUNK_CHARS = 48_000;
const MAX_TOTAL_CHARS = 180_000;
const MAX_CONTEXT_CHARS = 12_000;
const REVIEW_TIMEOUT_MS = 180_000;
const MAX_RUNS = 80;
const SEVERITIES = new Set<AiReviewSeverity>(['blocker', 'warn', 'nit']);
const VERDICTS = new Set<AiReviewVerdict>(['commit', 'suggest', 'blocker']);

interface ReviewTarget {
  profileId: string;
  groupId?: string;
  model: string;
  effort?: ReasoningEffort;
}

interface DiffFile {
  path: string;
  diff: string;
  newLines: Set<number>;
}

function snapshot(run: AiReviewRun): AiReviewRun {
  return { ...run, findings: run.findings.map((item) => ({ ...item })) };
}

function addUsage(target: Usage, source: Usage): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  if (source.cacheReadTokens) target.cacheReadTokens = (target.cacheReadTokens ?? 0) + source.cacheReadTokens;
  if (source.cacheWriteTokens) target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + source.cacheWriteTokens;
  if (source.reasoningTokens) target.reasoningTokens = (target.reasoningTokens ?? 0) + source.reasoningTokens;
  if (source.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
}

/** 新文件里实际出现在 diff 中的行号；行号校验和前端挂载都以它为准。 */
function newLineNumbers(diff: string): Set<number> {
  const lines = new Set<number>();
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) newNo = Number(match[1]);
      continue;
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('\\ No newline')
    ) {
      continue;
    }
    if (!newNo) continue;
    const sign = line[0] ?? ' ';
    if (sign === '+') {
      lines.add(newNo);
      newNo++;
    } else if (sign === '-' || line === '') {
      if (line === '' && sign === '') continue;
      if (sign === ' ') {
        lines.add(newNo);
        newNo++;
      }
    } else if (sign === ' ') {
      lines.add(newNo);
      newNo++;
    }
  }
  return lines;
}

function normalizeFindingPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
}

function parseReviewJson(text: string): {
  verdict?: AiReviewVerdict;
  summary?: string;
  items: unknown[];
} | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const verdict =
      typeof parsed.verdict === 'string' && VERDICTS.has(parsed.verdict as AiReviewVerdict)
        ? (parsed.verdict as AiReviewVerdict)
        : undefined;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return { verdict, ...(summary ? { summary } : {}), items };
  } catch {
    return undefined;
  }
}

function readText(file: string, limit: number): string {
  try {
    if (!existsSync(file)) return '';
    const text = readFileSync(file, 'utf8').trim();
    return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
  } catch {
    return '';
  }
}

/** 项目约定（AGENTS/CLAUDE）与记忆；误报单独抽出来，下次评审时告诉模型不要重复报告。 */
async function collectContext(
  host: Host,
  rec: SessionRecord,
): Promise<{ context: string; falsePositives: string }> {
  const root = (await repoRootOf(rec.cwd)) ?? rec.cwd;
  const parts: string[] = [];
  const agents = readText(path.join(root, 'AGENTS.md'), 8000);
  const claude = readText(path.join(root, 'CLAUDE.md'), 8000);
  if (agents) parts.push(`### AGENTS.md\n${agents}`);
  if (claude) parts.push(`### CLAUDE.md\n${claude}`);
  const projectMemory = bodyOfMemory(host.memory.read('project', rec.cwd).text);
  if (projectMemory) parts.push(`### 项目记忆\n${projectMemory.slice(0, 6000)}`);
  const globalMemory = bodyOfMemory(host.memory.read('global').text);
  const falseLines = `${globalMemory}\n${projectMemory}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /AI 评审误报/.test(line))
    .slice(-30);
  const context = parts.join('\n\n');
  return {
    context: context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n…（已截断）` : context,
    falsePositives: falseLines.length ? falseLines.join('\n') : '（无）',
  };
}

function chunkDiffFiles(files: DiffFile[]): DiffFile[][] {
  const chunks: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.diff.length > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.diff.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function chunkText(files: DiffFile[]): string {
  return files.map((file) => `### 文件：${file.path}\n${file.diff}`).join('\n');
}

export class AiReviewManager {
  private readonly host: Host;
  private readonly runs = new Map<string, AiReviewRun>();
  private readonly latest = new Map<string, string>();
  private readonly active = new Map<string, string>();

  constructor(host: Host) {
    this.host = host;
  }

  latestFor(sessionId: string): AiReviewRun | undefined {
    const id = this.latest.get(sessionId);
    const run = id ? this.runs.get(id) : undefined;
    return run ? snapshot(run) : undefined;
  }

  get(sessionId: string, reviewId: string): AiReviewRun | undefined {
    const run = this.runs.get(reviewId);
    return run && run.sessionId === sessionId ? snapshot(run) : undefined;
  }

  /** 立即返回 running 状态，评审在后台子会话里完成；同一会话同时只跑一个。 */
  start(rec: SessionRecord, paths?: unknown): AiReviewRun {
    const activeId = this.active.get(rec.id);
    const activeRun = activeId ? this.runs.get(activeId) : undefined;
    if (activeRun?.status === 'running') return snapshot(activeRun);

    const run: AiReviewRun = {
      id: randomUUID(),
      sessionId: rec.id,
      status: 'running',
      findings: [],
      ignored: 0,
      createdAt: Date.now(),
    };
    this.runs.set(run.id, run);
    this.latest.set(rec.id, run.id);
    this.active.set(rec.id, run.id);
    this.prune();
    const wanted = Array.isArray(paths)
      ? new Set(paths.filter((item): item is string => typeof item === 'string'))
      : undefined;
    void this.execute(rec, run, wanted)
      .catch((err) => {
        run.status = 'error';
        run.error = errorMessage(err);
      })
      .finally(() => {
        run.finishedAt = Date.now();
        if (this.active.get(rec.id) === run.id) this.active.delete(rec.id);
      });
    return snapshot(run);
  }

  /** 把「标记为误报」写进项目记忆，下次评审时作为上下文避免重复。 */
  recordFalsePositive(sessionId: string, reviewId: string, findingId: string): boolean {
    const run = this.runs.get(reviewId);
    if (!run || run.sessionId !== sessionId) return false;
    const finding = run.findings.find((item) => item.id === findingId);
    if (!finding) return false;
    const rec = this.host.store.get(sessionId);
    if (!rec) return false;
    try {
      const body = bodyOfMemory(this.host.memory.read('project', rec.cwd).text);
      const line = `- [AI 评审误报] ${finding.file}:${finding.line} ${finding.title}${
        finding.detail ? `：${finding.detail.slice(0, 300)}` : ''
      }`;
      const next = body.includes('## AI 评审误报')
        ? `${body.trimEnd()}\n${line}`
        : `${body.trimEnd()}\n\n## AI 评审误报\n${line}`;
      this.host.memory.write('project', rec.cwd, next.trim());
      return true;
    } catch {
      return false;
    }
  }

  private prune(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const sorted = [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const run of sorted.slice(0, this.runs.size - MAX_RUNS)) {
      this.runs.delete(run.id);
      if (this.latest.get(run.sessionId) === run.id) this.latest.delete(run.sessionId);
    }
  }

  private resolveTarget(rec: SessionRecord): ReviewTarget {
    const configured = this.host.settings().aiReview;
    if (configured?.profileId) {
      const profile = this.host.profiles.get(configured.profileId);
      if (profile) {
        const groupId =
          configured.groupId && this.host.groupFor(profile.id, configured.groupId)
            ? configured.groupId
            : undefined;
        const effective = effectiveProfile(profile, groupId);
        const model = configured.model || effective.defaultModel || effective.models[0] || '';
        if (model) {
          return {
            profileId: profile.id,
            ...(groupId ? { groupId } : {}),
            model,
            ...(configured.effort ? { effort: configured.effort } : {}),
          };
        }
      }
    }
    const preset = this.host.subagentPresets.resolve(REVIEW_PRESET, rec.cwd);
    if (preset) {
      const config = subagentConfig(this.host, rec, preset.name);
      return {
        profileId: config.profileId,
        ...(config.groupId ? { groupId: config.groupId } : {}),
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
      };
    }
    return {
      profileId: rec.profileId,
      ...(rec.groupId ? { groupId: rec.groupId } : {}),
      model: rec.model,
      ...(rec.effort ? { effort: rec.effort } : {}),
    };
  }

  private async execute(
    rec: SessionRecord,
    run: AiReviewRun,
    wanted?: Set<string>,
  ): Promise<void> {
    const target = this.resolveTarget(rec);
    run.model = target.model;
    const changes = await getChanges(rec.cwd);
    if (!changes.isRepo) throw new Error('当前目录不是 git 仓库');
    const files: DiffFile[] = [];
    let total = 0;
    for (const file of changes.files) {
      if (wanted && wanted.size > 0 && !wanted.has(file.path)) continue;
      if (total >= MAX_TOTAL_CHARS) {
        run.truncated = true;
        break;
      }
      const result = await getFileDiff(rec.cwd, file.path).catch(() => undefined);
      if (!result?.diff.trim()) continue;
      let diff = result.diff;
      if (diff.length > MAX_CHUNK_CHARS) {
        diff = diff.slice(0, MAX_CHUNK_CHARS);
        run.truncated = true;
      }
      files.push({ path: file.path, diff, newLines: newLineNumbers(diff) });
      total += diff.length;
    }
    if (files.length === 0) {
      run.status = 'done';
      run.verdict = 'commit';
      run.summary = '工作区没有可评审的改动';
      return;
    }
    const lineMap = new Map(files.map((file) => [file.path, file.newLines]));
    const { context, falsePositives } = await collectContext(this.host, rec);
    const summaries: string[] = [];
    let verdict: AiReviewVerdict | undefined;
    let fallback: string | undefined;
    const findings: AiReviewFinding[] = [];
    let invalid = 0;

    for (const chunk of chunkDiffFiles(files)) {
      const prompt = this.host.promptTemplates.render(
        'aiReview',
        { diff: chunkText(chunk), context, falsePositives },
        rec.cwd,
      );
      const label = chunk.map((file) => file.path).slice(0, 4).join('、');
      let parsed = parseReviewJson(await this.runReviewSession(rec, target, prompt, label));
      if (!parsed) {
        // 只重试一次：补充“只输出 JSON”的强约束
        const retry = `${prompt}\n\n注意：上一次输出不是合法 JSON。这次只输出一个 JSON 对象，不要代码块、不要解释。`;
        const text = await this.runReviewSession(rec, target, retry, `${label}（重试）`);
        parsed = parseReviewJson(text);
        if (!parsed) fallback = text || '评审模型没有返回内容';
      }
      if (!parsed) continue;
      if (parsed.summary) summaries.push(parsed.summary);
      const chunkVerdict = parsed.verdict;
      if (chunkVerdict === 'blocker') verdict = 'blocker';
      else if (chunkVerdict === 'suggest' && verdict !== 'blocker') verdict = 'suggest';
      for (const raw of parsed.items) {
        if (!raw || typeof raw !== 'object') {
          invalid++;
          continue;
        }
        const item = raw as Record<string, unknown>;
        const file = typeof item.file === 'string' ? normalizeFindingPath(item.file) : '';
        const line = Number(item.line);
        const severity =
          typeof item.severity === 'string' && SEVERITIES.has(item.severity as AiReviewSeverity)
            ? (item.severity as AiReviewSeverity)
            : 'warn';
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
        const lines = lineMap.get(file);
        if (!file || !title || !detail || !lines || !Number.isInteger(line) || !lines.has(line)) {
          invalid++;
          continue;
        }
        let endLine = Number(item.endLine);
        if (!Number.isInteger(endLine) || endLine < line || !lines.has(endLine)) endLine = line;
        findings.push({
          id: `f-${findings.length + 1}`,
          file,
          line,
          ...(endLine > line ? { endLine } : {}),
          severity,
          title: title.slice(0, 200),
          detail: detail.slice(0, 3000),
          ...(typeof item.suggestion === 'string' && item.suggestion.trim()
            ? { suggestion: item.suggestion.trim().slice(0, 2000) }
            : {}),
        });
      }
    }

    run.findings = findings;
    run.ignored = invalid;
    if (fallback && findings.length === 0 && summaries.length === 0) {
      run.verdict = 'suggest';
      run.summary = '评审模型输出不是合法 JSON，以下为原文';
      run.fallbackText = fallback.slice(0, 8000);
      run.status = 'done';
      return;
    }
    const hasBlocker = findings.some((item) => item.severity === 'blocker');
    run.verdict = hasBlocker ? 'blocker' : verdict ?? (findings.length ? 'suggest' : 'commit');
    run.summary = [...new Set(summaries)].join('；').slice(0, 1000) || (findings.length ? '' : '未发现问题');
    if (fallback) run.fallbackText = fallback.slice(0, 8000);
    run.status = 'done';
  }

  /** 只读子会话：白名单只有 Read/Glob/Grep，不出现在侧栏；用完删除。 */
  private async runReviewSession(
    parent: SessionRecord,
    target: ReviewTarget,
    prompt: string,
    label: string,
  ): Promise<string> {
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: `[AI 评审] ${label}`.slice(0, 120),
      cwd: parent.cwd,
      profileId: target.profileId,
      ...(target.groupId ? { groupId: target.groupId } : {}),
      model: target.model,
      permissionMode: 'default',
      ...(target.effort ? { effort: target.effort } : {}),
      delegation: 'none',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      todos: [],
      allowedTools: [],
      toolWhitelist: [...REVIEW_TOOLS],
      systemPromptExtra:
        '你是提交前的只读代码评审子会话。只能使用 Read / Glob / Grep 查看代码；改动 diff 已提供，通常不需要调用工具。' +
        '禁止修改文件、提交或推送。严格按用户消息要求只输出 JSON。',
      parentId: parent.id,
      depth: 1,
    };
    this.host.store.add(rec);
    this.host.broadcastSummary(rec);
    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      createdAt: Date.now(),
    };
    rec.messages.push(message);
    this.host.hub.broadcastSession(rec.id, { type: 'message_start', sessionId: rec.id, message });
    this.host.hub.broadcastSession(rec.id, { type: 'message_end', sessionId: rec.id, message });
    this.host.store.markDirty(rec.id, true);
    this.host.broadcastSummary(rec);
    const timer = setTimeout(() => this.host.interrupt(rec.id), REVIEW_TIMEOUT_MS);
    try {
      const result = await runTurn(this.host, rec, { allowTask: false });
      if (result.reason === 'interrupted') throw new Error('评审超时或已中断');
      if (result.reason === 'error') throw new Error(result.error ?? '评审模型调用失败');
      return result.lastText ?? '';
    } finally {
      clearTimeout(timer);
      this.aggregateUsage(parent, rec.usage);
      await this.host.deleteSession(rec.id, true).catch(() => false);
    }
  }

  /** 评审用量计入当前会话：usage 汇总 + 单独的「评审」桶。 */
  private aggregateUsage(parent: SessionRecord, usage: Usage): void {
    if (
      usage.inputTokens === 0 &&
      usage.outputTokens === 0 &&
      !usage.costUsd &&
      !usage.cacheReadTokens &&
      !usage.cacheWriteTokens
    ) {
      return;
    }
    const bucket = parent.aiReviewUsage ?? { inputTokens: 0, outputTokens: 0 };
    addUsage(bucket, usage);
    parent.aiReviewUsage = bucket;
    addUsage(parent.usage, usage);
    this.host.store.markDirty(parent.id, true);
    this.host.broadcastSummary(parent);
  }
}
