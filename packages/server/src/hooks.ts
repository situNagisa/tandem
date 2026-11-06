// Hooks：只读兼容 Claude Code 的 settings.json 配置形状，并维护 Tandem 自己的
// ~/.tandem/hooks.json。命令通过 stdin 收到 Claude Code 风格的 JSON，按退出码/JSON 决定是否阻止。
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HookEntry,
  HookEvent,
  HookSettings,
  HookSource,
  HookSourceInfo,
  PermissionMode,
} from '@tandem/protocol';
import { isSubPath } from './util/path.js';

export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
];

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_OUTPUT = 200_000;
const MAX_MESSAGE = 2_000;

const SOURCE_ORDER: HookSource[] = ['claude-user', 'claude-project', 'claude-project-local', 'tandem'];

interface RawHookCommand {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface RawHookMatcher {
  matcher?: unknown;
  hooks?: unknown;
}

export interface HookExecutionContext {
  sessionId: string;
  cwd: string;
  permissionMode?: PermissionMode;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolResponse?: string;
  prompt?: string;
  /** SessionStart 的来源：startup / resume / clear / compact。 */
  source?: string;
  stopHookActive?: boolean;
  signal?: AbortSignal;
}

export interface HookOutcome {
  entry: HookEntry;
  name: string;
  ok: boolean;
  blocked: boolean;
  message?: string;
  additionalContext?: string;
  durationMs: number;
}

export interface HookRunResult {
  blocked: boolean;
  /** 阻止时回填给模型的反馈（stderr / reason）。 */
  feedback: string[];
  /** UserPromptSubmit / SessionStart 的附加上下文。 */
  contexts: string[];
  outcomes: HookOutcome[];
}

interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function sourcePath(home: string, source: HookSource, cwd?: string): string {
  if (source === 'tandem') return path.join(home, 'hooks.json');
  if (source === 'claude-user') return path.join(os.homedir(), '.claude', 'settings.json');
  if (!cwd) return '';
  return path.join(cwd, '.claude', source === 'claude-project' ? 'settings.json' : 'settings.local.json');
}

function normalizeTimeout(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(600, Math.max(1, Math.round(n)));
}

function readHooksFile(file: string, source: HookSource): HookEntry[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[tandem] 无法解析 hooks 配置 ${file}:`, (err as Error).message);
    return [];
  }
  const hooks = raw && typeof raw === 'object' ? (raw as { hooks?: unknown }).hooks : undefined;
  if (!hooks || typeof hooks !== 'object') return [];

  const entries: HookEntry[] = [];
  let index = 0;
  for (const event of HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const rawMatcher = (group as RawHookMatcher).matcher;
      const matcher =
        typeof rawMatcher === 'string' ? rawMatcher.trim() || undefined : undefined;
      const commands = (group as RawHookMatcher).hooks;
      if (!Array.isArray(commands)) continue;
      for (const item of commands) {
        if (!item || typeof item !== 'object') continue;
        const cmd = item as RawHookCommand;
        if (cmd.type !== undefined && cmd.type !== 'command') continue;
        const command = typeof cmd.command === 'string' ? cmd.command.trim() : '';
        if (!command) continue;
        const timeout = normalizeTimeout(cmd.timeout);
        entries.push({
          id: `${source}:${event}:${index++}`,
          event,
          ...(matcher ? { matcher } : {}),
          command,
          ...(timeout ? { timeout } : {}),
          source,
        });
      }
    }
  }
  return entries;
}

/** 工具名 matcher：正则，支持用 | 分隔；留空匹配全部。非法正则退回字面包含匹配。 */
export function hookMatcherMatches(matcher: string | undefined, value: string): boolean {
  if (!matcher) return true;
  const patterns = matcher.split('|').map((part) => part.trim()).filter(Boolean);
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(value);
    } catch {
      return value === pattern;
    }
  });
}

/** 从命令推断展示名：/path/to/lint.sh -> lint.sh；node /x/lint.mjs 也取脚本名。 */
export function hookCommandName(command: string): string {
  const tokens = command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  let target = tokens[0] ?? '';
  const interpreter = path.basename(target);
  if (['node', 'tsx', 'bun', 'deno', 'python', 'python3', 'bash', 'sh', 'zsh'].includes(interpreter)) {
    const script = tokens
      .slice(1)
      .find((token) => !token.startsWith('-') && /\.(?:[cm]?[jt]s|py|sh)$/.test(token));
    if (script) target = script;
  }
  const base = target ? path.basename(target) : '';
  return base.slice(0, 60) || 'hook';
}

function clipMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_MESSAGE ? `${trimmed.slice(0, MAX_MESSAGE)}\n…[已截断]` : trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function buildHookStdin(event: HookEvent, ctx: HookExecutionContext): string {
  const payload: Record<string, unknown> = {
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    hook_event_name: event,
  };
  if (ctx.permissionMode) payload.permission_mode = ctx.permissionMode;
  if (ctx.toolName) {
    payload.tool_name = ctx.toolName;
    payload.tool_input = ctx.toolInput ?? {};
  }
  if (ctx.toolUseId) payload.tool_use_id = ctx.toolUseId;
  if (ctx.toolResponse !== undefined) payload.tool_response = ctx.toolResponse;
  if (ctx.prompt !== undefined) payload.prompt = ctx.prompt;
  if (event === 'SessionStart') payload.source = ctx.source ?? 'startup';
  if (event === 'Stop') payload.stop_hook_active = ctx.stopHookActive === true;
  return `${JSON.stringify(payload)}\n`;
}

/** 执行单个命令。超时/中断会杀掉整个进程组，避免留下子进程。 */
function execHookCommand(
  command: string,
  cwd: string,
  stdin: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          env: process.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn('/bin/bash', ['-c', command], {
          cwd,
          env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const kill = () => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
    };
    const finish = (code: number | null, sig: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout, stderr, timedOut, aborted });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_OUTPUT);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT);
    });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(-1, null);
    });
    child.on('close', (code, sig) => finish(code, sig));

    try {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    } catch {
      /* stdin 已关闭 */
    }
  });
}

function evaluateExec(event: HookEvent, result: ExecResult, timeoutSec: number): Pick<
  HookOutcome,
  'ok' | 'blocked' | 'message' | 'additionalContext'
> {
  if (result.aborted) return { ok: false, blocked: false, message: '已中断' };
  if (result.timedOut) {
    return { ok: false, blocked: false, message: clipMessage(`执行超时（${timeoutSec}s）`) };
  }

  const json = parseJsonObject(result.stdout) ?? {};
  const specific =
    json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object'
      ? (json.hookSpecificOutput as Record<string, unknown>)
      : {};
  const additionalContext =
    stringField(specific.additionalContext) ?? stringField(json.additionalContext);

  // 退出码 2：阻止；stderr 作为反馈（Claude Code 语义）。
  if (result.code === 2) {
    return {
      ok: false,
      blocked: true,
      message: clipMessage(result.stderr || result.stdout || 'Hook 阻止了该操作'),
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      blocked: false,
      message: clipMessage(result.stderr || result.stdout || `Hook 退出码 ${result.code ?? 'unknown'}`),
    };
  }

  const decision = stringField(json.decision);
  const permissionDecision = stringField(specific.permissionDecision);
  const cont = json.continue;
  const blocked =
    decision === 'block' || cont === false || permissionDecision === 'deny';
  if (blocked) {
    return {
      ok: true,
      blocked: true,
      message: clipMessage(
        stringField(json.stopReason) ||
          stringField(json.reason) ||
          stringField(specific.permissionDecisionReason) ||
          result.stderr ||
          result.stdout ||
          'Hook 阻止了该操作',
      ),
    };
  }

  // 只有 UserPromptSubmit / SessionStart 把 stdout 作为附加上下文；其余事件忽略普通 stdout。
  const rawStdoutContext =
    (event === 'UserPromptSubmit' || event === 'SessionStart') && !parseJsonObject(result.stdout)
      ? stringField(result.stdout)
      : undefined;
  return {
    ok: true,
    blocked: false,
    ...(additionalContext || rawStdoutContext
      ? { additionalContext: additionalContext ?? rawStdoutContext }
      : {}),
  };
}

/** 执行一组已加载的 hooks（按配置顺序，遇到阻止继续执行其余 hook 但结果汇总）。 */
export async function runHookEntries(
  entries: HookEntry[],
  event: HookEvent,
  ctx: HookExecutionContext,
  onOutcome?: (outcome: HookOutcome) => void,
): Promise<HookRunResult> {
  const result: HookRunResult = { blocked: false, feedback: [], contexts: [], outcomes: [] };
  for (const entry of entries) {
    if (entry.event !== event) continue;
    if (ctx.signal?.aborted) break;
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      if (!ctx.toolName || !hookMatcherMatches(entry.matcher, ctx.toolName)) continue;
    } else if (event === 'SessionStart') {
      if (entry.matcher && !hookMatcherMatches(entry.matcher, ctx.source ?? 'startup')) continue;
    }

    const started = Date.now();
    const timeoutSec = entry.timeout ?? DEFAULT_TIMEOUT_SEC;
    const exec = await execHookCommand(
      entry.command,
      ctx.cwd,
      buildHookStdin(event, ctx),
      timeoutSec,
      ctx.signal,
    );
    const evaluated = evaluateExec(event, exec, timeoutSec);
    const outcome: HookOutcome = {
      entry,
      name: hookCommandName(entry.command),
      durationMs: Date.now() - started,
      ...evaluated,
    };
    result.outcomes.push(outcome);
    onOutcome?.(outcome);

    if (outcome.blocked) {
      result.blocked = true;
      if (outcome.message) result.feedback.push(outcome.message);
    }
    if (outcome.additionalContext &&
      (event === 'UserPromptSubmit' || event === 'SessionStart')) {
      result.contexts.push(outcome.additionalContext);
    }
  }
  return result;
}

export class HookManager {
  private home: string;
  private tandemFile: string;
  private trustFile: string;

  constructor(home: string) {
    this.home = home;
    this.tandemFile = path.join(home, 'hooks.json');
    this.trustFile = path.join(home, 'hooks-trust.json');
  }

  /** UI 用：所有来源的 hooks + 项目信任状态。 */
  settings(cwd?: string): HookSettings {
    const resolved = cwd ? path.resolve(cwd) : undefined;
    const entries: HookEntry[] = [];
    const sources: HookSourceInfo[] = [];
    for (const source of SOURCE_ORDER) {
      if ((source === 'claude-project' || source === 'claude-project-local') && !resolved) continue;
      const file = sourcePath(this.home, source, resolved);
      const exists = !!file && existsSync(file);
      sources.push({ source, path: file, readOnly: source !== 'tandem', exists });
      if (file) entries.push(...readHooksFile(file, source));
    }
    const hasProjectHooks = entries.some(
      (entry) => entry.source === 'claude-project' || entry.source === 'claude-project-local',
    );
    return {
      ...(resolved ? { cwd: resolved } : {}),
      entries,
      sources,
      hasProjectHooks,
      projectTrusted: resolved ? this.isTrusted(resolved) : false,
    };
  }

  /** 运行前加载：未信任的项目 hooks 一律跳过（首次使用需在设置里确认）。 */
  entriesForRun(cwd: string): HookEntry[] {
    const resolved = path.resolve(cwd);
    const trusted = this.isTrusted(resolved);
    return this.settings(resolved).entries.filter((entry) => {
      const project = entry.source === 'claude-project' || entry.source === 'claude-project-local';
      return !project || trusted;
    });
  }

  isTrusted(cwd: string): boolean {
    const resolved = path.resolve(cwd);
    return this.readTrustedProjects().some((project) => isSubPath(project, resolved));
  }

  setTrust(cwd: string, trusted: boolean): HookSettings {
    const resolved = path.resolve(cwd);
    const list = this.readTrustedProjects().filter((project) => project !== resolved);
    if (trusted) list.push(resolved);
    this.writeJson(this.trustFile, { projects: [...new Set(list)] });
    return this.settings(resolved);
  }

  /** 只保存 tandem 来源；entries 为界面上的扁平条目。 */
  save(entries: unknown, cwd?: string): HookSettings {
    const normalized: HookEntry[] = [];
    if (Array.isArray(entries)) {
      for (const item of entries) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const event = typeof raw.event === 'string' ? raw.event : '';
        if (!HOOK_EVENTS.includes(event as HookEvent)) continue;
        const command = typeof raw.command === 'string' ? raw.command.trim() : '';
        if (!command) continue;
        const matcher = typeof raw.matcher === 'string' ? raw.matcher.trim() : '';
        normalized.push({
          id: typeof raw.id === 'string' ? raw.id : `tandem:${event}:${normalized.length}`,
          event: event as HookEvent,
          ...(matcher ? { matcher } : {}),
          command,
          ...(normalizeTimeout(raw.timeout) ? { timeout: normalizeTimeout(raw.timeout) } : {}),
          source: 'tandem',
        });
      }
    }

    const hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>> = {};
    for (const entry of normalized) {
      const groups = (hooks[entry.event] ??= []);
      let group = groups.find((candidate) => (candidate.matcher ?? '') === (entry.matcher ?? ''));
      if (!group) {
        group = { ...(entry.matcher ? { matcher: entry.matcher } : {}), hooks: [] };
        groups.push(group);
      }
      group.hooks.push({
        type: 'command',
        command: entry.command,
        ...(entry.timeout ? { timeout: entry.timeout } : {}),
      });
    }
    this.writeJson(this.tandemFile, { hooks });
    return this.settings(cwd);
  }

  private readTrustedProjects(): string[] {
    try {
      if (!existsSync(this.trustFile)) return [];
      const raw = JSON.parse(readFileSync(this.trustFile, 'utf8')) as { projects?: unknown };
      return Array.isArray(raw.projects)
        ? raw.projects.filter((item): item is string => typeof item === 'string' && !!item)
        : [];
    } catch {
      return [];
    }
  }

  private writeJson(file: string, data: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
}
