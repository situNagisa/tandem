// 会话分页的纯函数：尾部截取、超大工具输出截断、轮次大纲。
import type { Message, SessionTurnMark } from '@tandem/protocol';

/** 单条工具输出超过 64KB 时只下发首尾各 8KB。 */
export const TOOL_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const TOOL_OUTPUT_EDGE_BYTES = 8 * 1024;
/** 快照尾部默认最多 200 条、约 2MB（单条超大消息仍会保留）。 */
export const SNAPSHOT_TAIL_MESSAGES = 200;
export const SNAPSHOT_TAIL_BYTES = 2 * 1024 * 1024;
export const PAGE_LIMIT_DEFAULT = 200;
export const PAGE_LIMIT_MAX = 500;
export const PAGE_BYTES_MAX = 4 * 1024 * 1024;
export const TURN_PREVIEW_LENGTH = 80;

function headOf(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let out = buffer.subarray(0, maxBytes).toString('utf8');
  if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return out;
}

function tailOf(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let out = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  while (out.startsWith('\uFFFD')) out = out.slice(1);
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * 分页下发前把超大工具输出压成首尾片段，原消息在 Host 内存/磁盘里保持全文。
 * 只克隆被改动的消息，旧客户端也能看到省略提示。
 */
export function truncateLargeToolOutputs(messages: Message[]): Message[] {
  let changedAny = false;
  const next = messages.map((message) => {
    let content = message.content;
    let changed = false;
    message.content.forEach((block, index) => {
      if (block.type !== 'tool_result' || block.truncated) return;
      const totalBytes = Buffer.byteLength(block.content, 'utf8');
      if (totalBytes <= TOOL_OUTPUT_LIMIT_BYTES) return;
      const head = headOf(block.content, TOOL_OUTPUT_EDGE_BYTES);
      const tail = tailOf(block.content, TOOL_OUTPUT_EDGE_BYTES);
      const omittedBytes = Math.max(
        0,
        totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
      );
      if (!changed) {
        content = content.slice();
        changed = true;
        changedAny = true;
      }
      content[index] = {
        ...block,
        content: `${head}\n\n…（已省略 ${formatBytes(omittedBytes)}，点「显示全部」查看）…\n\n${tail}`,
        truncated: { totalBytes, omittedBytes },
      };
    });
    return changed ? { ...message, content } : message;
  });
  return changedAny ? next : messages;
}

/** 按条数 + 体积取尾部消息（至少保留最后一条）。 */
export function tailMessages(
  messages: Message[],
  limit = SNAPSHOT_TAIL_MESSAGES,
  maxBytes = SNAPSHOT_TAIL_BYTES,
): Message[] {
  const count = Math.max(1, Math.min(Math.floor(limit) || SNAPSHOT_TAIL_MESSAGES, 5000));
  let start = messages.length;
  let bytes = 0;
  while (start > 0 && messages.length - start < count) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1]), 'utf8');
    if (messages.length - start > 0 && bytes + size > maxBytes) break;
    start -= 1;
    bytes += size;
  }
  return messages.slice(start);
}

/** 轮次大纲：每轮用户消息的 id 与前 80 字摘要（与前端 hasUserContent 的规则一致）。 */
export function sessionTurns(messages: Message[]): SessionTurnMark[] {
  const turns: SessionTurnMark[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const texts: string[] = [];
    let hasImage = false;
    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'image') hasImage = true;
    }
    const firstLine =
      texts
        .join('\n')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .find(Boolean) ?? '';
    const preview = firstLine || (hasImage ? '图片' : '');
    if (!preview) continue;
    turns.push({
      turn: turns.length + 1,
      messageId: message.id,
      preview:
        preview.length > TURN_PREVIEW_LENGTH
          ? `${preview.slice(0, TURN_PREVIEW_LENGTH)}…`
          : preview,
    });
  }
  return turns;
}
