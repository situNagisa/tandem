// Skills：兼容 Claude Code 的 <dir>/SKILL.md（YAML frontmatter + markdown 正文）。
// 只读扫描 ~/.claude 与插件目录；启用状态单独存 ~/.tandem/skills-state.json。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo, SkillSource } from '@tandem/protocol';
import { truncateEnd } from './util/text.js';

const MAX_SKILLS_PER_SOURCE = 200;
const MAX_BODY = 120_000;
const MAX_PROMPT_CHARS = 6000;
const MAX_DESCRIPTION = 300;

interface ParsedSkill {
  info: SkillInfo;
  body: string;
}

interface Frontmatter {
  values: Record<string, string>;
  body: string;
}

/** 解析开头的 --- YAML 块；只处理 skills 用到的标量/简单列表，够用且不引第三方依赖。 */
function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { values: {}, body: text };
  const values: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  let current: string | undefined;
  let blockIndent = 0;
  const append = (key: string, value: string) => {
    values[key] = values[key] ? `${values[key]} ${value}`.trim() : value;
  };
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    // 多行块（| 或 >）的续行
    if (current && indent > blockIndent) {
      append(current, line.trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (value === '|' || value === '>') {
      current = key;
      blockIndent = indent;
      continue;
    }
    current = undefined;
    value = value.replace(/^["']|["']$/g, '').trim();
    if (value) append(key, value);
    else values[key] = '';
  }
  return { values, body: text.slice(match[0].length) };
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function isTruthy(value: string | undefined): boolean {
  return /^(true|yes|1)$/i.test((value ?? '').trim());
}

function isFalsy(value: string | undefined): boolean {
  return /^(false|no|0)$/i.test((value ?? '').trim());
}

function readSkill(file: string, source: SkillSource, enabled: boolean): ParsedSkill | undefined {
  try {
    const raw = readFileSync(file, 'utf8');
    const { values, body } = parseFrontmatter(raw);
    const dir = path.dirname(file);
    const fallbackName = path.basename(dir) || path.basename(path.dirname(dir));
    const name = (values.name || fallbackName).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return undefined;
    const description =
      (values.description || firstMeaningfulLine(body) || name).slice(0, MAX_DESCRIPTION);
    const allowed = splitList(values['allowed-tools'] ?? values.allowed_tools);
    const info: SkillInfo = {
      name,
      description,
      source,
      path: file,
      dir,
      enabled,
      modelInvocable: !isTruthy(values['disable-model-invocation']),
      userInvocable: !isFalsy(values['user-invocable']),
      ...(allowed.length ? { allowedTools: allowed } : {}),
    };
    return { info, body: body.trim() };
  } catch {
    return undefined;
  }
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 插件目录里的 skills 可能嵌套在 cache/<市场>/<插件>/<版本>/skills 下，这里找所有名为 skills 的目录。 */
function pluginSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && found.length < 50) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'skills') {
        found.push(full);
        continue;
      }
      if (depth < 6) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return found;
}

export interface SkillManagerOptions {
  /** ~/.tandem 数据目录。 */
  home: string;
  /** 覆盖 ~/.claude（测试用）。 */
  claudeHome?: string;
}

export class SkillManager {
  private readonly home: string;
  private readonly claudeHome: string;
  private readonly stateFile: string;
  private disabled = new Set<string>();
  private cache = new Map<string, { at: number; skills: ParsedSkill[] }>();

  constructor(options: SkillManagerOptions) {
    this.home = options.home;
    this.claudeHome = options.claudeHome ?? path.join(os.homedir(), '.claude');
    this.stateFile = path.join(this.home, 'skills-state.json');
    this.loadState();
  }

  private loadState(): void {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { disabled?: unknown };
      if (Array.isArray(data.disabled)) {
        this.disabled = new Set(
          data.disabled.filter((item): item is string => typeof item === 'string' && item.length > 0),
        );
      }
    } catch {
      this.disabled = new Set();
    }
  }

  private saveState(): void {
    try {
      writeFileSync(
        this.stateFile,
        `${JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2)}\n`,
      );
    } catch {
      // 状态文件写失败不影响读取，只是重启后丢失停用设置
    }
  }

  private sourceDirs(cwd: string): Array<{ source: SkillSource; dir: string }> {
    return [
      { source: 'project', dir: path.join(cwd, '.claude', 'skills') },
      { source: 'tandem', dir: path.join(this.home, 'skills') },
      { source: 'user', dir: path.join(this.claudeHome, 'skills') },
      ...pluginSkillDirs(path.join(this.claudeHome, 'plugins')).map((dir) => ({
        source: 'plugin' as const,
        dir,
      })),
    ];
  }

  private scan(cwd: string): ParsedSkill[] {
    const key = path.resolve(cwd);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 3000) return cached.skills;
    const byName = new Map<string, ParsedSkill>();
    for (const { source, dir } of this.sourceDirs(key)) {
      if (!existsSync(dir)) continue;
      let count = 0;
      for (const child of childDirs(dir)) {
        if (count >= MAX_SKILLS_PER_SOURCE) break;
        const file = path.join(child, 'SKILL.md');
        try {
          if (!statSync(file).isFile()) continue;
        } catch {
          continue;
        }
        const parsed = readSkill(file, source, true);
        if (!parsed) continue;
        count++;
        // 先扫到的来源优先（project > tandem > user > plugin）
        if (!byName.has(parsed.info.name)) byName.set(parsed.info.name, parsed);
      }
    }
    const skills = [...byName.values()];
    this.cache.set(key, { at: Date.now(), skills });
    return skills;
  }

  list(cwd: string): SkillInfo[] {
    return this.scan(cwd)
      .map(({ info }) => ({ ...info, enabled: !this.disabled.has(info.path) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称查找已启用的技能，返回正文（去掉 frontmatter）与目录。 */
  resolve(name: string, cwd: string): { info: SkillInfo; body: string } | undefined {
    const wanted = name.replace(/^\//, '').trim();
    if (!wanted || wanted.includes('..') || wanted.includes('/') || wanted.includes('\\')) {
      return undefined;
    }
    const found = this.scan(cwd).find(({ info }) => info.name === wanted);
    if (!found || this.disabled.has(found.info.path)) return undefined;
    return {
      info: { ...found.info, enabled: true },
      body: truncateEnd(found.body, MAX_BODY),
    };
  }

  /** / 菜单里的技能命令（停用或用 user-invocable: false 的不出现）。 */
  commands(cwd: string): Array<{ name: string; description: string; source: 'skill' }> {
    return this.list(cwd)
      .filter((skill) => skill.enabled && skill.userInvocable)
      .map((skill) => ({
        name: skill.name,
        description: skill.description || '技能',
        source: 'skill' as const,
      }));
  }

  /** 系统提示里的技能索引：只含启用的、允许模型调用的技能，控制总长度。 */
  promptSection(cwd: string): string {
    const skills = this.list(cwd).filter((skill) => skill.enabled && skill.modelInvocable);
    if (skills.length === 0) return '';
    const header =
      '# 可用技能（Skills）\n' +
      '下面是本机安装的技能。任务与某个技能的描述匹配时，先调用 Skill 工具（参数 { "skill": "<name>" }）加载完整说明，再按说明执行；不要凭名称猜测技能内容。\n';
    const lines: string[] = [];
    let used = header.length;
    let omitted = 0;
    for (const skill of skills) {
      const desc = skill.description.replace(/\s+/g, ' ').slice(0, 240);
      const line = `- ${skill.name}: ${desc}`;
      if (used + line.length + 1 > MAX_PROMPT_CHARS) {
        omitted++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted > 0) lines.push(`- （另有 ${omitted} 个技能未列出，可用 /help 查看）`);
    return `${header}${lines.join('\n')}\n`;
  }

  /** 保存停用列表（绝对路径）；返回按 cwd 重新计算的列表。 */
  setDisabled(disabled: string[], cwd: string): SkillInfo[] {
    this.disabled = new Set(
      disabled.filter((item): item is string => typeof item === 'string' && item.length > 0),
    );
    this.saveState();
    return this.list(cwd);
  }

  invalidate(): void {
    this.cache.clear();
  }
}
