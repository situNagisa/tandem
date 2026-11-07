// 会话：CRUD、环境（分支 / worktree / 迁移）、检查点、改动审阅、VCS / PR / CI。
import type { FastifyInstance } from 'fastify';
import type {
  CreateSessionInput,
  PrMergeMethod,
  RewindInput,
  UpdateSessionInput,
} from '@tandem/protocol';
import { commitChanges, getChanges, getFileDiff, revertChanges } from '../changes.js';
import { createPullRequest, failedCheckPrompt, getVcsState, mergePullRequest } from '../vcs.js';
import { bad, statusOf, str, type RouteDeps } from './common.js';
import { memberCanAccessPath, memberCanSeeSession, principalOf } from '../team/access.js';
import { recordAudit } from '../team/audit.js';
import { expandHome } from '../util/path.js';
import path from 'node:path';

export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/sessions', async (req) => {
    const principal = principalOf(req);
    return host
      .listSessions()
      .filter((rec) => memberCanSeeSession(principal, rec))
      .map((s) => host.toSummary(s));
  });

  app.post('/api/sessions', async (req, reply) => {
    const principal = principalOf(req);
    try {
      const input = (req.body ?? {}) as Partial<CreateSessionInput>;
      if (principal.kind === 'member') {
        const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
        const cwd = rawCwd ? path.resolve(expandHome(rawCwd)) : '';
        if (!cwd || !memberCanAccessPath(principal, cwd)) {
          return bad(reply, '只能在自己被授权的项目目录里新建会话', 403);
        }
      }
      const rec = await host.createSession(input);
      // 创建时检测 cwd 的 git 仓库/分支，供侧栏归类
      await host.refreshEnv(rec.id);
      recordAudit(host, principal, 'session.create', { sessionId: rec.id, sessionTitle: rec.title });
      return reply.code(201).send(host.toSummary(rec));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSession(rec);
  });

  app.get('/api/sessions/:id/context', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.contextFor(rec);
  });

  app.get('/api/sessions/:id/injections', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.injectionsFor(rec);
  });

  // Host 重启后暂停的会话：用户确认后继续运行
  app.post('/api/sessions/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.resumePausedSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSummary(rec);
  });

  // block 预算达到上限后，用户可在会话内临时放行一次
  app.post('/api/sessions/:id/budget-allow-once', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.allowBudgetOnce(id)) return bad(reply, '会话不存在', 404);
    return { ok: true };
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const patch = (req.body ?? {}) as Partial<UpdateSessionInput>;
      const rec = host.updateSession(id, patch);
      if (!rec) return bad(reply, '会话不存在', 404);
      if (typeof patch.cwd === 'string') await host.refreshEnv(id);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { force?: string };
    const force = query.force === '1' || query.force === 'true';
    try {
      if (!(await host.deleteSession(id, force))) return bad(reply, '会话不存在', 404);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
    return reply.code(204).send();
  });

  // worktree 会话合回基准分支
  app.post('/api/sessions/:id/worktree/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { strategy?: unknown };
    const strategy = body.strategy === 'squash' ? 'squash' : body.strategy === 'merge' || body.strategy === undefined ? 'merge' : '';
    if (!strategy) return bad(reply, 'strategy 必须是 merge 或 squash');
    try {
      return await host.mergeSessionWorktree(id, strategy);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/sessions/:id/fork', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { messageId?: unknown };
    try {
      const rec = host.forkSession(id, str(body.messageId) || undefined);
      if (!rec) return bad(reply, '会话不存在', 404);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  // ---------- 会话环境：分支 / worktree / 跨 Host 迁移 ----------
  app.get('/api/sessions/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await host.sessionBranches(id);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/sessions/:id/checkout', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { branch?: unknown; create?: unknown };
    const branch = str(body.branch);
    if (!branch) return bad(reply, 'branch 不能为空');
    try {
      const rec = await host.checkoutSessionBranch(id, branch, body.create === true);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/sessions/:id/worktree', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { branch?: unknown };
    try {
      const rec = await host.enterSessionWorktree(id, str(body.branch) || undefined);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.get('/api/sessions/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSession(rec);
  });

  app.post('/api/sessions/import', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { session?: unknown; cwd?: unknown };
      const rec = await host.importSession(body);
      await host.refreshEnv(rec.id);
      return reply.code(201).send(host.toSummary(rec));
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  // ---------- 检查点 ----------
  app.get('/api/sessions/:id/checkpoints', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    return host.listCheckpoints(id);
  });

  app.post('/api/sessions/:id/rewind', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as Partial<RewindInput>;
    try {
      return host.rewind(id, {
        checkpointId: typeof body.checkpointId === 'string' ? body.checkpointId : '',
        restoreFiles: body.restoreFiles === true,
        restoreConversation: body.restoreConversation === true,
      });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  // ---------- 改动审阅（git 工作区） ----------
  app.get('/api/sessions/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return getChanges(rec.cwd);
  });

  app.get('/api/sessions/:id/changes/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const query = req.query as { path?: string };
    const filePath = str(query.path);
    if (!filePath) return bad(reply, 'path 不能为空');
    try {
      return await getFileDiff(rec.cwd, filePath);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/changes/revert', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { paths?: unknown };
    if (!Array.isArray(body.paths)) return bad(reply, 'paths 必须是数组');
    try {
      return await revertChanges(rec.cwd, body.paths.filter((p): p is string => typeof p === 'string'));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/changes/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { message?: unknown; paths?: unknown };
    return commitChanges(rec.cwd, body.message, body.paths);
  });

  // ---------- VCS / PR / CI（本机 git + gh / glab） ----------
  app.get('/api/sessions/:id/vcs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    try {
      return await getVcsState(rec.cwd, rec.id);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/sessions/:id/pr', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    try {
      return await getVcsState(rec.cwd, rec.id);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/pr', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return await createPullRequest(rec.cwd, rec.id, {
        title: str(body.title),
        ...(typeof body.body === 'string' ? { body: body.body } : {}),
        ...(str(body.base) ? { base: str(body.base) } : {}),
        ...(body.draft === true ? { draft: true } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/pr/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { method?: unknown };
    const method = str(body.method);
    if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
      return bad(reply, '合并方式无效');
    }
    try {
      return await mergePullRequest(rec.cwd, rec.id, method as PrMergeMethod);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/pr/fix', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await failedCheckPrompt(
        rec.cwd,
        { checkName: body.checkName, runId: body.runId, url: body.url },
        (name, log) =>
          host.promptTemplates.render('ciFix', { name, log }, rec.cwd),
      );
      if (!result.ok || !result.message) return result;
      await host.send(rec.id, [{ type: 'text', text: result.message }]);
      return { ok: true, sent: true, checkName: result.checkName };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
