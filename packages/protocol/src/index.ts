// Tandem 协议：host 守护进程（server）与各端客户端（web/桌面/手机）之间的契约。
// REST 用于 CRUD，WebSocket (/ws) 用于实时事件。所有请求带 Authorization: Bearer <hostToken>
// （WebSocket 用 ?token=）。

// ---------- 账号 / Key / 模型 ----------
export type ProviderKind =
  | 'anthropic'          // Anthropic Messages API
  | 'openai'             // OpenAI Chat Completions
  | 'openai-compatible'  // DeepSeek / Qwen / Moonshot / OpenRouter / Ollama 等兼容接口
  | 'gemini';            // Google Gemini (走 OpenAI 兼容端点)

export interface Profile {
  id: string;
  name: string;            // 显示名，如 "公司 Anthropic"、"个人 OpenAI"
  kind: ProviderKind;
  baseUrl?: string;        // 自定义端点
  apiKeyMasked: string;    // 只回传掩码，明文 key 永不下发给客户端
  models: string[];        // 该账号可选模型（无分组时使用）
  defaultModel: string;
  groups?: ProfileGroup[]; // 分组：同一账号（同一服务商/中转站）下多组 key，各自可用模型不同，如 "官方渠道"/"低价渠道"
  createdAt: number;
}
export interface ProfileGroup {
  id: string;
  name: string;
  apiKeyMasked: string;
  baseUrl?: string;        // 缺省用账号 baseUrl
  models: string[];
  defaultModel: string;
}
export interface ProfileGroupInput { id?: string; name: string; apiKey?: string; baseUrl?: string; models: string[]; defaultModel: string }
export interface ProfileInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;         // 更新时不传表示不改
  models: string[];
  defaultModel: string;
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
  status: SessionStatus;
  pinned?: boolean;        // 置顶
  archived?: boolean;      // 归档（列表默认隐藏）
  env?: SessionEnv;        // 会话执行环境，用于侧栏按 项目/分支 自动归类
  createdAt: number;
  updatedAt: number;
  usage: Usage;
}
export interface SessionEnv {
  repoRoot?: string;       // cwd 所在 git 仓库根目录（非仓库则无）
  repoName?: string;       // 仓库名（根目录 basename）
  branch?: string;         // 当前分支
}
export interface Usage { inputTokens: number; outputTokens: number; costUsd?: number }

export interface CreateSessionInput {
  cwd: string;
  profileId: string;
  groupId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  title?: string;
}
export type UpdateSessionInput = Partial<Pick<SessionSummary, 'title' | 'profileId' | 'groupId' | 'model' | 'permissionMode' | 'pinned' | 'archived'>>;

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
export interface ModelInfo { id: string; displayName?: string; contextWindow?: number }

// ---------- 消息 ----------
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  createdAt: number;
  model?: string;
}

export interface Session extends SessionSummary { messages: Message[]; todos: Todo[] }

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }

// ---------- 工具权限 ----------
export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  description: string;     // 人类可读描述，如 "运行命令: npm test"
}
export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

// ---------- Host 信息 ----------
export interface HostInfo {
  id: string;
  name: string;            // 机器名
  platform: string;        // linux / win32 / darwin
  version: string;
  homeDir: string;
}

export interface FsEntry { name: string; path: string; isDir: boolean }

// ---------- WebSocket: 客户端 -> 服务端 ----------
export type ClientMsg =
  | { type: 'subscribe'; sessionId: string }        // 订阅某会话的实时事件（可多端同时订阅）
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send'; sessionId: string; content: ContentBlock[] }  // 发送用户消息；运行中发送则排队
  | { type: 'interrupt'; sessionId: string }        // 中断当前轮（Esc）
  | { type: 'permission'; requestId: string; decision: PermissionDecision }
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
  | { type: 'turn_end'; sessionId: string; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

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
// POST   /api/profiles/:id/test       -> { ok: boolean; error?: string }   测试 key 可用
// POST   /api/models  ListModelsInput -> { ok: boolean; models: ModelInfo[]; error?: string }  从 provider 拉取模型列表
// GET    /api/sessions                -> SessionSummary[]   (按 updatedAt 倒序)
// POST   /api/sessions CreateSessionInput -> SessionSummary
// GET    /api/sessions/:id            -> Session
// PATCH  /api/sessions/:id UpdateSessionInput -> SessionSummary  (运行中切换模型/账号：下一轮生效)
// DELETE /api/sessions/:id
// POST   /api/sessions/:id/fork       -> SessionSummary   复制会话（含历史）为新会话
// GET    /api/fs/list?path=           -> FsEntry[]   目录选择器
// GET    /api/fs/complete?cwd=&q=     -> string[]    @文件 补全（相对 cwd 的路径）
// GET    /api/external-sessions?source=   -> ExternalSession[]    扫描 ~/.claude/projects、~/.codex/sessions
// GET    /api/external-sessions/:source/:id -> Session            只读预览（转换为 Tandem 消息格式）
// POST   /api/external-sessions/:source/:id/import -> SessionSummary  复制为 Tandem 会话
// POST   /api/config/export ConfigExportInput -> ConfigBundle
// POST   /api/config/import ConfigImportInput -> ConfigImportResult
// GET    /api/commands                -> SlashCommand[]
export interface SlashCommand { name: string; description: string; source: 'builtin' | 'project' | 'user' }

export const PROTOCOL_VERSION = 1;
