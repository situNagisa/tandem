// Tandem 协议：host 守护进程（server）与各端客户端（web/桌面/手机）之间的契约。
// REST 用于 CRUD，WebSocket (/ws) 用于实时事件。所有请求带 Authorization: Bearer <hostToken>
// （WebSocket 用 ?token=）。

// ---------- 账号 / Key / 模型 ----------
export type ProviderKind =
  | 'anthropic'          // Anthropic Messages API
  | 'openai'             // OpenAI Chat Completions
  | 'openai-compatible'  // DeepSeek / Qwen / Moonshot / OpenRouter / Ollama 等兼容接口
  | 'gemini'             // Google Gemini (走 OpenAI 兼容端点)
  | 'tandem-gateway';    // 团队自建 Tandem 网关（OpenAI 兼容入口；地址填网关 Host，Key 填网关令牌）

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
/** provider 响应头里带回的限流额度；没有该头时缺省，不参与预估。 */
export interface KeyQuota {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  /** 请求数配额的重置时间（epoch ms）。 */
  resetRequestsAt?: number;
  /** token 配额的重置时间（epoch ms）。 */
  resetTokensAt?: number;
  updatedAt: number;
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
  /** provider 返回的剩余额度/重置时间（用于会话交接预估）。 */
  quota?: KeyQuota;
  /** 最近累计的 429 次数（成功请求不清零，便于排查限流）。 */
  rateLimitHits?: number;
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
  /** 备用分组链（同一账号内，按顺序）：额度将尽时交接给第一个可用的分组。 */
  fallbackGroupIds?: string[];
}
export interface ProfileGroupInput { id?: string; name: string; kind?: ProviderKind; apiKey?: string; /** 旧的单 Key 字段，等价于 apiKeys=[{apiKey}] */ apiKeys?: ProfileKeyInput[]; keyStrategy?: KeyStrategy; baseUrl?: string; models: string[]; defaultModel: string; modelCapabilities?: Record<string, ModelCapabilities>; fallbackGroupIds?: string[] }
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
  pinned?: boolean;        // 全局置顶（显示在侧栏「置顶」区）
  pinnedInProject?: boolean; // 项目内固定（只在该项目分组内置顶，与全局置顶区分）
  pinnedTurns?: string[];  // 被 pin 的轮次（用户消息 id），轮次导航中特殊显示
  archived?: boolean;      // 归档（列表默认隐藏）
  unread?: boolean;        // 回合已完成、用户尚未打开过；读取接口 POST /api/sessions/:id/read 清除
  env?: SessionEnv;        // 会话执行环境，用于侧栏按 项目/分支 自动归类
  importedFrom?: { source: ExternalSource; id: string }; // 从 Claude Code / Codex 导入的副本
  forkedFrom?: { sessionId: string; messageId?: string; title?: string }; // 分叉来源：会话页显示「分叉自」，父会话在分叉点显示子会话入口
  scheduledBy?: { id: string; name: string }; // 由定时任务创建；侧栏显示小时钟，tooltip 为任务名
  parentId?: string;       // Task 子代理会话指向主会话（孙代理指向子代理）
  depth?: number;          // 0 主会话 / 1 子代理 / 2 孙代理…；侧栏只显示主会话（parentId 为空）
  worktree?: { path: string; branch: string; baseBranch: string }; // 隔离分支会话
  board?: { boardId: string; cardId: string; boardName?: string }; // 任务看板卡片会话：不进侧栏会话列表，从看板进入
  createdAt: number;
  updatedAt: number;
  usage: Usage;
  /** 提交前 AI 评审累计用量（已计入 usage，单列展示）。 */
  aiReviewUsage?: Usage;
  /** 最近一次请求的上下文占用（随 session_updated 推送，也可 GET /api/sessions/:id/context）。 */
  context?: ContextBreakdown;
  /** 配额将尽时的交接状态（卡片/等待/已交接）；无交接时不填。 */
  handoff?: HandoffState;
  /** 按最近几轮消耗速度预估的剩余可跑轮数。 */
  quota?: QuotaEstimate;
  /** 本项目（仓库根或 cwd）+ 全局可用的 secret 数量；右栏「详情」显示，不含值。 */
  secretsCount?: number;
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

// ---------- 配额预估与会话交接 ----------
/** 会话交接策略：询问 / 自动切到备用分组 / 自动等待重置。 */
export type HandoffPolicy = 'ask' | 'switch' | 'wait';
export type HandoffReason = 'ratelimit' | 'budget' | 'forecast';
export type HandoffStatus = 'pending' | 'switching' | 'waiting' | 'done' | 'paused' | 'failed';
/** 交接来源/目标（profileId + groupId + 模型 + 展示名）。 */
export interface HandoffPeer {
  profileId: string;
  groupId?: string;
  model?: string;
  label: string;
}
export interface HandoffState {
  id: string;
  reason: HandoffReason;
  status: HandoffStatus;
  createdAt: number;
  from: HandoffPeer;
  /** 可切换的备用分组/模型；没有备用链时缺省，只保留等待/暂停。 */
  target?: HandoffPeer;
  /** 等待策略的预计恢复时间（epoch ms）。 */
  resumeAt?: number;
  /** 切换前保存的检查点 id（可在回退面板查看）。 */
  checkpointId?: string;
  /** 卡片正文，如「muze › codex 额度将尽。继续方式：…」。 */
  message: string;
  via?: 'auto' | 'user';
  resolvedAt?: number;
}
/** 当前会话按最近消耗速度的预估；随 session_updated / 上下文面板下发。 */
export interface QuotaEstimate {
  /** 预计还能跑的轮数（取预算与限流中更紧的一项）。 */
  turnsLeft?: number;
  limitedBy?: 'budget' | 'ratelimit';
  avgCostPerTurn?: number;
  avgTokensPerTurn?: number;
  budget?: {
    ruleId: string;
    label: string;
    percent: number;
    remainingUsd: number;
    resetAt: number;
  };
  key?: {
    remainingRequests?: number;
    remainingTokens?: number;
    resetAt?: number;
    /** 当前分组是否所有 Key 都在冷却。 */
    cooling: boolean;
  };
  updatedAt: number;
}
export interface HandoffSettings {
  policy: HandoffPolicy;
  /** 自动切换策略的默认目标；缺省先用当前分组的备用分组链。 */
  target?: { profileId: string; groupId?: string; model?: string };
}
// 上下文里最占空间的单条内容（消息或工具结果），供面板点选跳转
export interface ContextTopItem {
  messageId: string;
  role: 'user' | 'assistant';
  kind: 'message' | 'tool_result';
  turn: number;              // 1-based 轮次（纯 tool_result 的 user 消息并入所属轮）
  tokens: number;
  preview: string;           // 单行摘要
  tool?: string;             // tool_result 对应的工具名（能查到才给）
}
// 上下文占用（参考 Claude Code /context）：最近一次请求实际发送给模型的组成估算
export interface ContextBreakdown {
  model: string;
  contextWindow: number;     // 模型上下文上限
  usedTokens: number;        // 最近一次请求的输入总量（含缓存）
  parts: { kind: 'system' | 'tools' | 'mcp' | 'memory' | 'messages' | 'tool_results' | 'free'; tokens: number }[];
  cacheHitRate?: number;     // 本会话累计：cacheRead / (input + cacheRead + cacheWrite)
  /** 最占空间的 10 条消息/工具结果（按 token 降序）。 */
  topItems?: ContextTopItem[];
  /** 自动压缩触发配置；老 Host 缺失时不展示提示。 */
  autoCompact?: { enabled: boolean; threshold: number };
  /** 按当前速度的剩余轮数预估（用量卡/上下文面板共用）。 */
  quota?: QuotaEstimate;
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
export type UpdateSessionInput = Partial<Pick<SessionSummary, 'title' | 'profileId' | 'groupId' | 'model' | 'permissionMode' | 'pinned' | 'pinnedInProject' | 'archived' | 'effort' | 'delegation' | 'cwd' | 'pinnedTurns'>>;

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

// ---------- 全文搜索（Host 本地索引，覆盖 Tandem 与外部会话） ----------
export type SearchSource = 'tandem' | ExternalSource;
export type SearchStatusFilter = 'all' | 'running' | 'waiting_permission' | 'error' | 'unread';
export interface SearchFilters {
  /** 只看某个来源；缺省 all。 */
  source?: SearchSource | 'all';
  /** 项目名（仓库名或 cwd basename）；缺省 all。 */
  project?: string;
  status?: SearchStatusFilter;
  /** 归档会话默认不参与搜索。 */
  includeArchived?: boolean;
}
export interface SearchHighlight {
  start: number;
  end: number;
}
export interface SearchHit {
  source: SearchSource;
  /** Tandem 会话 id；外部会话为原软件会话 id。 */
  sessionId: string;
  /** 命中消息 id；空会话只有标题命中时为空字符串。 */
  messageId: string;
  /** 命中消息在会话 messages 数组中的下标；-1 表示仅标题命中。 */
  messageIndex: number;
  title: string;
  project: string;
  role: 'user' | 'assistant';
  /** 命中片段（已截取上下文，未转义）。 */
  snippet: string;
  /** 高亮区间，相对 snippet。 */
  highlights: SearchHighlight[];
  updatedAt: number;
  score: number;
}
export interface SearchResponse {
  q: string;
  tookMs: number;
  total: number;
  hits: SearchHit[];
}
// GET /api/search?q=&filters=  -> SearchResponse
// filters 为 SearchFilters 的 JSON（URL 编码）；也接受 source/project/status/includeArchived 单独查询参数。
// 中文按字符 + bigram、英文按词建立倒排索引，短语命中由 Host 做精确过滤。

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
// POST /api/sessions/:id/handoff { action: 'switch' | 'wait' | 'pause' } -> SessionSummary
//        额度将尽时选择继续方式：切换备用分组 / 等待重置后自动继续 / 暂停。

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
  /** 压缩摘要消息：参与模型请求，但界面不直接展示（由 compaction 提示展开查看）。 */
  summary?: boolean;
  /** 自动/手动压缩后的单行提示，界面可展开查看摘要全文。 */
  compaction?: CompactionNotice;
  usage?: Usage;             // assistant 消息：生成该消息的那次请求的用量与花费（一轮内多次请求各自记在对应消息上）
}

export interface CompactionNotice {
  summary: string;           // 摘要全文
  savedTokens: number;       // 压缩节省的估算 token
  keptTurns: number;         // 保留原文的最近轮数
  auto: boolean;             // 自动触发 / 手动压缩
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
  /** 被转交给某个审批者；只有该成员与所有者会收到此审批。 */
  assignedTo?: { memberId: string; name: string };
  /** 转交来源（由 X 转交）；首次转交时记录。 */
  transferredFrom?: { memberId: string; name: string; at: number };
  /** 从审批历史学到的建议：同类请求已多次批准时，客户端可在「总是允许」旁提供一键规则。 */
  learned?: { pattern: string; allows: number; project: string };
  /** 命令沙箱/网络白名单触发审批时的说明（写工作目录之外、受保护路径、非白名单主机等）。 */
  sandbox?: PermissionSandboxNotice;
}

/** 沙箱/网络策略导致转审批的原因；客户端在审批卡上单独高亮显示。 */
export interface PermissionSandboxNotice {
  kind: 'write-outside' | 'protected' | 'network' | 'network-offline' | 'unknown-write';
  reason: string;
  /** 触发路径（写入类）或主机名（联网类）。 */
  target?: string;
  /** 联网类：涉及的主机列表；「总是允许」时会加入网络白名单。 */
  hosts?: string[];
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

// ---------- Host 诊断（doctor） ----------
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  /** 稳定 id；账号/分组/MCP 服务器会追加后缀。 */
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
  /** 可复制的修复命令或步骤（已脱敏）；无需处理时为空。 */
  fix?: string;
}

export interface DoctorReport {
  generatedAt: number;
  host: { id: string; name: string; platform: string; version: string };
  listen: { host: string; port: number };
  /** 已按 fail → warn → skip → ok 排序。 */
  checks: DoctorCheck[];
  /** 纯文本报告（已脱敏）。 */
  text: string;
  /** 纯文本报告：用户主目录替换为 ~。 */
  textHidden: string;
  /** 实际执行的检查项 id。 */
  ran: string[];
}
// GET /api/doctor?checks=node,dataDir,profiles&clientTime=<epoch ms> -> DoctorReport
// checks 省略时执行除账号连通性外的全部检查（profiles 会向模型服务商发最小请求）。

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

/** 上下文自动管理：达到阈值自动压缩，并裁剪旧的大工具输出。 */
export interface ContextSettings {
  /** 请求前预计占用达到阈值时自动压缩；关闭后只在 /compact 或上下文超长报错时压缩。 */
  autoCompact: boolean;
  /** 触发阈值占上下文窗口的比例（0.5–0.95）。 */
  autoCompactThreshold: number;
  /** 自动压缩保留最近多少轮原文。 */
  autoCompactKeepTurns: number;
  /** 是否在发送时把较旧的大工具输出替换为占位（会话里保留原文）。 */
  trimLargeToolResults: boolean;
  /** 单条工具结果超过多少 token 才裁剪。 */
  trimToolResultTokens: number;
  /** 保留最近多少轮内的工具输出不裁剪。 */
  trimKeepTurns: number;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  autoCompact: true,
  autoCompactThreshold: 0.85,
  autoCompactKeepTurns: 4,
  trimLargeToolResults: true,
  trimToolResultTokens: 8000,
  trimKeepTurns: 20,
};

/** Host 行为设置（~/.tandem/config.json，跨端共享）。 */
export interface HostSettings {
  /** Host 重启后对未完成会话的处理：自动继续 / 恢复为暂停等我确认。 */
  resumeOnRestart: 'auto' | 'pause';
  /** 新会话默认委派策略。 */
  defaultDelegation?: DelegationStrategy;
  /** 本机语音转写配置；未配置时客户端隐藏 Host 转写方式。 */
  voice?: VoiceSettings;
  /** 上下文自动压缩与工具输出裁剪。缺省用 DEFAULT_CONTEXT_SETTINGS。 */
  context?: ContextSettings;
  /** 提交前 AI 评审的模型与拦截策略。 */
  aiReview?: AiReviewSettings;
  /** 配额将尽时的默认交接策略。 */
  handoff?: HandoffSettings;
  /** 命令沙箱与网络白名单（~/.tandem/sandbox.json）。 */
  sandbox?: SandboxSettings;
}
// GET  /api/settings -> HostSettings
// PUT  /api/settings HostSettings -> HostSettings

// ---------- 命令沙箱与网络白名单 ----------
// 静态检查跨平台生效；真正的文件系统隔离仅在 Linux bwrap / macOS sandbox-exec 可用时启用。
export interface SandboxSettings {
  /** 可用时启用真沙箱（Linux bwrap / macOS sandbox-exec）。 */
  enabled: boolean;
  /** 真沙箱内的网络策略：host=可联网；none=断网（需要联网的命令逐次审批后临时放行）。 */
  network: 'host' | 'none';
  /** 严格模式：无法静态判断写入范围的命令也转审批（默认不拦截，避免误伤）。 */
  strict: boolean;
  /** 网络白名单：域名、*.example.com、IP 或 CIDR 网段；回环地址始终放行。 */
  allowedHosts: string[];
}
export interface SandboxPlatformStatus {
  platform: 'linux' | 'darwin' | 'win32' | 'other';
  /** bwrap / sandbox-exec 是否可用；不可用时只做静态检查。 */
  available: boolean;
  engine: 'bwrap' | 'sandbox-exec' | '';
  /** 面向用户的一句话说明（含安装建议）。 */
  message: string;
  /** 当前平台是否能对命令断网。 */
  networkIsolation: boolean;
}
export interface SandboxPackageSource {
  label: string;
  hosts: string[];
}
export interface SandboxStatus {
  platform: SandboxPlatformStatus;
  settings: SandboxSettings;
  /** 包管理器官方源，设置页可一键加入白名单。 */
  packageSources: SandboxPackageSource[];
}
// GET /api/sandbox/status -> SandboxStatus

// ---------- 内网团队共享（成员 / 邀请 / 审计） ----------
// 全部在 Host 本地完成：邀请码与成员 token 只存 SHA-256，无第三方账号体系。
export type TeamRole = 'owner' | 'observer' | 'approver' | 'collaborator';
/** 被邀请成员的角色（所有者不可通过邀请获得）。 */
export type MemberRole = Exclude<TeamRole, 'owner'>;
export interface TeamMember {
  id: string;
  name: string;
  role: MemberRole;
  /** 可见/可协作的项目目录（绝对路径）；观察者与审批者只读这些目录下的会话。 */
  projectDirs: string[];
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  /** 当前是否有 WS 连接。 */
  online?: boolean;
}
export interface TeamInvite {
  id: string;
  role: MemberRole;
  projectDirs: string[];
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  usedByName?: string;
}
export interface CreateTeamInviteInput {
  role: MemberRole;
  projectDirs: string[];
}
export interface CreateTeamInviteResult {
  invite: TeamInvite;
  /** 一次性邀请码，只在创建时返回；链接/二维码内嵌该码。 */
  code: string;
  url: string;
  /** Host 只监听回环时的提示。 */
  warning?: string;
}
export interface AcceptTeamInviteInput {
  code: string;
  name: string;
}
export interface AcceptTeamInviteResult {
  /** 成员 token，只在接受邀请时返回一次；Host 只存哈希。 */
  token: string;
  member: TeamMember;
  host: HostInfo;
}
export interface UpdateTeamMemberInput {
  name?: string;
  role?: MemberRole;
  projectDirs?: string[];
}
/** GET /api/team/me：当前连接的身份（所有者或成员）。 */
export interface TeamIdentity {
  role: TeamRole;
  member?: TeamMember;
  /** Host 所有者展示名，固定「所有者」。 */
  ownerName: string;
}
/** GET /api/team/members：所有者视角的成员与有效邀请。 */
export interface TeamOverview {
  members: TeamMember[];
  invites: TeamInvite[];
}
export type TeamAuditAction =
  | 'invite.create'
  | 'invite.accept'
  | 'member.update'
  | 'member.revoke'
  | 'session.create'
  | 'message.send'
  | 'permission.decide'
  | 'permission.transfer';
export interface TeamAuditEntry {
  id: string;
  at: number;
  actorId: string;
  actorName: string;
  role: TeamRole;
  action: TeamAuditAction;
  sessionId?: string;
  sessionTitle?: string;
  detail?: string;
}
/** 正在查看会话的连接（会话页顶部头像）。 */
export interface TeamPresence {
  id: string;
  name: string;
  role: TeamRole;
}
// GET    /api/team/me                 -> TeamIdentity
// GET    /api/team/members            -> TeamOverview（仅所有者）
// GET    /api/team/approvers          -> TeamMember[]（所有者/审批者/协作者：可用于转交的在线审批者）
// POST   /api/team/invites {role,projectDirs} -> CreateTeamInviteResult（仅所有者）
// DELETE /api/team/invites/:id        -> 204（仅所有者）
// POST   /api/team/members/:id        -> TeamMember（仅所有者：改角色/目录/名称）
// POST   /api/team/members/:id/revoke -> 204（仅所有者，立即吊销 token）
// GET    /api/team/audit?limit=200    -> TeamAuditEntry[]（仅所有者，最近 200 条）
// POST   /api/team/invites/accept {code,name} -> AcceptTeamInviteResult（公开接口，凭邀请码）
// POST   /api/permissions/:requestId/transfer {toMemberId} -> PermissionRequest（所有者/审批者）

// ---------- 浏览器操作（~/.tandem/browser.json） ----------
/** Host 浏览器工具设置：默认关闭；默认只允许访问本机地址与 file://。 */
export interface BrowserSettings {
  enabled: boolean;
  /** 额外允许的域名/内网网段模式：如 example.com、*.corp.example.com、10.*、192.168.*。本机地址始终允许。 */
  allowedHosts: string[];
  /** 无头模式；关闭后 Host 会弹出可见窗口（仅当客户端与 Host 同机时可见）。 */
  headless: boolean;
}
// GET  /api/browser/settings -> BrowserSettings
// PUT  /api/browser/settings BrowserSettings -> BrowserSettings
/** GET /api/browser/status：Playwright 与 Chromium 是否可用。 */
export interface BrowserStatus {
  available: boolean;
  version?: string;
  browser?: string;
  error?: string;
}
/** 每个会话的浏览器实时状态（WS browser_state 与 GET /api/sessions/:id/browser/state）。 */
export interface BrowserState {
  sessionId: string;
  /** 浏览器上下文是否打开。 */
  active: boolean;
  url?: string;
  title?: string;
  /** 最新截图 id；GET /api/sessions/:id/browser/screenshot?shot=<id> 取图。 */
  screenshotId?: string;
  updatedAt: number;
  error?: string;
}
// GET /api/sessions/:id/browser/screenshot?shot=shot_1 -> image/jpeg

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
export type InboxEventKind = 'permission' | 'permission_resolved' | 'turn_end' | 'budget' | 'ci' | 'eval' | 'board' | 'handoff'
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
  /** kind=eval：评测运行开始/进度/结束。 */
  eval?: {
    runId: string;
    suite: string;
    status: 'running' | 'done' | 'cancelled';
    finished: number;
    total: number;
    /** 可读描述，如「评测完成：3/4 通过」。 */
    text: string;
  };
  /** kind=board：任务看板卡片待评审/失败/整块跑完。 */
  board?: {
    boardId: string;
    boardName: string;
    cardId?: string;
    cardTitle?: string;
    event: 'review' | 'failed' | 'finished';
    text: string;
  };
  /** kind=handoff：额度将尽，等待用户选择切换/等待/暂停。 */
  handoff?: { state: HandoffState; text: string };
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
  | { type: 'hello'; host: HostInfo; me?: TeamIdentity }
  | { type: 'session_snapshot'; session: Session; pendingPermissions: PermissionRequest[] } // subscribe 后先下发全量
  | { type: 'session_updated'; session: SessionSummary }   // 广播给所有连接（用于列表刷新）
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'message_start'; sessionId: string; message: Message }       // 新消息（用户消息也走这里，用于多端同步）
  | { type: 'block_delta'; sessionId: string; messageId: string; index: number; delta: BlockDelta }
  | { type: 'message_end'; sessionId: string; message: Message }         // 最终完整消息，客户端以此为准覆盖
  | { type: 'permission_request'; request: PermissionRequest; sessionId?: string } // sessionId=广播所属会话（子代理冒泡时为主会话），供客户端按会话 seq 排序
  | { type: 'permission_resolved'; requestId: string; sessionId: string; decision: PermissionDecision }
  | { type: 'permission_transferred'; requestId: string; sessionId: string; request: PermissionRequest; from: string; to: string } // 审批转交：非目标审批者从待办移除
  | { type: 'todos'; sessionId: string; todos: Todo[] }
  | { type: 'plan'; sessionId: string; plan?: SessionPlan }                 // 计划提交/批准/拒绝
  | ({ type: 'hook_event' } & HookEventNotice)                              // Hook 执行记录（成功默认不展示）
  | ({ type: 'budget_alert' } & BudgetAlert)                                // 预算告警：全局广播，触发会话内同时插 notice
  | { type: 'turn_end'; sessionId: string; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { type: 'inbox_snapshot'; snapshot: InboxSnapshot }                     // 订阅收件箱后的全量（或补齐失败时）
  | { type: 'inbox_event'; event: InboxEvent }                             // 收件箱增量事件
  | { type: 'vcs_updated'; sessionId: string; state: VcsState }            // 当前会话 PR/CI 状态变化（60s 轮询）
  | { type: 'injections'; sessionId: string; injections: InjectionSnapshot } // 本轮系统提示的注入段落清单/变化
  | { type: 'browser_state'; sessionId: string; state: BrowserState }      // 浏览器当前页面/最新截图（工具调用后刷新）
  | { type: 'presence'; sessionId: string; viewers: TeamPresence[] }       // 正在查看该会话的连接（含所有者）
  | { type: 'team_updated' }                                              // 成员/邀请/审计变化，所有者客户端刷新
  // 外部会话（Claude Code / Codex）文件有变动，客户端应重新拉取列表
  | { type: 'task_updated'; sessionId: string; task: BackgroundTask; content?: string; since?: number; truncated?: boolean }
  | { type: 'schedules_updated' }
  | { type: 'board_updated'; boardId: string }
  | { type: 'eval_run_updated'; run: EvalRunSummary }
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
// POST   /api/sessions/:id/read       -> SessionSummary  标记已读（多端同步，清除 unread）
// GET    /api/search?q=&filters=      -> SearchResponse  本机全文索引（Tandem + Claude Code / Codex）
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
export interface RewindInput { checkpointId: string; restoreFiles: boolean; restoreConversation: boolean; messageId?: string }
// GET  /api/sessions/:id/checkpoints -> Checkpoint[]
// POST /api/sessions/:id/rewind RewindInput -> Session   恢复到该用户消息之前（文件和/或对话）
// 没有检查点时（旧会话/导入会话/本轮未改文件）可传空 checkpointId + messageId，仅恢复对话

// ---------- Hooks ----------
// GET  /api/hooks?cwd=            -> HookSettings   汇总 ~/.claude、<cwd>/.claude 与 ~/.tandem/hooks.json
// PUT  /api/hooks { cwd?, entries } -> HookSettings  只写 ~/.tandem/hooks.json（entries 为 tandem 来源的扁平条目）
// PUT  /api/hooks/trust { cwd, trusted } -> HookSettings  项目 hooks 信任列表（~/.tandem/hooks-trust.json）

// ---------- 改动审阅（git 工作区） ----------
export interface FileChange { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; additions: number; deletions: number; oldPath?: string }
export interface ChangesResult { isRepo: boolean; branch?: string; files: FileChange[] }
/** 单文件 diff 为空时的原因：仅文件模式变化 / 仅换行符或空白变化 / 仅重命名 / 确实没有差异。 */
export type DiffEmptyReason = 'mode' | 'eol' | 'rename' | 'none'

// ---------- 提交前 AI 评审 ----------
// 评审在后台只读子会话中运行，结果按行挂到改动审阅；不影响主会话，除非用户采纳意见。
export type AiReviewSeverity = 'blocker' | 'warn' | 'nit'
export type AiReviewVerdict = 'commit' | 'suggest' | 'blocker'
export interface AiReviewFinding {
  id: string;
  file: string;
  /** 新文件行号（1-based）；找不到对应 diff 行时会被 Host 丢弃。 */
  line: number;
  endLine?: number;
  severity: AiReviewSeverity;
  title: string;
  detail: string;
  suggestion?: string;
}
export interface AiReviewRun {
  id: string;
  sessionId: string;
  status: 'running' | 'done' | 'error';
  verdict?: AiReviewVerdict;
  summary?: string;
  findings: AiReviewFinding[];
  /** 模型给出但指向不存在行/文件的条目数。 */
  ignored: number;
  /** 模型输出不是合法 JSON 时保留的原文（面板作为总评展示）。 */
  fallbackText?: string;
  /** 改动过大，只评审了部分文件。 */
  truncated?: boolean;
  model?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}
export interface AiReviewSettings {
  /** 留空表示使用「审查」子代理预设，没有则该会话当前模型。 */
  profileId?: string;
  groupId?: string;
  model?: string;
  effort?: ReasoningEffort;
  /** 有 blocker 时禁止提交（默认只提示）。 */
  blockOnBlocker?: boolean;
}
// POST /api/sessions/:id/ai-review { paths? } -> { review: AiReviewRun }（立即返回 running，后台执行）
// GET  /api/sessions/:id/ai-review/:reviewId -> { review: AiReviewRun }
// GET  /api/sessions/:id/ai-review -> { review?: AiReviewRun }（最近一次）
// POST /api/sessions/:id/ai-review/:reviewId/false-positive { findingId } -> { ok: true }（写入项目记忆）

// GET  /api/sessions/:id/changes                 -> ChangesResult
// GET  /api/sessions/:id/changes/diff?path=      -> { path: string; diff: string; emptyReason?: DiffEmptyReason; truncated?: true }  (统一 diff 文本；超大时截断)
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
export interface PermissionRule {
  tool: string;
  pattern?: string;         // Bash 为命令前缀通配，如 "npm test*"；文件工具为相对 glob、绝对路径或 ~/目录（按目录前缀匹配）；browser_* 为域名模式，如 "192.168.*"
  action: 'allow' | 'ask' | 'deny';
  project?: string;         // 可选：绝对路径，仅对该项目（含子目录）生效；缺省为全局
}
// tool 支持 * 通配（如 browser_*）。浏览器工具还有一道硬边界：域名必须在本机地址或设置 → 浏览器的允许列表内。
// GET /api/permissions -> PermissionRule[]   PUT /api/permissions PermissionRule[]   优先级 deny > ask > allow

// ---------- 审批策略学习（Host 本地：~/.tandem/approvals.jsonl，最近 5000 条） ----------
/** 从审批历史生成的建议规则；危险命令只会建议「询问」，不会建议自动允许。 */
export interface PermissionSuggestion {
  id: string;
  tool: string;
  pattern: string;
  action: 'allow' | 'ask';
  project: string;          // 绝对路径
  projectName: string;
  allows: number;
  denies: number;
  reason: string;
  dangerous?: string;       // 命中的危险模式说明
}
/** 权限页顶部统计与建议。 */
export interface PermissionInsights {
  stats: { days: number; prompts: number; autoHandled: number };
  suggestions: PermissionSuggestion[];
}
/** 自然语言生成的结构化规则草稿（需用户确认后才保存）。 */
export interface PermissionRuleDraft {
  rule: PermissionRule;
  explanation: string;
}
// GET  /api/permissions/insights -> PermissionInsights
// POST /api/permissions/suggestions/:id/adopt -> PermissionRule[]（采纳建议）
// DELETE /api/permissions/suggestions/:id -> { ok }（忽略建议）
// POST /api/permissions/rules { rule } -> PermissionRule[]（确认草稿后保存单条规则）
// POST /api/permissions/draft { sessionId, text } -> PermissionRuleDraft（用当前会话模型解析；危险模式返回 400）

// ---------- 项目 Secrets（~/.tandem/secrets.json，值 AES-GCM 加密、接口永不回传） ----------
/** secret 注入的子系统：Bash/后台任务、stdio MCP、Hooks。 */
export type SecretScope = 'bash' | 'mcp' | 'hooks';
/** 公开元信息：只有名称、描述、作用范围与使用时间，没有值。 */
export interface SecretMeta {
  id: string;
  name: string;
  description?: string;
  scopes: SecretScope[];
  /** 所属项目（git 仓库根或 cwd 的绝对路径）；缺省为全局 secret。 */
  project?: string;
  createdAt: number;
  updatedAt: number;
  /** 最近一次注入到进程环境的时间。 */
  lastUsedAt?: number;
}
export interface SecretInput {
  name: string;
  /** 创建时必填；更新时省略/留空表示保留原值。 */
  value?: string;
  description?: string;
  scopes: SecretScope[];
  project?: string;
}
export interface SecretsSettings {
  /** 对 sk-…、ghp_…、AKIA…、私钥块等常见 Key 形态做通用打码；关闭后只打码本机 secrets。 */
  genericMask: boolean;
}
export interface SecretsOverview {
  global: SecretMeta[];
  projects: Array<{ project: string; secrets: SecretMeta[] }>;
  /** 设置页项目下拉可选项（已存过 secret 的项目 + 最近会话的项目根）。 */
  knownProjects: string[];
  settings: SecretsSettings;
}
// GET    /api/secrets?cwd=        -> SecretsOverview
// POST   /api/secrets SecretInput -> SecretMeta
// PATCH  /api/secrets/:id SecretInput -> SecretMeta（value 省略表示保留）
// DELETE /api/secrets/:id         -> { ok: true }
// PUT    /api/secrets/settings SecretsSettings -> SecretsSettings
// 注入到 Bash/后台任务/Hooks/stdio MCP 的环境变量；所有工具输出在进入会话前按值打码为 [secret:NAME]。

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
  | 'evalReview'
  | 'aiReview'
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
export interface UsageStatsRow { day: string; hostId: string; profileId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; turns: number; keyId?: string; groupId?: string; memberId?: string; memberName?: string }
// GET /api/usage?from=&to= -> UsageStatsRow[]   （Host 内置常见模型单价表，可在账号上覆盖 price: {input, output} 每百万 token 美元）
// 经网关转发的请求额外带 memberId/memberName：用量页据此显示「按成员」维度，不会重复计数（一条请求只有一行）。

// ---------- 自建 Key 网关（可选，默认关闭） ----------
// 仅在内网使用：成员把模型请求发到某台 Host 的 /gateway/v1/*，由网关统一替换 Key、限流、记账与脱敏日志。
// 网关令牌与团队成员绑定；Host 只存令牌哈希，明文只在签发响应里出现一次。
export interface GatewayModelRoute {
  id: string;
  /** 网关本机账号（Host 上的 Profile）。 */
  profileId: string;
  /** 账号下的分组；缺省用账号自身（含账号级 Key）。 */
  groupId?: string;
  /** 该路由承接的模型名（与请求里的 model 精确匹配，大小写不敏感）。 */
  models: string[];
}
export interface GatewaySettings {
  /** 默认关闭；开启后 /gateway/v1/* 才可用。 */
  enabled: boolean;
  routes: GatewayModelRoute[];
  /** 调试正文：临时记录请求/响应并自动脱敏，24 小时后自动删除；默认关闭。 */
  debugBodies: boolean;
}
export interface GatewayToken {
  id: string;
  memberId: string;
  memberName: string;
  createdAt: number;
  revokedAt?: number;
  lastUsedAt?: number;
  /** 每日花费上限（美元）；缺省不限。 */
  dailyLimitUsd?: number;
  /** 每月花费上限（美元）；缺省不限。 */
  monthlyLimitUsd?: number;
  /** 每分钟请求数上限。 */
  rpm: number;
  /** 可用模型白名单；空数组表示路由里的全部模型都可用。 */
  allowedModels: string[];
}
export interface GatewayTokenInput {
  memberId: string;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  rpm?: number;
  allowedModels?: string[];
}
export interface GatewayTokenUpdateInput {
  /** null 表示清除该限额。 */
  dailyLimitUsd?: number | null;
  monthlyLimitUsd?: number | null;
  rpm?: number;
  allowedModels?: string[];
}
export interface GatewayTokenIssued {
  /** 明文网关令牌，只在签发时返回一次。 */
  token: string;
  grant: GatewayToken;
}
export interface GatewayMemberUsage {
  memberId: string;
  memberName: string;
  todayRequests: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCostUsd: number;
  monthCostUsd: number;
  tokenCount: number;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  rpm?: number;
  lastUsedAt?: number;
}
/** 网关请求日志：只含元数据，不含请求/响应正文。 */
export interface GatewayLogEntry {
  at: number;
  memberId?: string;
  memberName?: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  status: number;
  stream: boolean;
  route?: string;
  error?: string;
}
export interface GatewayOverview {
  settings: GatewaySettings;
  tokens: GatewayToken[];
  usage: GatewayMemberUsage[];
  logs: GatewayLogEntry[];
  /** 仍保留在磁盘上的调试正文条数（24 小时内；关闭调试模式即清空）。 */
  debugCount: number;
}
// GET    /gateway/v1/models              OpenAI 兼容模型列表（Bearer 或 x-api-key 网关令牌）
// POST   /gateway/v1/chat/completions    OpenAI 兼容转发
// POST   /gateway/v1/messages            Anthropic 兼容转发
// GET    /api/gateway                    -> GatewayOverview（仅所有者）
// PUT    /api/gateway/settings {enabled,routes,debugBodies} -> GatewaySettings（仅所有者）
// POST   /api/gateway/tokens {memberId,...} -> GatewayTokenIssued（仅所有者，明文令牌只返回一次）
// POST   /api/gateway/tokens/:id {dailyLimitUsd?,monthlyLimitUsd?,rpm?,allowedModels?} -> GatewayToken（仅所有者）
// DELETE /api/gateway/tokens/:id         -> 204（仅所有者，立即吊销）
// GET    /api/gateway/logs?limit=100     -> GatewayLogEntry[]（仅所有者，只含元数据）

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

// ---------- 评测（轨迹回放 / 回归用例） ----------
// 用例存 ~/.tandem/evals/<suite>/<case>.json；运行时每个 用例×配置 在独立临时目录中
// 以 bypassPermissions 跑一遍 agent，记录轨迹、检查命令、用量与耗时。
export type EvalSnapshotMode = 'git' | 'copy';
export interface EvalSnapshot {
  mode: EvalSnapshotMode;
  /** 原会话工作目录（展示用）。 */
  cwd: string;
  /** mode=git：仓库根目录与保存时记录的 commit hash。 */
  repoPath?: string;
  commit?: string;
  /** 保存时仓库有未提交改动（快照只包含该 commit）。 */
  dirty?: boolean;
  /** mode=copy：复制出的快照目录（位于 ~/.tandem/evals 下）。 */
  snapshotPath?: string;
  sizeBytes?: number;
}
export interface EvalCase {
  suite: string;
  name: string;
  title: string;
  /** 截取起点：原会话中的用户消息 id。 */
  startMessageId?: string;
  initialPrompt: string;
  snapshot: EvalSnapshot;
  /** 用户写的通过标准（供评审模型判断）。 */
  passCriteria?: string;
  /** 自动检查命令，退出码 0 视为通过。 */
  checkCommand?: string;
  sourceSession?: { id: string; title: string };
  createdAt: number;
}
export interface EvalConfig {
  id: string;
  name: string;
  profileId: string;
  groupId?: string;
  model: string;
  effort?: ReasoningEffort;
  delegation?: DelegationStrategy;
  /** 仅对该评测配置生效的提示词覆盖（key -> 文本），不写回全局设置。 */
  promptOverrides?: Partial<Record<PromptTemplateKey, string>>;
}
export interface EvalReviewer {
  profileId: string;
  groupId?: string;
  model: string;
}
export interface EvalCheckResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
  durationMs: number;
}
export interface EvalReviewResult {
  verdict: 'pass' | 'fail';
  reason: string;
  model: string;
}
export type EvalCellStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface EvalResult {
  caseName: string;
  caseTitle: string;
  configId: string;
  configName: string;
  status: EvalCellStatus;
  /** agent 回合是否正常结束。 */
  completed: boolean;
  /** 综合完成、检查命令与评审模型后的结论。 */
  passed: boolean;
  check?: EvalCheckResult;
  review?: EvalReviewResult;
  /** 模型请求轮数（assistant 消息数）。 */
  turns: number;
  toolCalls: number;
  usage: Usage;
  costUsd?: number;
  durationMs: number;
  finalAnswer?: string;
  error?: string;
  /** 完整轨迹；列表接口不返回，详情接口返回。 */
  messages?: Message[];
}
export interface EvalRun {
  id: string;
  suite: string;
  status: 'running' | 'done' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  configs: EvalConfig[];
  reviewer?: EvalReviewer;
  concurrency: number;
  total: number;
  finished: number;
  results: EvalResult[];
}
export interface EvalRunSummary extends Omit<EvalRun, 'results' | 'configs'> {
  configs: Array<Pick<EvalConfig, 'id' | 'name' | 'model'>>;
  results: Array<Omit<EvalResult, 'messages'>>;
}
export interface SaveEvalCaseInput {
  sessionId: string;
  /** 从这条用户消息开始截取；缺省为第一条用户消息。 */
  messageId?: string;
  suite?: string;
  name?: string;
  passCriteria?: string;
  checkCommand?: string;
}
export interface StartEvalRunInput {
  suite: string;
  caseNames?: string[];
  configs: EvalConfig[];
  concurrency?: number;
  reviewer?: EvalReviewer;
}
// GET    /api/evals/suites                  -> { suites: string[] }
// GET    /api/evals/cases?suite=            -> { cases: EvalCase[] }
// POST   /api/evals/cases SaveEvalCaseInput -> EvalCase
// DELETE /api/evals/cases/:suite/:name
// GET    /api/evals/runs                    -> EvalRunSummary[]（按开始时间倒序，不含轨迹）
// POST   /api/evals/runs StartEvalRunInput  -> EvalRun（后台运行）
// GET    /api/evals/runs/:id                -> EvalRun（含完整轨迹）
// POST   /api/evals/runs/:id/cancel         -> { ok: boolean }
// WS: eval_run_updated  运行进度变化（收件箱另有 eval 事件）

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

// ---------- 任务看板（docs/taskboard.md） ----------
// 一块看板属于一个项目目录；每张卡运行时 = 一个顶层会话（SessionSummary.board 标记，不设 parentId）。
export type BoardCardStatus = 'todo' | 'queued' | 'running' | 'approval' | 'review' | 'done' | 'failed';
export const BOARD_COLUMNS: BoardCardStatus[] = ['todo', 'queued', 'running', 'approval', 'review', 'done', 'failed'];
export interface BoardExec {
  preset?: string;               // 子代理预设名：带来模型/权限/工具白名单/附加提示
  profileId?: string;
  groupId?: string;
  model?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode; // 缺省 acceptEdits
  worktree?: boolean;            // git 仓库内缺省 true；false 或非 git 目录时同目录同时只跑一张卡
  budgetUsd?: number;            // 单卡花费上限，缺省不限
  maxRetries?: number;           // 回合出错后同会话重试次数，缺省 1
  gate?: boolean;                // 审批门：回合结束后停在 review，人通过后才算 done、下游才启动
}
export interface BoardCardResult {
  summary: string;               // 最后一条 assistant 文本
  files: number;
  additions: number;
  deletions: number;
  branch?: string;
  commit?: string;
  costUsd: number;
  durationMs: number;
  mergedAt?: number;
  mergeError?: string;
}
export interface BoardCard {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  status: BoardCardStatus;
  order: number;                 // 列内排序（升序）
  exec: BoardExec;
  sessionId?: string;
  attempts: number;              // 已用的自动重试次数
  result?: BoardCardResult;
  error?: string;
  /** 运行中最近一次工具活动的一行描述（服务端按会话实时推导，不落盘）。 */
  activity?: string;
  /** 排队中的阻塞原因：waiting=等依赖；upstream_failed=有依赖失败；slot=等并发槽；dir=同目录有卡在跑。 */
  blocked?: 'waiting' | 'upstream_failed' | 'slot' | 'dir';
  /** review 时用户打回的意见（下次运行注入）。 */
  reviewNote?: string;
  /** 内部：最近一次发给会话的任务说明，用于编辑提示词后重试时重新下发。 */
  sentPrompt?: string;
  /** worktree 合入依赖分支后的起点提交：结果统计只算本卡自己的改动。 */
  baseCommit?: string;
  /** 失败重试的最早时间（epoch ms）；排队中的卡到点才会被调度。 */
  retryAt?: number;
  /** 预留：运行时由协调者提议的卡片（v2）。 */
  proposedBy?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}
export type BoardMergePolicy = 'manual' | 'auto';
export interface Board {
  id: string;
  name: string;
  cwd: string;                   // 项目目录（通常是仓库根）
  isGit: boolean;
  baseBranch?: string;
  maxParallel: number;           // 1–8，缺省 2
  mergePolicy: BoardMergePolicy;
  defaults: BoardExec;           // 看板默认执行配置（卡 > 看板）
  cards: BoardCard[];
  createdAt: number;
  updatedAt: number;
}
export interface BoardSummary {
  id: string;
  name: string;
  cwd: string;
  counts: Record<BoardCardStatus, number>;
  /** 需要人处理的卡数：approval + review + failed。 */
  needsMe: number;
  costUsd: number;
  updatedAt: number;
}
export type BoardInput = Partial<Pick<Board, 'name' | 'cwd' | 'maxParallel' | 'mergePolicy' | 'defaults'>>;
export interface BoardCardInput {
  title?: string;
  prompt?: string;
  deps?: string[];
  exec?: BoardExec;
  /** 创建时直接放行（queued）；缺省 todo。 */
  status?: 'todo' | 'queued';
}
export interface BoardPlanDraft {
  ref: string;                   // 草稿内部引用（deps 用它指向其他草稿）
  title: string;
  prompt: string;
  deps: string[];
  preset?: string;
  gate?: boolean;
}
export type BoardCardAction = 'start' | 'unqueue' | 'stop' | 'retry' | 'approve' | 'reject' | 'merge';
// GET    /api/boards                          -> BoardSummary[]
// POST   /api/boards BoardInput               -> Board（cwd 必填；defaults.profileId 缺省取第一个账号）
// GET    /api/boards/:id                      -> Board（cards 含实时 activity/blocked）
// PUT    /api/boards/:id BoardInput           -> Board
// DELETE /api/boards/:id                      -> {ok}（运行中的卡先中断；卡会话保留但解除看板标记）
// POST   /api/boards/:id/cards BoardCardInput -> BoardCard（deps 成环/不存在返回 400）
// PUT    /api/boards/:id/cards/:cid BoardCardInput -> BoardCard（title/prompt/deps/exec 仅 todo/queued/failed 可改）
// DELETE /api/boards/:id/cards/:cid           -> {ok}（其他卡对它的依赖一并移除）
// POST   /api/boards/:id/cards/:cid/action {action, note?, strategy?: 'merge'|'squash'} -> BoardCard
// POST   /api/boards/:id/cards/:cid/move {beforeId?: string|null}  -> Board（列内排序：放到 beforeId 之前，null=列尾）
// POST   /api/boards/:id/merge-all {strategy?} -> {merged: string[]; failed: {cardId: string; error: string}[]}
// POST   /api/boards/:id/plan {goal}          -> {drafts: BoardPlanDraft[]}（只返回草稿，不创建）
// POST   /api/boards/:id/plan/apply {drafts}  -> {cards: BoardCard[]}（确认后创建，状态 todo）
// WS board_updated {boardId} 广播：客户端重新拉取该看板；收件箱 kind=board 见 InboxEvent.board。

export const PROTOCOL_VERSION = 3;
