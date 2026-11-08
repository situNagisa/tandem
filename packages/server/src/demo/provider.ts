// 内置演示模型：按剧本流式输出，不做任何网络请求。
// 只依赖已有的 ContentBlock 回调；工具调用固定为演示仓库内的只读/安全命令。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message } from '@tandem/protocol';
import type { StreamRequest, StreamResult } from '../providers/types.js';

/** 演示模型累计网络请求数；恒为 0，供验收脚本与关于页展示。 */
export let demoNetworkRequests = 0;

function userText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    return message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

function hasToolResult(messages: Message[]): boolean {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return !!last?.content.some((block) => block.type === 'tool_result');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function emitText(
  req: StreamRequest,
  index: number,
  text: string,
): Promise<void> {
  const block: ContentBlock = { type: 'text', text: '' };
  req.blocks[index] = block;
  req.onBlockStart(index, block);
  // 按小段输出，模拟真实流式；每段 20ms，总时长可控。
  const chunks = text.match(/[\s\S]{1,18}/g) ?? [text];
  for (const chunk of chunks) {
    if (req.signal.aborted) return;
    block.text += chunk;
    req.onText(index, chunk);
    await wait(18, req.signal);
  }
}

async function emitThinking(
  req: StreamRequest,
  index: number,
  text: string,
): Promise<void> {
  const block: ContentBlock = { type: 'thinking', text: '' };
  req.blocks[index] = block;
  req.onBlockStart(index, block);
  for (const chunk of text.match(/[\s\S]{1,16}/g) ?? [text]) {
    if (req.signal.aborted) return;
    block.text += chunk;
    req.onText(index, chunk);
    await wait(14, req.signal);
  }
}

function emitTool(
  req: StreamRequest,
  index: number,
  name: string,
  input: Record<string, unknown>,
): void {
  const block: ContentBlock = {
    type: 'tool_use',
    id: `demo_${randomUUID().slice(0, 8)}`,
    name,
    input,
  };
  req.blocks[index] = block;
  req.onBlockStart(index, block);
  req.onToolInput(index, JSON.stringify(input));
}

/**
 * 剧本选择：只读取最后一条用户消息，不执行用户要求的任意命令。
 * - 已拿到工具结果：给中文总结；
 * - 含「权限 / 审批」：发起一次 Bash 审批（git status）；
 * - 含「计划」：发起 ExitPlanMode（计划卡）；
 * - 含「后台」：发起后台任务；
 * - 其他：先思考，再读取演示仓库 README（只读工具），下一轮总结。
 */
export async function streamDemo(req: StreamRequest): Promise<StreamResult> {
  // 这里刻意不调用 fetch/undici；baseUrl 即使是不可达地址也不会被使用。
  const text = userText(req.messages).toLowerCase();
  const usage = {
    inputTokens: Math.max(16, Math.ceil(JSON.stringify(req.messages).length / 4)),
    outputTokens: 0,
  };
  let index = 0;

  if (hasToolResult(req.messages)) {
    const resultText =
      '工具结果已返回。演示模型只执行固定剧本：所有动作都限制在演示仓库内，' +
      '不会读取真实项目、不会访问网络。你可以继续发消息，或回到「设置 → 关于 → 演示工作区」重新播放场景。';
    await emitText(req, index++, resultText);
    usage.outputTokens = Math.ceil(resultText.length / 3);
    return { usage, stopReason: 'end_turn' };
  }

  await emitThinking(
    req,
    index++,
    '这是内置演示模型的思考过程：我不调用任何外部接口，只根据预设剧本选择安全的演示动作。',
  );

  if (text.includes('后台')) {
    const intro =
      '好的，我会在演示仓库里启动一个只打印心跳的后台任务。它不会访问网络，也只会写在演示目录的任务日志里。';
    await emitText(req, index++, intro);
    usage.outputTokens += Math.ceil(intro.length / 3);
    emitTool(req, index++, 'Bash', {
      command: "sh -c 'for i in 1 2 3 4 5 6; do echo \"演示后台 tick $i\"; sleep 2; done'",
      description: '演示后台任务（本地心跳）',
      run_in_background: true,
    });
    return { usage, stopReason: 'tool_use' };
  }

  if (text.includes('计划')) {
    const intro =
      '我先进入计划模式，梳理一个最小可用的改造计划；批准后才会开始编辑。';
    await emitText(req, index++, intro);
    usage.outputTokens += Math.ceil(intro.length / 3);
    const plan = [
      '## 演示计划：整理演示仓库',
      '',
      '1. 阅读 `README.md` 与 `src/app.js`，确认演示入口。',
      '2. 在 `docs/` 下补充一页说明，不修改真实项目。',
      '3. 运行演示仓库内的静态页面，检查应用预览。',
      '4. 在改动审阅里查看 diff，再决定是否提交。',
      '',
      '> 这份计划只针对 `~/.tandem/demo/project`。',
    ].join('\n');
    emitTool(req, index++, 'ExitPlanMode', { plan });
    return { usage, stopReason: 'tool_use' };
  }

  if (text.includes('权限') || text.includes('审批')) {
    const intro =
      '我会用一条只读的 git 命令演示审批流程：命令会真实执行，但只作用于演示仓库。';
    await emitText(req, index++, intro);
    usage.outputTokens += Math.ceil(intro.length / 3);
    emitTool(req, index++, 'Bash', {
      command: 'git status --short',
      description: '查看演示仓库改动',
      timeout: 15_000,
    });
    return { usage, stopReason: 'tool_use' };
  }

  const intro =
    '这是演示模型的固定回复：我会读取演示仓库里的 README，再把内容摘要给你。' +
    '整个过程不访问网络，也不消耗真实账号额度。';
  await emitText(req, index++, intro);
  usage.outputTokens += Math.ceil(intro.length / 3);
  emitTool(req, index++, 'Read', { file_path: 'README.md' });
  return { usage, stopReason: 'tool_use' };
}
