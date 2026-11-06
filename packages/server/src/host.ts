// Host 核心：会话生命周期、agent 调度、权限审批、命令处理。
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Checkpoint,
  ContentBlock,
  HookEntry,
  HookEvent,
  HostInfo,
  ListModelsInput,
  Message,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RewindInput,
  Session,
  SessionStatus,
  SessionSummary,
  SlashCommand,
  Todo,
} from '@tandem/protocol';
import {
  ProfileStore,
  effectiveProfile,
  loadHostConfig,
  providerDefaultBaseUrl,
  tandemHome,
} from './config.js';
import { CheckpointStore } from './checkpoints.js';
import { ExternalSessionStore } from './external.js';
import { Hub } from './events.js';
import {
  HookManager,
  runHookEntries,
  type HookExecutionContext,
  type HookRunResult,
} from './hooks.js';
import { McpManager } from './mcp.js';
import { PermissionRuleStore } from './permissions.js';
import { SessionStore } from './store.js';
import type { HostConfig, SessionRecord, SessionRuntime, StoredProfile, ToolDefinition, ToolResult } from './types.js';
import { UsageStore, costOf, priceForModel } from './usage.js';
import {
  checkoutBranch,
  createWorktree,
  gitRepoRoot,
  listBranches,
  mergeWorktree,
  removeWorktree,
  worktreeCleanliness,
} from './worktree.js';
import { runTurn } from './agent/loop.js';
import {
  BUILTIN_NAMES,
  INIT_PROMPT,
  findCommandBody,
  listCommands,
  parseSlashCommand,
  type ParsedCommand,
} from './agent/commands.js';
import { PLAN_ALLOWED, TOOLS, TOOL_MAP, describeTool } from './tools/index.js';
import { completeText, listModels as fetchModelList, streamChat } from './providers/index.js';
import type { ListModelsResult } from './providers/index.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { errorMessage } from './util/text.js';
import { detectSessionEnv } from './util/git.js';
import { expandHome, isSubPath, resolvePath } from './util/path.js';

const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

interface PermissionEntry {
  sessionId: string;
  resolve: (decision: PermissionDecision, reason?: string) => void;
}

export class Host {
  readonly config: HostConfig;
  readonly home: string;
  readonly profiles: ProfileStore;
  readonly store: SessionStore;
  /** 外部会话（Claude Code / Codex）扫描缓存，只读。 */
  readonly external = new ExternalSessionStore(this);
  readonly checkpoints: CheckpointStore;
  readonly permissionRules: PermissionRuleStore;
  readonly hooks: HookManager;
  readonly mcp: McpManager;
  readonly usage: UsageStore;
  readonly hub = new Hub();
  readonly version: string;
  private runtimes = new Map<string, SessionRuntime>();
  private permissions = new Map<string, PermissionEntry>();

  constructor(config?: HostConfig, home = tandemHome()) {
    this.home = home;
    this.config = config ?? loadHostConfig(home);
    this.profiles = new ProfileStore(home);
    this.store = new SessionStore(home);
    this.checkpoints = new CheckpointStore(home);
    this.permissionRules = new PermissionRuleStore(home);
    this.hooks = new HookManager(home);
    this.mcp = new McpManager(home);
    this.usage = new UsageStore(home);
    this.version = readVersion();
    // 启动时连接已启用的 MCP 服务器；失败只记录状态，不影响 Host 启动
    this.mcp.start();
    // 外部会话目录有变化时通知客户端刷新侧栏（30s 定时扫描）
    this.external.startWatching(() => this.notifyExternalSessionsChanged());
  }

  /** 外部会话列表可能变化（文件更新 / 导入状态变化），广播给所有客户端。 */
  notifyExternalSessionsChanged(): void {
    this.hub.broadcastAll({ type: 'external_sessions_changed' });
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
      ...(rec.groupId ? { groupId: rec.groupId } : {}),
      model: rec.model,
      permissionMode: rec.permissionMode,
      status: rec.status,
      ...(rec.effort ? { effort: rec.effort } : {}),
      // 可选字段只在有值时下发，老客户端不受影响
      ...(rec.pinned ? { pinned: true } : {}),
      ...(rec.archived ? { archived: true } : {}),
      ...(rec.env ? { env: { ...rec.env } } : {}),
      ...(rec.parentId ? { parentId: rec.parentId } : {}),
      ...(rec.worktree ? { worktree: { ...rec.worktree } } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      usage: { ...rec.usage },
    };
  }

  /** 检测 cwd 的 git 环境；变化时广播 session_updated。 */
  async refreshEnv(id: string): Promise<void> {
    const rec = this.store.get(id);
    if (!rec) return;
    // worktree 内跑 git 会把 worktree 目录当成仓库根，项目名变成分支目录名。
    // 统一用原仓库根 + worktree 分支，保证侧栏/顶栏与主仓库一致。
    const env =
      rec.worktree && rec.worktreeRepoRoot
        ? {
            repoRoot: rec.worktreeRepoRoot,
            repoName: path.basename(rec.worktreeRepoRoot),
            branch: rec.worktree.branch,
          }
        : await detectSessionEnv(rec.cwd);
    const before = JSON.stringify(rec.env ?? null);
    const after = JSON.stringify(env ?? null);
    if (before === after) return;
    if (env) rec.env = env;
    else delete rec.env;
    this.store.markDirty(rec.id, false);
    this.broadcastSummary(rec);
  }

  /** 取会话运行时的有效账号：account + 分组（key/baseUrl/模型按分组覆盖）。 */
  profileFor(profileId: string, groupId?: string): StoredProfile | undefined {
    const profile = this.profiles.get(profileId);
    return profile ? effectiveProfile(profile, groupId) : undefined;
  }

  /** 拉取模型列表：apiKey/baseUrl 缺省时用账号（或分组）已存的值。 */
  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    const profile = input.profileId
      ? this.profileFor(input.profileId, input.groupId)
      : undefined;
    return fetchModelList(input, profile);
  }

  /** 本轮可用的工具：内置工具（子代理不含 Task）+ 当前 cwd 已连接的 MCP 工具。 */
  toolDefinitions(rec: SessionRecord, allowTask = true): ToolDefinition[] {
    const base = TOOLS.filter(
      (tool) =>
        (allowTask || tool.name !== 'Task') &&
        // 仅计划模式暴露 ExitPlanMode，其它模式下不打扰模型
        (tool.name !== 'ExitPlanMode' || rec.permissionMode === 'plan'),
    );
    return [...base, ...this.mcp.toolDefinitions(rec.cwd)];
  }

  /** 按名称找工具定义（含动态 MCP 工具），供权限判定/调用路由使用。 */
  toolDefinition(name: string, cwd: string): ToolDefinition | undefined {
    return (
      TOOL_MAP.get(name) ??
      this.mcp.toolDefinitions(cwd).find((tool) => tool.name === name) ??
      this.mcp.findTool(name)
    );
  }

  /** 把 worktree 分支合回基准分支。 */
  async mergeSessionWorktree(
    id: string,
    strategy: 'merge' | 'squash',
  ): Promise<{ ok: boolean; error?: string }> {
    const rec = this.store.get(id);
    if (!rec) throw httpError('会话不存在', 404);
    if (!rec.worktree) return { ok: false, error: '该会话不是 worktree 会话' };
    if (this.isRunning(id)) return { ok: false, error: '会话正在运行，无法合并' };
    const repoRoot = rec.worktreeRepoRoot ?? (await gitRepoRoot(rec.worktree.path));
    if (!repoRoot) return { ok: false, error: '找不到 worktree 所属的原仓库' };
    const result = await mergeWorktree(
      repoRoot,
      rec.worktree.baseBranch,
      rec.worktree.branch,
      strategy,
    );
    if (result.ok) void this.refreshEnv(id);
    return result;
  }

  /** 会话中途切换工作目录、分支或进入 worktree。 */
  async sessionBranches(id: string): Promise<{ current?: string; branches: string[] }> {
    const rec = this.store.get(id);
    if (!rec) throw httpError('会话不存在', 404);
    return listBranches(rec.cwd);
  }

  async checkoutSessionBranch(id: string, branch: string, create: boolean): Promise<SessionRecord> {
    const rec = this.store.get(id);
    if (!rec) throw httpError('会话不存在', 404);
    if (this.isRunning(id)) throw httpError('会话正在运行，无法切换分支', 409);
    await checkoutBranch(rec.cwd, branch, create);
    await this.refreshEnv(id);
    return rec;
  }

  async enterSessionWorktree(id: string, branch?: string): Promise<SessionRecord> {
    const rec = this.store.get(id);
    if (!rec) throw httpError('会话不存在', 404);
    if (this.isRunning(id)) throw httpError('会话正在运行，无法创建 worktree', 409);
    if (rec.worktree) throw new Error('该会话已在 worktree 中');
    const info = await createWorktree(this.home, rec.cwd, branch, randomUUID().slice(0, 8));
    rec.cwd = info.path;
    rec.worktree = { path: info.path, branch: info.branch, baseBranch: info.baseBranch };
    rec.worktreeRepoRoot = info.repoRoot;
    rec.env = {
      repoRoot: info.repoRoot,
      repoName: path.basename(info.repoRoot),
      branch: info.branch,
    };
    this.store.markDirty(rec.id, false);
    this.broadcastSummary(rec);
    return rec;
  }

  /** 跨 Host 迁移：复制完整会话为新 id，可指定目标 Host 上的 cwd。 */
  async importSession(input: { session?: unknown; cwd?: unknown }): Promise<SessionRecord> {
    const source = input.session as Session | undefined;
    if (!source || typeof source !== 'object' || !Array.isArray(source.messages)) {
      throw new Error('session 无效');
    }
    const rawCwd =
      typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : source.cwd;
    if (!rawCwd) throw new Error('cwd 不能为空');
    const profiles = this.profiles.list();
    const profile = this.profiles.get(source.profileId) ?? profiles[0];
    if (!profile) throw new Error('目标 Host 还没有账号，请先创建账号');
    const groupId =
      profile.id === source.profileId &&
      source.groupId &&
      profile.groups?.some((g) => g.id === source.groupId)
        ? source.groupId
        : undefined;
    const rec = await this.createSession({
      cwd: rawCwd,
      profileId: profile.id,
      title: source.title || '导入的会话',
      permissionMode: source.permissionMode,
      ...(groupId ? { groupId } : {}),
      ...(profile.id === source.profileId && source.model ? { model: source.model } : {}),
    });
    rec.messages = structuredClone(source.messages);
    rec.todos = Array.isArray(source.todos) ? structuredClone(source.todos) : [];
    if (source.plan) rec.plan = structuredClone(source.plan);
    if (source.usage) rec.usage = { ...source.usage };
    if (source.effort) rec.effort = source.effort;
    this.store.markDirty(rec.id, false);
    this.broadcastSummary(rec);
    return rec;
  }

  toSession(rec: SessionRecord): Session {
    return {
      ...this.toSummary(rec),
      messages: rec.messages,
      todos: rec.todos,
      ...(rec.plan ? { plan: { ...rec.plan } } : {}),
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

  async createSession(input: {
    cwd?: unknown;
    profileId?: unknown;
    groupId?: unknown;
    model?: unknown;
    permissionMode?: unknown;
    title?: unknown;
    worktree?: unknown;
  }): Promise<SessionRecord> {
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
    const groupId =
      typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : undefined;
    if (groupId && !profile.groups?.some((g) => g.id === groupId)) throw new Error('分组不存在');
    const effective = effectiveProfile(profile, groupId);
    const model =
      (typeof input.model === 'string' && input.model.trim()) ||
      effective.defaultModel ||
      effective.models[0] ||
      '';
    if (!model) throw new Error('该账号没有可用模型');

    const permissionMode = PERMISSION_MODES.has(input.permissionMode as PermissionMode)
      ? (input.permissionMode as PermissionMode)
      : 'default';

    // worktree 会话：先创建 worktree，会话 cwd 指向新目录
    const shortId = randomUUID().slice(0, 8);
    let sessionCwd = cwd;
    let worktree: SessionRecord['worktree'];
    let worktreeRepoRoot: string | undefined;
    if (input.worktree && typeof input.worktree === 'object') {
      const branch = (input.worktree as { branch?: unknown }).branch;
      const info = await createWorktree(
        this.home,
        cwd,
        typeof branch === 'string' ? branch : undefined,
        shortId,
      );
      sessionCwd = info.path;
      worktree = { path: info.path, branch: info.branch, baseBranch: info.baseBranch };
      worktreeRepoRoot = info.repoRoot;
    }

    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '新会话',
      cwd: sessionCwd,
      profileId,
      ...(groupId ? { groupId } : {}),
      model,
      permissionMode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      todos: [],
      allowedTools: [],
      ...(worktree ? { worktree } : {}),
      ...(worktreeRepoRoot ? { worktreeRepoRoot } : {}),
      ...(worktree && worktreeRepoRoot
        ? {
            env: {
              repoRoot: worktreeRepoRoot,
              repoName: path.basename(worktreeRepoRoot),
              branch: worktree.branch,
            },
          }
        : {}),
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
      groupId?: unknown;
      model?: unknown;
      permissionMode?: unknown;
      pinned?: unknown;
      archived?: unknown;
      effort?: unknown;
      cwd?: unknown;
    },
  ): SessionRecord | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;

    if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim();
    if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
      if (this.isRunning(id)) throw httpError('会话正在运行，无法切换目录', 409);
      const cwd = path.resolve(expandHome(patch.cwd.trim()));
      let stat;
      try {
        stat = statSync(cwd);
      } catch {
        throw new Error(`工作目录不存在: ${cwd}`);
      }
      if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);
      if (cwd !== rec.cwd) {
        rec.cwd = cwd;
        // 换目录后旧的 worktree 元数据不再适用，重新检测环境
        delete rec.worktree;
        delete rec.worktreeRepoRoot;
        delete rec.env;
      }
    }
    if (typeof patch.effort === 'string') {
      const effort = patch.effort as SessionSummary['effort'];
      if (!['off', 'low', 'medium', 'high', 'max'].includes(effort ?? '')) {
        throw new Error(`无效的 effort: ${patch.effort}`);
      }
      rec.effort = effort;
    }
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
      // 换账号时分组不再适用，默认切到该账号的默认模型
      delete rec.groupId;
      if (typeof patch.model !== 'string' || !patch.model.trim()) {
        rec.model = profile.defaultModel || profile.models[0] || rec.model;
      }
    }
    if (typeof patch.groupId === 'string') {
      const groupId = patch.groupId.trim();
      if (groupId) {
        const profile = this.profiles.get(rec.profileId);
        const group = profile?.groups?.find((g) => g.id === groupId);
        if (!group) throw new Error('分组不存在');
        rec.groupId = groupId;
        // 切换分组时若没显式指定模型，用该分组的默认模型
        if (typeof patch.model !== 'string' || !patch.model.trim()) {
          rec.model = group.defaultModel || group.models[0] || rec.model;
        }
      } else {
        delete rec.groupId;
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
      ...(src.groupId ? { groupId: src.groupId } : {}),
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
      ...(src.plan ? { plan: structuredClone(src.plan) } : {}),
    };
    this.store.add(rec);
    this.broadcastSummary(rec);
    return rec;
  }

  /**
   * 删除会话。worktree 会话有未提交改动时拒绝（409），force=true 时强制删除目录与分支。
   */
  async deleteSession(id: string, force = false): Promise<boolean> {
    const rec = this.store.get(id);
    if (!rec) return false;
    if (rec.worktree && !force) {
      const status = await worktreeCleanliness(rec.worktree.path);
      if (status.dirty) {
        throw httpError(
          `worktree 有未提交改动，未删除。确认丢弃后可带 ?force=1 重试`,
          409,
        );
      }
    }
    // 先级联中断正在运行的子代理
    this.interrupt(id);
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
    // 删除导入的会话后，原外部会话应重新出现在侧栏
    if (rec.importedFrom) this.notifyExternalSessionsChanged();
    if (rec.worktree) {
      await removeWorktree(
        rec.worktreeRepoRoot ?? (await gitRepoRoot(rec.cwd)) ?? '',
        rec.worktree.path,
        rec.worktree.branch,
        force,
      ).catch((err) => {
        console.warn(`[tandem] 清理 worktree 失败:`, errorMessage(err));
      });
    }
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
    const rt = this.ensureRuntime(rec.id);

    // UserPromptSubmit：可阻止消息，stdout/JSON 作为下一轮系统提示的附加上下文
    if (text) {
      const hookResult = await this.runHooks(rec, this.hooks.entriesForRun(rec.cwd), 'UserPromptSubmit', {
        prompt: text,
      });
      if (hookResult.blocked) {
        this.appendLocalAssistant(
          rec,
          `用户消息被 Hook 阻止：\n${hookResult.feedback.join('\n') || '（Hook 没有给出原因）'}`,
        );
        return;
      }
      if (hookResult.contexts.length > 0) {
        rt.pendingHookContext = hookResult.contexts.join('\n\n');
      }
    }

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
    // 每轮开始创建检查点：本轮 Write/Edit 执行前把原文件快照进去
    rt.checkpoint = this.checkpoints.create(rec.id, message.id);
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
    await runTurn(this, rec);
    if (needsTitle && isFirstUserMessage) void this.autoTitle(rec, text, rec.title);
  }

  /**
   * 用当前模型异步生成 ≤20 字的会话标题。失败或用户已改名时保留兜底标题。
   * baseTitle 是发起请求时的标题，用于判断期间是否被用户手动改过。
   */
  private async autoTitle(rec: SessionRecord, firstText: string, baseTitle: string): Promise<void> {
    const profile = this.profileFor(rec.profileId, rec.groupId);
    const model = rec.model || profile?.defaultModel || '';
    if (!profile?.apiKey || !model) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const raw = await completeText({
        profile,
        model,
        system: '你是会话标题生成器。只输出标题本身，不要解释、不要引号、不要标点。',
        prompt:
          '请为下面这段用户的首条消息生成一个简短的中文标题，不超过 20 个字，概括用户真正想做的事：\n\n' +
          firstText.slice(0, 2000),
        maxTokens: 200,
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
    // 先级联中断子代理会话，再中断主会话
    for (const child of this.store.list()) {
      if (child.parentId !== sessionId) continue;
      const childRt = this.runtimes.get(child.id);
      if (childRt?.running) this.interrupt(child.id);
    }
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.queue = [];
    if (!rt.running) return;
    rt.interrupted = true;
    rt.abort?.abort();
    // 拒绝所有待审批请求，让工具循环尽快退出
    for (const pending of [...rt.pending.values()]) pending.resolve('deny');
  }

  /** Task 工具：创建子会话并运行完整 agent 循环；最后一条 assistant 文本作为结果。 */
  async runSubagent(
    parent: SessionRecord,
    input: { description: string; prompt: string; subagentType?: string },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) return { content: '用户中断', isError: true };
    const now = Date.now();
    const sub: SessionRecord = {
      id: randomUUID(),
      title: input.description.slice(0, 120) || '子代理',
      cwd: parent.cwd,
      profileId: parent.profileId,
      ...(parent.groupId ? { groupId: parent.groupId } : {}),
      model: parent.model,
      permissionMode: parent.permissionMode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      todos: [],
      allowedTools: [...parent.allowedTools],
      parentId: parent.id,
    };
    this.store.add(sub);
    this.broadcastSummary(sub);

    const promptMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: input.prompt }],
      createdAt: Date.now(),
    };
    sub.messages.push(promptMessage);
    const subRt = this.ensureRuntime(sub.id);
    subRt.checkpoint = this.checkpoints.create(sub.id, promptMessage.id);
    this.hub.broadcastSession(sub.id, {
      type: 'message_start',
      sessionId: sub.id,
      message: promptMessage,
    });
    this.hub.broadcastSession(sub.id, {
      type: 'message_end',
      sessionId: sub.id,
      message: promptMessage,
    });
    this.store.markDirty(sub.id, true);
    this.broadcastSummary(sub);

    // 主会话中断时级联中断子会话
    const onAbort = () => this.interrupt(sub.id);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) this.interrupt(sub.id);
    try {
      const result = await runTurn(this, sub, { allowTask: false });
      if (result.lastText) return { content: result.lastText };
      if (result.reason === 'error') {
        return { content: `子代理执行失败: ${result.error ?? '未知错误'}`, isError: true };
      }
      if (result.reason === 'interrupted') return { content: '子代理已被中断', isError: true };
      return { content: '（子代理没有返回文本）' };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
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

  // ---------- 检查点 ----------

  /** Write/Edit 执行前调用：把文件当前内容（或“不存在”）存进本轮检查点。 */
  snapshotForCheckpoint(rec: SessionRecord, rawPath: string): void {
    const rt = this.runtimes.get(rec.id);
    const checkpoint = rt?.checkpoint;
    if (!checkpoint) return;
    const abs = resolvePath(rec.cwd, rawPath);
    // cwd 之外的文件不纳入检查点，避免回退时误改仓库外内容
    if (!isSubPath(rec.cwd, abs)) return;
    this.checkpoints.snapshotFile(checkpoint, rec.cwd, abs);
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    return this.checkpoints.list(sessionId);
  }

  /** 会话是否正在执行（运行中不允许回退）。 */
  isRunning(sessionId: string): boolean {
    const rt = this.runtimes.get(sessionId);
    return !!rt && (rt.running || rt.draining);
  }

  /**
   * 回退到某个检查点：restoreFiles 按时间倒序恢复（最早快照最终生效），
   * restoreConversation 把对话截断到触发该检查点的用户消息之前。
   */
  rewind(sessionId: string, input: RewindInput): Session | undefined {
    const rec = this.store.get(sessionId);
    if (!rec) return undefined;
    if (this.isRunning(sessionId)) throw httpError('会话正在运行，无法回退', 409);
    if (!input || typeof input.checkpointId !== 'string' || !input.checkpointId) {
      throw httpError('checkpointId 不能为空', 400);
    }

    const list = this.checkpoints.list(sessionId);
    const target = list.find((cp) => cp.id === input.checkpointId);
    if (!target) throw httpError('检查点不存在', 404);

    if (input.restoreFiles) {
      // 从最新检查点往最早恢复，同一文件最终落到最早的那份快照
      const ordered = [...list].sort((a, b) => b.createdAt - a.createdAt);
      for (const cp of ordered) {
        if (cp.createdAt < target.createdAt && cp.id !== target.id) continue;
        for (const file of cp.files) this.checkpoints.restoreFile(cp, rec.cwd, file);
      }
    }
    if (input.restoreConversation) {
      const index = rec.messages.findIndex((m) => m.id === target.messageId);
      if (index >= 0) rec.messages = rec.messages.slice(0, index);
    }

    // 被回退的检查点不再有效
    this.checkpoints.removeFrom(sessionId, target.id);
    const rt = this.runtimes.get(sessionId);
    if (rt) delete rt.checkpoint;
    this.store.markDirty(sessionId, true);
    this.setStatus(rec, 'idle');
    // 旧事件不再适用于回退后的状态，清空缓冲让客户端以快照为准
    this.hub.resetSession(sessionId);
    this.broadcastSummary(rec);
    this.broadcastSnapshot(rec);
    return this.toSession(rec);
  }

  // ---------- Hooks ----------

  /** 执行一组已加载的 hooks，并把每条执行记录广播给客户端。 */
  async runHooks(
    rec: SessionRecord,
    entries: HookEntry[],
    event: HookEvent,
    context: Omit<HookExecutionContext, 'sessionId' | 'cwd' | 'permissionMode'>,
  ): Promise<HookRunResult> {
    return runHookEntries(
      entries,
      event,
      { sessionId: rec.id, cwd: rec.cwd, permissionMode: rec.permissionMode, ...context },
      (outcome) => {
        this.hub.broadcastSession(rec.id, {
          type: 'hook_event',
          sessionId: rec.id,
          event,
          name: outcome.name,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          ...(outcome.blocked ? { blocked: true } : {}),
          ...(outcome.message ? { message: outcome.message } : {}),
        });
      },
    );
  }

  // ---------- 权限 ----------

  /** plan 模式：将 ExitPlanMode 转为需要用户决策的特殊审批。 */
  async requestPlanApproval(
    rec: SessionRecord,
    planInput: unknown,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (rec.permissionMode !== 'plan') {
      return { allowed: false, reason: 'ExitPlanMode 只能在计划模式下使用' };
    }
    const content = typeof planInput === 'string' ? planInput.trim() : '';
    if (!content) {
      return { allowed: false, reason: '计划内容为空：请通过 plan 参数提交 markdown 计划' };
    }
    if (signal.aborted) return { allowed: false, reason: '用户中断' };

    rec.plan = { content, createdAt: Date.now(), status: 'pending' };
    this.store.markDirty(rec.id, true);
    this.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });

    const result = await this.askPermission(rec, 'ExitPlanMode', { plan: content }, toolUseId, signal);
    if (signal.aborted) return { allowed: false, reason: '用户中断' };
    if (!result.allowed) {
      rec.plan = { ...rec.plan, status: 'rejected' };
      this.store.markDirty(rec.id, true);
      this.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
      return { allowed: false, reason: result.reason ?? '用户要求继续完善计划' };
    }

    const mode: 'acceptEdits' | 'default' = result.decision === 'allow_always' ? 'acceptEdits' : 'default';
    rec.permissionMode = mode;
    rec.plan = { ...rec.plan, status: 'approved', approvalMode: mode };
    this.store.markDirty(rec.id, true);
    this.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
    this.broadcastSummary(rec);
    return {
      allowed: true,
      reason:
        mode === 'acceptEdits'
          ? '计划已获批准，已切换到自动接受编辑模式，请开始执行计划。'
          : '计划已获批准，请开始执行计划（编辑操作会逐个询问）。',
    };
  }

  async authorize(
    rec: SessionRecord,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const def = this.toolDefinition(toolName, rec.cwd);
    const mode = rec.permissionMode;

    // plan 模式：只允许只读工具，写类工具直接拒绝
    if (mode === 'plan' && !PLAN_ALLOWED.has(toolName)) {
      return { allowed: false, reason: `plan 模式下不允许执行 ${toolName}（只允许只读工具）` };
    }
    if (!def) return { allowed: true }; // 交给执行器返回“未知工具”

    // Host 级规则：deny > ask > allow，deny 在 bypassPermissions 下依然生效
    const rule = this.permissionRules.evaluate(toolName, input, rec.cwd);
    if (rule === 'deny') {
      return { allowed: false, reason: `被权限规则拒绝: ${describeTool(toolName, input)}` };
    }
    if (mode === 'bypassPermissions') return { allowed: true };
    if (rule === 'ask') {
      if (signal.aborted) return { allowed: false, reason: '用户中断' };
      return this.askPermission(rec, toolName, input, toolUseId, signal);
    }
    if (rule === 'allow') return { allowed: true };

    // 只读且无需审批的工具直接放行
    if (def.readOnly && !def.requiresApproval) return { allowed: true };
    // 会话级 allow_always 优先于权限模式的默认行为
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
  ): Promise<{ allowed: boolean; reason?: string; decision?: PermissionDecision }> {
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
      const settle = (decision: PermissionDecision, customReason?: string) => {
        if (settled) return;
        settled = true;
        this.permissions.delete(request.id);
        rt.pending.delete(request.id);
        signal.removeEventListener('abort', onAbort);

        if (decision === 'allow_always' && toolName !== 'ExitPlanMode') {
          this.addAllowed(rec, toolName, input);
        }
        this.hub.broadcastSession(rec.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
        // 子代理的审批状态同步给主会话订阅者
        if (rec.parentId) {
          this.hub.broadcastSession(rec.parentId, {
            type: 'permission_resolved',
            requestId: request.id,
            sessionId: rec.id,
            decision,
          });
        }
        if (rt.pending.size === 0 && rt.running && !rt.interrupted && rec.status === 'waiting_permission') {
          this.setStatus(rec, 'running');
        }
        resolve({
          allowed: decision !== 'deny',
          decision,
          reason:
            decision === 'deny'
              ? customReason?.trim() ||
                (signal.aborted ? '用户中断' : '用户拒绝了该操作')
              : undefined,
        });
      };
      const onAbort = () => settle('deny');

      rt.pending.set(request.id, { request, resolve: settle });
      this.permissions.set(request.id, { sessionId: rec.id, resolve: settle });
      signal.addEventListener('abort', onAbort, { once: true });

      this.setStatus(rec, 'waiting_permission');
      this.hub.broadcastSession(rec.id, { type: 'permission_request', request });
      // 子代理的权限请求同时广播给主会话订阅者，便于在主会话里直接审批
      if (rec.parentId) {
        this.hub.broadcastSession(rec.parentId, { type: 'permission_request', request });
      }
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision, reason?: string): void {
    if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') return;
    this.permissions.get(requestId)?.resolve(
      decision,
      typeof reason === 'string' ? reason : undefined,
    );
  }

  private addAllowed(rec: SessionRecord, toolName: string, input: unknown): void {
    if (toolName === 'ExitPlanMode') return;
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
        delete rec.plan;
        const clearedRt = this.runtimes.get(rec.id);
        if (clearedRt) clearedRt.sessionStartDone = false;
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
        const profile = this.profileFor(rec.profileId, rec.groupId);
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
      case 'cost': {
        // 本地统计用量与花费，不调用模型
        this.appendLocalAssistant(rec, costSummary(rec));
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
    // 快照作为一条会话事件下发，客户端据此重置到当前 seq
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
      const profile = this.profileFor(rec.profileId, rec.groupId);
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
        idleTimeoutSec: this.config.idleTimeoutSec ?? 180,
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
      const price = priceForModel(profile, model);
      const inputTokens = result.usage.inputTokens || 0;
      const outputTokens = result.usage.outputTokens || 0;
      const cost = costOf(price, inputTokens, outputTokens);
      if (price) rec.usage.costUsd = (rec.usage.costUsd ?? 0) + cost;
      this.usage.record({
        hostId: this.config.hostId,
        profileId: rec.profileId,
        model,
        inputTokens,
        outputTokens,
        costUsd: cost,
      });
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
  /** 进程退出：落盘会话/用量，关闭 MCP 子进程。 */
  async shutdown(): Promise<void> {
    this.external.stopWatching();
    this.store.flush();
    this.usage.flush();
    await this.mcp.close();
  }
}

/** 带 HTTP 状态码的错误，供 server 路由按状态返回（如运行中回退 409）。 */
function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** /cost 的本地摘要：token 用量 + 已记录花费。 */
function costSummary(rec: SessionRecord): string {
  const usage = rec.usage;
  const cost =
    typeof usage.costUsd === 'number' ? `$${usage.costUsd.toFixed(4)}` : '未记录（该账号未配置单价）';
  return [
    '本会话用量',
    `- 输入 token: ${usage.inputTokens.toLocaleString('en-US')}`,
    `- 输出 token: ${usage.outputTokens.toLocaleString('en-US')}`,
    `- 累计花费: ${cost}`,
    `- 当前模型: ${rec.model || '(未设置)'}`,
  ].join('\n');
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
