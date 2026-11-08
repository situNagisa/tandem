// 仅调试版加载：内置演示模型不会进入发布产物的模块图。
import type { StreamRequest, StreamResult } from '../providers/types.js';

export async function streamBuiltInModel(req: StreamRequest): Promise<StreamResult> {
  const { streamDemo } = await import('../demo/provider.js');
  return streamDemo(req);
}
