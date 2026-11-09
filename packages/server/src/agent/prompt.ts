// 系统提示：按注册表分段构建（类 Claude Code 的工作方式 + 环境信息 + 项目说明文件），
// 同时把每段内容、来源与 token 估算交给 Host 记录，供会话开头的「注入上下文」展开查看。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { InjectionSegment, InjectionSource, PromptSource } from '@tandem/protocol';
import {
  EDITABLE_PROMPTS,
  READONLY_PROMPTS,
  type ReadonlyPromptDef,
} from '../prompts/registry.js';

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 3.5) : 0;
}

function readInstructionFile(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    if (!text.trim()) return undefined;
    return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[已截断]` : text;
  } catch {
    return undefined;
  }
}

function isGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function readonlyText(key: string): string {
  return READONLY_PROMPTS.find((item) => item.key === key)?.text ?? '';
}

function readonlyDef(key: string): ReadonlyPromptDef | undefined {
  return READONLY_PROMPTS.find((item) => item.key === key);
}

export type ResolvedPrompt = { text: string; source: PromptSource };

/** Task 工具说明里的子代理预设列表（上下文面板按「自定义 agents」单独统计）。 */
export function subagentListing(
  subagents?: Array<{ name: string; description?: string }>,
): string {
  if (!subagents?.length) return '';
  return subagents
    .map((agent) => `  - ${agent.name}${agent.description ? `：${agent.description}` : ''}`)
    .join('\n');
}

export interface PromptOptions {
  allowTask?: boolean;
  planMode?: boolean;
  hookContext?: string;
  skills?: string;
  /** 来自 MemoryStore.promptSection 的项目记忆段。 */
  memory?: string;
  /** 本项目已有 Wiki 时的一句话提示（页数 + 页面名）。 */
  wiki?: string;
  /** 本项目可用的 secrets：只列名称/描述/作用范围，不含值。 */
  secrets?: string;
  /** 子代理预设（名称 + 描述），列在 Task 工具说明里。 */
  subagents?: Array<{ name: string; description?: string }>;
  /** 子代理预设的附加系统提示。 */
  extraSystemPrompt?: string;
  /** 当前委派倾向提示词（由 Host 按策略模板渲染）。 */
  delegationPrompt?: string;
  /** 当前委派倾向对应的模板 key，用于标注来源。 */
  delegationKey?: string;
  /** Host 解析后的可编辑提示词（项目覆盖 > 用户自定义 > 内置默认）。 */
  prompts?: Record<string, ResolvedPrompt | undefined>;
}

function textOf(options: PromptOptions, key: string): string {
  return options.prompts?.[key]?.text ?? EDITABLE_PROMPTS[key]?.text ?? '';
}

function sourceOf(options: PromptOptions, key: string): InjectionSource {
  return options.prompts?.[key]?.source ?? 'builtin';
}

/** 构建系统提示的各个注入段落。 */
export function buildSystemPromptParts(
  cwd: string,
  options: PromptOptions = {},
): InjectionSegment[] {
  const date = new Date().toISOString().slice(0, 10);
  const env = readonlyText('environment')
    .replace(/\{\{cwd\}\}/g, cwd)
    .replace(/\{\{platform\}\}/g, process.platform)
    .replace(/\{\{arch\}\}/g, process.arch)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{git\}\}/g, isGitRepo(cwd) ? '是' : '否');

  const listing = subagentListing(options.subagents);
  const taskLine =
    options.allowTask !== false
      ? `- Task：把独立、多步的子任务派给子代理。description 是简短标题，prompt 要自包含；subagent_type 可选 Explore/Plan（只读，可同批并行）、general-purpose（可改文件）${listing ? '，或以下子代理预设' : ''}。可用 model 参数临时指定子代理模型。子代理最后一条文本会作为工具结果返回，不要用它处理必须共享同一上下文的小事。${listing ? `\n${listing}` : ''}`
      : '';
  const toolGuidance = readonlyText('toolGuidance').replace(/\{\{taskLine\}\}/g, taskLine).replace(/\n\n- MCP/, '\n- MCP');

  const parts: InjectionSegment[] = [];
  const push = (
    id: string,
    name: string,
    source: InjectionSource,
    content: string,
    sourcePath?: string,
  ) => {
    const text = content.trim();
    if (!text) return;
    parts.push({
      id,
      name,
      source,
      ...(sourcePath ? { sourcePath } : {}),
      tokens: estimateTokens(text),
      content: text,
    });
  };

  push('persona', '身份说明', 'builtin', readonlyText('persona'));
  push(
    'baseBehavior',
    '基础行为与工作方式',
    sourceOf(options, 'baseBehavior'),
    `# 工作方式\n${textOf(options, 'baseBehavior')}`,
  );
  if (options.planMode) {
    push(
      'planMode',
      '计划模式',
      sourceOf(options, 'planMode'),
      `# 计划模式（重要）\n${textOf(options, 'planMode')}`,
    );
  }
  push('toolGuidance', '工具使用要点', 'builtin', `# 工具使用要点\n${toolGuidance}`);
  if (options.skills?.trim()) push('skills', 'Skills 列表', 'skill', options.skills);
  if (options.memory?.trim()) push('memory', '项目记忆', 'memory', options.memory);
  if (options.wiki?.trim()) push('wiki', '项目 Wiki', 'generated', options.wiki);
  if (options.secrets?.trim()) push('secrets', '项目环境变量', 'generated', options.secrets);
  if (options.delegationPrompt?.trim()) {
    const source = options.delegationKey
      ? sourceOf(options, options.delegationKey)
      : 'builtin';
    push('delegation', '委派倾向', source, options.delegationPrompt);
  }
  if (options.extraSystemPrompt?.trim()) {
    push('subagent', '子代理预设附加提示', 'session', `# 子代理预设\n${options.extraSystemPrompt}`);
  }
  push('environment', '环境信息', 'generated', `# 环境\n${env}`);

  for (const name of ['AGENTS.md', 'CLAUDE.md'] as const) {
    const file = path.join(cwd, name);
    const text = readInstructionFile(file);
    if (text) push(`project:${name}`, name, 'project', `## ${name}（${file}）\n${text}`, file);
  }
  if (options.hookContext?.trim()) {
    push('hook', 'Hook 附加上下文', 'hook', `# Hook 附加上下文\n${options.hookContext}`);
  }
  push('safety', '安全边界', 'builtin', `# 安全边界\n${readonlyText('safety')}`);
  return parts;
}

export function buildSystemPrompt(cwd: string, options: PromptOptions = {}): string {
  return buildSystemPromptParts(cwd, options)
    .map((part) => part.content)
    .join('\n\n');
}

/** 注册表里的只读段落（设置页展示用）。 */
export function readonlyPromptText(key: string): string {
  return readonlyDef(key)?.text ?? '';
}
