// Host 核心：会话生命周期、agent 调度、权限审批、命令处理。
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ContentBlock,
  HostInfo,
  ListModelsInput,
  Message,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  Session,
  SessionStatus,
  SessionSummary,
  SlashCommand,
  Todo,
} from '@tandem/protocol';
import { ProfileStore, loadHostConfig, providerDefaultBaseUrl, tandemHome } from './config.js';
import { Hub } from './events.js';
import { SessionStore } from './store.js';
import type { HostConfig, SessionRecord, SessionRuntime, StoredProfile } from './types.js';
import { runTurn } from './agent/loop.js';
import {
  BUILTIN_NAMES,
  INIT_PROMPT,
  findCommandBody,
  listCommands,
  parseSlashCommand,
  type ParsedCommand,
} from './agent/commands.js';
import { PLAN_ALLOWED, TOOL_MAP, describeTool } from './tools/index.js';
import { completeText, listModels as fetchModelList, streamChat } from './providers/index.js';
import type { ListModelsResult } from './providers/index.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { errorMessage } from './util/text.js';
import { detectSessionEnv } from './util/git.js';
import { expandHome } from './util/path.js';

const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

interface PermissionEntry {
  sessionId: string;
  resolve: (decision: PermissionDecision) => void;
}

export class Host {
  readonly config: HostConfig;
  readonly home: string;
  readonly profiles: ProfileStore;
  readonly store: SessionStore;
  readonly hub = new Hub();
  readonly version: string;
  private runtimes = new Map<string, SessionRuntime>();
  private permissions = new Map<string, PermissionEntry>();

  constructor(config?: HostConfig, home = tandemHome()) {
    this.home = home;
    this.config = config ?? loadHostConfig(home);
    this.profiles = new ProfileStore(home);
    this.store = new SessionStore(home);
    this.version = readVersion();
  }

  info(): HostInfo {
    return {
      id: this.config.hostId,
      name: os.hostname(),
      platform: process.platform,
      version: this.version,
      homeDir: os.homedir(),
    };
  }

  // ---------- 会话读取/转换 ----------

  getSession(id: string): SessionRecord | undefined {
    return this.store.get(id);
  }

  listSessions(): SessionRecord[] {
    return this.store.list();
  }

  toSummary(rec: SessionRecord): SessionSummary {
    return {
      id: rec.id,
      title: rec.title,
      cwd: rec.cwd,
      profileId: rec.profileId,
      model: rec.model,
      permissionMode: rec.permissionMode,
      status: rec.status,
      // 可选字段只在有值时下发，老客户端不受影响
      ...(rec.pinned ? { pinned: true } : {}),
      ...(rec.archived ? { archived: true } : {}),
      ...(rec.env ? { env: { ...rec.env } } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      usage: { ...rec.usage },
    };
  }

  /** 检测 cwd 的 git 环境；变化时广播 session_updated。 */
  async refreshEnv(id: string): Promise<void> {
    const rec = this.store.get(id);
    if (!rec) return;
    const env = await detectSessionEnv(rec.cwd);
    const before = JSON.stringify(rec.env ?? null);
    const after = JSON.stringify(env ?? null);
    if (before === after) return;
    if (env) rec.env = env;
    else delete rec.env;
    this.store.markDirty(rec.id, false);
    this.broadcastSummary(rec);
  }

  /** 拉取模型列表：apiKey 缺省时用 profileId 对应账号已存的 key。 */
  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    const profile = input.profileId ? this.profiles.get(input.profileId) : undefined;
    return fetchModelList(input, profile);
  }

  toSession(rec: SessionRecord): Session {
    return {
      ...this.toSummary(rec),
      messages: rec.messages,
      todos: rec.todos,
    };
  }

  snapshot(id: string): { session: Session; pendingPermissions: PermissionRequest[] } | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;
    const rt = this.runtimes.get(id);
    return {
      session: this.toSession(rec),
      pendingPermissions: rt ? [...rt.pending.values()].map((p) => p.request) : [],
    };
  }

  broadcastSummary(rec: SessionRecord): void {
    this.hub.broadcastAll({ type: 'session_updated', session: this.toSummary(rec) });
  }

  setStatus(rec: SessionRecord, status: SessionStatus): void {
    if (rec.status === status) return;
    rec.status = status;
    this.broadcastSummary(rec);
  }

  // ---------- 会话 CRUD ----------

  createSession(input: {
    cwd?: unknown;
    profileId?: unknown;
    model?: unknown;
    permissionMode?: unknown;
    title?: unknown;
  }): SessionRecord {
    const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!rawCwd) throw new Error('cwd 不能为空');
    const cwd = path.resolve(expandHome(rawCwd));
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      throw new Error(`工作目录不存在: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);

    const profileId = typeof input.profileId === 'string' ? input.profileId : '';
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error('账号不存在，请先创建账号');
    const model =
      (typeof input.model === 'string' && input.model.trim()) || profile.defaultModel || profile.models[0] || '';
    if (!model) throw new Error('该账号没有可用模型');

    const permissionMode = PERMISSION_MODES.has(input.permissionMode as PermissionMode)
      ? (input.permissionMode as PermissionMode)
      : 'default';
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '新会话',
      cwd,
      profileId,
      model,
      permissionMode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      todos: [],
      allowedTools: [],
    };
    this.store.add(rec);
    this.broadcastSummary(rec);
    return rec;
  }

  updateSession(
    id: string,
    patch: {
      title?: unknown;
      profileId?: unknown;
      model?: unknown;
      permissionMode?: unknown;
      pinned?: unknown;
      archived?: unknown;
    },
  ): SessionRecord | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;

    if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim();
    if (typeof patch.permissionMode === 'string') {
      if (!PERMISSION_MODES.has(patch.permissionMode as PermissionMode)) {
        throw new Error(`无效的 permissionMode: ${patch.permissionMode}`);
      }
      rec.permissionMode = patch.permissionMode as PermissionMode;
    }
    if (typeof patch.profileId === 'string' && patch.profileId !== rec.profileId) {
      const profile = this.profiles.get(patch.profileId);
      if (!profile) throw new Error('账号不存在');
      rec.profileId = profile.id;
      // 换账号时默认切换到该账号的默认模型
      if (typeof patch.model !== 'string' || !patch.model.trim()) {
        rec.model = profile.defaultModel || profile.models[0] || rec.model;
      }
    }
    if (typeof patch.model === 'string' && patch.model.trim()) rec.model = patch.model.trim();
    if (typeof patch.pinned === 'boolean') {
      if (patch.pinned) rec.pinned = true;
      else delete rec.pinned;
    }
    if (typeof patch.archived === 'boolean') {
      if (patch.archived) rec.archived = true;
      else delete rec.archived;
    }

    this.store.markDirty(rec.id, true);
    this.broadcastSummary(rec);
    return rec;
  }

  /** 复制会话（消息、todos、配置）为新会话，历史与原会话互不影响。 */
  forkSession(id: string): SessionRecord | undefined {
    const src = this.store.get(id);
    if (!src) return undefined;
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: `${src.title || '新会话'}（副本）`,
      cwd: src.cwd,
      profileId: src.profileId,
      model: src.model,
      permissionMode: src.permissionMode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { ...src.usage },
      messages: structuredClone(src.messages),
      todos: structuredClone(src.todos),
      allowedTools: [...src.allowedTools],
      ...(src.env ? { env: { ...src.env } } : {}),
    };
    this.store.add(rec);
    this.broadcastSummary(rec);
    return rec;
  }

  deleteSession(id: string): boolean {
    const rec = this.store.get(id);
    if (!rec) return false;
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.deleted = true;
      rt.interrupted = true;
      rt.queue = [];
      rt.abort?.abort();
      for (const pending of [...rt.pending.values()]) pending.resolve('deny');
      this.runtimes.delete(id);
    }
    this.store.delete(id);
    this.hub.dropSession(id);
    this.hub.broadcastAll({ type: 'session_deleted', sessionId: id });
    return true;
  }

  get pendingCount(): number {
    return this.permissions.size;
  }

  // ---------- 运行时 ----------

  ensureRuntime(id: string): SessionRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        running: false,
        interrupted: false,
        draining: false,
        queue: [],
        pending: new Map(),
        deleted: false,
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  // ---------- 消息入口 ----------

  async send(sessionId: string, content: ContentBlock[]): Promise<void> {
    const rec = this.store.get(sessionId);
    if (!rec) throw new Error('会话不存在');
    const rt = this.ensureRuntime(sessionId);
    if (rt.deleted) return;
    const blocks = Array.isArray(content) ? content.filter(isContentBlock) : [];
    if (blocks.length === 0) throw new Error('消息不能为空');
    // 运行中发送：排队，等本轮（含工具循环）结束后执行
    if (rt.running || rt.draining) {
      rt.queue.push(blocks);
      return;
    }
    await this.handleUserContent(rec, blocks);
  }

  private async handleUserContent(rec: SessionRecord, content: ContentBlock[]): Promise<void> {
    const first = content[0];
    if (content.length === 1 && first?.type === 'text' && first.text.trim().startsWith('/')) {
      const cmd = parseSlashCommand(first.text);
      // 只把已知命令当命令；以 / 开头的普通路径仍按普通消息处理
      if (cmd && (BUILTIN_NAMES.has(cmd.name) || findCommandBody(cmd.name, rec.cwd) !== undefined)) {
        if (await this.handleCommand(rec, cmd)) return;
      }
    }
    await this.sendToModel(rec, content);
  }

  private async sendToModel(rec: SessionRecord, content: ContentBlock[]): Promise<void> {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    // 首条用户消息且标题仍是默认值时，先截取正文做兜底标题，再异步让模型生成更短的标题
    const isFirstUserMessage = !rec.messages.some((m) => m.role === 'user');
    const needsTitle = (!rec.title || rec.title === '新会话') && !!text;
    if (needsTitle) rec.title = text.slice(0, 30);
    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    rec.messages.push(message);
    this.hub.broadcastSession(rec.id, {
      type: 'message_start',
      sessionId: rec.id,
      message,
    });
    this.hub.broadcastSession(rec.id, {
      type: 'message_end',
      sessionId: rec.id,
      message,
    });
    this.store.markDirty(rec.id, true);
    this.broadcastSummary(rec);
    if (needsTitle && isFirstUserMessage) void this.autoTitle(rec, text, rec.title);
    await runTurn(this, rec);
  }

  /**
   * 用当前模型异步生成 ≤20 字的会话标题。失败或用户已改名时保留兜底标题。
   * baseTitle 是发起请求时的标题，用于判断期间是否被用户手动改过。
   */
  private async autoTitle(rec: SessionRecord, firstText: string, baseTitle: string): Promise<void> {
    const profile = this.profiles.get(rec.profileId);
    const model = rec.model || profile?.defaultModel || '';
    if (!profile?.apiKey || !model) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const raw = await completeText({
        profile,
        model,
        system: '你是会话标题生成器。只输出标题本身，不要解释、不要引号、不要标点。',
        prompt:
          '请为下面这段用户的首条消息生成一个简短的中文标题，不超过 20 个字，概括用户真正想做的事：\n\n' +
          firstText.slice(0, 2000),
        maxTokens: 64,
        signal: controller.signal,
      });
      const title = cleanTitle(raw);
      if (!title || rec.title !== baseTitle) return;
      rec.title = title;
      this.store.markDirty(rec.id, false);
      this.broadcastSummary(rec);
    } catch {
      // 生成失败不打扰用户，保留截取正文的兜底标题
    } finally {
      clearTimeout(timer);
    }
  }

  /** 排队消息在本轮结束后依次执行。 */
  async drainQueue(sessionId: string): Promise<void> {
    const rec = this.store.get(sessionId);
    if (!rec) return;
    const rt = this.ensureRuntime(sessionId);
    if (rt.running || rt.draining || rt.deleted) return;
    rt.draining = true;
    try {
      while (rt.queue.length > 0 && !rt.deleted) {
        const next = rt.queue.shift()!;
        await this.handleUserContent(rec, next);
      }
    } finally {
      rt.draining = false;
    }
  }

  interrupt(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.queue = [];
    if (!rt.running) return;
    rt.interrupted = true;
    rt.abort?.abort();
    // 拒绝所有待审批请求，让工具循环尽快退出
    for (const pending of [...rt.pending.values()]) pending.resolve('deny');
  }

  updateTodos(rec: SessionRecord, todos: Todo[]): void {
    rec.todos = todos;
    this.store.markDirty(rec.id, true);
    this.hub.broadcastSession(rec.id, {
      type: 'todos',
      sessionId: rec.id,
      todos,
    });
    this.broadcastSummary(rec);
  }

  // ---------- 权限 ----------

  async authorize(
    rec: SessionRecord,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const def = TOOL_MAP.get(toolName);
    const mode = rec.permissionMode;

    // plan 模式：只允许只读工具，写类工具直接拒绝
    if (mode === 'plan' && !PLAN_ALLOWED.has(toolName)) {
      return { allowed: false, reason: `plan 模式下不允许执行 ${toolName}（只允许只读工具）` };
    }
    if (!def) return { allowed: true }; // 交给执行器返回“未知工具”

    // 只读且无需审批的工具直接放行
    if (def.readOnly && !def.requiresApproval) return { allowed: true };
    if (mode === 'bypassPermissions') return { allowed: true };
    if (this.isAllowed(rec, toolName, input)) return { allowed: true };
    if (mode === 'acceptEdits' && (toolName === 'Write' || toolName === 'Edit')) {
      return { allowed: true };
    }
    if (!def.requiresApproval) return { allowed: true };
    if (signal.aborted) return { allowed: false, reason: '用户中断' };

    return this.askPermission(rec, toolName, input, toolUseId, signal);
  }

  private isAllowed(rec: SessionRecord, toolName: string, input: unknown): boolean {
    const command =
      toolName === 'Bash' && input && typeof input === 'object'
        ? String((input as Record<string, unknown>).command ?? '').replace(/\s+/g, ' ').trim()
        : '';
    for (const entry of rec.allowedTools) {
      if (entry === toolName) return true;
      if (toolName === 'Bash' && entry.startsWith('Bash:')) {
        const prefix = entry.slice('Bash:'.length);
        if (prefix && command.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  private askPermission(
    rec: SessionRecord,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const rt = this.ensureRuntime(rec.id);
    const request: PermissionRequest = {
      id: randomUUID(),
      sessionId: rec.id,
      toolUseId,
      toolName,
      input,
      description: describeTool(toolName, input),
    };

    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision: PermissionDecision) => {
        if (settled) return;
        settled = true;
        this.permissions.delete(request.id);
        rt.pending.delete(request.id);
        signal.removeEventListener('abort', onAbort);

        if (decision === 'allow_always') this.addAllowed(rec, toolName, input);
        this.hub.broadcastSession(rec.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
        if (rt.pending.size === 0 && rt.running && !rt.interrupted && rec.status === 'waiting_permission') {
          this.setStatus(rec, 'running');
        }
        resolve({
          allowed: decision !== 'deny',
          reason:
            decision === 'deny' ? (signal.aborted ? '用户中断' : '用户拒绝了该操作') : undefined,
        });
      };
      const onAbort = () => settle('deny');

      rt.pending.set(request.id, { request, resolve: settle });
      this.permissions.set(request.id, { sessionId: rec.id, resolve: settle });
      signal.addEventListener('abort', onAbort, { once: true });

      this.setStatus(rec, 'waiting_permission');
      this.hub.broadcastSession(rec.id, { type: 'permission_request', request });
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') return;
    this.permissions.get(requestId)?.resolve(decision);
  }

  private addAllowed(rec: SessionRecord, toolName: string, input: unknown): void {
    let entry = toolName;
    if (toolName === 'Bash' && input && typeof input === 'object') {
      const command = String((input as Record<string, unknown>).command ?? '');
      entry = `Bash:${commandPrefix(command)}`;
    }
    if (!rec.allowedTools.includes(entry)) {
      rec.allowedTools.push(entry);
      this.store.markDirty(rec.id, true);
    }
  }

  // ---------- 斜杠命令 ----------

  listCommands(cwd: string): SlashCommand[] {
    return listCommands(cwd);
  }

  private async handleCommand(rec: SessionRecord, cmd: ParsedCommand): Promise<boolean> {
    switch (cmd.name) {
      case 'clear': {
        rec.messages = [];
        this.store.markDirty(rec.id, true);
        this.setStatus(rec, 'idle');
        this.broadcastSummary(rec);
        this.broadcastSnapshot(rec);
        return true;
      }
      case 'compact': {
        await this.compactSession(rec);
        return true;
      }
      case 'model': {
        const profile = this.profiles.get(rec.profileId);
        const models = profile?.models ?? [];
        if (cmd.args) {
          rec.model = cmd.args.split(/\s+/)[0]!;
          this.store.markDirty(rec.id, true);
          this.broadcastSummary(rec);
          this.appendLocalAssistant(
            rec,
            `已切换模型为 ${rec.model}（下一轮生效）。${models.length ? `\n可选模型: ${models.join(', ')}` : ''}`,
          );
        } else {
          this.appendLocalAssistant(
            rec,
            [
              `当前模型: ${rec.model}`,
              models.length ? `可选模型: ${models.join(', ')}` : '该账号未列出模型',
              '切换方式: /model <模型名>，或在界面上选择（下一轮生效）。',
            ].join('\n'),
          );
        }
        return true;
      }
      case 'init': {
        this.titleFromCommand(rec, cmd);
        await this.sendToModel(rec, [{ type: 'text', text: INIT_PROMPT }]);
        return true;
      }
      case 'help': {
        const commands = this.listCommands(rec.cwd);
        const lines = commands.map((c) => `/${c.name} - ${c.description}（${labelOfSource(c.source)}）`);
        this.appendLocalAssistant(rec, `可用命令:\n${lines.join('\n')}`);
        return true;
      }
      default:
        break;
    }

    // 自定义命令：cwd/.claude/commands 或 ~/.claude/commands 下的 md
    const body = findCommandBody(cmd.name, rec.cwd);
    if (body !== undefined) {
      this.titleFromCommand(rec, cmd);
      const expanded = body.replace(/\$ARGUMENTS/g, cmd.args);
      await this.sendToModel(rec, [{ type: 'text', text: expanded }]);
      return true;
    }

    this.appendLocalAssistant(
      rec,
      `未知命令 /${cmd.name}。输入 /help 查看可用命令。`,
    );
    return true;
  }

  /** 命令展开后，用命令本身作为新会话标题，避免标题变成整段提示词。 */
  private titleFromCommand(rec: SessionRecord, cmd: ParsedCommand): void {
    if (rec.title && rec.title !== '新会话') return;
    const title = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`.replace(/\s+/g, ' ').trim();
    rec.title = title.slice(0, 40);
  }

  private appendLocalAssistant(rec: SessionRecord, text: string): void {
    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text }],
      createdAt: Date.now(),
    };
    rec.messages.push(message);
    this.hub.broadcastSession(rec.id, {
      type: 'message_start',
      sessionId: rec.id,
      message,
    });
    this.hub.broadcastSession(rec.id, {
      type: 'message_end',
      sessionId: rec.id,
      message,
    });
    this.store.markDirty(rec.id, true);
    this.setStatus(rec, 'idle');
    this.broadcastSummary(rec);
  }

  private broadcastSnapshot(rec: SessionRecord): void {
    const rt = this.runtimes.get(rec.id);
    this.hub.broadcastSession(rec.id, {
      type: 'session_snapshot',
      session: this.toSession(rec),
      pendingPermissions: rt ? [...rt.pending.values()].map((p) => p.request) : [],
    });
  }

  /** /compact：让模型总结历史并替换为一条摘要消息。 */
  private async compactSession(rec: SessionRecord): Promise<void> {
    const rt = this.ensureRuntime(rec.id);
    if (rt.running) return;
    rt.running = true;
    rt.interrupted = false;
    const abort = new AbortController();
    rt.abort = abort;
    let failed: string | undefined;

    try {
      this.setStatus(rec, 'running');
      const profile = this.profiles.get(rec.profileId);
      if (!profile?.apiKey) throw new Error('当前账号未配置 API Key');
      const model = rec.model || profile.defaultModel;
      if (!model) throw new Error('当前账号没有配置模型');
      if (rec.messages.length === 0) {
        this.appendLocalAssistant(rec, '当前没有可压缩的对话。');
        return;
      }

      const instruction: Message = {
        id: randomUUID(),
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '请把上面的对话压缩成一份可供后续继续工作的摘要。保留：用户目标、已完成的改动、' +
              '关键文件路径与命令、重要决定、未完成事项。不要调用工具，直接输出摘要正文。',
          },
        ],
        createdAt: Date.now(),
      };
      const blocks: ContentBlock[] = [];
      const result = await streamChat({
        profile,
        model,
        system: buildSystemPrompt(rec.cwd),
        messages: [...rec.messages, instruction],
        tools: [],
        blocks,
        signal: abort.signal,
        maxTokens: 4096,
        onBlockStart: () => {},
        onText: () => {},
        onToolInput: () => {},
      });
      const summary = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!summary) throw new Error('模型没有返回摘要内容');

      rec.messages = [
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `[此前对话摘要]\n\n${summary}` }],
          createdAt: Date.now(),
        },
      ];
      rec.usage.inputTokens += result.usage.inputTokens || 0;
      rec.usage.outputTokens += result.usage.outputTokens || 0;
      this.store.markDirty(rec.id, true);
      this.broadcastSummary(rec);
      this.broadcastSnapshot(rec);
    } catch (err) {
      failed = abort.signal.aborted ? '用户中断' : errorMessage(err);
    } finally {
      rt.running = false;
      rt.abort = undefined;
      this.setStatus(rec, failed && failed !== '用户中断' ? 'error' : 'idle');
      this.store.markDirty(rec.id, true);
      this.hub.broadcastSession(rec.id, {
        type: 'turn_end',
        sessionId: rec.id,
        reason: failed ? (failed === '用户中断' ? 'interrupted' : 'error') : 'done',
        ...(failed && failed !== '用户中断' ? { error: failed } : {}),
      });
      if (failed) {
        this.hub.broadcastSession(rec.id, { type: 'error', message: failed });
      }
      this.broadcastSummary(rec);
      void this.drainQueue(rec.id);
      void this.refreshEnv(rec.id);
    }
  }
}

function labelOfSource(source: SlashCommand['source']): string {
  if (source === 'builtin') return '内置';
  if (source === 'project') return '项目';
  return '用户';
}

/** 清理模型返回的标题：取首行、去引号/前缀，限制 20 字。 */
function cleanTitle(raw: string): string {
  let title = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  title = title
    .replace(/^标题\s*[:：]\s*/, '')
    .replace(/^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/g, '')
    .replace(/[。！？!?，,、；;：:]+$/g, '')
    .trim();
  return [...title].slice(0, 20).join('').trim();
}

function commandPrefix(command: string): string {
  const firstLine = command.split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!firstLine) return '';
  const tokens = firstLine.split(' ');
  const prefixTokens = [tokens[0]!];
  if (tokens[1] && !tokens[1].startsWith('-')) prefixTokens.push(tokens[1]);
  return prefixTokens.join(' ');
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'thinking' ||
    type === 'image' ||
    type === 'tool_use' ||
    type === 'tool_result'
  );
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/** 供 server 路由复用。 */
export function defaultBaseUrlFor(kind: StoredProfile['kind']): string {
  return providerDefaultBaseUrl(kind);
}

export type { ParsedCommand };
