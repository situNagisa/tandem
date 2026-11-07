// Host 核心：会话生命周期、agent 调度、权限审批、命令处理。
// 状态与构造留在这里；方法实现按职责拆在 host/ 下，同名方法只做一行转调。
import type {
  Checkpoint,
  ContentBlock,
  ContextBreakdown,
  DelegationStrategy,
  HookEntry,
  HookEvent,
  HostInfo,
  HostSettings,
  InboxEvent,
  InjectionChange,
  InjectionSegment,
  InjectionSnapshot,
  ListModelsInput,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PromptTemplateKey,
  ReasoningEffort,
  RewindInput,
  Session,
  SessionStatus,
  SessionSummary,
  SkillInfo,
  SlashCommand,
  Todo,
} from '@tandem/protocol';
import { ProfileStore, loadHostConfig, tandemHome } from './config.js';
import { BrowserManager } from './browser.js';
import { CheckpointStore } from './checkpoints.js';
import { ExternalSessionStore } from './external.js';
import { Hub } from './events.js';
import { HookManager } from './hooks.js';
import type { HookExecutionContext, HookRunResult } from './hooks.js';
import { McpManager } from './mcp.js';
import { PermissionRuleStore } from './permissions.js';
import { ApprovalHistoryStore } from './approval.js';
import { SearchIndex } from './search.js';
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
import { UsageStore } from './usage.js';
import { GatewayStore } from './gateway/store.js';
import { BudgetStore } from './budgets.js';
import { Inbox } from './inbox.js';
import { BackgroundTaskManager } from './tasks.js';
import { ScheduleManager } from './schedules.js';
import { EvalManager } from './evals.js';
import type { ListModelsResult } from './providers/index.js';
import { SkillManager } from './skills.js';
import { SubagentPresetStore } from './subagent-presets.js';
import { PromptTemplateStore } from './prompt-templates.js';
import { MemoryStore } from './memory.js';
import { SecretsStore } from './secrets.js';
import { TeamStore } from './team/store.js';
import { memberCanSeeSession } from './team/access.js';
import type { ParsedCommand } from './agent/commands.js';
import { readVersion, type PermissionEntry } from './host/helpers.js';
import {
  autoTitle,
  compactSession,
  drainQueue,
  ensureRuntime,
  handleUserContent,
  interrupt,
  send,
  sendToModel,
  updateTodos,
} from './host/turns.js';
import {
  appendLocalAssistant,
  appendNotice,
  broadcastSnapshot,
  handleCommand,
  listCommands,
  listSkills,
  setSkillState,
  titleFromCommand,
} from './host/commands.js';
import { addAllowed, ancestorsOf, askPermission, authorize, findPendingPermission, isAllowed, requestPlanApproval, resolvePermission, restorePendingPermission } from './host/permissions.js';
import { addRule, adoptSuggestion, draftRule, ignoreSuggestion, permissionInsights } from './host/approvals.js';
import { isRunning, listCheckpoints, rewind, snapshotForCheckpoint } from './host/rewind.js';
import { importSession, notifyExternalSessionsChanged } from './host/external.js';
import { runHooks } from './host/hooks.js';
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
  markRead,
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
  findModelForAlias,
  groupFor,
  keyCandidates,
  keysUnavailableMessage,
  markKeyFailure,
  markKeySuccess,
  profileFor,
} from './host/keys.js';
import { inboxSnapshot, pushInbox, recordCi } from './host/inbox.js';

export class Host {
  readonly config: HostConfig;
  readonly home: string;
  readonly profiles: ProfileStore;
  readonly store: SessionStore;
  /** 会话全文索引（Tandem + 外部会话），落盘 ~/.tandem/index/search.json。 */
  readonly searchIndex: SearchIndex;
  /** 外部会话（Claude Code / Codex）扫描缓存，只读。 */
  readonly external = new ExternalSessionStore(this);
  readonly checkpoints: CheckpointStore;
  readonly permissionRules: PermissionRuleStore;
  /** 审批历史与策略学习（~/.tandem/approvals.jsonl）。 */
  readonly approvalHistory: ApprovalHistoryStore;
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
  /** 项目/全局 Secrets：值加密落盘，只注入进程环境并按值打码输出。 */
  readonly secrets: SecretsStore;
  readonly usage: UsageStore;
  /** 自建 Key 网关（默认关闭）：设置、成员令牌、元数据日志与临时调试正文。 */
  readonly gateway: GatewayStore;
  readonly budgets: BudgetStore;
  readonly tasks: BackgroundTaskManager;
  readonly schedules: ScheduleManager;
  /** 评测：用例存储与后台批量运行。 */
  readonly evals: EvalManager;
  readonly hub = new Hub();
  /** 内网团队成员、邀请与审计（~/.tandem/team.json）。 */
  readonly team: TeamStore;
  /** 浏览器操作（Playwright）：每会话独立上下文，空闲 10 分钟关闭。 */
  readonly browser: BrowserManager;
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
    this.team = new TeamStore(home);
    this.hub.setSessionVisibility((access, sessionId) => {
      if (access.role === 'owner') return true;
      const rec = this.store.get(sessionId);
      return memberCanSeeSession(
        { kind: 'member', id: access.id, name: access.name, role: access.role as 'observer' | 'approver' | 'collaborator', projectDirs: access.projectDirs },
        rec,
      );
    });
    this.profiles = new ProfileStore(home);
    this.store = new SessionStore(home);
    this.searchIndex = new SearchIndex(this, home);
    // 会话写入/删除时增量更新全文索引（150ms 合并），首条搜索前也会强制 flush。
    this.store.onDirty = (rec) => this.searchIndex.touchSession(rec.id);
    this.store.onDelete = (id) => this.searchIndex.touchSession(id);
    this.checkpoints = new CheckpointStore(home);
    this.permissionRules = new PermissionRuleStore(home);
    this.approvalHistory = new ApprovalHistoryStore(home);
    this.hooks = new HookManager(home);
    this.mcp = new McpManager(home, (cwd) => this.secrets.envFor(cwd, 'mcp'));
    this.skills = new SkillManager({ home });
    this.subagentPresets = new SubagentPresetStore(home);
    this.promptTemplates = new PromptTemplateStore(home);
    this.memory = new MemoryStore(home);
    this.secrets = new SecretsStore(home);
    this.usage = new UsageStore(home);
    this.gateway = new GatewayStore(home);
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
    this.evals = new EvalManager(this);
    this.browser = new BrowserManager(home, {
      isSessionHostAllowed: (sessionId, host) => {
        const rec = this.store.get(sessionId);
        if (!rec) return false;
        const entry = `BrowserNavigate:${host}`;
        return rec.allowedTools.includes(entry) || rec.allowedTools.includes('browser_navigate');
      },
      onState: (state) => {
        this.hub.broadcastSession(state.sessionId, {
          type: 'browser_state',
          sessionId: state.sessionId,
          state,
        });
      },
    });
    this.version = readVersion();
    // 启动时连接已启用的 MCP 服务器；失败只记录状态，不影响 Host 启动
    this.mcp.start();
    // 外部会话目录有变化时通知客户端刷新侧栏（30s 定时扫描）
    this.external.startWatching(() => this.notifyExternalSessionsChanged());
  }

  notifyExternalSessionsChanged(): void {
    this.searchIndex.touchExternal();
    return notifyExternalSessionsChanged(this);
  }

  pushInbox(event: InboxEvent): void {
    return pushInbox(this, event);
  }

  inboxSnapshot(sinceSeq?: number) {
    return inboxSnapshot(this, sinceSeq);
  }

  findPendingPermission(requestId: string) {
    return findPendingPermission(this, requestId);
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

  markRead(id: string): SessionRecord | undefined {
    return markRead(this, id);
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

  mergeSessionWorktree(
    id: string,
    strategy: 'merge' | 'squash',
  ): Promise<{ ok: boolean; error?: string }> {
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

  updateSession(
    id: string,
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
    },
  ): SessionRecord | undefined {
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
    return ensureRuntime(this, id);
  }

  // ---------- 消息入口 ----------

  send(sessionId: string, content: ContentBlock[]): Promise<void> {
    return send(this, sessionId, content);
  }

  handleUserContent(rec: SessionRecord, content: ContentBlock[]): Promise<void> {
    return handleUserContent(this, rec, content);
  }

  sendToModel(rec: SessionRecord, content: ContentBlock[]): Promise<void> {
    return sendToModel(this, rec, content);
  }

  autoTitle(rec: SessionRecord, firstText: string, baseTitle: string): Promise<void> {
    return autoTitle(this, rec, firstText, baseTitle);
  }

  drainQueue(sessionId: string): Promise<void> {
    return drainQueue(this, sessionId);
  }

  interrupt(sessionId: string): void {
    return interrupt(this, sessionId);
  }

  ancestorsOf(rec: SessionRecord): SessionRecord[] {
    return ancestorsOf(this, rec);
  }

  runSubagent(parent: SessionRecord, input: { description: string; prompt: string; subagentType?: string; model?: string }, signal: AbortSignal): Promise<ToolResult> {
    return runSubagent(this, parent, input, signal);
  }

  updateTodos(rec: SessionRecord, todos: Todo[]): void {
    return updateTodos(this, rec, todos);
  }

  // ---------- 检查点 ----------

  snapshotForCheckpoint(rec: SessionRecord, rawPath: string): void {
    return snapshotForCheckpoint(this, rec, rawPath);
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    return listCheckpoints(this, sessionId);
  }

  isRunning(sessionId: string): boolean {
    return isRunning(this, sessionId);
  }

  rewind(sessionId: string, input: RewindInput): Session | undefined {
    return rewind(this, sessionId, input);
  }

  // ---------- Hooks ----------

  runHooks(rec: SessionRecord, entries: HookEntry[], event: HookEvent, context: Omit<HookExecutionContext, 'sessionId' | 'cwd' | 'permissionMode'>): Promise<HookRunResult> {
    return runHooks(this, rec, entries, event, context);
  }

  // ---------- 权限 ----------

  requestPlanApproval(rec: SessionRecord, planInput: unknown, toolUseId: string, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    return requestPlanApproval(this, rec, planInput, toolUseId, signal);
  }

  authorize(rec: SessionRecord, toolName: string, input: unknown, toolUseId: string, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    return authorize(this, rec, toolName, input, toolUseId, signal);
  }

  isAllowed(rec: SessionRecord, toolName: string, input: unknown): boolean {
    return isAllowed(this, rec, toolName, input);
  }

  askPermission(rec: SessionRecord, toolName: string, input: unknown, toolUseId: string, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string; decision?: PermissionDecision }> {
    return askPermission(this, rec, toolName, input, toolUseId, signal);
  }

  resolvePermission(requestId: string, decision: PermissionDecision, reason?: string): void {
    return resolvePermission(this, requestId, decision, reason);
  }

  restorePendingPermission(rec: SessionRecord, request: PermissionRequest, signal: AbortSignal): Promise<{ decision: PermissionDecision; reason?: string }> {
    return restorePendingPermission(this, rec, request, signal);
  }

  addAllowed(rec: SessionRecord, toolName: string, input: unknown): void {
    return addAllowed(this, rec, toolName, input);
  }

  permissionInsights() {
    return permissionInsights(this);
  }

  adoptPermissionSuggestion(id: string) {
    return adoptSuggestion(this, id);
  }

  ignorePermissionSuggestion(id: string): void {
    ignoreSuggestion(this, id);
  }

  addPermissionRule(rule: unknown) {
    return addRule(this, rule);
  }

  draftPermissionRule(rec: SessionRecord, text: string) {
    return draftRule(this, rec, text);
  }

  // ---------- 斜杠命令 ----------

  listCommands(cwd: string): SlashCommand[] {
    return listCommands(this, cwd);
  }

  listSkills(cwd: string): SkillInfo[] {
    return listSkills(this, cwd);
  }

  setSkillState(disabled: string[], cwd: string): SkillInfo[] {
    return setSkillState(this, disabled, cwd);
  }

  handleCommand(rec: SessionRecord, cmd: ParsedCommand): Promise<boolean> {
    return handleCommand(this, rec, cmd);
  }

  titleFromCommand(rec: SessionRecord, cmd: ParsedCommand): void {
    return titleFromCommand(this, rec, cmd);
  }

  appendNotice(rec: SessionRecord, text: string): void {
    return appendNotice(this, rec, text);
  }

  appendLocalAssistant(rec: SessionRecord, text: string): void {
    return appendLocalAssistant(this, rec, text);
  }

  broadcastSnapshot(rec: SessionRecord): void {
    return broadcastSnapshot(this, rec);
  }

  compactSession(rec: SessionRecord): Promise<void> {
    return compactSession(this, rec);
  }
  /** 进程退出：落盘会话/用量，关闭 MCP 子进程。 */
  async shutdown(): Promise<void> {
    this.tasks.dispose();
    this.secrets.dispose();
    this.schedules.dispose();
    this.external.stopWatching();
    this.store.flush();
    this.searchIndex.flush();
    this.usage.flush();
    await this.browser.dispose();
    await this.mcp.close();
  }
}

/** 供 server 复用（实现见 host/helpers.ts）。 */
export { defaultBaseUrlFor } from './host/helpers.js';
export type { ParsedCommand };
