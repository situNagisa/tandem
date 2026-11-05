// 斜杠命令：内置命令 + cwd/.claude/commands 与 ~/.claude/commands 下的自定义 md。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommand } from '@tandem/protocol';
import { walkFiles } from '../util/fs-walk.js';
import { toPosix } from '../util/path.js';

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: '清空当前会话的消息历史', source: 'builtin' },
  { name: 'compact', description: '用模型总结当前对话并替换为摘要，释放上下文', source: 'builtin' },
  { name: 'model', description: '查看或切换当前会话模型：/model <模型名>（下一轮生效）', source: 'builtin' },
  { name: 'init', description: '分析当前仓库并生成 AGENTS.md', source: 'builtin' },
  { name: 'help', description: '显示所有可用命令', source: 'builtin' },
];

export const INIT_PROMPT = `请分析当前仓库：先用工具浏览目录结构、README、包管理配置、构建/测试脚本和关键源码，然后根据实际情况在仓库根目录创建或更新 AGENTS.md。

AGENTS.md 需要面向后续接手工作的 agent，内容简洁、可执行，包含：
- 项目概览与技术栈
- 目录结构与关键模块
- 常用命令（安装、开发、构建、测试、lint）
- 代码风格与约定、注意事项、容易踩的坑

不要臆测：只写你在仓库中确认过的信息。如果 AGENTS.md 已存在，请在其基础上补充或修正，不要覆盖掉仍然有效的内容。`;

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

function projectCommandDir(cwd: string): string {
  return path.join(cwd, '.claude', 'commands');
}

function userCommandDir(): string {
  return path.join(os.homedir(), '.claude', 'commands');
}

/** 列出内置 + 项目 + 用户命令（重名时项目覆盖用户）。 */
export function listCommands(cwd: string): SlashCommand[] {
  const project = scanCommandDir(projectCommandDir(cwd), 'project');
  const user = scanCommandDir(userCommandDir(), 'user');
  const byName = new Map<string, SlashCommand>();
  for (const cmd of user) byName.set(cmd.name, cmd);
  for (const cmd of project) byName.set(cmd.name, cmd);
  for (const cmd of BUILTIN_COMMANDS) byName.set(cmd.name, cmd);
  return [...byName.values()];
}

/** 读取自定义命令正文（项目优先）。 */
export function findCommandBody(name: string, cwd: string): string | undefined {
  if (!name || name.includes('..') || path.isAbsolute(name)) return undefined;
  for (const dir of [projectCommandDir(cwd), userCommandDir()]) {
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
