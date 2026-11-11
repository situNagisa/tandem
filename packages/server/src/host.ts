// Host 核心：会话生命周期、agent 调度、权限审批、命令处理。
// 状态与构造留在这里；方法实现按职责拆在 host/ 下，同名方法只做一行转调。
import type {
  Checkpoint,
  ContentBlock,
  ContextBreakdown,
  DelegationStrategy,
  HookEntry,
  HookEvent,
  HandoffReason,
  HostInfo,
  HostSettings,
  InboxEvent,
  InjectionChange,
  InjectionSegment,
  InjectionSnapshot,
  ListModelsInput,
  MessagePage,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PromptTemplateKey,
  QuotaEstimate,
  ReasoningEffort,
  RewindInput,
  SandboxStatus,
  Session,
  SessionStatus,
  SessionSummary,
  SessionTurns,
  SkillInfo,
  SlashCommand,
  RoutePreference,
  Todo,
  TurnRouteOverride,
} from '@tandem/protocol';
import { ProfileStore, loadHostConfig, tandemHome } from './config.js';
import { BrowserManager } from './browser.js';
import { PreviewManager } from './preview.js';
import { DeviceManager } from './devices/manager.js';
import { CheckpointStore } from './checkpoints.js';
import { ExternalSessionStore } from './external.js';
import { Hub } from './events.js';
import { HookManager } from './hooks.js';
import type { HookExecutionContext, HookRunResult } from './hooks.js';
import { McpManager } from './mcp.js';
import { PermissionRuleStore } from './permissions.js';
import { ApprovalHistoryStore } from './approval.js';
import { SandboxSettingsStore, sandboxProfile, sandboxStatus as sandboxStatusOf } from './sandbox.js';
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
import { AiReviewManager } from './ai-review.js';
import type { DemoApi } from './demo/api.js';
import { DisabledDemoManager } from './demo/api.js';
import { IS_DEBUG_FLAVOR } from './flavor.js';
import { localHostEnv, type HostEnv } from './host-env.js';

// 演示工作区模块只在调试版加载；发布构建会连同剧本、种子与内置模型一起剔除。
const DemoManagerClass = IS_DEBUG_FLAVOR
  ? (await import('./demo/manager.js')).DemoManager
  : undefined;
import { BoardManager } from './board/manager.js';
import type { ListModelsResult } from './providers/index.js';
import { SkillManager } from './skills.js';
import { SubagentPresetStore } from './subagent-presets.js';
import { PromptTemplateStore } from './prompt-templates.js';
import { MemoryStore } from './memory.js';
import { WikiManager } from './wiki.js';
import { SecretsStore } from './secrets.js';
import { AccountsStore } from './accounts/store.js';
import { canSeeSession } from './access.js';
import type { ParsedCommand } from './agent/commands.js';
import { readVersion, type PermissionEntry } from './host/helpers.js';
import { WorkstationProfileClient } from './workstation/client.js';
import type { WorkstationModelBridge } from './workstation/bridge.js';
import type { ProxyRunner } from './providers/types.js';
import os from 'node:os';
import {
  autoTitle,
  compactSession,
  drainQueue,
  ensureRuntime,
  handleUserContent,
  interrupt,
  resumeAfterHandoff,
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
  messageBlock,
  messagePage,
  recoverAfterRestart,
  resumePausedSession,
  retryNow,
  setStatus,
  settings,
  snapshot,
  toSession,
  toSessionPaged,
  toSummary,
  turnsFor,
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
  modelPrices,
  observeBudgets,
  promptOptions,
  recordInjections,
  setContext,
} from './host/usage.js';
import {
  delegationFor,
  delegationKey,
  delegationPrompt,
  presetSummary,
  routeBiasFor,
  routeNativeFor,
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
import { estimateFor, recordKeyQuota, refreshQuota } from './host/quota.js';
import { cancelHandoff, chooseHandoff, triggerHandoff } from './host/handoff.js';
import type { ProviderRateLimit } from './providers/types.js';

export class Host {
  readonly config: HostConfig;
  readonly home: string;
  profiles: ProfileStore;
  /** 工作站模式：profiles 是账号级镜像（Key 不在本机）。 */
  mirrorProfiles = false;
  private profileClient?: WorkstationProfileClient;
  private profileSyncAt = new Map<string, number>();
  private readonly modelBridge?: WorkstationModelBridge;
  readonly store: SessionStore;
  /** 会话全文索引（Tandem + 外部会话），落盘 ~/.tandem/index/search.json。 */
  readonly searchIndex: SearchIndex;
  /** 外部会话（Claude Code / Codex）扫描缓存，只读。 */
  readonly external = new ExternalSessionStore(this);
  readonly checkpoints: CheckpointStore;
  readonly permissionRules: PermissionRuleStore;
  /** 命令沙箱与网络白名单（~/.tandem/sandbox.json）。 */
  readonly sandbox: SandboxSettingsStore;
  /** 用户为断网沙箱里的单次命令临时放行联网（toolUseId）。 */
  readonly sandboxNetworkAllow = new Set<string>();
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
  /** 项目 Wiki：自动生成的代码库说明文档（~/.tandem/wiki）。 */
  readonly wiki: WikiManager;
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
  /** 提交前 AI 评审：只读子会话、结果按行挂载与误报记忆。 */
  readonly aiReviews: AiReviewManager;
  /** 任务看板：卡片 = 后台会话，依赖/并发/审批门/重试调度。 */
  readonly boards: BoardManager;
  readonly hub = new Hub();
  /** 浏览器操作（Playwright）：每会话独立上下文，空闲 10 分钟关闭。 */
  readonly browser: BrowserManager;
  /** 应用预览：Host 上本地 Web 应用的截图流、元素点选与改完自动刷新。 */
  readonly preview: PreviewManager;
  /** 工作站设备：本机 ADB/串口、跨 Host 挂载代理、串口锁与审计。 */
  readonly devices: DeviceManager;
  /** 演示工作区：独立 demo 仓库 + 内置演示模型 + 可重播/清除的场景（仅调试版）。 */
  readonly demo: DemoApi;
  /** 跨会话收件箱（审批/回合结束/预算摘要），手机审批台的数据源。 */
  readonly inbox = new Inbox();
  readonly version: string;
  /** 项目所在机器的访问接口：本机为 localHostEnv；远端主机上下文由执行器连接换入。 */
  env: HostEnv = localHostEnv;
  /** 远端主机上下文（工作站代管的执行器主机）：只经 env 访问远端，不启动本机的外部会话扫描、MCP、演示与本机钩子。 */
  readonly remote: boolean;
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
  /** 交接「等待重置」的恢复计时器（sessionId → timeout）。 */
  handoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 分工计划待确认（planId → 等待中的 Promise）。 */
  divisionPlans = new Map<
    string,
    {
      sessionId: string;
      request: import('@tandem/protocol').DivisionPlanRequest;
      resolve: (decision: import('@tandem/protocol').DivisionPlanDecision) => void;
    }
  >();

  accounts!: AccountsStore;

  constructor(
    config?: HostConfig,
    home = tandemHome(),
    options: { remote?: boolean; modelBridge?: WorkstationModelBridge } = {},
  ) {
    this.home = home;
    this.modelBridge = options.modelBridge;
    this.remote = options.remote === true;
    this.config = config ?? loadHostConfig(home);
    this.hub.setSessionVisibility((access, sessionId) => canSeeSession(access, this.store.get(sessionId)));
    this.profiles = new ProfileStore(home);
    this.store = new SessionStore(home);
    this.searchIndex = new SearchIndex(this, home);
    // 会话写入/删除时增量更新全文索引（150ms 合并），首条搜索前也会强制 flush。
    this.store.onDirty = (rec) => this.searchIndex.touchSession(rec.id);
    this.store.onDelete = (id) => this.searchIndex.touchSession(id);
    this.checkpoints = new CheckpointStore(home);
    this.permissionRules = new PermissionRuleStore(home);
    this.sandbox = new SandboxSettingsStore(home);
    this.approvalHistory = new ApprovalHistoryStore(home);
    this.hooks = new HookManager(home);
    this.mcp = new McpManager(home, (cwd) => this.secrets.envFor(cwd, 'mcp'));
    this.skills = new SkillManager({ home });
    this.subagentPresets = new SubagentPresetStore(home);
    this.promptTemplates = new PromptTemplateStore(home);
    this.memory = new MemoryStore(home);
    this.wiki = new WikiManager(home, this);
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
    this.aiReviews = new AiReviewManager(this);
    this.boards = new BoardManager(this, home);
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
    this.preview = new PreviewManager({
      getSettings: () => this.browser.settings,
      getSessionCwd: (sessionId) => this.store.get(sessionId)?.cwd,
      listTasks: (sessionId) => this.tasks.list(sessionId),
      readTaskOutput: (taskId) => this.tasks.output(taskId, 0)?.content ?? '',
      onState: (state) => {
        this.hub.broadcastSession(state.sessionId, {
          type: 'preview_state',
          sessionId: state.sessionId,
          state,
        });
      },
    });
    this.devices = new DeviceManager(this, home);
    this.version = readVersion();
    this.accounts = new AccountsStore({
      home,
      hostId: this.config.hostId,
      hostName: os.hostname(),
      version: this.version,
      platform: process.platform,
    });
    this.accounts.onRevoked = (revoked) => {
      for (const id of Object.keys(revoked)) this.hub.disconnectMember(id);
    };
    this.accounts.start();
    // 工作站进程内的主机上下文：模型账号是账号级（Key 在工作站），主机只保存同步下来的元数据与掩码。
    if (this.modelBridge || this.accounts.mode() === 'member') {
      this.mirrorProfiles = true;
      this.profiles = new ProfileStore(home, { file: 'workstation-profiles.json', mirror: true });
    }
    // 启动时连接已启用的 MCP 服务器；失败只记录状态，不影响 Host 启动
    if (!this.remote) this.mcp.start();
    // 外部会话目录有变化时通知客户端刷新侧栏（30s 定时扫描）
    if (!this.remote) this.external.startWatching(() => this.notifyExternalSessionsChanged());
    this.demo = DemoManagerClass ? new DemoManagerClass(this) : new DisabledDemoManager();
    if (!this.remote) void this.demo.restore();
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

  sandboxStatusInfo(): SandboxStatus {
    return sandboxStatusOf(this.sandbox.get());
  }

  /** Bash 工具执行前取沙箱启动参数；断网时用户临时放行会消费掉一次 toolUseId。 */
  sandboxProfileFor(toolUseId: string) {
    const allowNetwork = this.sandboxNetworkAllow.delete(toolUseId);
    return sandboxProfile(this.sandbox.get(), allowNetwork);
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

  subagentConfig(
    parent: SessionRecord,
    presetName?: string,
    modelOverride?: string,
    role?: import('@tandem/protocol').RouteRole,
    domain?: import('@tandem/protocol').RouteDomain,
  ): { profileId: string; groupId?: string; model: string; autoRoute?: boolean; effort?: ReasoningEffort; permissionMode: PermissionMode; delegation: DelegationStrategy; toolWhitelist?: string[]; systemPromptExtra?: string; presetName?: string; routeRole?: import('@tandem/protocol').RouteRole; } {
    return subagentConfig(this, parent, presetName, modelOverride, role, domain);
  }

  keyCandidates(profileId: string, groupId?: string): { group?: StoredProfileGroup; effective?: StoredProfile; candidates: Array<{ keyId?: string; label?: string; profile: StoredProfile }>; } {
    return keyCandidates(this, profileId, groupId);
  }

  /** 刚加入工作站：立即把本机模型账号切到账号级镜像（无需重启），并迁移旧数据。 */
  async enableWorkstationProfiles(): Promise<void> {
    if (!this.mirrorProfiles) {
      this.mirrorProfiles = true;
      this.profileClient = undefined;
      this.profiles = new ProfileStore(this.home, { file: 'workstation-profiles.json', mirror: true });
    }
    const accountId = this.accounts.ownerAccountId();
    if (!accountId) return;
    await this.syncWorkstationProfiles(accountId, true).catch(() => undefined);
  }

  /** 工作站账号级模型账号客户端；本地模式或未加入工作站时为 undefined。 */
  workstationProfiles(): WorkstationProfileClient | undefined {
    if (!this.mirrorProfiles) return undefined;
    if (this.profileClient) return this.profileClient;
    if (!this.modelBridge) return undefined;
    this.profileClient = new WorkstationProfileClient({
      hostId: this.config.hostId,
      hostName: os.hostname(),
      bridge: this.modelBridge,
    });
    return this.profileClient;
  }

  /** 同步该账号的账号级模型账号元数据（Key 只在工作站）；15 秒内不重复拉取。 */
  async syncWorkstationProfiles(accountId: string, force = false): Promise<void> {
    const client = this.workstationProfiles();
    if (!client || !accountId) return;
    const last = this.profileSyncAt.get(accountId) ?? 0;
    // 进程内桥接是内存读取，每次都同步；远端同步 15 秒内不重复拉取。
    const window = this.modelBridge ? 0 : 15_000;
    if (!force && Date.now() - last < window) return;
    this.profileSyncAt.set(accountId, Date.now());
    try {
      const snapshot = await client.snapshot(accountId);
      this.profiles.applyPublicProfiles(accountId, snapshot.profiles);
    } catch (err) {
      this.profileSyncAt.delete(accountId);
      throw err;
    }
  }

  /** 会话模型请求归属的工作站账号；共享主机时用发起人的账号，缺省回落到主机主人。 */
  accountIdForSession(rec: { workspaceAccountId?: string }): string | undefined {
    return rec.workspaceAccountId ?? this.accounts.ownerAccountId();
  }

  /** 账号级模型账号的代理执行器；普通本机账号返回 undefined（直接调 provider）。 */
  profileProxyFor(rec: { workspaceAccountId?: string }): ProxyRunner | undefined {
    if (!this.mirrorProfiles) return undefined;
    const client = this.workstationProfiles();
    const accountId = this.accountIdForSession(rec);
    if (!client || !accountId) {
      console.warn(
        `[tandem] 账号级模型账号缺少代理：client=${!!client} accountId=${accountId ?? ''} mirror=${this.mirrorProfiles}`,
      );
      return undefined;
    }
    return {
      run: (body, emit, signal) => client.runProxy(accountId, body, emit, signal),
    };
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

  assertBudget(rec: SessionRecord, model: string, scope?: { profileId?: string; groupId?: string }): void {
    return assertBudget(this, rec, model, scope);
  }

  allowBudgetOnce(sessionId: string): boolean {
    return allowBudgetOnce(this, sessionId);
  }

  observeBudgets(rec: SessionRecord): void {
    return observeBudgets(this, rec);
  }

  recordKeyQuota(profileId: string, groupId: string | undefined, keyId: string | undefined, info: ProviderRateLimit): void {
    return recordKeyQuota(this, profileId, groupId, keyId, info);
  }

  estimateQuota(rec: SessionRecord): QuotaEstimate {
    return estimateFor(this, rec);
  }

  refreshQuota(rec: SessionRecord, broadcast = false): QuotaEstimate {
    return refreshQuota(this, rec, broadcast);
  }

  triggerHandoff(rec: SessionRecord, reason: HandoffReason, signal?: AbortSignal): Promise<'continue' | 'stop'> {
    return triggerHandoff(this, rec, reason, signal);
  }

  chooseHandoff(rec: SessionRecord, action: 'switch' | 'wait' | 'pause'): Promise<SessionRecord> {
    return chooseHandoff(this, rec, action);
  }

  cancelHandoff(rec: SessionRecord): void {
    return cancelHandoff(this, rec);
  }

  /** 根据 resumeAt 安排等待后的恢复；重复调用会替换旧计时器。 */
  scheduleHandoffResume(sessionId: string, delay: number): void {
    const existing = this.handoffTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.handoffTimers.delete(sessionId);
      this.resumeAfterHandoff(sessionId, 'wait');
    }, Math.max(0, delay));
    this.handoffTimers.set(sessionId, timer);
  }

  resumeAfterHandoff(sessionId: string, kind: 'switch' | 'wait'): void {
    const rec = this.store.get(sessionId);
    if (!rec) return;
    void resumeAfterHandoff(this, rec, kind);
  }

  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    return listModels(this, input);
  }

  modelCapabilities(profileId: string, groupId: string | undefined, model: string): Promise<ModelInfo | undefined> {
    return modelCapabilities(this, profileId, groupId, model);
  }

  modelPrices(profileId: string, groupId?: string) {
    return modelPrices(this, profileId, groupId);
  }

  delegationFor(rec: SessionRecord): DelegationStrategy {
    return delegationFor(this, rec);
  }

  routeBiasFor(rec: SessionRecord): RoutePreference {
    return routeBiasFor(this, rec);
  }

  routeNativeFor(rec: SessionRecord): boolean {
    return routeNativeFor(rec);
  }

  presetSummary(cwd: string): string {
    return presetSummary(this, cwd);
  }

  taskToolDescription(cwd: string, native = false): string {
    return taskToolDescription(this, cwd, native);
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
  ): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
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

  toSessionPaged(rec: SessionRecord, tail: number): Session {
    return toSessionPaged(this, rec, tail);
  }

  snapshot(
    id: string,
    tail?: number,
  ):
    | {
        session: Session;
        pendingPermissions: PermissionRequest[];
        totalMessages?: number;
        firstMessageId?: string;
        truncated?: boolean;
      }
    | undefined {
    return snapshot(this, id, tail);
  }

  messagePage(
    rec: SessionRecord,
    options: { beforeId?: string; aroundId?: string; limit?: number },
  ): MessagePage {
    return messagePage(this, rec, options);
  }

  turnsFor(rec: SessionRecord): SessionTurns {
    return turnsFor(this, rec);
  }

  messageBlock(
    rec: SessionRecord,
    lookup: { messageId?: string; index?: number; toolUseId?: string },
  ): ContentBlock | undefined {
    return messageBlock(this, rec, lookup);
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
    autoRoute?: unknown;
    routeBias?: unknown;
    permissionMode?: unknown;
    effort?: unknown;
    delegation?: unknown;
    routeNative?: unknown;
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
      autoRoute?: unknown;
      routeBias?: unknown;
      permissionMode?: unknown;
      pinned?: unknown;
      pinnedTurns?: unknown;
      archived?: unknown;
      effort?: unknown;
      delegation?: unknown;
      routeNative?: unknown;
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

  send(sessionId: string, content: ContentBlock[], route?: TurnRouteOverride): Promise<void> {
    return send(this, sessionId, content, route);
  }

  handleUserContent(rec: SessionRecord, content: ContentBlock[], route?: TurnRouteOverride): Promise<void> {
    return handleUserContent(this, rec, content, route);
  }

  sendToModel(rec: SessionRecord, content: ContentBlock[], route?: TurnRouteOverride): Promise<void> {
    return sendToModel(this, rec, content, route);
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

  runSubagent(
    parent: SessionRecord,
    input: {
      description: string;
      prompt: string;
      subagentType?: string;
      model?: string;
      role?: import('@tandem/protocol').RouteRole;
      domain?: import('@tandem/protocol').RouteDomain;
      toolUseId?: string;
    },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return runSubagent(this, parent, input, signal);
  }

  /** 换模型重跑：复制子代理的首条任务，在父会话下新建一个子代理。 */
  async rerunSubagent(childId: string, model?: string): Promise<ToolResult | undefined> {
    const child = this.store.get(childId);
    const parent = child?.parentId ? this.store.get(child.parentId) : undefined;
    if (!child || !parent) return undefined;
    if (this.ensureRuntime(parent.id).running) throw new Error('主会话正在运行，稍后再试');
    const prompt = child.messages
      .find((message) => message.role === 'user')
      ?.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!prompt) return undefined;
    const controller = new AbortController();
    return this.runSubagent(
      parent,
      {
        description: child.title,
        prompt,
        ...(model ? { model } : {}),
        ...(child.routeRole ? { role: child.routeRole } : {}),
        ...(child.parentToolUseId ? { toolUseId: child.parentToolUseId } : {}),
      },
      controller.signal,
    );
  }

  /** 改由主会话直接做：把子代理的原始任务作为用户消息发回父会话。 */
  async promoteSubagent(childId: string): Promise<boolean> {
    const child = this.store.get(childId);
    const parent = child?.parentId ? this.store.get(child.parentId) : undefined;
    if (!child || !parent) return false;
    const prompt = child.messages
      .find((message) => message.role === 'user')
      ?.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!prompt) return false;
    await this.send(
      parent.id,
      [
        {
          type: 'text',
          text: `子代理「${child.title}」已停止。请由你直接完成这个任务：\n\n${prompt}`,
        },
      ],
      { delegation: 'none' },
    );
    return true;
  }

  updateTodos(rec: SessionRecord, todos: Todo[]): void {
    return updateTodos(this, rec, todos);
  }

  // ---------- 检查点 ----------

  snapshotForCheckpoint(rec: SessionRecord, absPath: string, before: Buffer | undefined): void {
    return snapshotForCheckpoint(this, rec, absPath, before);
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

  askPermission(rec: SessionRecord, toolName: string, input: unknown, toolUseId: string, signal: AbortSignal, sandboxNotice?: import('@tandem/protocol').PermissionSandboxNotice): Promise<{ allowed: boolean; reason?: string; decision?: PermissionDecision }> {
    return askPermission(this, rec, toolName, input, toolUseId, signal, sandboxNotice);
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

  appendNotice(
    rec: SessionRecord,
    text: string,
    route?: import('@tandem/protocol').ModelRouteDecision,
    routePlan?: import('@tandem/protocol').RoutePlan,
  ): void {
    return appendNotice(this, rec, text, route, routePlan);
  }

  /** 等待用户处理分工计划卡；中断时返回 cancel。 */
  waitDivisionPlan(
    rec: SessionRecord,
    request: import('@tandem/protocol').DivisionPlanRequest,
    signal: AbortSignal,
  ): Promise<import('@tandem/protocol').DivisionPlanDecision> {
    return new Promise((resolve) => {
      const done = (decision: import('@tandem/protocol').DivisionPlanDecision) => {
        this.divisionPlans.delete(request.id);
        resolve(decision);
      };
      this.divisionPlans.set(request.id, { sessionId: rec.id, request, resolve: done });
      if (signal.aborted) done({ action: 'cancel' });
      else signal.addEventListener('abort', () => done({ action: 'cancel' }), { once: true });
    });
  }

  resolveDivisionPlan(
    planId: string,
    decision: import('@tandem/protocol').DivisionPlanDecision,
  ): boolean {
    const pending = this.divisionPlans.get(planId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
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
    for (const timer of this.handoffTimers.values()) clearTimeout(timer);
    this.handoffTimers.clear();
    this.tasks.dispose();
    this.wiki.dispose();
    this.secrets.dispose();
    this.schedules.dispose();
    this.boards.dispose();
    this.devices.dispose();
    this.external.stopWatching();
    this.store.flush();
    this.searchIndex.flush();
    this.usage.flush();
    await this.browser.dispose();
    await this.preview.dispose();
    await this.mcp.close();
  }
}

/** 供 server 复用（实现见 host/helpers.ts）。 */
export { defaultBaseUrlFor } from './host/helpers.js';
export type { ParsedCommand };
