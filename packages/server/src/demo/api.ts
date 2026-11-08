// 演示工作区的对外接口；发布版使用空实现，不加载任何演示剧本与种子数据。
import type { DemoState } from '@tandem/protocol';

export interface DemoApi {
  get(): DemoState;
  isDemoPath(target: string): boolean;
  restore(): Promise<void>;
  create(): Promise<DemoState>;
  replay(id: string): Promise<DemoState>;
  play(id: string): boolean;
  clear(): Promise<void>;
}

export class DisabledDemoManager implements DemoApi {
  get(): DemoState {
    return { active: false, scenarios: [], networkRequests: 0 };
  }

  isDemoPath(): boolean {
    return false;
  }

  async restore(): Promise<void> {}

  async create(): Promise<DemoState> {
    throw new Error('Not available in this build');
  }

  async replay(): Promise<DemoState> {
    throw new Error('Not available in this build');
  }

  play(): boolean {
    return false;
  }

  async clear(): Promise<void> {}
}
