// Host 核心：会话生命周期、agent 调度、权限审批、命令处理。
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Checkpoint,
  ContentBlock,
  ContextBreakdown,
  HookEntry,
  HookEvent,
  HostInfo,
  HostSettings,
  InboxEvent,
  InjectionChange,
  InjectionSegment,
  InjectionSnapshot,
  ListModelsInput,
  Message,
  ModelInfo,
  PromptTemplateKey,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  DelegationStrategy,
  ReasoningEffort,
  RewindInput,
  Session,
  SessionStatus,
  SessionSummary,
  VoiceSettings,
  SkillInfo,
  SlashCommand,
  Todo,
} from '@tandem/protocol';
import {
  ProfileStore,
  effectiveProfile,
  loadHostConfig,
  providerDefaultBaseUrl,
  saveHostSettings,
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
import type {
  HostConfig,
  SessionRecord,
  SessionRuntime,
  StoredProfile,
  StoredProfileGroup,
  ToolDefinition,
  ToolResult,
} from './types.js';
import { UsageStore, costOfUsage, priceForModel } from './usage.js';
import { BudgetStore } from './budgets.js';
import { Inbox } from './inbox.js';
import {
  classifyKeyFailure,
  cooldownMsFor,
  groupUnavailableError,
  orderedAvailableKeys,
  profileWithKey,
} from './key-rotation.js';
import { BackgroundTaskManager } from './tasks.js';
import { ScheduleManager } from './schedules.js';
import { removeWorktree, worktreeCleanliness } from './worktree.js';
import { runTurn } from './agent/loop.js';
import { persist as persistRunState } from './run-state.js';
import {
  BUILTIN_NAMES,
  findCommandBody,
  listCommands,
  parseSlashCommand,
  type ParsedCommand,
} from './agent/commands.js';
import { PLAN_ALLOWED, TOOLS, TOOL_MAP, describeTool } from './tools/index.js';
import { completeText, streamChat } from './providers/index.js';
import type { ListModelsResult } from './providers/index.js';
import { SkillManager } from './skills.js';
import { SubagentPresetStore, modelAliasOf } from './subagent-presets.js';
import { PromptTemplateStore } from './prompt-templates.js';
import { TASK_DESCRIPTION_DEFAULT } from './prompts/registry.js';
import { MemoryStore, bodyOfMemory, normalizeFactLines } from './memory.js';
import { errorMessage, truncateEnd } from './util/text.js';
import { detectSessionEnv } from './util/git.js';
import { expandHome, isSubPath, resolvePath } from './util/path.js';
import {
  DELEGATIONS,
  EFFORTS,
  PERMISSION_MODES,
  cleanTitle,
  commandPrefix,
  costSummary,
  formatUsd,
  httpError,
  isContentBlock,
  labelOfSource,
  readVersion,
  rememberTextOf,
  sanitizeVoiceSettings,
  splitCompactOutput,
  type PermissionEntry,
} from './host/helpers.js';
import { inboxSnapshot, pushInbox, recordCi } from './host/inbox.js';
import { importSession, notifyExternalSessionsChanged } from './host/external.js';
import {
  delegationFor,
  delegationKey,
  delegationPrompt,
  orchestrateTools,
  presetSummary,
  runSubagent,
  subagentConfig,
  taskToolDescription,
  toolDefinition,
  toolDefinitions,
} from './host/subagents.js';
import {
  allowBudgetOnce,
  assertBudget,
  buildSystemFor,
  calibrateContext,
  contextFor,
  injectionsFor,
  listModels,
  modelCapabilities,
  observeBudgets,
  promptOptions,
  recordInjections,
  setContext,
} from './host/usage.js';
import {
  findModelForAlias,
  groupFor,
  keyCandidates,
  keysUnavailableMessage,
  markKeyFailure,
  markKeySuccess,
  profileFor,
} from './host/keys.js';
import {
  checkoutSessionBranch,
  enterSessionWorktree,
  mergeSessionWorktree,
  refreshEnv,
  sessionBranches,
} from './host/vcs.js';
import {
  broadcastSummary,
  createSession,
  deleteSession,
  ensureSessionEnv,
  forkSession,
  getSession,
  info,
  listSessions,
  markScheduled,
  recoverAfterRestart,
  resumePausedSession,
  retryNow,
  setStatus,
  settings,
  snapshot,
  toSession,
  toSummary,
  updateSettings,
  updateSession,
} from './host/sessions.js';

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
  /** Claude Code 兼容 skills（只读扫描，启用状态存 ~/.tandem/skills-state.json）。 */
  readonly skills: SkillManager;
  /** 子代理预设：Tandem 自定义 + Claude Code agents/*.md 只读兼容。 */
  readonly subagentPresets: SubagentPresetStore;
  /** 可配置提示词（Task 说明 / 四档委派 / 子代理默认附加提示）。 */
  readonly promptTemplates: PromptTemplateStore;
  /** 项目/全局长期记忆（Tandem 私有）。 */
  readonly memory: MemoryStore;
  readonly usage: UsageStore;
  readonly budgets: BudgetStore;
  readonly tasks: BackgroundTaskManager;
  readonly schedules: ScheduleManager;
  readonly hub = new Hub();
  /** 跨会话收件箱（审批/回合结束/预算摘要），手机审批台的数据源。 */
  readonly inbox = new Inbox();
  readonly version: string;
  runtimes = new Map<string, SessionRuntime>();
  permissions = new Map<string, PermissionEntry>();
  /** 每轮系统提示的注入段落清单与变化历史（内存态，GET /injections 时按需重算）。 */
  injections = new Map<
    string,
    { segments: InjectionSegment[]; changes: InjectionChange[]; updatedAt: number }
  >();
  /** 单模型能力缓存，避免每次打开选择器都请求 provider 模型列表。 */
  capabilityCache = new Map<string, { at: number; info: ModelInfo }>();
  /** 已尝试过环境检测的会话：非 git 目录也记住，避免列表轮询反复执行 git。 */
  envChecked = new Set<string>();
  /** 分组 Key 轮询游标（按 profileId:groupId 存内存）。 */
  keyRotation = new Map<string, number>();

  constructor(config?: HostConfig, home = tandemHome()) {
    this.home = home;
    this.config = config ?? loadHostConfig(home);
    this.profiles = new ProfileStore(home);
    this.store = new SessionStore(home);
    this.checkpoints = new CheckpointStore(home);
    this.permissionRules = new PermissionRuleStore(home);
    this.hooks = new HookManager(home);
    this.mcp = new McpManager(home);
    this.skills = new SkillManager({ home });
    this.subagentPresets = new SubagentPresetStore(home);
    this.promptTemplates = new PromptTemplateStore(home);
    this.memory = new MemoryStore(home);
    this.usage = new UsageStore(home);
    this.budgets = new BudgetStore(home, this.usage);
    this.tasks = new BackgroundTaskManager(home, (task, content, truncated) => {
      this.hub.broadcastAll({
        type: 'task_updated',
        sessionId: task.sessionId,
        task,
        ...(content ? { content } : {}),
        ...(task.outputChars !== undefined ? { since: task.outputChars } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    });
    this.schedules = new ScheduleManager(home, this, () => {
      this.hub.broadcastAll({ type: 'schedules_updated' });
    });
    this.version = readVersion();
    // 启动时连接已启用的 MCP 服务器；失败只记录状态，不影响 Host 启动
    this.mcp.start();
    // 外部会话目录有变化时通知客户端刷新侧栏（30s 定时扫描）
    this.external.startWatching(() => this.notifyExternalSessionsChanged());
  }

  notifyExternalSessionsChanged(): void {
    return notifyExternalSessionsChanged(this);
  }

  pushInbox(event: InboxEvent): void {
    return pushInbox(this, event);
  }

  inboxSnapshot(sinceSeq?: number) {
    return inboxSnapshot(this, sinceSeq);
  }

  recordCi(sessionId: string, sessionTitle: string, ci: NonNullable<InboxEvent['ci']>): void {
    return recordCi(this, sessionId, sessionTitle, ci);
  }
  info(): HostInfo {
    return info(this);
  }

  // ---------- Host 行为设置 ----------

  settings(): HostSettings {
    return settings(this);
  }

  updateSettings(input: Partial<HostSettings>): HostSettings {
    return updateSettings(this, input);
  }

  recoverAfterRestart(): Promise<void> {
    return recoverAfterRestart(this);
  }

  resumePausedSession(id: string): SessionRecord | undefined {
    return resumePausedSession(this, id);
  }

  retryNow(sessionId: string): boolean {
    return retryNow(this, sessionId);
  }

  // ---------- 会话读取/转换 ----------

  getSession(id: string): SessionRecord | undefined {
    return getSession(this, id);
  }

  listSessions(): SessionRecord[] {
    return listSessions(this);
  }

  ensureSessionEnv(rec: SessionRecord): void {
    return ensureSessionEnv(this, rec);
  }

  toSummary(rec: SessionRecord): SessionSummary {
    return toSummary(this, rec);
  }

  markScheduled(id: string, info: { id: string; name: string }): void {
    return markScheduled(this, id, info);
  }

  setContext(rec: SessionRecord, context: ContextBreakdown, broadcast = true): void {
    return setContext(this, rec, context, broadcast);
  }

  calibrateContext(rec: SessionRecord, context: ContextBreakdown, actualInputTokens: number): void {
    return calibrateContext(this, rec, context, actualInputTokens);
  }

  promptOptions(rec: SessionRecord, opts: { allowTask?: boolean; hookContext?: string } = {}) {
    return promptOptions(this, rec, opts);
  }

  buildSystemFor(rec: SessionRecord, opts: { allowTask?: boolean; hookContext?: string } = {}): { system: string; parts: InjectionSegment[] } {
    return buildSystemFor(this, rec, opts);
  }

  recordInjections(rec: SessionRecord, segments: InjectionSegment[], beforeMessageId?: string): InjectionSnapshot {
    return recordInjections(this, rec, segments, beforeMessageId);
  }

  injectionsFor(rec: SessionRecord): InjectionSnapshot {
    return injectionsFor(this, rec);
  }

  contextFor(rec: SessionRecord): ContextBreakdown {
    return contextFor(this, rec);
  }

  refreshEnv(id: string): Promise<void> {
    return refreshEnv(this, id);
  }

  profileFor(profileId: string, groupId?: string): StoredProfile | undefined {
    return profileFor(this, profileId, groupId);
  }

  groupFor(profileId: string, groupId?: string): StoredProfileGroup | undefined {
    return groupFor(this, profileId, groupId);
  }

  findModelForAlias(alias: string, preferredProfileId: string, preferredGroupId?: string): { profileId: string; groupId?: string; model: string } | undefined {
    return findModelForAlias(this, alias, preferredProfileId, preferredGroupId);
  }

  subagentConfig(parent: SessionRecord, presetName?: string, modelOverride?: string): { profileId: string; groupId?: string; model: string; effort?: ReasoningEffort; permissionMode: PermissionMode; delegation: DelegationStrategy; toolWhitelist?: string[]; systemPromptExtra?: string; presetName?: string; } {
    return subagentConfig(this, parent, presetName, modelOverride);
  }

  keyCandidates(profileId: string, groupId?: string): { group?: StoredProfileGroup; effective?: StoredProfile; candidates: Array<{ keyId?: string; label?: string; profile: StoredProfile }>; } {
    return keyCandidates(this, profileId, groupId);
  }

  markKeySuccess(profileId: string, groupId: string | undefined, keyId?: string): void {
    return markKeySuccess(this, profileId, groupId, keyId);
  }

  markKeyFailure(profileId: string, groupId: string | undefined, keyId: string | undefined, err: unknown): boolean {
    return markKeyFailure(this, profileId, groupId, keyId, err);
  }

  keysUnavailableMessage(profileId: string, groupId?: string, errors: Map<string, string> = new Map()): string | undefined {
    return keysUnavailableMessage(this, profileId, groupId, errors);
  }

  assertBudget(rec: SessionRecord, model: string): void {
    return assertBudget(this, rec, model);
  }

  allowBudgetOnce(sessionId: string): boolean {
    return allowBudgetOnce(this, sessionId);
  }

  observeBudgets(rec: SessionRecord): void {
    return observeBudgets(this, rec);
  }

  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    return listModels(this, input);
  }

  modelCapabilities(profileId: string, groupId: string | undefined, model: string): Promise<ModelInfo | undefined> {
    return modelCapabilities(this, profileId, groupId, model);
  }

  delegationFor(rec: SessionRecord): DelegationStrategy {
    return delegationFor(this, rec);
  }

  orchestrateTools(rec: SessionRecord): ToolDefinition[] {
    return orchestrateTools(this, rec);
  }

  presetSummary(cwd: string): string {
    return presetSummary(this, cwd);
  }

  taskToolDescription(cwd: string): string {
    return taskToolDescription(this, cwd);
  }

  delegationKey(rec: SessionRecord): PromptTemplateKey {
    return delegationKey(this, rec);
  }

  delegationPrompt(rec: SessionRecord): string {
    return delegationPrompt(this, rec);
  }

  toolDefinitions(rec: SessionRecord, allowTask = true): ToolDefinition[] {
    return toolDefinitions(this, rec, allowTask);
  }

  toolDefinition(name: string, cwd: string): ToolDefinition | undefined {
    return toolDefinition(this, name, cwd);
  }

  mergeSessionWorktree(id: string,
      strategy: 'merge' | 'squash',): Promise<{ ok: boolean; error?: string }> {
    return mergeSessionWorktree(this, id, strategy);
  }

  sessionBranches(id: string): Promise<{ current?: string; branches: string[] }> {
    return sessionBranches(this, id);
  }

  checkoutSessionBranch(id: string, branch: string, create: boolean): Promise<SessionRecord> {
    return checkoutSessionBranch(this, id, branch, create);
  }

  enterSessionWorktree(id: string, branch?: string): Promise<SessionRecord> {
    return enterSessionWorktree(this, id, branch);
  }

  importSession(input: { session?: unknown; cwd?: unknown }): Promise<SessionRecord> {
    return importSession(this, input);
  }

  toSession(rec: SessionRecord): Session {
    return toSession(this, rec);
  }

  snapshot(id: string): { session: Session; pendingPermissions: PermissionRequest[] } | undefined {
    return snapshot(this, id);
  }

  broadcastSummary(rec: SessionRecord): void {
    return broadcastSummary(this, rec);
  }

  setStatus(rec: SessionRecord, status: SessionStatus): void {
    return setStatus(this, rec, status);
  }

  // ---------- 会话 CRUD ----------

  createSession(input: {
      cwd?: unknown;
      profileId?: unknown;
      groupId?: unknown;
      model?: unknown;
      permissionMode?: unknown;
      effort?: unknown;
      delegation?: unknown;
      title?: unknown;
      worktree?: unknown;
    }): Promise<SessionRecord> {
    return createSession(this, input);
  }

  updateSession(id: string,
      patch: {
        title?: unknown;
        profileId?: unknown;
        groupId?: unknown;
        model?: unknown;
        permissionMode?: unknown;
        pinned?: unknown;
        pinnedTurns?: unknown;
        archived?: unknown;
        effort?: unknown;
        delegation?: unknown;
        cwd?: unknown;
      },): SessionRecord | undefined {
    return updateSession(this, id, patch);
  }

  forkSession(id: string, messageId?: string): SessionRecord | undefined {
    return forkSession(this, id, messageId);
  }

  deleteSession(id: string, force = false): Promise<boolean> {
    return deleteSession(this, id, force);
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
      persistRunState(this, rec);
      return;
    }
    await this.handleUserContent(rec, blocks);
  }

  private async handleUserContent(rec: SessionRecord, content: ContentBlock[]): Promise<void> {
    // #记住…：直接写入项目记忆，不发给模型
    const remembered = rememberTextOf(content);
    if (remembered !== undefined) {
      if (!remembered) {
        this.appendNotice(rec, '用法：#记住 <要长期保留的项目事实或约定>');
        return;
      }
      try {
        const file = this.memory.add(rec.cwd, remembered);
        this.appendNotice(rec, `已记住（${file.name} · ${file.entries} 条）：${remembered}`);
      } catch (err) {
        this.appendNotice(rec, `写入项目记忆失败：${errorMessage(err)}`);
      }
      return;
    }
    const first = content[0];
    if (content.length === 1 && first?.type === 'text' && first.text.trim().startsWith('/')) {
      const cmd = parseSlashCommand(first.text);
      // 只把已知命令当命令；以 / 开头的普通路径仍按普通消息处理
      if (
        cmd &&
        (BUILTIN_NAMES.has(cmd.name) ||
          findCommandBody(cmd.name, rec.cwd) !== undefined ||
          this.skills.list(rec.cwd).some((skill) => skill.name === cmd.name))
      ) {
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
    const result = await runTurn(this, rec);
    // 主会话回合结束写入收件箱（子代理只把结果回传父会话，不单独提醒）
    if ((rec.depth ?? 0) === 0) {
      this.pushInbox(
        this.inbox.recordTurnEnd(rec.id, rec.title, result.reason, result.error),
      );
    }
    if (needsTitle && isFirstUserMessage) void this.autoTitle(rec, text, rec.title);
  }

  /**
   * 用当前模型异步生成 ≤20 字的会话标题。失败或用户已改名时保留兜底标题。
   * baseTitle 是发起请求时的标题，用于判断期间是否被用户手动改过。
   */
  private async autoTitle(rec: SessionRecord, firstText: string, baseTitle: string): Promise<void> {
    const titleKey = this.keyCandidates(rec.profileId, rec.groupId).candidates[0];
    const profile = titleKey?.profile ?? this.profileFor(rec.profileId, rec.groupId);
    const model = rec.model || profile?.defaultModel || '';
    if (!profile?.apiKey || !model) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const raw = await completeText({
        profile,
        model,
        system: '你是会话标题生成器。只输出标题本身，不要解释、不要引号、不要标点。',
        prompt: this.promptTemplates.render(
          'autoTitle',
          { text: firstText.slice(0, 2000) },
          rec.cwd,
        ),
        maxTokens: 200,
        signal: controller.signal,
      });
      this.markKeySuccess(rec.profileId, rec.groupId, titleKey?.keyId);
      const title = cleanTitle(raw);
      if (!title || rec.title !== baseTitle) return;
      rec.title = title;
      this.store.markDirty(rec.id, false);
      this.broadcastSummary(rec);
    } catch (err) {
      this.markKeyFailure(rec.profileId, rec.groupId, titleKey?.keyId, err);
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
        persistRunState(this, rec);
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

  /** 沿 parentId 链返回所有祖先会话（由近及远）。 */
  private ancestorsOf(rec: SessionRecord): SessionRecord[] {
    const out: SessionRecord[] = [];
    const seen = new Set<string>([rec.id]);
    let cursor = rec;
    while (cursor.parentId) {
      if (seen.has(cursor.parentId)) break;
      seen.add(cursor.parentId);
      const parent = this.store.get(cursor.parentId);
      if (!parent) break;
      out.push(parent);
      cursor = parent;
    }
    return out;
  }

  runSubagent(parent: SessionRecord, input: { description: string; prompt: string; subagentType?: string; model?: string }, signal: AbortSignal): Promise<ToolResult> {
    return runSubagent(this, parent, input, signal);
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

    // Memory 的 view 是纯读取；写入按 Edit 类操作审批
    if (toolName === 'Memory' && (input as Record<string, unknown> | null)?.action === 'view') {
      return { allowed: true };
    }
    // 只读且无需审批的工具直接放行
    if (def.readOnly && !def.requiresApproval) return { allowed: true };
    // 会话级 allow_always 优先于权限模式的默认行为
    if (this.isAllowed(rec, toolName, input)) return { allowed: true };
    if (
      mode === 'acceptEdits' &&
      (toolName === 'Write' || toolName === 'Edit' || toolName === 'Memory')
    ) {
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
      ...(rec.parentId
        ? { depth: rec.depth ?? 1, sourceTitle: rec.title }
        : {}),
    };
    const ancestors = this.ancestorsOf(rec);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision: PermissionDecision, customReason?: string) => {
        if (settled) return;
        settled = true;
        this.permissions.delete(request.id);
        rt.pending.delete(request.id);
        signal.removeEventListener('abort', onAbort);
        persistRunState(this, rec);

        if (decision === 'allow_always' && toolName !== 'ExitPlanMode') {
          this.addAllowed(rec, toolName, input);
        }
        this.hub.broadcastSession(rec.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
        // 收件箱：任意一端处理后，所有端从待审批列表移除
        const resolved = this.inbox.resolvePermission(request.id, decision);
        if (resolved) this.pushInbox(resolved);
        // 逐级冒泡：祖先会话（子代理/主会话）的订阅者都能同步审批状态
        for (const ancestor of ancestors) {
          this.hub.broadcastSession(ancestor.id, {
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
      persistRunState(this, rec);

      this.setStatus(rec, 'waiting_permission');
      this.hub.broadcastSession(rec.id, { type: 'permission_request', request, sessionId: rec.id });
      // 收件箱：一次请求只记一条（不按祖先重复），带上会话标题与子代理来源
      this.pushInbox(this.inbox.recordPermission(request, rec.title));
      // 子代理/孙代理的权限请求逐级冒泡，主会话订阅者可直接审批
      for (const ancestor of ancestors) {
        this.hub.broadcastSession(ancestor.id, { type: 'permission_request', request, sessionId: ancestor.id });
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

  /**
   * Host 重启恢复：用 runState 里原样的 PermissionRequest 重新进入待审批状态，
   * 重新广播 permission_request 并写入收件箱；返回用户的决定。
   */
  restorePendingPermission(
    rec: SessionRecord,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<{ decision: PermissionDecision; reason?: string }> {
    const rt = this.ensureRuntime(rec.id);
    const ancestors = this.ancestorsOf(rec);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision: PermissionDecision, customReason?: string) => {
        if (settled) return;
        settled = true;
        this.permissions.delete(request.id);
        rt.pending.delete(request.id);
        signal.removeEventListener('abort', onAbort);
        if (decision === 'allow_always' && request.toolName !== 'ExitPlanMode') {
          this.addAllowed(rec, request.toolName, request.input);
        }
        this.hub.broadcastSession(rec.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
        const resolved = this.inbox.resolvePermission(request.id, decision);
        if (resolved) this.pushInbox(resolved);
        for (const ancestor of ancestors) {
          this.hub.broadcastSession(ancestor.id, {
            type: 'permission_resolved',
            requestId: request.id,
            sessionId: rec.id,
            decision,
          });
        }
        if (
          rt.pending.size === 0 &&
          rt.running &&
          !rt.interrupted &&
          rec.status === 'waiting_permission'
        ) {
          this.setStatus(rec, 'running');
        }
        persistRunState(this, rec);
        resolve({
          decision,
          ...(decision === 'deny'
            ? {
                reason:
                  customReason?.trim() ||
                  (signal.aborted ? '用户中断' : '用户拒绝了该操作'),
              }
            : {}),
        });
      };
      const onAbort = () => settle('deny', signal.aborted ? '用户中断' : undefined);

      rt.pending.set(request.id, { request, resolve: settle });
      this.permissions.set(request.id, { sessionId: rec.id, resolve: settle });
      signal.addEventListener('abort', onAbort, { once: true });
      this.setStatus(rec, 'waiting_permission');
      this.hub.broadcastSession(rec.id, { type: 'permission_request', request, sessionId: rec.id });
      this.pushInbox(this.inbox.recordPermission(request, rec.title));
      for (const ancestor of ancestors) {
        this.hub.broadcastSession(ancestor.id, {
          type: 'permission_request',
          request,
          sessionId: ancestor.id,
        });
      }
      persistRunState(this, rec);
    });
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
    // 技能命令排在后面，重名时让内置/自定义命令优先
    const commands = listCommands(cwd);
    const names = new Set(commands.map((cmd) => cmd.name));
    for (const skill of this.skills.commands(cwd)) {
      if (!names.has(skill.name)) {
        names.add(skill.name);
        commands.push(skill);
      }
    }
    return commands;
  }

  listSkills(cwd: string): SkillInfo[] {
    return this.skills.list(cwd);
  }

  setSkillState(disabled: string[], cwd: string): SkillInfo[] {
    return this.skills.setDisabled(disabled, cwd);
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
        await this.sendToModel(rec, [
          { type: 'text', text: this.promptTemplates.get('init', rec.cwd) },
        ]);
        return true;
      }
      case 'schedule': {
        this.appendLocalAssistant(rec, '请在客户端「设置 → 定时任务」中新建或管理定时任务（输入 /schedule 可直接打开）。');
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
      case 'memory': {
        const project = this.memory.read('project', rec.cwd);
        const global = this.memory.read('global');
        const projectBody = bodyOfMemory(project.text).trim();
        const globalBody = bodyOfMemory(global.text).trim();
        this.appendLocalAssistant(
          rec,
          [
            `## 项目记忆（${project.name} · ${project.entries} 条）`,
            projectBody || '（空）',
            '',
            `## 全局记忆（${global.entries} 条）`,
            globalBody || '（空）',
            '',
            '可在右侧「记忆」卡片或「设置 → 记忆」中编辑；输入 #记住 <内容> 可直接追加。',
          ].join('\n'),
        );
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

    // Skill：/<skill-name> 显式加载技能正文
    const skillInfo = this.skills.list(rec.cwd).find((skill) => skill.name === cmd.name);
    if (skillInfo) {
      if (!skillInfo.enabled) {
        this.appendLocalAssistant(
          rec,
          `技能「${cmd.name}」已停用。可在「设置 → Skills」中重新启用，或直接用自然语言描述任务。`,
        );
        return true;
      }
      if (!skillInfo.userInvocable) {
        this.appendLocalAssistant(
          rec,
          `技能「${cmd.name}」不允许用户直接调用（user-invocable: false），模型会在需要时自行使用。`,
        );
        return true;
      }
      const skill = this.skills.resolve(cmd.name, rec.cwd);
      if (skill) {
        this.titleFromCommand(rec, cmd);
        let expanded = skill.body.replace(/\$ARGUMENTS/g, cmd.args);
        if (cmd.args && !skill.body.includes('$ARGUMENTS')) {
          expanded += `\n\n用户参数：${cmd.args}`;
        }
        await this.sendToModel(rec, [
          { type: 'text', text: `[使用技能 ${skill.info.name}]\n\n${expanded}` },
        ]);
        return true;
      }
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

  /** 会话内低调提示：单行灰字展示，不发送给模型。 */
  appendNotice(rec: SessionRecord, text: string): void {
    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text }],
      createdAt: Date.now(),
      notice: true,
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
      const selection = this.keyCandidates(rec.profileId, rec.groupId);
      const compactKey = selection.candidates[0];
      const profile = compactKey?.profile ?? this.profileFor(rec.profileId, rec.groupId);
      if (!profile?.apiKey) {
        throw new Error(
          this.keysUnavailableMessage(rec.profileId, rec.groupId) ?? '当前账号未配置 API Key',
        );
      }
      const model = rec.model || profile.defaultModel;
      if (!model) throw new Error('当前账号没有配置模型');
      this.assertBudget(rec, model);
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
            text: this.promptTemplates.get('compact', rec.cwd),
          },
        ],
        createdAt: Date.now(),
      };
      const blocks: ContentBlock[] = [];
      let result: Awaited<ReturnType<typeof streamChat>>;
      try {
        result = await streamChat({
          profile,
          model,
          system: this.buildSystemFor(rec, { allowTask: false }).system,
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
        this.markKeySuccess(rec.profileId, rec.groupId, compactKey?.keyId);
      } catch (err) {
        this.markKeyFailure(rec.profileId, rec.groupId, compactKey?.keyId, err);
        throw err;
      }
      const raw = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      // 同一次调用里顺带产出可长期保留的事实，写入项目记忆（成本与单独请求相近但少一次往返）
      const { summary, facts } = splitCompactOutput(raw);
      if (!summary) throw new Error('模型没有返回摘要内容');
      if (facts.length > 0) {
        try {
          this.memory.add(rec.cwd, facts.join('\n'));
        } catch (err) {
          console.warn('[tandem] 写入项目记忆失败:', errorMessage(err));
        }
      }

      rec.messages = [
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `[此前对话摘要]\n\n${summary}` }],
          createdAt: Date.now(),
        },
      ];
      const usage = result.usage;
      const inputTokens = usage.inputTokens || 0;
      const outputTokens = usage.outputTokens || 0;
      const cacheReadTokens = usage.cacheReadTokens || 0;
      const cacheWriteTokens = usage.cacheWriteTokens || 0;
      rec.usage.inputTokens += inputTokens;
      rec.usage.outputTokens += outputTokens;
      rec.usage.cacheReadTokens = (rec.usage.cacheReadTokens ?? 0) + cacheReadTokens;
      rec.usage.cacheWriteTokens = (rec.usage.cacheWriteTokens ?? 0) + cacheWriteTokens;
      const price = priceForModel(profile, model);
      const cost = costOfUsage(price, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, profile.kind);
      if (price) rec.usage.costUsd = Math.round(((rec.usage.costUsd ?? 0) + cost) * 1e8) / 1e8;
      this.usage.record({
        hostId: this.config.hostId,
        profileId: rec.profileId,
        model,
        inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
        outputTokens,
        costUsd: cost,
        ...(compactKey?.keyId ? { keyId: compactKey.keyId } : {}),
        ...(rec.groupId ? { groupId: rec.groupId } : {}),
      });
      this.observeBudgets(rec);
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
      this.pushInbox(
        this.inbox.recordTurnEnd(
          rec.id,
          rec.title,
          failed ? (failed === '用户中断' ? 'interrupted' : 'error') : 'done',
          failed && failed !== '用户中断' ? failed : undefined,
        ),
      );
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
    this.tasks.dispose();
    this.schedules.dispose();
    this.external.stopWatching();
    this.store.flush();
    this.usage.flush();
    await this.mcp.close();
  }
}

/** 供 server 复用（实现见 host/helpers.ts）。 */
export { defaultBaseUrlFor } from './host/helpers.js';
export type { ParsedCommand };
