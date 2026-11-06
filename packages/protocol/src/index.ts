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
export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'error';

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;             // 会话工作目录（在 host 机器上）
  profileId: string;
  groupId?: string;        // 选用账号下的哪个分组（无分组账号不填）
  model: string;
  permissionMode: PermissionMode;
  effort?: ReasoningEffort; // 思考强度：映射到 Anthropic thinking budget / OpenAI reasoning_effort；模型不支持时忽略
  status: SessionStatus;
  pinned?: boolean;        // 置顶
  pinnedTurns?: string[];  // 被 pin 的轮次（用户消息 id），轮次导航中特殊显示
  archived?: boolean;      // 归档（列表默认隐藏）
  env?: SessionEnv;        // 会话执行环境，用于侧栏按 项目/分支 自动归类
  importedFrom?: { source: ExternalSource; id: string }; // 从 Claude Code / Codex 导入的副本
  forkedFrom?: { sessionId: string; messageId?: string; title?: string }; // 分叉来源：会话页显示「分叉自」，父会话在分叉点显示子会话入口
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
  title?: string;
  worktree?: { branch?: string };
}
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';
// cwd：会话中途切换工作目录（下一轮生效，重新检测 env）
export type UpdateSessionInput = Partial<Pick<SessionSummary, 'title' | 'profileId' | 'groupId' | 'model' | 'permissionMode' | 'pinned' | 'archived' | 'effort' | 'cwd' | 'pinnedTurns'>>;

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
export interface ConfigImportResult { profilesAdded: number; profilesUpdated: number; clientSettings?: unknown }

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

// ---------- WebSocket: 客户端 -> 服务端 ----------
export type ClientMsg =
  | { type: 'subscribe'; sessionId: string; sinceSeq?: number } // 订阅；带 sinceSeq 时服务端补发 seq>sinceSeq 的事件（缓冲不够则改发 snapshot）
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send'; sessionId: string; content: ContentBlock[] }  // 发送用户消息；运行中发送则排队
  | { type: 'interrupt'; sessionId: string }        // 中断当前轮（Esc）
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
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; requestId: string; sessionId: string; decision: PermissionDecision }
  | { type: 'todos'; sessionId: string; todos: Todo[] }
  | { type: 'plan'; sessionId: string; plan?: SessionPlan }                 // 计划提交/批准/拒绝
  | ({ type: 'hook_event' } & HookEventNotice)                              // Hook 执行记录（成功默认不展示）
  | { type: 'turn_end'; sessionId: string; reason: 'done' | 'interrupted' | 'error'; error?: string }
  // 外部会话（Claude Code / Codex）文件有变动，客户端应重新拉取列表
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
// GET    /api/commands                -> SlashCommand[]
export interface SlashCommand { name: string; description: string; source: 'builtin' | 'project' | 'user' }

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

export const PROTOCOL_VERSION = 3;
