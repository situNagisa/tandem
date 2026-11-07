// Secret 打码：工具输出、Hook 反馈、模型请求与消息广播前的统一文本处理。
import type { ContentBlock, Message } from '@tandem/protocol';

export type Redactor = (text: string) => string;

function redactUnknown(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactUnknown(item, redact);
    }
    return out;
  }
  return value;
}

export function redactContentBlock(block: ContentBlock, redact: Redactor): ContentBlock {
  switch (block.type) {
    case 'text':
    case 'thinking':
    case 'context':
      return { ...block, text: redact(block.text) };
    case 'tool_result':
      return { ...block, content: redact(block.content) };
    case 'tool_use':
      return { ...block, input: redactUnknown(block.input, redact) };
    default:
      return block;
  }
}

/** 复制消息并打码所有文本/工具入参与结果；图片块原样保留。 */
export function redactMessages(messages: Message[], redact: Redactor): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => redactContentBlock(block, redact)),
  }));
}
