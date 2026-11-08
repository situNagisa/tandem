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
import { definition as exitPlan, run as runExitPlan } from './exit-plan.js';
import { definition as bashOutput, run as runBashOutput } from './bash-output.js';
import { definition as killBash, run as runKillBash } from './kill-bash.js';
import { definition as skill, run as runSkill } from './skill.js';
import { definition as memory, run as runMemory } from './memory.js';
import { definition as wikiSearch, run as runWikiSearch } from './wiki-search.js';
import { definition as wikiRead, run as runWikiRead } from './wiki-read.js';
import { definition as proposeCards, run as runProposeCards } from './propose-cards.js';
import {
  clickDefinition as browserClick,
  closeDefinition as browserClose,
  consoleDefinition as browserConsole,
  navigateDefinition as browserNavigate,
  runClick as runBrowserClick,
  runClose as runBrowserClose,
  runConsole as runBrowserConsole,
  runNavigate as runBrowserNavigate,
  runScreenshot as runBrowserScreenshot,
  runSnapshot as runBrowserSnapshot,
  runType as runBrowserType,
  screenshotDefinition as browserScreenshot,
  snapshotDefinition as browserSnapshot,
  typeDefinition as browserType,
} from './browser.js';

type ToolRunner = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export const TOOLS: ToolDefinition[] = [
  bash,
  bashOutput,
  killBash,
  read,
  write,
  edit,
  glob,
  grep,
  todo,
  webfetch,
  task,
  exitPlan,
  skill,
  memory,
  wikiSearch,
  wikiRead,
  proposeCards,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserScreenshot,
  browserConsole,
  browserClose,
];

const RUNNERS: Record<string, ToolRunner> = {
  Bash: runBash,
  BashOutput: runBashOutput,
  KillBash: runKillBash,
  Read: runRead,
  Write: runWrite,
  Edit: runEdit,
  Glob: runGlob,
  Grep: runGrep,
  TodoWrite: runTodo,
  WebFetch: runWebfetch,
  Task: runTask,
  ExitPlanMode: runExitPlan,
  Skill: runSkill,
  Memory: runMemory,
  WikiSearch: runWikiSearch,
  WikiRead: runWikiRead,
  ProposeCards: runProposeCards,
  browser_navigate: runBrowserNavigate,
  browser_snapshot: runBrowserSnapshot,
  browser_click: runBrowserClick,
  browser_type: runBrowserType,
  browser_screenshot: runBrowserScreenshot,
  browser_console: runBrowserConsole,
  browser_close: runBrowserClose,
};

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** plan 模式允许的工具（纯只读）；ExitPlanMode 是提交计划的特殊工具。 */
export const PLAN_ALLOWED = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'BashOutput', 'TodoWrite', 'ExitPlanMode', 'Skill', 'WikiSearch', 'WikiRead', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_close']);

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
  if (name === 'BashOutput') return `读取后台任务输出: ${String(args.bash_id ?? '')}`;
  if (name === 'KillBash') return `终止后台任务: ${String(args.shell_id ?? '')}`;
  if (name === 'Bash') {
    const command = String(args.command ?? '').split('\n')[0].slice(0, 200);
    return `运行命令: ${command}`;
  }
  if (name === 'Write') return `写入文件: ${String(args.file_path ?? '')}`;
  if (name === 'Edit') return `编辑文件: ${String(args.file_path ?? '')}`;
  if (name === 'WebFetch') return `访问网页: ${String(args.url ?? '')}`;
  if (name === 'Task') return `启动子代理: ${String(args.description ?? '').slice(0, 80)}`;
  if (name === 'ExitPlanMode') return '提交执行计划，等待批准';
  if (name === 'Skill') return `使用技能: ${String(args.skill ?? '')}`;
  if (name === 'Memory') {
    const action = String(args.action ?? '');
    const text = String(args.text ?? args.old ?? '').replace(/\s+/g, ' ').slice(0, 80);
    return `记忆${action === 'view' ? '查看' : action === 'add' ? '新增' : action === 'replace' ? '替换' : action === 'remove' ? '删除' : '更新'}: ${text || '（空）'}`;
  }
  if (name === 'browser_navigate') {
    const url = String(args.url ?? '');
    let host = '';
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).host;
    } catch {
      host = url;
    }
    return `打开页面: ${host}${host && host !== url ? `（${url}）` : ''}`;
  }
  if (name === 'browser_click') return `点击页面元素: ${String(args.ref ?? '')}`;
  if (name === 'browser_type') {
    const text = String(args.text ?? '');
    return `在页面元素 ${String(args.ref ?? '')} 输入 ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  }
  if (name === 'browser_screenshot') return '截取当前页面';
  if (name === 'browser_snapshot') return '读取当前页面快照';
  if (name === 'browser_console') return '读取页面控制台输出';
  if (name === 'browser_close') return '关闭本会话的浏览器';
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `调用 MCP 工具: ${server ?? ''}/${rest.join('__')}`;
  }
  return `调用工具: ${name}`;
}
