// 浏览器操作工具：在 Host 本机打开页面、读取可访问性快照、点击/输入、截图与 console。
// 授权：navigate 新域名需审批（allow_always 按域名记）；click/type 属于写类操作。
import type { BrowserUnavailableError } from '../browser.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

function manager(ctx: ToolContext) {
  if (!ctx.browser) throw new Error('浏览器管理器不可用');
  return ctx.browser;
}

function failure(err: unknown): ToolResult {
  const error = err as BrowserUnavailableError;
  return {
    content: error.hint ? `${error.message}\n\n${error.hint}` : (error.message ?? String(err)),
    isError: true,
  };
}

export const navigateDefinition: ToolDefinition = {
  name: 'browser_navigate',
  readOnly: false,
  requiresApproval: true,
  description:
    'Open a URL in the browser running on the Host, so you can reproduce UI bugs and inspect local pages. ' +
    'Only localhost/127.0.0.1/[::1] and file:// are reachable by default; other hosts must be allowlisted by the user in Settings → Browser. ' +
    'Entering a new domain asks the user for approval. After navigating, call browser_snapshot to get element refs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL, e.g. http://localhost:5173 or file:///tmp/demo/index.html' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export async function runNavigate(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) return { content: 'url 不能为空', isError: true };
  try {
    const browser = manager(ctx);
    const result = await browser.navigate(ctx.session.id, url);
    const state = await browser.publish(ctx.session.id, { capture: true });
    return {
      content:
        `已打开：${result.url}\n标题：${result.title || '(无标题)'}` +
        (result.status ? `\nHTTP 状态：${result.status}` : '') +
        (state.screenshotId ? `\n截图：${state.screenshotId}` : '') +
        '\n\n需要操作页面时，请调用 browser_snapshot 获取元素 ref。',
    };
  } catch (err) {
    await manager(ctx).publish(ctx.session.id, { capture: false, error: (err as Error).message }).catch(() => undefined);
    return failure(err);
  }
}

export const snapshotDefinition: ToolDefinition = {
  name: 'browser_snapshot',
  readOnly: true,
  requiresApproval: false,
  description:
    'Return a compact accessibility-style snapshot of the current page with element refs (e.g. [ref=e3]). ' +
    'Pass those refs to browser_click / browser_type. Re-run after the page changes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runSnapshot(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const browser = manager(ctx);
    const snapshot = await browser.snapshot(ctx.session.id);
    await browser.publish(ctx.session.id, { capture: true });
    return { content: snapshot.text };
  } catch (err) {
    return failure(err);
  }
}

export const clickDefinition: ToolDefinition = {
  name: 'browser_click',
  readOnly: false,
  requiresApproval: true,
  description: 'Click an element on the current page by its ref from browser_snapshot.',
  inputSchema: {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. e3' } },
    required: ['ref'],
    additionalProperties: false,
  },
};

export async function runClick(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : String(input.ref ?? '');
  try {
    const browser = manager(ctx);
    const result = await browser.click(ctx.session.id, ref);
    await browser.publish(ctx.session.id, { capture: true });
    return {
      content: `已点击 "${result.label}"（${result.role}）。\n当前页面：${result.url}\n标题：${result.title || '(无标题)'}`,
    };
  } catch (err) {
    return failure(err);
  }
}

export const typeDefinition: ToolDefinition = {
  name: 'browser_type',
  readOnly: false,
  requiresApproval: true,
  description:
    'Type text into an input/textarea by its ref from browser_snapshot. Set submit=true to press Enter afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. e5' },
      text: { type: 'string', description: 'Text to type' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
    },
    required: ['ref', 'text'],
    additionalProperties: false,
  },
};

export async function runType(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : String(input.ref ?? '');
  const text = typeof input.text === 'string' ? input.text : String(input.text ?? '');
  const submit = input.submit === true;
  try {
    const browser = manager(ctx);
    const result = await browser.type(ctx.session.id, ref, text, submit);
    await browser.publish(ctx.session.id, { capture: true });
    const shown = result.password ? '（密码框，内容已隐藏）' : `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`;
    return {
      content: `已在 "${result.label}" 输入${shown}${result.submitted ? '，并按下 Enter 提交' : ''}。\n当前页面：${result.url}`,
    };
  } catch (err) {
    return failure(err);
  }
}

export const screenshotDefinition: ToolDefinition = {
  name: 'browser_screenshot',
  readOnly: true,
  requiresApproval: false,
  description:
    'Take a screenshot of the current page and return it as an image block. ' +
    'Use fullPage=true for the entire scrollable page. The latest screenshot is also shown in the client browser panel.',
  inputSchema: {
    type: 'object',
    properties: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false)' } },
    additionalProperties: false,
  },
};

export async function runScreenshot(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const browser = manager(ctx);
    const shot = await browser.screenshot(ctx.session.id, input.fullPage === true);
    await browser.publish(ctx.session.id, { capture: false, screenshotId: shot.id });
    return {
      content:
        `截图 screenshotId=${shot.id}（${shot.width}×${shot.height}）\n页面：${shot.url}\n标题：${shot.title || '(无标题)'}`,
      images: [
        {
          type: 'image',
          mediaType: 'image/jpeg',
          dataBase64: shot.data.toString('base64'),
        },
      ],
    };
  } catch (err) {
    return failure(err);
  }
}

export const consoleDefinition: ToolDefinition = {
  name: 'browser_console',
  readOnly: true,
  requiresApproval: false,
  description: 'Return the recent console output and page errors from the current page (including blocked requests).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runConsole(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const browser = manager(ctx);
    const text = await browser.consoleLog(ctx.session.id);
    await browser.publish(ctx.session.id, { capture: true });
    return { content: text };
  } catch (err) {
    return failure(err);
  }
}

export const closeDefinition: ToolDefinition = {
  name: 'browser_close',
  readOnly: true,
  requiresApproval: false,
  description: 'Close the browser context for this session. It also closes automatically after 10 minutes idle.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runClose(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    await manager(ctx).closeSession(ctx.session.id);
    return { content: '已关闭本会话的浏览器。' };
  } catch (err) {
    return failure(err);
  }
}
