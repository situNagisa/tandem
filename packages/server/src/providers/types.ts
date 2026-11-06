// 各 provider 共用的流式接口：统一产出协议 ContentBlock / BlockDelta。
import type { ContentBlock, Message, ReasoningEffort, Usage } from '@tandem/protocol';
import type { StoredProfile, ToolDefinition } from '../types.js';

export interface StreamRequest {
  profile: StoredProfile;
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
  /** provider 因模型不支持而去掉思考参数并重试成功时调用（每轮只记一次）。 */
  onEffortDropped?: () => void;
  onBlockStart: (index: number, block: ContentBlock) => void;
  onText: (index: number, text: string) => void;
  onToolInput: (index: number, partialJson: string) => void;
}

export interface StreamResult {
  usage: Usage;
  stopReason?: string;
}
