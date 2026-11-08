// 看板卡片的结果核对：卡片分支相对起点的 diff、会话里最近一次测试/检查输出。
// 供「合并前确认」「查看改动」「查看测试结果」共用；全部用参数数组调 git。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BoardCardCheck, BoardCardDiff, BoardCardFileChange, Message } from '@tandem/protocol';

const exec = promisify(execFile);

const MAX_DIFF_CHARS = 1_000_000;
const MAX_DIFF_LINES = 20_000;
const MAX_CHECK_CHARS = 4000;
const CHECK_LINE_LIMIT = 60;

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout ?? '');
}

/** 卡片分支相对起点的 diff；base 优先用卡片 worktree 起点提交。 */
export async function cardDiff(
  cwd: string,
  input: { base?: string; branch?: string; path?: string },
): Promise<BoardCardDiff> {
  const base = input.base;
  const branch = input.branch;
  if (!branch) return { files: [], diff: '' };
  const range = base ? `${base}...${branch}` : branch;
  const pathFilter = input.path ? ['--', input.path] : [];
  const files: BoardCardFileChange[] = [];
  try {
    const numstat = await git(cwd, ['diff', '--numstat', range, ...pathFilter]);
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      files.push({
        path: file,
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      });
    }
  } catch {
    return { files: [], diff: '', ...(base ? { base } : {}), branch };
  }
  let diff = '';
  let truncated: true | undefined;
  try {
    diff = await git(cwd, ['-c', 'core.quotepath=false', 'diff', range, ...pathFilter]);
    if (diff.length > MAX_DIFF_CHARS) {
      let text = diff.slice(0, MAX_DIFF_CHARS);
      const newline = text.lastIndexOf('\n');
      if (newline > 0) text = text.slice(0, newline + 1);
      const lines = text.split('\n');
      if (lines.length > MAX_DIFF_LINES) text = `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n`;
      diff = text;
      truncated = true;
    }
  } catch {
    diff = '';
  }
  return {
    files,
    diff,
    ...(base ? { base } : {}),
    branch,
    ...(truncated ? { truncated } : {}),
  };
}

/** 只取文件清单，合并前确认用（不拉 diff 全文）。 */
export async function changedFiles(cwd: string, base: string | undefined, branch: string): Promise<BoardCardFileChange[]> {
  const range = base ? `${base}...${branch}` : branch;
  try {
    const numstat = await git(cwd, ['diff', '--numstat', range]);
    const files: BoardCardFileChange[] = [];
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      files.push({ path: file, additions: Number(add) || 0, deletions: Number(del) || 0 });
    }
    return files;
  } catch {
    return [];
  }
}

/** 识别测试/检查类命令：npm test、pnpm run check、pytest、go test、cargo test、tsc、vitest… */
const CHECK_COMMAND = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|e2e|ci)\b|(?:^|[;&|]\s*)(?:pytest|vitest|jest|mocha|go\s+test|cargo\s+test|cargo\s+check|make\s+test|node\s+scripts\/check\.mjs|tsc\b)/;

function commandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

function clip(text: string): string {
  const lines = text.split('\n');
  let out = lines.slice(0, CHECK_LINE_LIMIT).join('\n');
  if (out.length > MAX_CHECK_CHARS) out = out.slice(0, MAX_CHECK_CHARS);
  if (lines.length > CHECK_LINE_LIMIT || out.length < text.length) out += '\n…（输出已截断）';
  return out;
}

/** 从会话里摘出最近一次测试/检查命令及其结果。 */
export function latestCheck(messages: Message[]): BoardCardCheck | undefined {
  // 先收集 tool_use（命令与 id），再从后往前找对应 tool_result。
  const commands = new Map<string, { command: string; at: number }>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const command = commandOf(block.input);
      if (command && CHECK_COMMAND.test(command)) {
        commands.set(block.id, { command, at: message.createdAt });
      }
    }
  }
  if (commands.size === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const found = commands.get(block.toolUseId);
      if (!found) continue;
      return {
        command: found.command,
        output: clip(block.content || '（没有输出）'),
        isError: block.isError === true,
        at: message.createdAt || found.at,
      };
    }
  }
  // 只有命令、结果还没回来：也给出命令本身。
  const last = [...commands.values()].sort((a, b) => b.at - a.at)[0]!;
  return { command: last.command, output: '（这条命令的结果还没有记录）', isError: false, at: last.at };
}
