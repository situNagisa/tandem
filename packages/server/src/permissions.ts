// Host 级权限规则：~/.tandem/permissions.json。
// 判定顺序：deny > ask > allow > 会话 allow_always > 权限模式默认。
// Bash 的 pattern 是命令前缀通配（"npm test*"、"git status"）；文件工具的 pattern 是相对 cwd 的 glob。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionRule } from '@tandem/protocol';
import { matchGlob } from './util/glob.js';
import { isSubPath, toPosix } from './util/path.js';

export type RuleDecision = 'deny' | 'ask' | 'allow';

const ACTIONS = new Set<RuleDecision>(['allow', 'ask', 'deny']);
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

export class PermissionRuleStore {
  private file: string;
  private rules: PermissionRule[] = [];

  constructor(home: string) {
    this.file = path.join(home, 'permissions.json');
    this.rules = loadRules(this.file);
  }

  list(): PermissionRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  /** 整体替换规则并落盘；非法条目直接丢弃。 */
  set(input: unknown): PermissionRule[] {
    this.rules = normalizeRules(input);
    this.save();
    return this.list();
  }

  /**
   * 命中规则的动作：deny 优先，其次 ask，最后 allow；都未命中返回 undefined。
   */
  evaluate(toolName: string, input: unknown, cwd: string): RuleDecision | undefined {
    let hit: RuleDecision | undefined;
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    for (const rule of this.rules) {
      if (rule.tool !== '*' && rule.tool.toLowerCase() !== toolName.toLowerCase()) continue;
      if (!matchesInput(rule, args, cwd)) continue;
      if (rule.action === 'deny') return 'deny';
      if (rule.action === 'ask') hit = 'ask';
      else if (!hit) hit = 'allow';
    }
    return hit;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rules, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}

function normalizeRules(input: unknown): PermissionRule[] {
  const raw = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { rules?: unknown }).rules)
      ? (input as { rules: unknown[] }).rules
      : [];
  const out: PermissionRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Record<string, unknown>;
    const tool = typeof rule.tool === 'string' ? rule.tool.trim() : '';
    const action = typeof rule.action === 'string' ? rule.action.trim() : '';
    if (!tool || !ACTIONS.has(action as RuleDecision)) continue;
    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
    out.push({
      tool,
      ...(pattern ? { pattern } : {}),
      action: action as RuleDecision,
    });
  }
  return out;
}

function loadRules(file: string): PermissionRule[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return normalizeRules(raw);
  } catch (err) {
    console.warn(`[tandem] 无法解析权限规则 ${file}:`, (err as Error).message);
    return [];
  }
}

/** 命令归一化：单行、压缩空白，和会话 allow_always 的判断口径一致。 */
function normalizeCommand(input: unknown): string {
  return String(input ?? '').split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * Bash 前缀通配：`*` 匹配任意字符，模式从命令开头匹配（末尾隐含通配）。
 * 没有 `*` 的模式按字面前缀匹配。
 */
function matchCommand(command: string, pattern: string): boolean {
  if (!pattern) return true;
  const source = pattern.replace(/\s+/g, ' ').trim();
  const escaped = source
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}`).test(command);
}

function matchesInput(rule: PermissionRule, args: Record<string, unknown>, cwd: string): boolean {
  if (rule.tool === 'Bash') {
    return matchCommand(normalizeCommand(args.command), rule.pattern ?? '');
  }
  if (FILE_TOOLS.has(rule.tool)) {
    const raw = typeof args.file_path === 'string' ? args.file_path : '';
    if (!raw) return !rule.pattern;
    if (!rule.pattern) return true;
    const abs = path.resolve(cwd, raw);
    if (!isSubPath(cwd, abs)) return false; // cwd 外的文件不参与 glob 匹配
    return matchGlob(toPosix(path.relative(cwd, abs)), rule.pattern);
  }
  // 其它工具没有可匹配的路径/命令：只有不带 pattern 的规则才命中
  return !rule.pattern;
}
