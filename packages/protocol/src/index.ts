// Tandem 协议：host 守护进程（server）与各端客户端（web/桌面/手机）之间的契约。
// REST 用于 CRUD，WebSocket (/ws) 用于实时事件。所有请求带 Authorization: Bearer <hostToken>
// （WebSocket 用 ?token=）。

// ---------- 账号 / Key / 模型 ----------
export type ProviderKind =
  | 'anthropic'          // Anthropic Messages API
  | 'openai'             // OpenAI Chat Completions
  | 'openai-compatible'  // DeepSeek / Qwen / Moonshot / OpenRouter / Ollama 等兼容接口
  | 'gemini';            // Google Gemini (走 OpenAI 兼容端点)

/** 单个模型的能力覆盖；缺省字段按 provider 能力或内置表推断。 */
export interface ModelCapabilities {
  efforts?: ReasoningEffort[];
  contextWindow?: number;
}

export interface Profile {
  id: string;
  name: string;            // 显示名，如 "公司 Anthropic"、"个人 OpenAI"
  kind: ProviderKind;
  baseUrl?: string;        // 自定义端点
  apiKeyMasked: string;    // 只回传掩码，明文 key 永不下发给客户端
  models: string[];        // 该账号可选模型（无分组时使用）
  defaultModel: string;
  price?: Record<string, { input: number; output: number }>; // 每百万 token 美元，按模型覆盖内置单价
  modelCapabilities?: Record<string, ModelCapabilities>; // 手动覆盖模型能力（思考强度/上下文）
  groups?: ProfileGroup[]; // 分组：同一账号（同一服务商/中转站）下多组 key，各自可用模型不同，如 "官方渠道"/"低价渠道"
  createdAt: number;
}
/** 同组多 Key 的调度策略：按顺序优先（failover，默认）或轮询（round_robin）。 */
export type KeyStrategy = 'failover' | 'round_robin';
/** 分组里的一个 Key。明文只存在 Host 的 profiles.json，接口只回掩码与运行状态。 */
export interface ProfileKey {
  id: string;
  label?: string;
  apiKeyMasked: string;
  /** 401/403 后自动置位，需用户在设置里手动启用。 */
  disabled?: boolean;
  /** 冷却截止时间（epoch ms）；429/额度不足/5xx 后指数退避 60s→30min。 */
  cooldownUntil?: number;
  /** 最近一次失败的可读原因。 */
  lastError?: string;
}
export interface ProfileKeyInput { id?: string; label?: string; apiKey?: string; disabled?: boolean } // 带 id 不带 apiKey 表示保留原 key；disabled=false 表示手动重新启用
export interface ProfileGroup {
  id: string;
  name: string;
  kind?: ProviderKind;     // 该分组使用的协议；缺省继承账号 kind。同一中转 URL 下不同分组可走不同协议
  apiKeyMasked: string;    // 兼容字段：第一个 Key 的掩码
  keys: ProfileKey[];      // 同组多 Key（按顺序 failover / round_robin）
  keyStrategy?: KeyStrategy;
  baseUrl?: string;        // 缺省用账号 baseUrl
  models: string[];
  defaultModel: string;
  modelCapabilities?: Record<string, ModelCapabilities>;
}
export interface ProfileGroupInput { id?: string; name: string; kind?: ProviderKind; apiKey?: string; /** 旧的单 Key 字段，等价于 apiKeys=[{apiKey}] */ apiKeys?: ProfileKeyInput[]; keyStrategy?: KeyStrategy; baseUrl?: string; models: string[]; defaultModel: string; modelCapabilities?: Record<string, ModelCapabilities> }
export interface ProfileInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;         // 更新时不传表示不改
  models: string[];
  defaultModel: string;
  price?: Record<string, { input: number; output: number }>;
  modelCapabilities?: Record<string, ModelCapabilities>;
  groups?: ProfileGroupInput[]; // 传入即整体替换；带 id 且不带 apiKey 表示保留原 key
}

// ---------- 会话 ----------
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'retrying' | 'error';
/** 委派策略：会话级控制主会话如何/是否使用 Task 子代理。 */
export type DelegationStrategy = 'orchestrate' | 'more' | 'less' | 'none';

export interface RetryInfo {
  /** 第几次重试（从 1 开始）。 */
  attempt: number;
  /** 下一次重试的时间（epoch ms）。 */
  nextAt: number;
  /** 最近一次失败原因（已截断）。 */
  lastError?: string;
}
export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;             // 会话工作目录（在 host 机器上）
  profileId: string;
  groupId?: string;        // 选用账号下的哪个分组（无分组账号不填）
  model: string;
  permissionMode: PermissionMode;
  effort?: ReasoningEffort; // 思考强度：映射到 Anthropic thinking budget / OpenAI reasoning_effort；模型不支持时忽略
  /** 委派策略；缺省按 Host 设置（默认 less）。 */
  delegation?: DelegationStrategy;
  status: SessionStatus;
  /** 模型请求因网络错误/超时连续失败后进入「等待网络」：下一次重试时间与原因。 */
  retryInfo?: RetryInfo;
  /** Host 重启后检测到未完成运行，按设置暂停等待用户确认（POST /api/sessions/:id/resume）。 */
  resumePaused?: boolean;
  pinned?: boolean;        // 置顶
  pinnedTurns?: string[];  // 被 pin 的轮次（用户消息 id），轮次导航中特殊显示
  archived?: boolean;      // 归档（列表默认隐藏）
  env?: SessionEnv;        // 会话执行环境，用于侧栏按 项目/分支 自动归类
  importedFrom?: { source: ExternalSource; id: string }; // 从 Claude Code / Codex 导入的副本
  forkedFrom?: { sessionId: string; messageId?: string; title?: string }; // 分叉来源：会话页显示「分叉自」，父会话在分叉点显示子会话入口
  scheduledBy?: { id: string; name: string }; // 由定时任务创建；侧栏显示小时钟，tooltip 为任务名
  parentId?: string;       // Task 子代理会话指向主会话（孙代理指向子代理）
  depth?: number;          // 0 主会话 / 1 子代理 / 2 孙代理…；侧栏只显示主会话（parentId 为空）
  worktree?: { path: string; branch: string; baseBranch: string }; // 隔离分支会话
  createdAt: number;
  updatedAt: number;
  usage: Usage;
  /** 最近一次请求的上下文占用（随 session_updated 推送，也可 GET /api/sessions/:id/context）。 */
  context?: ContextBreakdown;
}
export interface SessionEnv {
  repoRoot?: string;       // cwd 所在 git 仓库根目录（非仓库则无）
  repoName?: string;       // 仓库名（根目录 basename）
  branch?: string;         // 当前分支
}
export interface Usage {
  inputTokens: number;       // 未命中缓存的输入
  outputTokens: number;
  cacheReadTokens?: number;  // 命中缓存读取（Anthropic cache_read_input_tokens / OpenAI cached_tokens）
  cacheWriteTokens?: number; // 写入缓存（Anthropic cache_creation_input_tokens）
  reasoningTokens?: number;  // 输出中的推理 token（OpenAI reasoning_tokens 等，已含在 outputTokens 内）
  costUsd?: number;
  keyId?: string;            // 本轮实际使用的分组 Key id（多 Key 切换后便于统计）
}
// 上下文占用（参考 Claude Code /context）：最近一次请求实际发送给模型的组成估算
export interface ContextBreakdown {
  model: string;
  contextWindow: number;     // 模型上下文上限
  usedTokens: number;        // 最近一次请求的输入总量（含缓存）
  parts: { kind: 'system' | 'tools' | 'mcp' | 'memory' | 'messages' | 'tool_results' | 'free'; tokens: number }[];
  cacheHitRate?: number;     // 本会话累计：cacheRead / (input + cacheRead + cacheWrite)
  updatedAt: number;
}

export interface CreateSessionInput {
  cwd: string;
  profileId: string;
  groupId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: ReasoningEffort;
  delegation?: DelegationStrategy;
  title?: string;
  worktree?: { branch?: string };
}
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';
// cwd：会话中途切换工作目录（下一轮生效，重新检测 env）
export type UpdateSessionInput = Partial<Pick<SessionSummary, 'title' | 'profileId' | 'groupId' | 'model' | 'permissionMode' | 'pinned' | 'archived' | 'effort' | 'delegation' | 'cwd' | 'pinnedTurns'>>;

// ---------- 外部会话（本机已有的 Claude Code / Codex 会话） ----------
// 原则：只读原软件的文件，绝不写回；"导入"= 复制成 Tandem 会话后继续（可换任意模型）。
export type ExternalSource = 'claude-code' | 'codex';
export interface ExternalSession {
  source: ExternalSource;
  id: string;              // 原软件的会话 id
  title: string;           // 首条用户消息摘要
  cwd: string;
  updatedAt: number;
  messageCount: number;
  importedSessionId?: string; // 已导入过则给出对应 Tandem 会话 id
}

// ---------- 配置迁移（换电脑不用重配） ----------
// 导出包含账号（含明文 key）与客户端设置，用用户口令加密（scrypt + AES-256-GCM）。
export interface ConfigBundle { version: 1; encrypted: string; salt: string; iv: string; createdAt: number; hostName: string }
export interface ConfigExportInput { passphrase: string; clientSettings?: unknown } // clientSettings：客户端的 Host 列表、主题等，原样打包
export interface ConfigImportInput { passphrase: string; bundle: ConfigBundle; mode: 'merge' | 'replace' }
export interface ConfigImportResult { profilesAdded: number; profilesUpdated: number; clientSettings?: unknown; memoriesImported?: number }

// 拉取模型列表：填 Key 后自动获取可用模型（无需手填）
export interface ListModelsInput { kind: ProviderKind; baseUrl?: string; apiKey?: string; profileId?: string; groupId?: string } // apiKey 缺省时用 profileId 已存的 key
export interface ModelInfo {
  id: string; displayName?: string; contextWindow?: number;
  efforts?: ReasoningEffort[]; // 该模型支持的思考强度档位；缺省表示未知（客户端按 provider 默认显示）；[] 表示不支持思考
}
// 思考强度能力来源：provider 模型列表接口若提供（如 OpenRouter supported_parameters、Anthropic models 的 capabilities）则用之；
// 否则 Host 内置能力表按模型 id 前缀匹配（如 claude-*-4/4.5/5 支持 thinking；o1/o3/o4/gpt-5 系列支持 reasoning_effort；deepseek-reasoner 不可调）。
// GET /api/models/capabilities?profileId=&groupId=&model= -> ModelInfo   单个模型的能力（含 efforts、contextWindow）
// GET /api/sessions/:id/context -> ContextBreakdown

// ---------- 消息 ----------
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** 外部会话里系统注入的上下文（AGENTS.md、skills_instructions 等），前端折叠展示。 */
  | { type: 'context'; kind: string; text: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  createdAt: number;
  model?: string;
  /** 服务端记录的低调提示（如模型不支持思考强度），界面以单行灰字展示。 */
  notice?: boolean;
  usage?: Usage;             // assistant 消息：生成该消息的那次请求的用量与花费（一轮内多次请求各自记在对应消息上）
}

export interface Session extends SessionSummary { messages: Message[]; todos: Todo[]; plan?: SessionPlan }

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }

// ---------- 工具权限 ----------
export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  description: string;     // 人类可读描述，如 "运行命令: npm test"
  depth?: number;          // 冒泡来源层级：1 子代理 / 2 孙代理；主会话请求不填
  sourceTitle?: string;    // 冒泡来源会话标题，用于审批卡标注
}
// ExitPlanMode 的决策语义：allow_always = 批准并自动接受编辑（acceptEdits）；
// allow = 批准但逐个询问（default）；deny 可带 reason（用户要求继续完善计划）。
export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

// ---------- Hooks（兼容 Claude Code 配置形状） ----------
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';
/** tandem 可编辑；其余三个来自 Claude Code 的只读配置。 */
export type HookSource = 'tandem' | 'claude-user' | 'claude-project' | 'claude-project-local';
export interface HookEntry {
  id: string;
  event: HookEvent;
  matcher?: string;          // 工具名正则，可用 | 分隔；留空匹配全部
  command: string;
  timeout?: number;          // 秒，默认 60
  source: HookSource;
}
export interface HookSourceInfo {
  source: HookSource;
  path: string;
  readOnly: boolean;
  exists: boolean;
}
export interface HookSettings {
  cwd?: string;
  entries: HookEntry[];
  sources: HookSourceInfo[];
  hasProjectHooks: boolean;
  /** 项目目录 hooks 需先信任才会执行；信任列表存 ~/.tandem/hooks-trust.json。 */
  projectTrusted: boolean;
}
/** Hook 执行记录：客户端只在 blocked / !ok 时以灰色单行展示。 */
export interface HookEventNotice {
  sessionId: string;
  event: HookEvent;
  name: string;              // 命令名（如 lint.sh）
  ok: boolean;               // 命令是否正常退出（decision=block 仍算 ok）
  durationMs: number;
  blocked?: boolean;
  message?: string;          // stderr / JSON reason / 超时信息
}

// ---------- 计划模式 ----------
export interface SessionPlan {
  content: string;           // markdown
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
  approvalMode?: 'acceptEdits' | 'default';
}

// ---------- Host 信息 ----------
export interface HostInfo {
  id: string;
  name: string;            // 机器名
  platform: string;        // linux / win32 / darwin
  version: string;
  homeDir: string;
}

/** 语音输入（Host 本机 Whisper）配置。只保存路径，不保存任何音频/文本。 */
export interface VoiceSettings {
  /** auto：按可执行文件名判断；也可强制 whisper-cpp / faster-whisper。 */
  engine?: 'auto' | 'whisper-cpp' | 'faster-whisper';
  /** whisper.cpp 的 whisper-cli/main；faster-whisper 模式填 python 解释器。留空自动探测 PATH。 */
  binaryPath?: string;
  /** whisper.cpp 的 ggml-*.bin 模型文件；faster-whisper 模式填模型名（如 small）或本地目录。 */
  modelPath?: string;
  /** 识别语言，默认 zh。 */
  language?: string;
}

/** Host 行为设置（~/.tandem/config.json，跨端共享）。 */
export interface HostSettings {
  /** Host 重启后对未完成会话的处理：自动继续 / 恢复为暂停等我确认。 */
  resumeOnRestart: 'auto' | 'pause';
  /** 新会话默认委派策略。 */
  defaultDelegation?: DelegationStrategy;
  /** 本机语音转写配置；未配置时客户端隐藏 Host 转写方式。 */
  voice?: VoiceSettings;
}
// GET  /api/settings -> HostSettings
// PUT  /api/settings HostSettings -> HostSettings

/** GET /api/stt/capabilities：本机 Whisper 探测结果，用于设置页展示与客户端降级。 */
export interface SttCapabilities {
  configured: boolean;
  available: boolean;
  engine: 'whisper-cpp' | 'faster-whisper' | null;
  binaryPath?: string;
  modelPath?: string;
  language: string;
  /** 自动探测到的其他候选（只用于提示）。 */
  detected: Array<{ engine: 'whisper-cpp' | 'faster-whisper'; binaryPath: string; note?: string }>;
  /** 不可用原因（缺模型/二进制不存在等）。 */
  error?: string;
}
/** POST /api/stt { audioBase64, mimeType?, language? } -> SttResult */
export interface SttInput {
  audioBase64: string;
  mimeType?: string;
  language?: string;
}
export interface SttResult {
  ok: true;
  text: string;
  engine: 'whisper-cpp' | 'faster-whisper';
  elapsedMs: number;
}
/** POST /api/stt/test -> SttTestResult（跑一段 1 秒静音，验证可执行文件与模型可用） */
export interface SttTestResult {
  ok: boolean;
  text?: string;
  engine?: 'whisper-cpp' | 'faster-whisper';
  elapsedMs: number;
  error?: string;
}
// POST /api/sessions/:id/resume -> SessionSummary  恢复被暂停的重启会话

export interface FsEntry { name: string; path: string; isDir: boolean }

export interface FsReadResult {
  path: string;            // 解析后的绝对路径
  content: string;
  truncated: boolean;      // 超过 1MB 时截断
  isBinary: boolean;
  size: number;
  language?: string;       // 按扩展名推断的 highlight.js 语言
}

export interface FsRevealResult { ok: boolean; error?: string }

// ---------- 预算（Host 级，存 ~/.tandem/budgets.json；基于 usage.json 实时累计） ----------
export type BudgetScope = 'global' | 'account' | 'group' | 'model';
export type BudgetPeriod = 'day' | 'week' | 'month';
export type BudgetAction = 'warn' | 'block';
export interface BudgetRule {
  id: string;
  scope: BudgetScope;
  /** account / group 范围对应的账号；group 还需 profileId + groupId。 */
  profileId?: string;
  groupId?: string;
  /** model 范围对应的模型名。 */
  model?: string;
  period: BudgetPeriod;     // 自然日 / 本周（周一起）/ 本月
  limitUsd: number;
  action: BudgetAction;     // warn=仅提醒（80%/100%），block=达到 100% 拒绝新请求
  enabled?: boolean;        // 缺省 true
  label?: string;
}
export interface BudgetStatus {
  ruleId: string;
  scope: BudgetScope;
  profileId?: string;
  groupId?: string;
  model?: string;
  period: BudgetPeriod;
  limitUsd: number;
  spentUsd: number;
  percent: number;          // spentUsd / limitUsd * 100，可为 0–100+
  level?: '80' | '100';     // 已达到的告警档位
  action: BudgetAction;
  blocked: boolean;         // 当前是否会拒绝新请求（action=block 且百分比 ≥100）
  resetAt: number;          // 下个周期起点（epoch ms）
}
export interface BudgetAlert {
  ruleId: string;
  scope: BudgetScope;
  spentUsd: number;
  limitUsd: number;
  level: '80' | '100';
  profileId?: string;
  groupId?: string;
  model?: string;
  period: BudgetPeriod;
  action: BudgetAction;
}
// GET /api/budgets -> BudgetRule[]    PUT /api/budgets BudgetRule[] -> BudgetRule[]（整体替换）
// GET /api/budgets/status -> BudgetStatus[]   各规则当前周期用量、百分比与是否阻止
// POST /api/sessions/:id/budget-allow-once -> { ok: boolean }   block 预算下临时放行一次（下一次模型请求后失效）

// ---------- 收件箱（跨会话的“需要我”事件流） ----------
// 客户端连上 WS 后发 subscribe_inbox，服务端把全 Host 的审批/回合结束/预算等摘要推给该连接。
// 事件按 Host 内全局 seq 单调递增，客户端重连时带 sinceSeq 补齐；缓冲不覆盖则收到 inbox_snapshot。
export type InboxEventKind = 'permission' | 'permission_resolved' | 'turn_end' | 'budget' | 'ci'
export interface InboxEvent {
  seq: number;
  kind: InboxEventKind;
  at: number;
  /** 来源会话；预算告警等 Host 级事件可缺省。 */
  sessionId?: string;
  sessionTitle?: string;
  /** 审批来自子代理/孙代理时的来源标题与层级。 */
  sourceTitle?: string;
  depth?: number;
  /** kind=permission 时为完整审批请求（ExitPlanMode 的计划内容在 input.plan）。 */
  permission?: PermissionRequest;
  /** 是计划待批准（ExitPlanMode），客户端显示为「计划审批」。 */
  plan?: boolean;
  requestId?: string;
  decision?: PermissionDecision;
  turnReason?: 'done' | 'interrupted' | 'error';
  error?: string;
  budget?: BudgetAlert;
  /** 预算告警绑定的会话（触发本次用量的会话）。 */
  budgetSessionId?: string;
  budgetSessionTitle?: string;
  /** 预算告警的可读描述，如「今日 公司 Anthropic 预算已用 80%」。 */
  budgetText?: string;
  /** kind=ci：PR 状态 / CI 检查变化。 */
  ci?: {
    prNumber: number;
    prUrl: string;
    checksState?: PrChecksState;
    checkName?: string;
    /** 可读描述，如「PR #12 CI 失败：build」。 */
    text: string;
  };
}
export interface InboxSnapshot {
  /** Host 当前收件箱 seq；客户端记录用于下次 sinceSeq。 */
  seq: number;
  /** 最近的事件（按 seq 升序，最多数百条）。 */
  events: InboxEvent[];
  /** 当前仍未处理的审批（服务端权威状态，包含事件缓冲里已被挤掉的旧请求）。 */
  pending: InboxEvent[];
}

// ---------- WebSocket: 客户端 -> 服务端 ----------
export type ClientMsg =
  | { type: 'subscribe'; sessionId: string; sinceSeq?: number } // 订阅；带 sinceSeq 时服务端补发 seq>sinceSeq 的事件（缓冲不够则改发 snapshot）
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'subscribe_inbox'; sinceSeq?: number } // 订阅全 Host 收件箱；带 sinceSeq 时先补发
  | { type: 'unsubscribe_inbox' }
  | { type: 'send'; sessionId: string; content: ContentBlock[] }  // 发送用户消息；运行中发送则排队
  | { type: 'interrupt'; sessionId: string }        // 中断当前轮（Esc）
  | { type: 'retry_now'; sessionId: string }        // 等待网络重试期间立即重试
  | { type: 'permission'; requestId: string; decision: PermissionDecision; reason?: string } // reason 仅用于 ExitPlanMode 的“继续完善”反馈
  | { type: 'ping' };

// ---------- WebSocket: 服务端 -> 客户端 ----------
export type ServerMsg =
  | { type: 'hello'; host: HostInfo }
  | { type: 'session_snapshot'; session: Session; pendingPermissions: PermissionRequest[] } // subscribe 后先下发全量
  | { type: 'session_updated'; session: SessionSummary }   // 广播给所有连接（用于列表刷新）
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'message_start'; sessionId: string; message: Message }       // 新消息（用户消息也走这里，用于多端同步）
  | { type: 'block_delta'; sessionId: string; messageId: string; index: number; delta: BlockDelta }
  | { type: 'message_end'; sessionId: string; message: Message }         // 最终完整消息，客户端以此为准覆盖
  | { type: 'permission_request'; request: PermissionRequest; sessionId?: string } // sessionId=广播所属会话（子代理冒泡时为主会话），供客户端按会话 seq 排序
  | { type: 'permission_resolved'; requestId: string; sessionId: string; decision: PermissionDecision }
  | { type: 'todos'; sessionId: string; todos: Todo[] }
  | { type: 'plan'; sessionId: string; plan?: SessionPlan }                 // 计划提交/批准/拒绝
  | ({ type: 'hook_event' } & HookEventNotice)                              // Hook 执行记录（成功默认不展示）
  | ({ type: 'budget_alert' } & BudgetAlert)                                // 预算告警：全局广播，触发会话内同时插 notice
  | { type: 'turn_end'; sessionId: string; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { type: 'inbox_snapshot'; snapshot: InboxSnapshot }                     // 订阅收件箱后的全量（或补齐失败时）
  | { type: 'inbox_event'; event: InboxEvent }                             // 收件箱增量事件
  | { type: 'vcs_updated'; sessionId: string; state: VcsState }            // 当前会话 PR/CI 状态变化（60s 轮询）
  | { type: 'injections'; sessionId: string; injections: InjectionSnapshot } // 本轮系统提示的注入段落清单/变化
  // 外部会话（Claude Code / Codex）文件有变动，客户端应重新拉取列表
  | { type: 'task_updated'; sessionId: string; task: BackgroundTask; content?: string; since?: number; truncated?: boolean }
  | { type: 'schedules_updated' }
  | { type: 'external_sessions_changed' }
  | { type: 'error'; message: string }
  | { type: 'pong' };

// 会话级事件序号：所有带 sessionId 的 ServerMsg 都附带 seq（单会话内单调递增），客户端记录最后 seq 用于断线重放。
export type SeqServerMsg = ServerMsg & { seq?: number };

export type BlockDelta =
  | { kind: 'block_start'; block: ContentBlock }     // 新 block 出现（tool_use 时 input 可能为空对象）
  | { kind: 'text'; text: string }                   // 追加到 text/thinking block
  | { kind: 'tool_input'; partialJson: string };     // 追加 tool_use 的入参 JSON 片段

// ---------- REST 端点约定 ----------
// GET    /api/host                    -> HostInfo
// GET    /api/profiles                -> Profile[]
// POST   /api/profiles  ProfileInput  -> Profile
// PUT    /api/profiles/:id            -> Profile
// DELETE /api/profiles/:id
// POST   /api/profiles/:id/test       -> { ok: boolean; error?: string }   测试 key 可用（body: { groupId?, keyId? }，缺省测分组当前可用 Key）
// POST   /api/models  ListModelsInput -> { ok: boolean; models: ModelInfo[]; error?: string }  从 provider 拉取模型列表
// GET    /api/sessions                -> SessionSummary[]   (按 updatedAt 倒序)
// POST   /api/sessions CreateSessionInput -> SessionSummary
// GET    /api/sessions/:id            -> Session
// PATCH  /api/sessions/:id UpdateSessionInput -> SessionSummary  (运行中切换模型/账号：下一轮生效)
// DELETE /api/sessions/:id
// POST   /api/sessions/:id/fork { messageId? } -> SessionSummary   分叉：复制到 messageId（含）为止的历史为新会话，写 forkedFrom；缺省复制全部
// GET    /api/sessions/:id/branches   -> { current?: string; branches: string[] }   cwd 所在仓库的本地分支
// POST   /api/sessions/:id/checkout { branch, create?: boolean } -> SessionSummary  会话中途切换分支（有未提交改动时 409）
// POST   /api/sessions/:id/worktree { branch? } -> SessionSummary  会话中途切到新 worktree 中继续（之后的工具都在 worktree 内执行）
// GET    /api/sessions/:id/export     -> Session（完整）   POST /api/sessions/import { session: Session; cwd?: string } -> SessionSummary
//        跨 Host 迁移会话：客户端从 A 导出、向 B 导入（cwd 可改为 B 上的目录），实现"中途更换主机"
// GET    /api/fs/list?path=           -> FsEntry[]   目录选择器
// GET    /api/fs/complete?cwd=&q=     -> string[]    @文件 补全（相对 cwd 的路径）
// GET    /api/external-sessions?source=   -> ExternalSession[]    扫描 ~/.claude/projects、~/.codex/sessions
// GET    /api/external-sessions/:source/:id -> Session            只读预览（转换为 Tandem 消息格式）
// POST   /api/external-sessions/:source/:id/import -> SessionSummary  复制为 Tandem 会话
// POST   /api/config/export ConfigExportInput -> ConfigBundle
// POST   /api/config/import ConfigImportInput -> ConfigImportResult
// GET    /api/fs/read?path=&cwd=        -> { path: string; content: string; truncated: boolean; isBinary: boolean; size: number; language?: string }
//        文件预览：path 可为绝对路径或相对 cwd；限制在 Host 用户可读范围内，>1MB 截断
// POST   /api/fs/reveal { path }       -> { ok: boolean }  在 Host 本机用系统文件管理器/编辑器打开（仅当客户端与 Host 同机时有意义）
// GET    /api/commands                -> SlashCommand[]   （含用户可调用的 skills，source 为 skill）
export interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'project' | 'user' | 'skill';
}

// ---------- Skills（兼容 Claude Code 的 SKILL.md） ----------
/** 来源：~/.claude/skills、<cwd>/.claude/skills、~/.tandem/skills、~/.claude/plugins 下的 skills。 */
export type SkillSource = 'user' | 'project' | 'tandem' | 'plugin';
export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  /** SKILL.md 的绝对路径（原文件只读，启用状态另存 ~/.tandem/skills-state.json）。 */
  path: string;
  /** 技能目录，用于继续 Read 附带的脚本/模板。 */
  dir: string;
  enabled: boolean;
  /** frontmatter 中 disable-model-invocation 为真时不写入系统提示，仅可 /<name> 调用。 */
  modelInvocable: boolean;
  /** frontmatter 中 user-invocable 为假时不出现在 / 菜单。 */
  userInvocable: boolean;
  /** 可选的 allowed-tools 声明（仅展示，权限仍由 Tandem 的审批/规则决定）。 */
  allowedTools?: string[];
}
// GET /api/skills?cwd=                     -> SkillInfo[]   扫描并合并各来源（同名时 project > tandem > user > plugin）
// PUT /api/skills/state { disabled, cwd? } -> SkillInfo[]   停用列表按绝对路径存 ~/.tandem/skills-state.json，不改原文件

// ---------- 检查点（每轮开始前对本轮将改动的文件做快照） ----------
export interface Checkpoint {
  id: string;
  sessionId: string;
  messageId: string;       // 触发本轮的用户消息 id
  createdAt: number;
  files: { path: string; existed: boolean }[]; // 本轮被 Write/Edit 改动的文件（相对 cwd）
}
export interface RewindInput { checkpointId: string; restoreFiles: boolean; restoreConversation: boolean }
// GET  /api/sessions/:id/checkpoints -> Checkpoint[]
// POST /api/sessions/:id/rewind RewindInput -> Session   恢复到该用户消息之前（文件和/或对话）

// ---------- Hooks ----------
// GET  /api/hooks?cwd=            -> HookSettings   汇总 ~/.claude、<cwd>/.claude 与 ~/.tandem/hooks.json
// PUT  /api/hooks { cwd?, entries } -> HookSettings  只写 ~/.tandem/hooks.json（entries 为 tandem 来源的扁平条目）
// PUT  /api/hooks/trust { cwd, trusted } -> HookSettings  项目 hooks 信任列表（~/.tandem/hooks-trust.json）

// ---------- 改动审阅（git 工作区） ----------
export interface FileChange { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; additions: number; deletions: number; oldPath?: string }
export interface ChangesResult { isRepo: boolean; branch?: string; files: FileChange[] }
/** 单文件 diff 为空时的原因：仅文件模式变化 / 仅换行符或空白变化 / 仅重命名 / 确实没有差异。 */
export type DiffEmptyReason = 'mode' | 'eol' | 'rename' | 'none'
// GET  /api/sessions/:id/changes                 -> ChangesResult
// GET  /api/sessions/:id/changes/diff?path=      -> { path: string; diff: string; emptyReason?: DiffEmptyReason }  (统一 diff 文本)
// POST /api/sessions/:id/changes/revert {paths}  -> ChangesResult  丢弃这些文件的工作区改动
// POST /api/sessions/:id/changes/commit {message, paths?} -> { ok: boolean; commit?: string; error?: string }
// 行内评论：客户端把评论拼成一条用户消息发送（"关于 src/a.ts 第 12 行：..."），无需新接口。

// ---------- VCS / PR / CI ----------
// Host 通过本机已安装并登录的 GitHub CLI (gh) / GitLab CLI (glab) 操作远程仓库，
// 不在 Host 内保存任何托管平台令牌。
export type VcsProvider = 'github' | 'gitlab' | 'none' | 'other';
export interface VcsCapability {
  isRepo: boolean;
  /** 仓库根目录（Host 机器上的绝对路径）。 */
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  provider: VcsProvider;
  /** 远程主机名（如 github.com），不返回完整 remote URL。 */
  remoteHost?: string;
  cli: 'gh' | 'glab' | 'none';
  cliInstalled: boolean;
  authenticated: boolean;
  /** 已登录的 CLI 用户名。 */
  cliUser?: string;
  /** 安装/登录官方文档链接。 */
  docUrl?: string;
  error?: string;
}
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT' | 'UNKNOWN';
export type PrCheckStatus =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'pending'
  | 'unknown';
export interface PrCheck {
  name: string;
  status: PrCheckStatus;
  conclusion?: string;
  durationMs?: number;
  url?: string;
  workflow?: string;
  /** CI 提供方的运行 id（gh run view 用）。 */
  runId?: string;
}
export type PrChecksState = 'none' | 'pending' | 'success' | 'failure' | 'unknown';
export interface PullRequestInfo {
  number: number;
  title: string;
  state: PrState;
  url: string;
  isDraft: boolean;
  reviewDecision?: string;
  mergeable?: string;
  baseRefName?: string;
  headRefName?: string;
  updatedAt?: number;
  checks: PrCheck[];
  checksState: PrChecksState;
}
export interface VcsState {
  vcs: VcsCapability;
  pr?: PullRequestInfo;
}
export interface CreatePrInput {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
}
export type PrMergeMethod = 'squash' | 'merge' | 'rebase';
export interface PrActionResult {
  ok: boolean;
  error?: string;
  state?: VcsState;
}
// GET  /api/sessions/:id/vcs            -> VcsState   仓库/分支/上游/CLI 能力与当前分支 PR
// GET  /api/sessions/:id/pr             -> VcsState   同 vcs（语义化别名，供 PR 面板刷新）
// POST /api/sessions/:id/pr CreatePrInput -> PrActionResult
//        先 git push -u origin HEAD，再 gh pr create / glab mr create；客户端须二次确认
// POST /api/sessions/:id/pr/merge { method: PrMergeMethod } -> PrActionResult
// POST /api/sessions/:id/pr/fix { checkName, url?, runId? } -> { ok; sent?: boolean; error? }
//        读取失败日志（gh run view <id> --log-failed，截断）并作为用户消息发给当前会话
// WS: vcs_updated   当前会话 PR 状态变化（Host 每 60s 轮询有 PR 且被订阅的会话）

// ---------- 权限规则（Host 级，存 ~/.tandem/permissions.json；会话级 allow_always 仍保留） ----------
export interface PermissionRule { tool: string; pattern?: string; action: 'allow' | 'ask' | 'deny' } // pattern：Bash 为命令前缀通配，如 "npm test*"；文件工具为 glob
// GET /api/permissions -> PermissionRule[]   PUT /api/permissions PermissionRule[]   优先级 deny > ask > allow

// ---------- MCP（Host 级，存 ~/.tandem/mcp.json；同时只读兼容 ~/.claude.json 与项目 .mcp.json） ----------
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string; args?: string[]; env?: Record<string, string>; // stdio
  url?: string; headers?: Record<string, string>;                  // http（Streamable HTTP）
  enabled: boolean;
  source?: 'tandem' | 'claude' | 'project';                       // 来源；非 tandem 的只读
}
export interface McpServerStatus { name: string; status: 'connected' | 'connecting' | 'error' | 'disabled'; error?: string; tools: string[]; source: McpServerConfig['source'] }
// GET /api/mcp -> { servers: McpServerConfig[]; status: McpServerStatus[] }   PUT /api/mcp McpServerConfig[]（只含 tandem 来源）
// MCP 工具在 agent 中命名为 mcp__<server>__<tool>，默认需审批，可用权限规则放行。

// ---------- 子代理（Task 工具） ----------
// 主会话调用 Task 工具时创建子会话（SessionSummary.parentId 指向主会话），子会话的消息流照常广播，权限请求冒泡到主会话订阅者。
// SessionSummary 新增可选字段：parentId?: string; worktree?: { path: string; branch: string; baseBranch: string }

// ---------- 子代理预设（跨模型子代理） ----------
// 预设的 name 直接作为 Task 工具的 subagent_type 暴露给模型；子代理可换账号/分组/模型/effort/权限/工具白名单。
// 兼容只读扫描 ~/.claude/agents/*.md 与项目 .claude/agents/*.md（frontmatter: name、description、tools、model）。
export type SubagentPresetSource = 'tandem' | 'claude' | 'project';
export interface SubagentPreset {
  id: string;
  name: string;
  description: string;
  profileId?: string;
  groupId?: string;
  /** 显式模型名，或 Claude Code 别名 sonnet / opus / haiku（按用户账号里的模型映射）。 */
  model?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  /** 覆盖子代理自己的委派策略；缺省 less（子代理仍可再派，但默认克制）。 */
  delegation?: DelegationStrategy;
  /** 非空即工具白名单；空/缺省继承主会话全部工具。 */
  allowedTools?: string[];
  systemPrompt?: string;
  source: SubagentPresetSource;
  /** 只读来源文件（Claude Code / 项目 agents/*.md）。 */
  file?: string;
  /** 只读预设里模型仍是别名时保留原文，便于界面展示。 */
  modelAlias?: string;
}
export interface SubagentPresetInput {
  id?: string;
  name: string;
  description?: string;
  profileId?: string;
  groupId?: string;
  model?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  delegation?: DelegationStrategy;
  allowedTools?: string[];
  systemPrompt?: string;
}
// GET /api/subagent-presets?cwd=  -> { presets: SubagentPreset[] }（含只读文件预设）
// PUT /api/subagent-presets { presets: SubagentPresetInput[] } -> { presets: SubagentPreset[] }（只替换 Tandem 自定义预设）

// ---------- 可配置提示词 ----------
// 所有内置提示词登记在 Host 的注册表；可编辑项存 ~/.tandem/prompts.json（未修改时跟随内置默认），
// 项目可用 <cwd>/.tandem/prompts.json 覆盖（只读，优先级高于用户级）。
export type PromptTemplateKey =
  | 'baseBehavior'
  | 'planMode'
  | 'delegationOrchestrate'
  | 'delegationMore'
  | 'delegationLess'
  | 'delegationNone'
  | 'subagentDefault'
  | 'compact'
  | 'init'
  | 'prDraft'
  | 'ciFix'
  | 'autoTitle'
  | 'memoryRule'
  | 'persona'
  | 'taskDescription'
  | 'toolGuidance'
  | 'safety'
  | 'environment';
export type PromptCategory = 'system' | 'workflow' | 'command' | 'aux';
export type PromptSource = 'builtin' | 'user' | 'project';
export interface PromptTemplate {
  key: PromptTemplateKey;
  label: string;
  description: string;
  /** 当前生效文本（项目覆盖 > 用户自定义 > 内置默认）。 */
  text: string;
  defaultText: string;
  /** 是否与内置默认不同（用户或项目改写）。 */
  modified: boolean;
  category: PromptCategory;
  /** 是否允许在设置页编辑；只读项仍可查看全文。 */
  editable: boolean;
  /** 只读原因。 */
  readOnlyReason?: string;
  /** 模板支持的变量名。 */
  variables?: string[];
  /** 当前文本来源。 */
  source: PromptSource;
  /** 项目级覆盖文本（存在时 text 优先取它）。 */
  projectText?: string;
}
// GET /api/prompt-templates?cwd= -> { templates: PromptTemplate[] }
// PUT /api/prompt-templates { values: Partial<Record<PromptTemplateKey,string>> } -> { templates: PromptTemplate[] }
// 空字符串表示恢复默认。模板变量：{{presets}}、{{cwd}}、{{delegation}}、{{name}}、{{log}}、{{text}}。

// ---------- 系统提示注入段落 ----------
export type InjectionSource = 'builtin' | 'user' | 'project' | 'memory' | 'skill' | 'generated' | 'hook' | 'session';
export interface InjectionSegment {
  id: string;
  name: string;
  source: InjectionSource;
  /** 项目文件/记忆文件等来源路径。 */
  sourcePath?: string;
  /** token 估算（字符数/3.5）。 */
  tokens: number;
  content: string;
}
export interface InjectionChange {
  /** 变化发生在哪条用户消息触发的那一轮之前。 */
  beforeMessageId?: string;
  at: number;
  added: string[];
  removed: string[];
  /** 展示用摘要，如「+记忆 −计划模式」。 */
  summary: string;
}
export interface InjectionSnapshot {
  segments: InjectionSegment[];
  totalTokens: number;
  updatedAt: number;
  /** 本会话发生过的上下文变化（新的在前）。 */
  changes: InjectionChange[];
}
// GET /api/sessions/:id/injections -> InjectionSnapshot
// 变化时通过 WS 推送 { type: 'injections', sessionId, injections }。

// ---------- Worktree 并行会话 ----------
// CreateSessionInput 新增可选 worktree?: { branch?: string }：在 cwd 所在仓库创建 git worktree（~/.tandem/worktrees/<repo>/<branch>），会话 cwd 指向它。
// POST /api/sessions/:id/worktree/merge {strategy:'merge'|'squash'} -> { ok; error? }   合回 baseBranch
// DELETE 会话时若有 worktree：未提交改动则 409，带 ?force=1 才删除

// ---------- 用量统计 ----------
export interface UsageStatsRow { day: string; hostId: string; profileId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; turns: number; keyId?: string; groupId?: string }
// GET /api/usage?from=&to= -> UsageStatsRow[]   （Host 内置常见模型单价表，可在账号上覆盖 price: {input, output} 每百万 token 美元）

// ---------- 配对 ----------
// GET /api/pair -> { urls: string[]; token: string; loopback?: boolean; hint?: string; relay?: RelayPairInfo }   列出本机所有可达地址（局域网 IP、Tailscale IP），客户端据此生成二维码供手机扫码；loopback=true 表示只监听本机、扫码不可用。
// 启用中继（config.relay）时多一个 relay 字段：url 形如 https://relay.example.com/h/<hostId>，可直接当 Host URL（token 不变，由 Host 校验）；
// 未设置 requireE2E 时该 url 也会追加到 urls 末尾（此时不再返回 loopback），老客户端扫码即可走明文中继。
// 端到端加密连接用 fingerprint 做 Host 公钥校验（配对时展示给用户核对 / 二维码携带），见 @tandem/relay/client 与 docs/relay.md。
export interface RelayPairInfo {
  url: string;
  hostId: string;
  /** Host 公钥（Ed25519）SHA-256，64 位小写十六进制。 */
  fingerprint: string;
  /** Host 公钥原始 32 字节，base64url。 */
  publicKey: string;
  /** true 时 Host 拒绝明文中继请求，只能走 /_e2e 加密通道。 */
  requireE2E: boolean;
  /** Host 当前是否已连上 relay。 */
  connected: boolean;
}

// ---------- 后台任务（Bash run_in_background） ----------
// Host 内 BackgroundTaskManager 管理；输出环形缓冲最多 1MB，完整输出落盘 ~/.tandem/tasks/<id>.log。
// Host 重启后：已结束任务保留可查看，运行中任务标记为 lost。
export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'lost';
export interface BackgroundTask {
  id: string;              // bash_id，如 bash_a1b2c3d4
  sessionId: string;
  command: string;
  description?: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: BackgroundTaskStatus;
  exitCode?: number;
  /** 当前累计输出字符数（GET output?since= 的位移口径）。 */
  outputChars: number;
}
export interface BackgroundTaskOutput {
  task: BackgroundTask;
  content: string;         // since 之后的新增文本
  since: number;           // 下次请求应传的位移
  /** since 早于环形缓冲起点，content 已从可用的最早位置开始。 */
  truncated?: boolean;
}
// GET  /api/tasks?sessionId=            -> BackgroundTask[]（sessionId 缺省返回全部，按 startedAt 倒序）
// GET  /api/tasks/:id/output?since=     -> BackgroundTaskOutput
// POST /api/tasks/:id/kill              -> BackgroundTask
// 工具：Bash {run_in_background:true} 返回 bash_id；BashOutput {bash_id, filter?} 增量读取；KillBash {shell_id} 终止。
// WS：task_updated 携带状态与节流后的新增输出。

// ---------- 定时任务（Host 级，存 ~/.tandem/schedules.json） ----------
// cron 为 5 段标准表达式；为便于本机测试也接受 6 段（首段为秒）。由 Host 进程内调度，不依赖公网。
export type ScheduleTargetKind = 'new' | 'session';
export interface ScheduleTarget {
  kind: ScheduleTargetKind;
  /** kind=session 时追加到该会话。 */
  sessionId?: string;
}
export interface ScheduleRunRecord {
  at: number;
  sessionId?: string;
  ok: boolean;
  error?: string;
}
export interface Schedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  target: ScheduleTarget;
  cwd: string;
  profileId?: string;      // kind=new 时必填；kind=session 时缺省沿用会话
  groupId?: string;
  model?: string;
  effort?: ReasoningEffort;
  permissionMode: PermissionMode; // 默认 acceptEdits；bypassPermissions 必须显式选择
  prompt: string;
  /** Host 未运行时错过触发点，启动后补跑一次（仅一次）。 */
  catchUp?: boolean;
  /** 计算字段：下次触发时间（epoch ms），禁用时为空。 */
  nextRunAt?: number;
  lastRun?: ScheduleRunRecord;
  createdAt: number;
  updatedAt: number;
}
export type ScheduleInput = Omit<Schedule, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'lastRun'> & { id?: string };
// GET    /api/schedules            -> Schedule[]（含 nextRunAt）
// POST   /api/schedules ScheduleInput -> Schedule
// PUT    /api/schedules/:id ScheduleInput -> Schedule
// DELETE /api/schedules/:id
// POST   /api/schedules/:id/run    -> { ok: boolean; sessionId?: string; error?: string }  立即运行一次
// 由定时任务新建的会话带 SessionSummary.scheduledBy，侧栏显示小时钟。
// 斜杠命令 /schedule 由客户端拦截并打开「定时任务」设置页。

// ---------- 项目记忆（Tandem 私有，与仓库内 AGENTS.md / CLAUDE.md 区分） ----------
// 每个项目（git 仓库根或 cwd）一份 ~/.tandem/memory/<hash>.md；global 为 _global.md。
// 记忆可被 Memory 工具写入（需审批，acceptEdits 下自动），也可在客户端 Markdown 编辑器中手工编辑。
export type MemoryScope = 'project' | 'global';
export interface MemoryFile {
  scope: MemoryScope;
  /** 项目根路径（scope=project 时有）。 */
  project?: string;
  /** 项目名（仓库根目录名）或「全局」。 */
  name: string;
  /** 原始 Markdown，首行可能含 Tandem 元数据注释。 */
  text: string;
  exists: boolean;
  /** 最后修改时间（epoch ms）；不存在为 0。 */
  updatedAt: number;
  size: number;
  /** 条目数（以 - / * 开头的列表行）。 */
  entries: number;
}
export interface MemoryListItem {
  scope: MemoryScope;
  project?: string;
  name: string;
  size: number;
  updatedAt: number;
  entries: number;
}
// GET    /api/memory?scope=global|project&project=<path>  -> MemoryFile
// PUT    /api/memory { scope, project?, text }           -> MemoryFile
// DELETE /api/memory?scope=global|project&project=<path> -> { ok: boolean }
// GET    /api/memory/list                                -> { global?: MemoryListItem; projects: MemoryListItem[] }
// POST /api/memory/import { project, text, source?, mode? } -> { ok, merged }  跨 Host 迁移合并记忆

// ---------- 会话只读分享（仅可信内网） ----------
// 分享链接形如 http://<host>:<port>/s/<shareId>#<token>；token 只在创建时返回一次，
// Host 只保存 SHA-256 哈希。公开接口 /api/public/shares/:id 用 Authorization: Share <token>。
export type ShareExpiry = '1h' | '1d' | '7d' | 'never';
export interface CreateShareInput {
  expiresIn?: ShareExpiry;      // 默认 7d
  includeToolOutputs?: boolean; // 默认 true；false 时工具结果只保留摘要
  hidePaths?: boolean;          // 默认 true；绝对路径替换为项目相对路径 / <home>
  snapshot?: boolean;           // 默认 false；true 冻结创建时的内容
}
export interface CreateShareResult {
  shareId: string;
  /** 含 fragment token 的完整链接，只在此次响应中出现。 */
  url: string;
  /** Host 只监听回环 / 未配置有效期等提示。 */
  warning?: string;
  expiresAt?: number;
}
export interface ShareInfo {
  id: string;
  sessionId: string;
  sessionTitle: string;
  createdAt: number;
  expiresAt?: number;
  expired: boolean;
  includeToolOutputs: boolean;
  hidePaths: boolean;
  snapshot: boolean;
  accessCount: number;
  lastAccessAt?: number;
}
export interface PublicShare {
  id: string;
  hostName: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  live: boolean;
  expiresAt?: number;
  messages: Message[];
}
// POST   /api/sessions/:id/shares {expiresIn?,includeToolOutputs?,hidePaths?,snapshot?} -> CreateShareResult
// GET    /api/shares      -> ShareInfo[]
// DELETE /api/shares/:id  -> 204（之后公开接口立即 404）
// GET    /api/public/shares/:id  Authorization: Share <token> -> PublicShare

export const PROTOCOL_VERSION = 3;
