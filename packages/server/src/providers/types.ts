// 各 provider 共用的流式接口：统一产出协议 ContentBlock / BlockDelta。
import type { ContentBlock, Message, ReasoningEffort, Usage, WorkspaceModelProxyEvent } from '@tandem/protocol';
import type { StoredProfile, ToolDefinition } from '../types.js';

/** 工作站账号级模型账号：把一次请求交给工作站代理执行（Key 留在工作站）。 */
export interface ProxyRunner {
  run: (
    body: {
      profileId: string;
      groupId?: string;
      model: string;
      system: string;
      messages: Message[];
      tools: ToolDefinition[];
      maxTokens: number;
      effort?: ReasoningEffort;
      idleTimeoutSec: number;
      /** 冷却中的 Key 也直接试一次（用户选择继续使用当前分组 / 关闭交接）。 */
      includeCoolingKeys?: boolean;
    },
    emit: (event: WorkspaceModelProxyEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface StreamRequest {
  profile: StoredProfile;
  /** 账号级镜像：原始分组 id（有效账号会合并分组字段）。 */
  groupId?: string;
  /** 账号级镜像：请求经工作站代理；Key 不在主机上。 */
  proxy?: ProxyRunner;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** provider 把内容块写入这个数组（引用共享，便于出错/中断时保留部分内容）。 */
  blocks: ContentBlock[];
  signal: AbortSignal;
  idleTimeoutSec: number;
  maxTokens: number;
  /** 思考强度；缺省或 off 时不向 provider 发送思考参数。 */
  effort?: ReasoningEffort;
  /** 账号级镜像：冷却中的 Key 也直接试一次（用户选择继续使用当前分组 / 关闭交接）。 */
  includeCoolingKeys?: boolean;
  /** provider 因上游拒绝思考参数而去掉参数并重试成功时调用（每轮只记一次），detail 为脱敏后的上游错误摘要。 */
  onEffortDropped?: (detail: string) => void;
  /** 响应头里的限流额度（provider 支持时）；用于按 Key 记录剩余额度。 */
  onRateLimit?: (info: ProviderRateLimit, keyId?: string) => void;
  onBlockStart: (index: number, block: ContentBlock) => void;
  onText: (index: number, text: string) => void;
  onToolInput: (index: number, partialJson: string) => void;
}

/** provider 限流响应头解析结果；缺省字段表示该 provider 没有返回。 */
export interface ProviderRateLimit {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetRequestsAt?: number;
  resetTokensAt?: number;
  unifiedStatus?: string;
  unifiedResetAt?: number;
}

export interface StreamResult {
  usage: Usage;
  stopReason?: string;
}
