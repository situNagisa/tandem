// 斜杠命令：内置命令 + 项目/用户自定义 md（.tandem/commands 与 .claude/commands）。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommand } from '@tandem/protocol';
import { walkFiles } from '../util/fs-walk.js';
import { toPosix } from '../util/path.js';
import { EDITABLE_PROMPTS } from '../prompts/registry.js';

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: '清空当前会话的消息历史', source: 'builtin' },
  { name: 'compact', description: '用模型总结当前对话并替换为摘要，释放上下文', source: 'builtin' },
  { name: 'model', description: '查看或切换当前会话模型：/model <模型名>（下一轮生效）', source: 'builtin' },
  { name: 'init', description: '分析当前仓库并生成 AGENTS.md', source: 'builtin' },
  { name: 'cost', description: '查看本会话的 token 用量与花费摘要', source: 'builtin' },
  { name: 'memory', description: '查看/编辑项目记忆与全局记忆', source: 'builtin' },
  { name: 'schedule', description: '新建定时任务（打开「定时任务」设置页）', source: 'builtin' },
  { name: 'help', description: '显示所有可用命令', source: 'builtin' },
];

export const INIT_PROMPT = EDITABLE_PROMPTS.init.text;

function parseDescription(content: string): string {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    const desc = frontmatter[1].match(/^description:\s*(.+)$/m);
    if (desc) return stripQuotes(desc[1]).slice(0, 120);
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (trimmed.startsWith('#')) return trimmed.replace(/^#+\s*/, '').slice(0, 120);
    return trimmed.slice(0, 120);
  }
  return '(无描述)';
}

/** 去掉命令文件开头的 YAML frontmatter（只用于元数据，不发给模型）。 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
}

function stripQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function scanCommandDir(dir: string, source: 'project' | 'user'): SlashCommand[] {
  if (!existsSync(dir)) return [];
  const files = walkFiles(dir, { maxEntries: 1000, maxDepth: 4 });
  const commands: SlashCommand[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const rel = toPosix(path.relative(dir, file)).replace(/\.md$/, '');
    try {
      const content = readFileSync(file, 'utf8');
      commands.push({ name: rel, description: parseDescription(content), source });
    } catch {
      // 忽略不可读文件
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/** 项目自定义命令目录：Tandem 优先，兼容 Claude Code。 */
function projectCommandDirs(cwd: string): string[] {
  return [path.join(cwd, '.tandem', 'commands'), path.join(cwd, '.claude', 'commands')];
}

/** 用户级自定义命令目录：Tandem 优先，兼容 Claude Code。 */
function userCommandDirs(): string[] {
  return [path.join(os.homedir(), '.tandem', 'commands'), path.join(os.homedir(), '.claude', 'commands')];
}

/** 列出内置 + 项目 + 用户命令（重名时项目覆盖用户，.tandem 覆盖 .claude）。 */
export function listCommands(cwd: string): SlashCommand[] {
  const project = projectCommandDirs(cwd).flatMap((dir) => scanCommandDir(dir, 'project'));
  const user = userCommandDirs().flatMap((dir) => scanCommandDir(dir, 'user'));
  const byName = new Map<string, SlashCommand>();
  for (const cmd of user) byName.set(cmd.name, cmd);
  for (const cmd of project) byName.set(cmd.name, cmd);
  for (const cmd of BUILTIN_COMMANDS) byName.set(cmd.name, cmd);
  return [...byName.values()];
}

/** 读取自定义命令正文（项目优先）。 */
export function findCommandBody(name: string, cwd: string): string | undefined {
  if (!name || name.includes('..') || path.isAbsolute(name)) return undefined;
  for (const dir of [...projectCommandDirs(cwd), ...userCommandDirs()]) {
    const file = path.join(dir, `${name}.md`);
    if (existsSync(file)) {
      try {
        return stripFrontmatter(readFileSync(file, 'utf8'));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

/** 解析 "/command args"（仅当文本以 / 开头）。 */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = trimmed.match(/^\/([A-Za-z0-9_][A-Za-z0-9_./-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1], args: (match[2] ?? '').trim(), raw: trimmed };
}

export const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((cmd) => cmd.name));
