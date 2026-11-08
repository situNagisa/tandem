// WikiSearch：在本项目自动生成的 Wiki 里检索页面（复用全文索引的 tokenizer）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const KIND_LABEL: Record<string, string> = {
  overview: '概览',
  module: '模块',
  glossary: '术语',
};

export const definition: ToolDefinition = {
  name: 'WikiSearch',
  readOnly: true,
  requiresApproval: false,
  description:
    '检索本项目的项目 Wiki（自动生成的架构文档）。遇到「某模块做什么」「改 X 去哪里」「项目怎么运行」这类架构问题，' +
    '先用它查页面，再用 WikiRead 读取命中页面，不要一次读入整个 Wiki。query 为空时列出全部页面。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（中文/英文均可，支持多词）。留空列出全部页面。' },
      limit: { type: 'number', description: '最多返回几条（默认 8）。' },
    },
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const wiki = ctx.wiki;
  if (!wiki) return { content: '当前环境没有启用项目 Wiki', isError: true };
  const query = String(input.query ?? '').trim();
  const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.min(20, Number(input.limit))) : 8;
  try {
    if (!query) {
      const meta = wiki.meta(ctx.cwd);
      if (!meta.exists) {
        return { content: '本项目还没有 Wiki。可以在右侧栏 Wiki 卡片里点「生成 Wiki」。' };
      }
      const lines = meta.pages.map(
        (page) => `- ${page.title}（${KIND_LABEL[page.kind] ?? page.kind}，id=${page.id}${page.commit ? `，基于 ${page.commit}` : ''}）`,
      );
      return { content: [`本项目 Wiki 共 ${meta.pages.length} 页${meta.commit ? `，基于 commit ${meta.commit}` : ''}：`, ...lines].join('\n') };
    }
    const result = wiki.search(ctx.cwd, query, limit);
    if (result.hits.length === 0) {
      return { content: `Wiki 中没有找到「${query}」。可用 WikiSearch 空 query 查看全部页面，或直接 Glob/Grep 代码。` };
    }
    const lines = result.hits.map(
      (hit, index) =>
        `${index + 1}. ${hit.title}（${KIND_LABEL[hit.kind] ?? hit.kind}，id=${hit.pageId}）\n   ${hit.snippet}`,
    );
    return {
      content: [`Wiki 命中 ${result.total} 页，显示前 ${result.hits.length} 页：`, ...lines, '', '用 WikiRead {page:"<id>"} 读取完整页面。'].join('\n'),
    };
  } catch (err) {
    return { content: `Wiki 检索失败: ${(err as Error).message}`, isError: true };
  }
}
