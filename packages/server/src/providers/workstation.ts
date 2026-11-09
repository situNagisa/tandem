// 工作站代理 provider：主机本身没有 Key，把请求经签名通道交给工作站；
// 工作站用账号自己的 Key 调上游并流式回传事件，这里回放为统一的 block 回调。
import type { ContentBlock, Usage } from '@tandem/protocol';
import type { StreamRequest, StreamResult } from './types.js';

export async function streamViaWorkstation(req: StreamRequest): Promise<StreamResult> {
  const proxy = req.proxy;
  if (!proxy) throw new Error('账号级模型账号需要通过工作站代理，但主机未连接工作站');
  const inputBuf = new Map<number, string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason: string | undefined;
  let error: string | undefined;

  await proxy.run(
    {
      profileId: req.profile.id,
      ...(req.groupId ? { groupId: req.groupId } : {}),
      model: req.model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      maxTokens: req.maxTokens,
      ...(req.effort ? { effort: req.effort } : {}),
      idleTimeoutSec: req.idleTimeoutSec,
    },
    (event) => {
      switch (event.type) {
        case 'block_start': {
          req.blocks[event.index] = event.block;
          req.onBlockStart(event.index, event.block);
          if (event.block.type === 'tool_use') inputBuf.set(event.index, '');
          break;
        }
        case 'text': {
          const block = req.blocks[event.index];
          if (block?.type === 'text' || block?.type === 'thinking') {
            block.text += event.text;
            req.onText(event.index, event.text);
          }
          break;
        }
        case 'tool_input': {
          const block = req.blocks[event.index];
          if (block?.type === 'tool_use') {
            inputBuf.set(event.index, (inputBuf.get(event.index) ?? '') + event.partialJson);
            req.onToolInput(event.index, event.partialJson);
          }
          break;
        }
        case 'rate_limit':
          req.onRateLimit?.(event.info as never);
          break;
        case 'effort_dropped':
          req.onEffortDropped?.();
          break;
        case 'done':
          usage.inputTokens = event.usage.inputTokens ?? 0;
          usage.outputTokens = event.usage.outputTokens ?? 0;
          usage.cacheReadTokens = event.usage.cacheReadTokens ?? 0;
          usage.cacheWriteTokens = event.usage.cacheWriteTokens ?? 0;
          if (event.stopReason) stopReason = event.stopReason;
          break;
        case 'error':
          error = event.message;
          break;
        default:
          break;
      }
    },
    req.signal,
  );

  finishToolInputs(req.blocks, inputBuf);
  if (error) throw new Error(error);
  return { usage, ...(stopReason ? { stopReason } : {}) };
}

function finishToolInputs(blocks: ContentBlock[], inputBuf: Map<number, string>): void {
  for (const [index, raw] of inputBuf) {
    const block = blocks[index];
    if (!block || block.type !== 'tool_use') continue;
    if (!raw.trim()) {
      block.input = {};
      continue;
    }
    try {
      block.input = JSON.parse(raw);
    } catch {
      block.input = {};
    }
  }
  inputBuf.clear();
}
