// MCP：~/.tandem/mcp.json 可读写；只读合并 ~/.claude.json 与会话 cwd 下的 .mcp.json。
// 使用官方 SDK 连接 stdio / Streamable HTTP 服务器，工具注入为 mcp__<server>__<tool>。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpServerStatus } from '@tandem/protocol';
import type { ToolDefinition, ToolResult } from './types.js';
import { errorMessage } from './util/text.js';

const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_COOLDOWN_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Connection {
  config: McpServerConfig;
  client: Client;
  status: McpServerStatus['status'];
  error?: string;
  tools: McpTool[];
  lastAttempt: number;
  connecting?: Promise<void>;
}

export class McpManager {
  private file: string;
  private own: McpServerConfig[] = [];
  private connections = new Map<string, Connection>();
  /** 合并配置缓存：避免每次工具调用都重新读取可能很大的 ~/.claude.json。 */
  private cache = new Map<string, { at: number; list: McpServerConfig[] }>();

  constructor(home: string) {
    this.file = path.join(home, 'mcp.json');
    this.own = loadOwnConfigs(this.file);
  }

  /** Host 启动时调用：异步连接已启用服务器，失败只记录状态。 */
  start(): void {
    void this.prepare(undefined, true);
  }

  /** 返回合并后的服务器配置（Host 自身 + Claude 只读 + 项目 .mcp.json）。 */
  servers(cwd?: string): McpServerConfig[] {
    const key = cwd ?? '';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3000) return hit.list;
    const list = mergeConfigs(this.own, cwd);
    this.cache.set(key, { at: Date.now(), list });
    return list;
  }

  /** 状态列表；只读来源原样带上 source。 */
  status(cwd?: string): McpServerStatus[] {
    return this.servers(cwd).map((config) => {
      if (!config.enabled) {
        return { name: config.name, status: 'disabled', tools: [], source: config.source };
      }
      const conn = this.connections.get(config.name);
      if (conn && sameConfig(conn.config, config)) {
        return {
          name: config.name,
          status: conn.status,
          ...(conn.error ? { error: conn.error } : {}),
          tools: conn.tools.map((t) => t.name),
          source: config.source,
        };
      }
      return { name: config.name, status: 'connecting', tools: [], source: config.source };
    });
  }

  /** 按需连接：为当前会话补充项目级 MCP，并重试失败的服务器（有冷却时间）。 */
  async prepare(cwd: string | undefined, force = false): Promise<void> {
    const configs = this.servers(cwd);
    const jobs: Promise<void>[] = [];
    for (const config of configs) {
      if (!config.enabled) {
        await this.disconnect(config.name);
        continue;
      }
      const conn = this.connections.get(config.name);
      if (conn && sameConfig(conn.config, config)) {
        if (conn.status === 'connected' || conn.connecting) continue;
        if (conn.status === 'error' && !force && Date.now() - conn.lastAttempt < RETRY_COOLDOWN_MS) {
          continue;
        }
      } else if (conn) {
        await this.disconnect(config.name);
      }
      jobs.push(this.connect(config));
    }
    if (jobs.length > 0) await Promise.allSettled(jobs);
  }

  /** 当前已连接服务器提供的工具（按 cwd 合并配置过滤）。 */
  toolDefinitions(cwd?: string): ToolDefinition[] {
    const allowed = new Set(this.servers(cwd).filter((c) => c.enabled).map((c) => c.name));
    const defs: ToolDefinition[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.status !== 'connected' || !allowed.has(name)) continue;
      for (const tool of conn.tools) {
        defs.push({
          name: `mcp__${name}__${tool.name}`,
          description: tool.description || `MCP 工具 ${name}/${tool.name}`,
          inputSchema: tool.inputSchema,
          readOnly: false,
          requiresApproval: true,
          mcp: { server: name, tool: tool.name },
        });
      }
    }
    return defs;
  }

  /** 在已缓存的连接工具里查找（即使连接已断开，也保留元数据用于路由）。 */
  findTool(name: string): ToolDefinition | undefined {
    for (const [server, conn] of this.connections) {
      for (const tool of conn.tools) {
        if (`mcp__${server}__${tool.name}` !== name) continue;
        return {
          name,
          description: tool.description || `MCP 工具 ${server}/${tool.name}`,
          inputSchema: tool.inputSchema,
          readOnly: false,
          requiresApproval: true,
          mcp: { server, tool: tool.name },
        };
      }
    }
    return undefined;
  }

  /** 调用 MCP 工具；断线时先重连一次。 */
  async callTool(
    server: string,
    tool: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    let conn = this.connections.get(server);
    if (conn?.connecting) await conn.connecting;
    if (!conn || conn.status !== 'connected') {
      // 优先沿用连接自身的配置（可能是项目级 MCP，全局列表里没有）
      const config = conn?.config ?? this.servers().find((c) => c.name === server);
      if (!config || !config.enabled) return { content: `MCP 服务器未启用: ${server}`, isError: true };
      if (conn) await this.disconnect(server);
      await this.connect(config);
      conn = this.connections.get(server);
    }
    if (!conn || conn.status !== 'connected') {
      return { content: `MCP 服务器 ${server} 未连接: ${conn?.error ?? '未知错误'}`, isError: true };
    }

    try {
      const result = await conn.client.callTool(
        { name: tool, arguments: asArguments(input) },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS },
      );
      return convertResult(result);
    } catch (err) {
      const message = errorMessage(err);
      conn.status = 'error';
      conn.error = message;
      return { content: `MCP 工具调用失败 (${server}/${tool}): ${message}`, isError: true };
    }
  }

  /** 整体替换 Host 自身的配置并写盘；只读来源不受影响。 */
  async save(input: unknown): Promise<McpServerConfig[]> {
    const list = normalizeOwnList(input);
    this.own = list;
    this.cache.clear();
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers: list }, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);

    // 关闭被删除/修改/禁用的连接，并连接新增的启用服务器
    const names = new Set(list.map((c) => c.name));
    for (const name of [...this.connections.keys()]) {
      const next = list.find((c) => c.name === name);
      const conn = this.connections.get(name);
      if (!next || !next.enabled || (conn && !sameConfig(conn.config, next))) {
        await this.disconnect(name);
      }
    }
    for (const config of list) {
      if (config.enabled && !this.connections.has(config.name)) {
        void this.connect(config);
      }
    }
    return this.servers();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  private async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      // ignore
    }
  }

  private connect(config: McpServerConfig): Promise<void> {
    const existing = this.connections.get(config.name);
    if (existing?.connecting) return existing.connecting;
    const client = new Client({ name: 'tandem-host', version: '0.1.0' }, { capabilities: {} });
    const conn: Connection = {
      config,
      client,
      status: 'connecting',
      tools: [],
      lastAttempt: Date.now(),
    };
    this.connections.set(config.name, conn);
    const task = (async () => {
      try {
        const transport = createTransport(config);
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const listed = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: CONNECT_TIMEOUT_MS,
          });
          for (const tool of listed.tools) {
            tools.push({
              name: tool.name,
              description: tool.description,
              inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            });
          }
          cursor = listed.nextCursor;
          if (!cursor) break;
        }
        // 连接期间配置可能已被替换/删除
        if (this.connections.get(config.name) !== conn) {
          await client.close().catch(() => {});
          return;
        }
        conn.tools = tools;
        conn.status = 'connected';
        conn.error = undefined;
      } catch (err) {
        conn.status = 'error';
        conn.error = errorMessage(err);
        await client.close().catch(() => {});
      } finally {
        conn.connecting = undefined;
      }
    })();
    conn.connecting = task;
    return task;
  }
}

function asArguments(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function createTransport(config: McpServerConfig) {
  if (config.transport === 'http') {
    if (!config.url) throw new Error('HTTP MCP 服务器缺少 url');
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }
  if (!config.command) throw new Error('stdio MCP 服务器缺少 command');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, config.env ?? {});
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env,
    stderr: 'pipe',
  });
}

/** MCP 工具结果 → 文本 + 图片块。 */
function convertResult(result: Awaited<ReturnType<Client['callTool']>>): ToolResult {
  const texts: string[] = [];
  const images: NonNullable<ToolResult['images']> = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'text':
        texts.push(item.text);
        break;
      case 'image':
        images.push({
          type: 'image',
          mediaType: item.mimeType,
          dataBase64: item.data,
        });
        break;
      case 'audio':
        texts.push(`[音频内容 ${item.mimeType}，已省略]`);
        break;
      case 'resource': {
        const resource = item.resource;
        if (resource && 'text' in resource && typeof resource.text === 'string') {
          texts.push(resource.text);
        } else if (resource && 'blob' in resource && typeof resource.blob === 'string') {
          const mime = resource.mimeType ?? '';
          if (mime.startsWith('image/')) {
            images.push({ type: 'image', mediaType: mime, dataBase64: resource.blob });
          } else {
            texts.push(`[资源 ${resource.uri} (${mime})，二进制内容已省略]`);
          }
        } else {
          texts.push(`[资源 ${(resource as { uri?: string })?.uri ?? '未知'}]`);
        }
        break;
      }
      case 'resource_link':
        texts.push(`[资源链接 ${item.name ?? ''}: ${item.uri}]`);
        break;
      default:
        texts.push(JSON.stringify(item));
        break;
    }
  }
  if (texts.length === 0 && result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return {
    content: texts.join('\n') || '(无输出)',
    ...(result.isError ? { isError: true } : {}),
    ...(images.length ? { images } : {}),
  };
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.name === b.name &&
    a.transport === b.transport &&
    JSON.stringify(a.command ?? '') === JSON.stringify(b.command ?? '') &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {}) &&
    (a.url ?? '') === (b.url ?? '') &&
    JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {})
  );
}

function loadOwnConfigs(file: string): McpServerConfig[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return normalizeOwnList(raw);
  } catch (err) {
    console.warn(`[tandem] 无法解析 MCP 配置 ${file}:`, (err as Error).message);
    return [];
  }
}

function normalizeOwnList(input: unknown): McpServerConfig[] {
  const raw = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { servers?: unknown }).servers)
      ? (input as { servers: unknown[] }).servers
      : [];
  const seen = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const item of raw) {
    const config = normalizeConfig(item);
    if (!config || seen.has(config.name)) continue;
    seen.add(config.name);
    // PUT 只管理 Host 自身的配置，来源固定为 tandem
    out.push({ ...config, source: 'tandem' });
  }
  return out;
}

/** 把外部（Claude / 项目）配置统一成协议结构；无法识别的条目丢弃。 */
function normalizeConfig(input: unknown): McpServerConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return undefined;
  const type = typeof raw.transport === 'string' ? raw.transport : typeof raw.type === 'string' ? raw.type : '';
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const transport: McpServerConfig['transport'] =
    type === 'http' || type === 'sse' || type === 'streamable-http' ? 'http' : url && !command ? 'http' : 'stdio';
  if (transport === 'http' && !url) return undefined;
  if (transport === 'stdio' && !command) return undefined;
  const args = Array.isArray(raw.args)
    ? raw.args.map((a) => String(a))
    : [];
  const env = stringRecord(raw.env);
  const headers = stringRecord(raw.headers);
  return {
    name,
    transport,
    ...(transport === 'stdio' ? { command, args } : { url }),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    enabled: raw.enabled !== false,
    source: raw.source === 'claude' || raw.source === 'project' ? raw.source : 'tandem',
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 合并配置：tandem 优先，其次 ~/.claude.json，最后项目 .mcp.json。 */
function mergeConfigs(own: McpServerConfig[], cwd?: string): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  const add = (config: McpServerConfig | undefined) => {
    if (!config || seen.has(config.name)) return;
    seen.add(config.name);
    out.push(config);
  };
  for (const config of own) add({ ...config, source: 'tandem' });
  for (const config of readClaudeConfigs(cwd)) add(config);
  if (cwd) for (const config of readProjectConfigs(cwd)) add(config);
  return out;
}

/** 只读 ~/.claude.json：顶层 mcpServers + 与 cwd 匹配的 projects[].mcpServers。 */
function readClaudeConfigs(cwd?: string): McpServerConfig[] {
  const file = path.join(os.homedir(), '.claude.json');
  if (!existsSync(file)) return [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: McpServerConfig[] = [];
  const addMap = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
      const config = normalizeConfig({ ...(raw as Record<string, unknown>), name, source: 'claude' });
      if (config) out.push({ ...config, source: 'claude' });
    }
  };
  addMap(data.mcpServers);
  if (cwd) {
    const projects = data.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      const target = path.resolve(cwd);
      for (const [dir, value] of Object.entries(projects as Record<string, unknown>)) {
        if (path.resolve(dir) !== target) continue;
        if (value && typeof value === 'object') addMap((value as Record<string, unknown>).mcpServers);
      }
    }
  }
  return out;
}

/** 只读会话 cwd 下的 .mcp.json。 */
function readProjectConfigs(cwd: string): McpServerConfig[] {
  const file = path.join(cwd, '.mcp.json');
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown };
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
      return [];
    }
    const out: McpServerConfig[] = [];
    for (const [name, raw] of Object.entries(data.mcpServers as Record<string, unknown>)) {
      const config = normalizeConfig({ ...(raw as Record<string, unknown>), name, source: 'project' });
      if (config) out.push({ ...config, source: 'project' });
    }
    return out;
  } catch (err) {
    console.warn(`[tandem] 无法解析 ${file}:`, (err as Error).message);
    return [];
  }
}
