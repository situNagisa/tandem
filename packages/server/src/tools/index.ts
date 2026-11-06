// 工具注册表：schema、权限属性、执行入口。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { definition as bash, run as runBash } from './bash.js';
import { definition as read, run as runRead } from './read.js';
import { definition as write, run as runWrite } from './write.js';
import { definition as edit, run as runEdit } from './edit.js';
import { definition as glob, run as runGlob } from './glob.js';
import { definition as grep, run as runGrep } from './grep.js';
import { definition as todo, run as runTodo } from './todo.js';
import { definition as webfetch, run as runWebfetch } from './webfetch.js';
import { definition as task, run as runTask } from './task.js';

type ToolRunner = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export const TOOLS: ToolDefinition[] = [bash, read, write, edit, glob, grep, todo, webfetch, task];

const RUNNERS: Record<string, ToolRunner> = {
  Bash: runBash,
  Read: runRead,
  Write: runWrite,
  Edit: runEdit,
  Glob: runGlob,
  Grep: runGrep,
  TodoWrite: runTodo,
  WebFetch: runWebfetch,
  Task: runTask,
};

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** plan 模式允许的工具（纯只读）。 */
export const PLAN_ALLOWED = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite']);

export function isReadOnlyTool(name: string): boolean {
  return TOOL_MAP.get(name)?.readOnly === true;
}

export function requiresApproval(name: string): boolean {
  return TOOL_MAP.get(name)?.requiresApproval === true;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const runner = RUNNERS[name];
  if (!runner) return { content: `未知工具: ${name}`, isError: true };
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return await runner(args, ctx);
  } catch (err) {
    return { content: `工具执行失败: ${(err as Error).message}`, isError: true };
  }
}

/** 给审批弹窗用的中文描述。 */
export function describeTool(name: string, input: unknown): string {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'Bash') {
    const command = String(args.command ?? '').split('\n')[0].slice(0, 200);
    return `运行命令: ${command}`;
  }
  if (name === 'Write') return `写入文件: ${String(args.file_path ?? '')}`;
  if (name === 'Edit') return `编辑文件: ${String(args.file_path ?? '')}`;
  if (name === 'WebFetch') return `访问网页: ${String(args.url ?? '')}`;
  if (name === 'Task') return `启动子代理: ${String(args.description ?? '').slice(0, 80)}`;
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `调用 MCP 工具: ${server ?? ''}/${rest.join('__')}`;
  }
  return `调用工具: ${name}`;
}
