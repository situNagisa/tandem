// Hook 执行与执行事件广播。
import type { HookEntry, HookEvent } from '@tandem/protocol';
import { runHookEntries } from '../hooks.js';
import type { HookExecutionContext, HookRunResult } from '../hooks.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';

export async function runHooks(host: Host, rec: SessionRecord,
    entries: HookEntry[],
    event: HookEvent,
    context: Omit<HookExecutionContext, 'sessionId' | 'cwd' | 'permissionMode'>): Promise<HookRunResult> {
  // 远端主机上下文不执行工作站本机的钩子（钩子配置读的是工作站用户的 ~/.claude 与项目目录）。
  if (host.remote) return { blocked: false, feedback: [], contexts: [], outcomes: [] };
  return runHookEntries(
    entries,
    event,
    {
      sessionId: rec.id,
      cwd: rec.cwd,
      permissionMode: rec.permissionMode,
      env: host.secrets.envFor(rec.cwd, 'hooks'),
      ...context,
    },
    (outcome) => {
      host.hub.broadcastSession(rec.id, {
        type: 'hook_event',
        sessionId: rec.id,
        event,
        name: outcome.name,
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        ...(outcome.blocked ? { blocked: true } : {}),
        ...(outcome.message ? { message: outcome.message } : {}),
      });
    },
  );
}
