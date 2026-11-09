// 演示场景造数：直接写会话/看板/评测/Wiki 等持久化对象，不调用任何模型。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AiReviewRun,
  Board,
  BoardCard,
  ContentBlock,
  EvalCase,
  EvalResult,
  EvalRun,
  HandoffState,
  InboxEvent,
  Message,
  SessionPlan,
  WikiPageMeta,
} from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { composePage } from '../wiki.js';
import type { DemoScenarioId } from './scenarios.js';

type DemoRefs = DemoSeedRefs;

export interface DemoSeedRefs {
  sessionIds?: string[];
  boardId?: string;
  evalRunId?: string;
  reviewIds?: string[];
  taskIds?: string[];
}

export interface DemoSeedContext {
  host: Host;
  scenario: DemoScenarioId;
  project: string;
  profileId: string;
  commit: string;
  /** 演示内置静态页面端口（预览场景用）。 */
  previewUrl: string;
}

const DEMO_MODEL = 'demo-model';
const DEMO_BACKUP_MODEL = 'demo-backup';

let clock = Date.now() - 60_000;

function tick(ms = 1000): number {
  clock += ms;
  return clock;
}

function content(text?: string, thinking?: string, tools?: Array<{ name: string; input: Record<string, unknown>; id?: string }>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (thinking) blocks.push({ type: 'thinking', text: thinking });
  if (text) blocks.push({ type: 'text', text });
  for (const tool of tools ?? []) {
    blocks.push({
      type: 'tool_use',
      id: tool.id ?? `demo_tool_${randomUUID().slice(0, 8)}`,
      name: tool.name,
      input: tool.input,
    });
  }
  return blocks;
}

function message(
  role: 'user' | 'assistant',
  blocks: ContentBlock[],
  extra: Partial<Message> = {},
): Message {
  return {
    id: randomUUID(),
    role,
    content: blocks,
    createdAt: tick(),
    ...extra,
  };
}

function user(text: string): Message {
  return message('user', [{ type: 'text', text }]);
}

function assistant(
  text: string,
  options: { thinking?: string; tools?: Array<{ name: string; input: Record<string, unknown>; id?: string }>; usage?: boolean } = {},
): Message {
  return message('assistant', content(text, options.thinking, options.tools), {
    model: DEMO_MODEL,
    ...(options.usage === false
      ? {}
      : {
          usage: {
            inputTokens: 1200 + Math.round(text.length / 2),
            outputTokens: 180 + Math.round(text.length / 3),
            costUsd: 0,
          },
        }),
  });
}

function toolResult(
  toolUseId: string,
  text: string,
  isError = false,
  subagent?: { id: string; model?: string },
): Message {
  return message('user', [
    { type: 'tool_result', toolUseId, content: text, isError, ...(subagent ? { subagent } : {}) },
  ]);
}

function addSession(host: Host, rec: SessionRecord): SessionRecord {
  host.store.add(rec);
  host.broadcastSummary(rec);
  return rec;
}

function baseSession(
  ctx: DemoSeedContext,
  scenario: DemoScenarioId,
  fields: Partial<SessionRecord> & { title: string; messages: Message[] },
): SessionRecord {
  const now = tick(4000);
  const { title, messages, ...rest } = fields;
  return {
    id: rest.id ?? `demo-${scenario}-${randomUUID().slice(0, 8)}`,
    title,
    cwd: ctx.project,
    profileId: ctx.profileId,
    model: DEMO_MODEL,
    permissionMode: 'default',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    messages,
    todos: [],
    allowedTools: [],
    demo: true,
    demoScenario: scenario,
    env: {
      repoRoot: ctx.project,
      repoName: path.basename(ctx.project) || 'tandem-demo',
      branch: 'demo',
    },
    ...rest,
  };
}

function pendingPermission(
  host: Host,
  rec: SessionRecord,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): void {
  const controller = new AbortController();
  void host
    .askPermission(rec, toolName, input, toolUseId, controller.signal)
    .then(() => {
      if (rec.status === 'waiting_permission') host.setStatus(rec, 'idle');
    })
    .catch(() => undefined);
}

function seedChatTools(ctx: DemoSeedContext): DemoRefs {
  const toolId = `demo_read_${randomUUID().slice(0, 6)}`;
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'chat-tools', {
      title: '演示 · 基础对话与工具调用',
      messages: [
        user('这个演示项目是做什么的？帮我读一下 README，再总结三个要点。'),
        assistant('我先读 README.md，再给你一个简短的摘要。', {
          thinking: '用户想要项目概览。先读取仓库根目录的 README，避免凭印象回答。',
          tools: [{ name: 'Read', input: { file_path: 'README.md' }, id: toolId }],
        }),
        toolResult(toolId, '# Tandem 演示项目\n\n这是一个用于体验 Tandem 功能的小仓库。\n\n- 一个静态页面（site/index.html）\n- 一个价格计算示例（src/app.js）\n- 一些待审阅的改动\n'),
        assistant(
          'README 说明这是一个专门用来体验 Tandem 的小仓库，包含静态页面、价格计算示例和一处未提交改动。\n\n三个要点：\n1. 所有文件都在演示目录里，不会影响真实项目。\n2. 可以放心尝试工具调用、审批、改动审阅与预览。\n3. 演示数据可一键清除，也不计入真实用量。',
        ),
        user('再检查一下 src/app.js 里价格计算有没有边界问题。'),
        assistant('我读一下价格计算函数。', {
          thinking: '用户关心边界条件。读取 src/app.js 并解释 0、负数和折扣。',
          tools: [{ name: 'Read', input: { file_path: 'src/app.js' } }],
        }),
        toolResult(
          `demo_read_${randomUUID().slice(0, 6)}`,
          'export function totalPrice(items, discount = 0) {\n  const sum = items.reduce((acc, item) => acc + item.price * item.qty, 0)\n  return Math.max(0, sum * (1 - discount))\n}\n',
        ),
        assistant(
          '目前实现会在折扣后把结果夹到 0，但负数单价与超过 100% 的折扣没有校验。建议在入口处校验 `price >= 0` 与 `0 <= discount <= 1`；这正好可以作为改动审阅场景里的行评论练习。',
        ),
      ],
    }),
  );
  return { sessionIds: [rec.id] };
}

function seedPermission(ctx: DemoSeedContext): DemoRefs {
  const toolId = `demo_perm_${randomUUID().slice(0, 6)}`;
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'permission', {
      title: '演示 · 权限审批',
      messages: [
        user('检查一下演示仓库当前的改动；这条命令需要我批准。'),
        assistant('我会运行 `git status --short`。它只读，但按默认权限模式仍会弹出审批卡。', {
          thinking: '演示审批流程：Bash 工具默认需要审批，命令只作用于演示仓库。',
          tools: [
            {
              name: 'Bash',
              input: { command: 'git status --short', description: '查看演示仓库改动', timeout: 15000 },
              id: toolId,
            },
          ],
        }),
      ],
    }),
  );
  pendingPermission(ctx.host, rec, 'Bash', { command: 'git status --short', description: '查看演示仓库改动' }, toolId);
  return { sessionIds: [rec.id] };
}

function seedPlan(ctx: DemoSeedContext): DemoRefs {
  const planContent = [
    '## 演示计划：整理演示项目',
    '',
    '1. 阅读 `README.md` 与 `src/app.js`，确认价格计算入口。',
    '2. 为 `totalPrice` 增加参数校验，并补一条最小测试。',
    '3. 在 `docs/notes.md` 记录边界条件，不改真实项目。',
    '4. 跑一次演示静态页面，确认预览不报错。',
    '',
    '**影响范围**：仅 `~/.tandem/demo/project`。',
  ].join('\n');
  const plan: SessionPlan = { content: planContent, createdAt: tick(), status: 'pending', approvalMode: 'default' };
  const toolId = `demo_plan_${randomUUID().slice(0, 6)}`;
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'plan', {
      title: '演示 · 计划模式与计划卡',
      permissionMode: 'plan',
      plan,
      messages: [
        user('先不要改代码。给我一个整理价格计算与校验的最小计划。'),
        assistant('我已经把计划提交上来，请检查右侧计划卡或下方审批卡。', {
          thinking: '计划模式下只做只读调查，计划通过后才允许写操作。',
          tools: [{ name: 'ExitPlanMode', input: { plan: planContent }, id: toolId }],
        }),
      ],
    }),
  );
  pendingPermission(ctx.host, rec, 'ExitPlanMode', { plan: planContent }, toolId);
  return { sessionIds: [rec.id] };
}

function seedSubagents(ctx: DemoSeedContext): DemoRefs {
  const mainId = `demo-subagents-main-${randomUUID().slice(0, 6)}`;
  const childId = `demo-subagents-child-${randomUUID().slice(0, 6)}`;
  const grandchildId = `demo-subagents-grand-${randomUUID().slice(0, 6)}`;
  const testAgentId = `demo-subagents-test-${randomUUID().slice(0, 6)}`;
  const docsAgentId = `demo-subagents-docs-${randomUUID().slice(0, 6)}`;
  const forkId = `demo-subagents-fork-${randomUUID().slice(0, 6)}`;
  const mainTaskId = `demo_task_main_${randomUUID().slice(0, 6)}`;
  const childTaskId = `demo_task_child_${randomUUID().slice(0, 6)}`;
  const testTaskId = `demo_task_test_${randomUUID().slice(0, 6)}`;
  const docsTaskId = `demo_task_docs_${randomUUID().slice(0, 6)}`;
  const MAIN_TITLE = '演示 · 子代理层级';

  // 第 1 层子代理：3 步（任务 → 派第 2 层 → 结果），内含一个 2 步的嵌套子代理。
  const child = baseSession(ctx, 'subagents', {
    id: childId,
    title: '演示 · 子代理 · 价格页前端',
    parentId: mainId,
    parentToolUseId: mainTaskId,
    depth: 1,
    messages: [
      user('阅读 src/app.js 与 site/index.html，列出价格页可改进的三点前端问题。'),
      assistant('我会先派一个子代理查竞品文案，再汇总三点问题。', {
        tools: [
          {
            name: 'Task',
            id: childTaskId,
            input: { description: '竞品价格页文案', prompt: '总结三个竞品价格页的文案结构。' },
          },
        ],
      }),
      toolResult(
        childTaskId,
        '子代理完成：竞品价格页普遍把「随时取消」放在价格旁。',
        false,
        { id: grandchildId, model: DEMO_MODEL },
      ),
    ],
  });

  const grandchild = baseSession(ctx, 'subagents', {
    id: grandchildId,
    title: '演示 · 子代理 · 竞品文案（第 2 层）',
    parentId: childId,
    parentToolUseId: childTaskId,
    depth: 2,
    messages: [
      user('总结三个竞品价格页的文案结构。'),
      assistant('竞品普遍采用「标题 → 一句话价值 → 价格 → 次要说明 → CTA」结构；价格旁边强调「随时取消」。'),
    ],
  });

  // 第 4 轮并行派出的两个子代理，各自 2 步。
  const testAgent = baseSession(ctx, 'subagents', {
    id: testAgentId,
    title: '演示 · 子代理 · 边界测试',
    parentId: mainId,
    parentToolUseId: testTaskId,
    depth: 1,
    messages: [
      user('为 totalPrice 补 0 件、负单价、折扣 100% 三条边界测试。'),
      assistant('已补三条测试：0 件商品、负单价、折扣 100%；建议入口同时校验 price >= 0 与 0 <= discount <= 1。'),
    ],
  });
  const docsAgent = baseSession(ctx, 'subagents', {
    id: docsAgentId,
    title: '演示 · 子代理 · 文档整理',
    parentId: mainId,
    parentToolUseId: docsTaskId,
    depth: 1,
    messages: [
      user('整理价格页文档，把边界条件写进 docs/notes.md。'),
      assistant('已整理：在 docs/notes.md 增加「价格计算边界」一节，列出三条测试与参数范围。'),
    ],
  });

  const turn1 = user('我们先把价格页的体验问题过一遍，最后给我一个可执行清单。');
  const turn2 = user('先派一个子代理检查价格页前端，让它顺带查一下竞品文案。');
  const turn3 = user('参数校验具体怎么做？给我两种方案。');
  const turn4 = user('并行派两个子代理：一个补测试，一个整理文档。');
  const turn5 = user('好，先补参数校验和测试，空态与移动端间距排到下一批。');
  const turn6 = user('顺手看一下发布前还需要哪些检查。');
  const turn7 = user('把今天的结论整理成三条。');
  const turn8 = user('收到，先按这个做。');

  const main = baseSession(ctx, 'subagents', {
    id: mainId,
    title: MAIN_TITLE,
    delegation: 'orchestrate',
    messages: [
      turn1,
      assistant('好，我会先派一个子代理检查前端，再继续讨论参数校验与发布检查。'),
      turn2,
      assistant('我派一个子代理检查前端，并让它再派一层查竞品文案。', {
        thinking: '使用 Task 派发；子代理可以再派下一层子代理，但不再暴露 Task 递归。',
        tools: [
          {
            name: 'Task',
            id: mainTaskId,
            input: {
              description: '检查价格页前端',
              prompt: '阅读 src/app.js 与 site/index.html，列出价格页可改进的三点前端问题。',
            },
          },
        ],
      }),
      toolResult(
        mainTaskId,
        '子代理完成：发现价格未做参数校验、空态文案缺失、移动端按钮间距偏小。',
        false,
        { id: childId, model: DEMO_MODEL },
      ),
      assistant('子代理与嵌套子代理都回来了：参数校验、空态文案、移动端按钮间距是三个明显问题。'),
      turn3,
      assistant('方案 A 在 totalPrice 入口校验 price >= 0、0 <= discount <= 1；方案 B 在商品加入购物车时就拒绝非法单价。A 更集中，B 更早失败。'),
      turn4,
      assistant('我同时派出测试与文档两个子代理，互不依赖。', {
        tools: [
          {
            name: 'Task',
            id: testTaskId,
            input: { description: '为价格计算补边界测试', prompt: '为 totalPrice 补 0 件、负单价、折扣 100% 三条测试。' },
          },
          {
            name: 'Task',
            id: docsTaskId,
            input: { description: '整理价格页文档', prompt: '在 docs/notes.md 记录价格计算边界条件。' },
          },
        ],
      }),
      toolResult(testTaskId, '测试子代理返回：建议覆盖 0、负数、折扣 100% 三种边界。', false, {
        id: testAgentId,
        model: DEMO_MODEL,
      }),
      toolResult(docsTaskId, '文档子代理返回：把边界条件写进 docs/notes.md 的「价格计算」一节。', false, {
        id: docsAgentId,
        model: DEMO_MODEL,
      }),
      assistant('两个并行子代理都回来了：测试覆盖 0/负数/100% 折扣，文档补到 docs/notes.md。'),
      turn5,
      assistant('已确认范围：本批只做参数校验与测试，空态和间距下一批。'),
      turn6,
      assistant('发布前检查：类型检查、单测、真机空态、移动端按钮间距，以及一条可回滚的演示数据。'),
      turn7,
      assistant('1. 先补参数校验；2. 补 0/负数/100% 折扣测试；3. 空态与间距下一批。'),
      turn8,
      assistant('好的，我会按这个顺序执行，完成后把 diff 与测试结果发你。'),
    ],
  });

  // 演示分叉：从第 5 轮分出另一个会话（3 轮），会话图里画不合并的分支。
  const fork = baseSession(ctx, 'subagents', {
    id: forkId,
    title: '演示 · 分叉 · 先补参数校验',
    forkedFrom: { sessionId: mainId, messageId: turn5.id, title: MAIN_TITLE },
    messages: [
      user('先补参数校验，空态稍后再说。'),
      assistant('明白，我会先给 totalPrice 补 discount 与单价校验，再补一条边界测试；这是从第 5 轮分出的另一条路。'),
      user('测试也一起补上，先跑本地单测。'),
      assistant('已补三条边界测试并运行本地单测：0 件、负单价、折扣 100% 全部通过。'),
      user('把改动整理成可提交的说明。'),
      assistant('改动说明：totalPrice 增加参数校验，新增三条边界测试；不影响空态与移动端布局。'),
    ],
  });

  addSession(ctx.host, main);
  addSession(ctx.host, child);
  addSession(ctx.host, grandchild);
  addSession(ctx.host, testAgent);
  addSession(ctx.host, docsAgent);
  addSession(ctx.host, fork);
  return { sessionIds: [main.id, child.id, grandchild.id, fork.id, testAgent.id, docsAgent.id] };
}

async function seedBackground(ctx: DemoSeedContext): Promise<DemoRefs> {
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'background', {
      title: '演示 · 后台任务',
      messages: [user('在演示仓库里启动一个后台任务，定期打印心跳。')],
    }),
  );
  const toolId = `demo_bg_${randomUUID().slice(0, 6)}`;
  const task = await ctx.host.tasks.start({
    sessionId: rec.id,
    cwd: ctx.project,
    command: "node -e \"console.log('演示后台任务已启动'); let i=0; const t=setInterval(()=>{i++; console.log('演示后台 tick '+i); if(i>=8){console.log('演示后台任务完成'); clearInterval(t)}}, 2000)\"",
    description: '演示后台任务（本地心跳）',
  });
  rec.messages.push(
    assistant('已启动后台任务；可打开「后台任务」面板查看增量输出。它只在本机演示目录运行。', {
      tools: [
        {
          name: 'Bash',
          input: {
            command: "node -e \"console.log('演示后台任务已启动')\"",
            description: '演示后台任务（本地心跳）',
            run_in_background: true,
          },
          id: toolId,
        },
      ],
    }),
    toolResult(toolId, `已启动后台任务 ${task.id}（本地心跳）。`),
    assistant('后台任务运行中：打开后台任务面板可以查看输出、结束后记录仍在。'),
  );
  ctx.host.store.markDirty(rec.id, true);
  ctx.host.broadcastSummary(rec);
  return { sessionIds: [rec.id], taskIds: [task.id] };
}

function seedDelegation(ctx: DemoSeedContext): DemoRefs {
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'delegation', {
      title: '演示 · 委派倾向仅规划',
      delegation: 'orchestrate',
      messages: [
        user('这个改动涉及前端、测试和文档，按「编排」策略分派。'),
        assistant('当前委派倾向是「仅规划」：我会拆成三个子任务，再按依赖顺序汇总。', {
          thinking: '编排模式下允许主动派发多个子代理，主会话只做计划与汇总。',
          tools: [
            { name: 'Task', input: { description: '前端改动', prompt: '修改价格页参数校验。' } },
            { name: 'Task', input: { description: '补测试', prompt: '为 totalPrice 补三条边界测试。' } },
            { name: 'Task', input: { description: '更新文档', prompt: '在 docs/notes.md 记录边界条件。' } },
          ],
        }),
        toolResult(`demo_task_${randomUUID().slice(0, 6)}`, '三个子代理都已完成：前端、测试、文档各一项。'),
        assistant('三个子任务完成。输入框底栏的「执行方式 → 委派倾向」可以切换到「仅规划 / 积极 / 适度 / 关闭」，观察系统提示与 Task 工具可见性变化。'),
      ],
    }),
  );
  return { sessionIds: [rec.id] };
}

function seedAutoCompact(ctx: DemoSeedContext): DemoRefs {
  const summary =
    '此前对话讨论了价格计算、空态文案、移动端布局与三条测试用例；结论是先补参数校验，再补空态与按钮间距。';
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'auto-compact', {
      title: '演示 · 上下文自动压缩',
      messages: [
        message('user', [{ type: 'text', text: `[此前对话摘要]\n\n${summary}` }], { summary: true }),
        message(
          'assistant',
          [{ type: 'text', text: '已自动压缩 · 节省 38.2k tokens' }],
          {
            notice: true,
            compaction: {
              summary,
              savedTokens: 38200,
              keptTurns: 3,
              auto: true,
            },
          },
        ),
        user('继续把边界条件补到测试里。'),
        assistant('好的，我会只改演示仓库的测试文件，并在改动审阅里展示 diff。'),
      ],
      context: {
        model: DEMO_MODEL,
        contextWindow: 32_000,
        usedTokens: 30_100,
        parts: [
          { kind: 'system', tokens: 2400 },
          { kind: 'tools', tokens: 1800 },
          { kind: 'memory', tokens: 320 },
          { kind: 'messages', tokens: 21_400 },
          { kind: 'tool_results', tokens: 3200 },
          { kind: 'free', tokens: 980 },
        ],
        cacheHitRate: 0.42,
        autoCompact: { enabled: true, threshold: 0.8 },
        updatedAt: Date.now(),
      },
    }),
  );
  if (rec.context) {
    const ids = rec.messages.map((item) => item.id);
    rec.context.topItems = [
      { messageId: ids[1] ?? ids[0]!, role: 'assistant', kind: 'message', turn: 1, tokens: 18_400, preview: '已自动压缩 · 节省 38.2k tokens' },
      { messageId: ids[2] ?? ids[0]!, role: 'user', kind: 'message', turn: 1, tokens: 6_200, preview: '继续把边界条件补到测试里。' },
      { messageId: ids[3] ?? ids[0]!, role: 'assistant', kind: 'message', turn: 1, tokens: 2_100, preview: '好的，我会只改演示仓库的测试文件…' },
    ];
    rec.context.topTurns = [
      {
        turn: 1,
        messageId: ids[2] ?? ids[0]!,
        tokens: 24_800,
        preview: '继续把边界条件补到测试里。',
        items: [
          { messageId: ids[2] ?? ids[0]!, role: 'user', kind: 'message', turn: 1, tokens: 18_400, preview: '继续把边界条件补到测试里。' },
          { messageId: ids[3] ?? ids[0]!, role: 'assistant', kind: 'message', turn: 1, tokens: 6_200, preview: '好的，我会只改演示仓库的测试文件…' },
        ],
      },
    ];
    ctx.host.store.markDirty(rec.id, false);
    ctx.host.broadcastSummary(rec);
  }
  return { sessionIds: [rec.id] };
}

function seedHandoff(ctx: DemoSeedContext): DemoRefs {
  const handoff: HandoffState = {
    id: `demo-handoff-${randomUUID().slice(0, 6)}`,
    reason: 'ratelimit',
    status: 'pending',
    createdAt: tick(),
    from: {
      profileId: ctx.profileId,
      model: DEMO_MODEL,
      label: '演示模型 › 主分组（demo-model）',
    },
    target: {
      profileId: ctx.profileId,
      model: DEMO_BACKUP_MODEL,
      label: '演示模型 › 备用模型（demo-backup）',
    },
    message: '演示模型 › 主分组额度将尽（模拟 429）。继续方式：切换到备用模型，或等待额度重置。',
  };
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'handoff', {
      title: '演示 · 配额交接卡（模拟 429）',
      handoff,
      messages: [
        user('继续把价格页的空态补上。'),
        assistant('正在请求模型…（演示：这里模拟收到 429，先保存检查点，再等待你选择继续方式。）'),
      ],
    }),
  );
  const event = ctx.host.inbox.recordHandoff(handoff, '演示：额度将尽，可切换到备用模型或等待重置。', {
    id: rec.id,
    title: rec.title,
  });
  event.demo = true;
  ctx.host.pushInbox(event);
  return { sessionIds: [rec.id] };
}

function seedReview(ctx: DemoSeedContext, withReview: boolean): DemoRefs {
  const toolId = `demo_edit_${randomUUID().slice(0, 6)}`;
  const rec = addSession(
    ctx.host,
    baseSession(ctx, ctx.scenario, {
      title: withReview ? '演示 · AI 评审意见挂到 diff 行' : '演示 · 改动审阅与行评论',
      messages: [
        user(
          withReview
            ? '把价格校验补上，然后让 AI 评审看一下 diff。'
            : '给价格计算补上参数校验，我想逐行审阅。',
        ),
        assistant('我已经改了两个文件：新增 review-notes 说明，并修改 README。', {
          thinking: '改动只落在演示仓库，仍保持未提交状态，便于改动审阅。',
          tools: [
            {
              name: 'Write',
              input: { file_path: 'src/review-notes.js', content: '// 审阅演示：参数校验\n' },
              id: toolId,
            },
          ],
        }),
        toolResult(toolId, '已写入 src/review-notes.js'),
        assistant('改动已准备好。打开「改动」面板可以逐行查看 diff，选中行写评论，或提交/丢弃。'),
      ],
    }),
  );
  const reviewIds: string[] = [];
  if (withReview) {
    const run: AiReviewRun = {
      id: `demo-review-${randomUUID().slice(0, 6)}`,
      sessionId: rec.id,
      status: 'done',
      verdict: 'suggest',
      summary: '整体可提交；建议补一条 discount 上界校验，并把演示说明移到 docs。',
      findings: [
        {
          id: 'demo-finding-1',
          file: 'src/app.js',
          line: 4,
          severity: 'warn',
          title: '缺少 discount 上界校验',
          detail: '当 discount > 1 时价格会被夹到 0，看起来像免费；建议显式抛错或夹到 [0,1]。',
          suggestion: 'if (discount < 0 || discount > 1) throw new Error(...)',
        },
        {
          id: 'demo-finding-2',
          file: 'src/app.js',
          line: 1,
          severity: 'nit',
          title: '新增 import 建议保持分组',
          detail: '新增的 validateDiscount 是相对导入，放在文件顶部即可；如果之后还有外部依赖，建议按先外部后相对的顺序分组。',
        },
      ],
      ignored: 0,
      model: DEMO_MODEL,
      createdAt: tick(),
      finishedAt: tick(),
    };
    ctx.host.aiReviews.seedDemoRun(run);
    reviewIds.push(run.id);
  }
  return { sessionIds: [rec.id], reviewIds };
}

function seedBoard(ctx: DemoSeedContext): DemoRefs {
  const now = tick();
  const exec = { profileId: ctx.profileId, model: DEMO_MODEL, permissionMode: 'acceptEdits' as const, worktree: false };
  const cards: BoardCard[] = [
    {
      id: 'demo-card-foundation',
      title: '搭建设计令牌与页面骨架',
      prompt: '在演示仓库里搭建设计令牌与价格页骨架。',
      deps: [],
      status: 'done',
      order: 0,
      exec,
      attempts: 0,
      result: { summary: '完成令牌与骨架，改动 4 个文件。', files: 4, additions: 126, deletions: 8, costUsd: 0, durationMs: 96_000, mergedAt: now - 3000 },
      createdAt: now - 9000,
      updatedAt: now - 3000,
    },
    {
      id: 'demo-card-layout',
      title: '实现价格页布局',
      prompt: '基于令牌实现价格页布局，保持移动端可用。',
      deps: ['demo-card-foundation'],
      status: 'todo',
      order: 0,
      exec,
      attempts: 0,
      createdAt: now - 8000,
      updatedAt: now - 8000,
    },
    {
      id: 'demo-card-api',
      title: '接入价格接口与空态',
      prompt: '接入价格接口，补齐加载与空态。',
      deps: ['demo-card-layout'],
      status: 'todo',
      order: 1,
      exec,
      attempts: 0,
      createdAt: now - 7000,
      updatedAt: now - 7000,
    },
    {
      id: 'demo-card-approval',
      title: '待审批：更新发布说明',
      prompt: '整理 v0.2 发布说明并更新 CHANGELOG。',
      deps: [],
      status: 'approval',
      order: 0,
      exec: { ...exec, gate: true },
      attempts: 0,
      result: { summary: '发布说明已整理，等待人工确认。', files: 2, additions: 34, deletions: 2, costUsd: 0, durationMs: 54_000 },
      createdAt: now - 6000,
      updatedAt: now - 2000,
    },
    {
      id: 'demo-card-review',
      title: '待评审：登录页文案微调',
      prompt: '把登录页文案改得更简洁，并保持术语一致。',
      deps: [],
      status: 'review',
      order: 0,
      exec: { ...exec, gate: true, aiReview: true },
      attempts: 1,
      result: { summary: '文案已更新，AI 评审发现一处术语不一致。', files: 1, additions: 6, deletions: 6, costUsd: 0, durationMs: 41_000 },
      reviewNote: '请确认「登录」与「登入」统一为「登录」。',
      createdAt: now - 5000,
      updatedAt: now - 1000,
    },
    {
      id: 'demo-card-failed',
      title: '失败：升级依赖',
      prompt: '升级演示仓库的依赖并跑构建。',
      deps: [],
      status: 'failed',
      order: 0,
      exec: { ...exec, maxRetries: 1 },
      attempts: 1,
      error: '演示失败：模拟安装超时（未联网）。可以点重试，不会真正访问网络。',
      createdAt: now - 4000,
      updatedAt: now - 500,
    },
    {
      id: 'demo-card-proposal',
      title: 'AI 拆分草稿：补充测试与截图',
      prompt: '补三条价格边界测试，并为价格页截一张移动端截图。',
      deps: ['demo-card-api'],
      status: 'todo',
      order: -1,
      exec,
      attempts: 0,
      proposedBy: '演示模型 · 协调者',
      proposedByCardId: 'demo-card-foundation',
      createdAt: now - 600,
      updatedAt: now - 600,
    },
  ];
  const board: Board = {
    id: 'demo-board',
    name: '演示 · 任务看板',
    cwd: ctx.project,
    isGit: true,
    baseBranch: 'demo',
    maxParallel: 2,
    mergePolicy: 'manual',
    defaults: { ...exec, worktree: false },
    autoAcceptProposals: 0,
    cards,
    createdAt: now - 10_000,
    updatedAt: now,
  };
  ctx.host.boards.seedDemo(board);
  return { boardId: board.id };
}

function seedEvals(ctx: DemoSeedContext): DemoRefs {
  const runId = 'demo-eval-run';
  const configs = [
    { id: 'demo-config-main', name: '演示模型', profileId: ctx.profileId, model: DEMO_MODEL },
    { id: 'demo-config-backup', name: '演示备用模型', profileId: ctx.profileId, model: DEMO_BACKUP_MODEL },
  ];
  const cases = [
    { name: 'price-boundary', title: '价格边界校验', prompt: '为 totalPrice 补三条边界测试' },
    { name: 'empty-state', title: '价格页空态', prompt: '补价格页空态文案' },
    { name: 'mobile-spacing', title: '移动端按钮间距', prompt: '修复移动端按钮间距' },
  ];
  const results: EvalResult[] = [];
  for (const testCase of cases) {
    for (const [index, config] of configs.entries()) {
      const pass = !(testCase.name === 'empty-state' && index === 1);
      results.push({
        caseName: testCase.name,
        caseTitle: testCase.title,
        configId: config.id,
        configName: config.name,
        status: 'done',
        completed: true,
        passed: pass,
        turns: 2 + index,
        toolCalls: 1 + index,
        usage: { inputTokens: 2200 + index * 500, outputTokens: 320 + index * 80 },
        costUsd: 0,
        durationMs: 18_000 + index * 7000,
        finalAnswer: pass ? '已补测试并通过。' : '空态文案遗漏了移动端，检查失败。',
        ...(pass
          ? {
              check: {
                command: 'npm test -- --runInBand',
                exitCode: 0,
                ok: true,
                output: '3 passed',
                durationMs: 4200,
              },
            }
          : {
              check: {
                command: 'npm test -- --runInBand',
                exitCode: 1,
                ok: false,
                output: '1 failed: empty state text missing on mobile',
                durationMs: 4300,
              },
            }),
      });
    }
  }
  const run: EvalRun = {
    id: runId,
    suite: 'demo',
    status: 'done',
    startedAt: tick(),
    finishedAt: tick(30_000),
    configs,
    concurrency: 2,
    total: results.length,
    finished: results.length,
    results,
  };
  const evalCases: EvalCase[] = cases.map((testCase, index) => ({
    suite: 'demo',
    name: testCase.name,
    title: testCase.title,
    initialPrompt: testCase.prompt,
    snapshot: {
      mode: 'git',
      cwd: ctx.project,
      repoPath: ctx.project,
      commit: ctx.commit,
      dirty: true,
    },
    passCriteria: '检查命令退出码为 0，且回复包含修改说明。',
    checkCommand: 'npm test -- --runInBand',
    sourceSession: { id: 'demo-source', title: testCase.title },
    createdAt: tick(500 + index),
  }));
  ctx.host.evals.seedDemoRun(run, evalCases);
  return { evalRunId: runId };
}

function seedWiki(ctx: DemoSeedContext): DemoRefs {
  const session = addSession(
    ctx.host,
    baseSession(ctx, 'wiki', {
      title: '演示 · Wiki 页面',
      messages: [
        user('帮我看下项目 Wiki，重点看模块页和手写段落。'),
        assistant('项目 Wiki 已生成：概览、模块与术语表三页；右侧 Wiki 卡可以直接打开，支持全文搜索与手写补充。'),
      ],
    }),
  );
  const autoOverview = [
    '# 演示项目概览',
    '',
    '这是一个用于体验 Tandem 的静态演示仓库，入口在 `site/index.html`，价格计算在 `src/app.js`。',
    '',
    '## 如何运行',
    '',
    '```bash',
    'node -e "require(\'http\').createServer((req,res)=>res.end(\'demo\')).listen(3000)"',
    '```',
    '',
    '## 目录地图',
    '',
    '- `src/`：价格计算与工具函数',
    '- `site/`：应用预览用的静态页面',
    '- `docs/`：说明与演示笔记',
  ].join('\n');
  const autoModule = [
    '# 模块：src',
    '',
    '`src/app.js` 暴露 `totalPrice(items, discount)`，负责把条目小计相加后应用折扣。',
    '',
    '`src/utils.js` 提供金额格式化；`src/review-notes.js` 是改动审阅演示文件。',
  ].join('\n');
  const autoGlossary = [
    '# 术语表',
    '',
    '- **演示数据**：只在 `~/.tandem/demo` 下存在、可一键清除的对象。',
    '- **演示模型**：Host 内置的脚本化 provider，不发起网络请求。',
    '- **交接卡**：额度将尽时让用户选择切换分组或等待的卡片。',
  ].join('\n');
  const pages: Array<{ id: string; title: string; kind: WikiPageMeta['kind']; module?: string; files: string[]; text: string; manual?: string }> = [
    { id: 'overview', title: '演示项目概览', kind: 'overview', files: ['README.md', 'package.json'], text: autoOverview },
    { id: 'm-src', title: '模块：src', kind: 'module', module: 'src', files: ['src/app.js', 'src/utils.js', 'src/review-notes.js'], text: autoModule, manual: '手写：价格校验优先检查 discount 是否在 0–1 之间。' },
    { id: 'glossary', title: '术语表', kind: 'glossary', files: ['README.md'], text: autoGlossary },
  ];
  const store = ctx.host.wiki.store;
  const now = tick();
  const meta = {
    version: 1,
    project: ctx.project,
    name: '演示项目',
    createdAt: now - 20_000,
    updatedAt: now,
    commit: ctx.commit,
    model: DEMO_MODEL,
    profileId: ctx.profileId,
    pages: [] as WikiPageMeta[],
  };
  for (const page of pages) {
    const text = composePage(page.text, page.manual ?? '');
    store.writePageText(ctx.project, page.id, text);
    meta.pages.push({
      id: page.id,
      title: page.title,
      kind: page.kind,
      ...(page.module ? { module: page.module } : {}),
      files: page.files,
      commit: ctx.commit,
      updatedAt: now,
      chars: text.length,
    });
  }
  store.writeMeta(ctx.project, meta);
  ctx.host.hub.broadcastAll({ type: 'wiki_updated', project: ctx.project });
  return { sessionIds: [session.id] };
}

function seedPreview(ctx: DemoSeedContext): DemoRefs {
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'preview', {
      title: '演示 · 应用预览',
      messages: [
        user('打开演示项目的静态页面，切到手机尺寸看看。'),
        assistant(
          `演示静态页面已由本机回环服务托管：${ctx.previewUrl}。打开「应用预览」即可自动识别并加载；点击「选择元素」可把页面元素带回对话。`,
        ),
      ],
    }),
  );
  return { sessionIds: [rec.id] };
}

function seedInbox(ctx: DemoSeedContext, fallbackSessionId: string | undefined): DemoRefs {
  const host = ctx.host;
  const rec = fallbackSessionId ? host.store.get(fallbackSessionId) : undefined;
  const session = rec
    ? { id: rec.id, title: rec.title }
    : undefined;
  const events: InboxEvent[] = [];
  const push = (event: InboxEvent) => {
    event.demo = true;
    host.pushInbox(event);
    events.push(event);
  };
  if (session) {
    push(host.inbox.recordTurnEnd(session.id, session.title, 'done'));
  }
  push(
    host.inbox.recordBudget(
      {
        ruleId: 'demo-budget',
        scope: 'global',
        spentUsd: 8.2,
        limitUsd: 10,
        level: '80',
        period: 'day',
        action: 'warn',
      },
      '演示：今日预算已用 82%（演示数据，不计入真实用量）。',
      session,
    ),
  );
  if (session) {
    push(
      host.inbox.recordCi(session.id, session.title, {
        prNumber: 42,
        prUrl: 'https://example.invalid/tandem/demo/pull/42',
        checksState: 'failure',
        checkName: 'build',
        text: '演示：PR #42 CI 失败：build（示例链接，不会访问网络）。',
      }),
    );
  }
  push(
    host.inbox.recordEval({
      runId: 'demo-eval-run',
      suite: 'demo',
      status: 'done',
      finished: 6,
      total: 6,
      text: '演示评测完成：5/6 通过。',
    }),
  );
  push(
    host.inbox.recordBoard({
      boardId: 'demo-board',
      boardName: '演示 · 任务看板',
      cardId: 'demo-card-review',
      cardTitle: '待评审：登录页文案微调',
      event: 'review',
      text: '演示：卡片「登录页文案微调」等待评审。',
    }),
  );
  const handoff = host.store
    .list()
    .find((item) => item.demo && item.demoScenario === 'handoff')?.handoff;
  if (handoff) {
    push(host.inbox.recordHandoff(handoff, '演示：主分组额度将尽，可切换到备用模型。', session));
  }
  return {};
}

function seedResume(ctx: DemoSeedContext): DemoRefs {
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'resume', {
      title: '演示 · 断点续跑恢复提示',
      resumePaused: true,
      messages: [
        user('把三条价格测试写完，然后跑一遍。'),
        assistant('已写入两条测试，正在补第三条…（Host 在这里重启，运行被暂停）'),
      ],
    }),
  );
  rec.runState = {
    version: 1,
    startedAt: Date.now() - 120_000,
    updatedAt: Date.now() - 60_000,
    completedMessages: [],
    queue: [],
    inFlightTools: [],
    pendingPermissions: [],
    phase: 'model',
    permissionMode: 'default',
  };
  ctx.host.store.markDirty(rec.id, false);
  return { sessionIds: [rec.id] };
}

function seedHooks(ctx: DemoSeedContext): DemoRefs {
  const rec = addSession(
    ctx.host,
    baseSession(ctx, 'hooks', {
      title: '演示 · Hooks 出错提示',
      messages: [
        user('提交前跑一下 Hook 检查。'),
        assistant('演示会话已就绪。打开场景时会广播一条失败的 PreToolUse Hook，消息流里会以内联灰字显示 stderr；它不会常驻底部。'),
      ],
    }),
  );
  return { sessionIds: [rec.id] };
}

/** 按场景造数；返回需要写入演示状态的引用。 */
export async function seedDemoScenario(
  ctx: DemoSeedContext,
  fallbackSessionId?: string,
): Promise<DemoSeedRefs> {
  switch (ctx.scenario) {
    case 'chat-tools':
      return seedChatTools(ctx);
    case 'permission':
      return seedPermission(ctx);
    case 'plan':
      return seedPlan(ctx);
    case 'subagents':
      return seedSubagents(ctx);
    case 'background':
      return seedBackground(ctx);
    case 'delegation':
      return seedDelegation(ctx);
    case 'auto-compact':
      return seedAutoCompact(ctx);
    case 'handoff':
      return seedHandoff(ctx);
    case 'ai-review':
      return seedReview(ctx, true);
    case 'changes':
      return seedReview(ctx, false);
    case 'board':
      return seedBoard(ctx);
    case 'evals':
      return seedEvals(ctx);
    case 'wiki':
      return seedWiki(ctx);
    case 'preview':
      return seedPreview(ctx);
    case 'inbox':
      return seedInbox(ctx, fallbackSessionId);
    case 'resume':
      return seedResume(ctx);
    case 'hooks':
      return seedHooks(ctx);
    default:
      return {};
  }
}

export function demoFile(project: string, relative: string): string {
  return path.join(project, relative);
}

export function readDemoDiff(project: string): string {
  try {
    return readFileSync(path.join(project, 'src', 'review-notes.js'), 'utf8');
  } catch {
    return '';
  }
}

/** 演示项目初始文件（由 Manager 在创建时写入）。 */
export function demoProjectFiles(previewPort: number): Record<string, string> {
  return {
    'README.md': [
      '# Tandem 演示项目',
      '',
      '这是一个用于体验 Tandem 功能的小仓库，所有内容都在 `~/.tandem/demo/project`。',
      '',
      '- `site/index.html`：应用预览用的静态页面',
      '- `src/app.js`：价格计算示例',
      '- `docs/notes.md`：演示笔记',
      '',
      '> 演示数据，可一键清除，不会计入真实会话、记忆、用量与搜索索引。',
    ].join('\n'),
    'package.json': JSON.stringify(
      {
        name: 'tandem-demo',
        private: true,
        version: '0.0.0',
        scripts: { dev: `node tools/serve.mjs --port ${previewPort}` },
      },
      null,
      2,
    ),
    '.gitignore': 'node_modules\ndist\n.tmp\n',
    'src/app.js': [
      'export function totalPrice(items, discount = 0) {',
      '  const sum = items.reduce((acc, item) => acc + item.price * item.qty, 0)',
      '  return Math.max(0, sum * (1 - discount))',
      '}',
      '',
      'export function formatPrice(value) {',
      "  return `¥${Number(value).toFixed(2)}`",
      '}',
      '',
    ].join('\n'),
    'src/utils.js': [
      'export function clamp(value, min, max) {',
      '  return Math.min(max, Math.max(min, value))',
      '}',
      '',
    ].join('\n'),
    'docs/notes.md': [
      '# 演示笔记',
      '',
      '- 价格计算需要校验 discount 范围。',
      '- 空态与移动端间距可以一起改。',
      '',
    ].join('\n'),
    'site/index.html': [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '  <title>Tandem 演示价格页</title>',
      '  <link rel="stylesheet" href="style.css" />',
      '</head>',
      '<body>',
      '  <main class="card">',
      '    <p class="eyebrow">Tandem Demo</p>',
      '    <h1>让 agent 先跑一遍，再安心合并</h1>',
      '    <p class="lead">这是演示仓库里的静态页面，用于体验应用预览、设备尺寸与元素点选。</p>',
      '    <section class="plans">',
      '      <article><h2>基础</h2><p class="price">¥0</p><p>本地体验全部核心功能</p></article>',
      '      <article class="featured"><h2>团队</h2><p class="price">¥49</p><p>多主机、看板与共享</p></article>',
      '      <article><h2>企业</h2><p class="price">联系</p><p>内网部署与审计</p></article>',
      '    </section>',
      '    <button id="cta">开始体验</button>',
      '  </main>',
      '  <script>document.getElementById("cta")?.addEventListener("click", () => { document.querySelector(".lead").textContent = "已开始体验（演示）" })</script>',
      '</body>',
      '</html>',
    ].join('\n'),
    'site/style.css': [
      ':root { color-scheme: light; font-family: -apple-system, "PingFang SC", sans-serif; }',
      'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf9f7; color: #171410; }',
      '.card { width: min(880px, calc(100vw - 48px)); padding: 40px; border: 1px solid rgba(45,35,22,.14); border-radius: 20px; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.06); }',
      '.eyebrow { margin: 0 0 8px; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8a7f70; }',
      'h1 { margin: 0; font-size: clamp(28px, 5vw, 44px); line-height: 1.1; }',
      '.lead { color: #5c5c5c; line-height: 1.7; }',
      '.plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 28px 0; }',
      '.plans article { padding: 18px; border: 1px solid rgba(45,35,22,.14); border-radius: 14px; background: #faf9f7; }',
      '.plans .featured { border-color: #d97757; background: #fff6f1; }',
      '.plans h2 { margin: 0 0 8px; font-size: 15px; }',
      '.price { margin: 0 0 8px; font-size: 30px; font-weight: 600; }',
      '.plans p:last-child { margin: 0; color: #5c5c5c; font-size: 13px; }',
      'button { padding: 10px 18px; border: 0; border-radius: 10px; background: #171410; color: #fff; font-size: 14px; cursor: pointer; }',
      '@media (max-width: 640px) { .plans { grid-template-columns: 1fr; } .card { padding: 24px; } }',
    ].join('\n'),
  };
}

/** 演示改动：保持未提交，供改动审阅与 AI 评审场景使用。 */
export function applyDemoChanges(project: string): void {
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(
    path.join(project, 'src', 'review-notes.js'),
    [
      '// 演示：价格参数校验（未提交改动）',
      'export function validateDiscount(discount) {',
      '  if (discount < 0) return 0',
      '  return discount',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const app = demoFile(project, 'src/app.js');
  const current = readFileSync(app, 'utf8');
  if (!current.includes('validateDiscount')) {
    writeFileSync(
      app,
      current.replace(
        'export function totalPrice(items, discount = 0) {',
        "import { validateDiscount } from './review-notes.js'\n\nexport function totalPrice(items, discount = 0) {\n  discount = validateDiscount(discount)",
      ),
      'utf8',
    );
  }
}
