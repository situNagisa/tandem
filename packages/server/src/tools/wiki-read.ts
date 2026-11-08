// WikiRead：读取一页项目 Wiki（支持页面 id 或标题）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const MAX_CHARS = 40_000;

export const definition: ToolDefinition = {
  name: 'WikiRead',
  readOnly: true,
  requiresApproval: false,
  description:
    '读取本项目 Wiki 的一页（page 可传 WikiSearch 返回的 id，或页面标题）。返回自动生成段落与用户手写段落；' +
    '内容过长时截断。不要用它一次读取多页，按需逐页阅读。',
  inputSchema: {
    type: 'object',
    properties: {
      page: { type: 'string', description: '页面 id（如 overview、m-...）或页面标题。' },
    },
    required: ['page'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const wiki = ctx.wiki;
  if (!wiki) return { content: '当前环境没有启用项目 Wiki', isError: true };
  const raw = String(input.page ?? '').trim();
  if (!raw) return { content: '缺少 page 参数', isError: true };
  try {
    const meta = wiki.meta(ctx.cwd);
    if (!meta.exists) return { content: '本项目还没有 Wiki。可以先让用户在右侧栏 Wiki 卡片生成。' };
    const exact = meta.pages.find((page) => page.id === raw);
    const byTitle = exact ?? meta.pages.find((page) => page.title.toLowerCase() === raw.toLowerCase());
    const fuzzy = byTitle ?? meta.pages.find((page) => page.title.toLowerCase().includes(raw.toLowerCase()));
    if (!fuzzy) {
      return {
        content: `Wiki 页面不存在：${raw}。可用页面：${meta.pages.map((page) => `${page.title}(${page.id})`).join('、')}`,
        isError: true,
      };
    }
    const page = wiki.page(ctx.cwd, fuzzy.id);
    const body = [page.auto, page.manual ? `## 手写笔记\n${page.manual}` : '']
      .filter(Boolean)
      .join('\n\n');
    const text = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n…[已截断]` : body;
    return {
      content: `# ${page.title}${page.commit ? `（基于 commit ${page.commit}）` : ''}\n\n${text || '（空页面）'}`,
    };
  } catch (err) {
    return { content: `Wiki 读取失败: ${(err as Error).message}`, isError: true };
  }
}
