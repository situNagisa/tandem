// 会话：CRUD、环境（分支 / worktree / 迁移）、检查点、改动审阅、VCS / PR / CI。
import type { FastifyInstance } from 'fastify';
import type {
  CreateSessionInput,
  PrMergeMethod,
  RewindInput,
  SearchFilters,
  SearchHit,
  SearchStatusFilter,
  UpdateSessionInput,
} from '@tandem/protocol';
import { commitChanges, getChanges, getFileDiff, revertChanges } from '../changes.js';
import { clearCompactionBackup, readCompactionBackup } from '../host/compaction.js';
import { createPullRequest, failedCheckPrompt, getVcsState, mergePullRequest } from '../vcs.js';
import { bad, statusOf, str, type RouteDeps } from './common.js';
import { memberCanAccessPath, memberCanSeeSession, principalOf } from '../team/access.js';
import { recordAudit } from '../team/audit.js';
import { expandHome } from '../util/path.js';
import type { SessionRecord } from '../types.js';
import path from 'node:path';

const SEARCH_STATUS: SearchStatusFilter[] = [
  'all',
  'running',
  'waiting_permission',
  'error',
  'unread',
];

function searchFilters(query: Record<string, unknown>): SearchFilters {
  let base: SearchFilters = {};
  if (typeof query.filters === 'string' && query.filters.trim()) {
    try {
      const parsed = JSON.parse(query.filters) as SearchFilters;
      if (parsed && typeof parsed === 'object') base = parsed;
    } catch {
      // 非法 JSON 忽略，按单参数处理
    }
  }
  const source = str(query.source) || base.source;
  if (source === 'tandem' || source === 'claude-code' || source === 'codex') {
    base.source = source;
  } else {
    delete base.source;
  }
  const status = str(query.status) || base.status;
  base.status = SEARCH_STATUS.includes(status as SearchStatusFilter)
    ? (status as SearchStatusFilter)
    : 'all';
  const project = str(query.project) || base.project;
  if (project && project !== 'all') base.project = project;
  else delete base.project;
  const archived = str(query.includeArchived);
  base.includeArchived =
    archived === '1' || archived === 'true' || base.includeArchived === true;
  return base;
}

function statusMatches(rec: SessionRecord | undefined, status: SearchStatusFilter): boolean {
  if (!rec || status === 'all') return true;
  if (status === 'running') return rec.status === 'running' || rec.status === 'retrying';
  if (status === 'waiting_permission') return rec.status === 'waiting_permission';
  if (status === 'error') return rec.status === 'error';
  return rec.unread === true;
}

export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  // 会话全文搜索（Host 本地索引；结果按成员可见性与筛选条件过滤）。
  app.get('/api/search', async (req) => {
    const principal = principalOf(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const q = str(query.q) || str(query.query);
    if (!q) return { q: '', tookMs: 0, total: 0, hits: [] };
    const filters = searchFilters(query);
    const result = await host.searchIndex.search(q, filters);
    const imported = new Set(
      host
        .listSessions()
        .filter((rec) => rec.importedFrom)
        .map((rec) => `${rec.importedFrom!.source}:${rec.importedFrom!.id}`),
    );
    const hits: SearchHit[] = [];
    for (const hit of result.hits) {
      if (hit.source === 'tandem') {
        const rec = host.store.get(hit.sessionId);
        if (!rec || rec.evalRun) continue;
        if (!memberCanSeeSession(principal, rec)) continue;
        if (rec.archived && !filters.includeArchived) continue;
        if (!statusMatches(rec, filters.status ?? 'all')) continue;
        if (filters.project && hit.project !== filters.project) continue;
        hits.push({ ...hit, title: rec.title || '未命名会话', updatedAt: rec.updatedAt });
      } else {
        // 外部会话没有 Tandem 内状态；成员暂不开放外部原文搜索。
        if (principal.kind !== 'owner') continue;
        if (imported.has(`${hit.source}:${hit.sessionId}`)) continue;
        if (filters.status && filters.status !== 'all') continue;
        if (filters.project && hit.project !== filters.project) continue;
        hits.push(hit);
      }
    }
    return { ...result, total: hits.length, hits: hits.slice(0, 100) };
  });

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
    const query = (req.query ?? {}) as { tail?: string };
    const tail = Number(query.tail);
    if (query.tail !== undefined && Number.isFinite(tail) && tail > 0) {
      return host.toSessionPaged(rec, tail);
    }
    return host.toSession(rec);
  });

  // 向前翻页：只回一小段，客户端滚到顶/跳转未加载的轮时按需取。
  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const query = (req.query ?? {}) as { before?: string; around?: string; limit?: string };
    const limit = Number(query.limit);
    return host.messagePage(rec, {
      beforeId: str(query.before) || undefined,
      aroundId: str(query.around) || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // 轮次大纲：只回轮号、消息 id、前 80 字，不拉全量消息。
  app.get('/api/sessions/:id/turns', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.turnsFor(rec);
  });

  // 超大工具输出“显示全部”：按消息 id + block 下标取完整内容块。
  app.get('/api/sessions/:id/message-block', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const query = (req.query ?? {}) as { messageId?: string; index?: string; toolUseId?: string };
    const messageId = str(query.messageId) || undefined;
    const toolUseId = str(query.toolUseId) || undefined;
    const index = Number(query.index);
    if (!toolUseId && (!messageId || !Number.isInteger(index) || index < 0)) {
      return bad(reply, 'messageId + index 或 toolUseId 不能为空');
    }
    const block = host.messageBlock(rec, {
      ...(toolUseId ? { toolUseId } : { messageId, index: Number.isInteger(index) ? index : undefined }),
    });
    if (!block) return bad(reply, '内容块不存在', 404);
    return { block };
  });

  // 压缩提示「查看原文」：返回被压掉的原始消息（仅最近一次压缩有留档）。
  app.get('/api/sessions/:id/compaction/:noticeId', async (req, reply) => {
    const { id, noticeId } = req.params as { id: string; noticeId: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const notice = rec.messages.find((message) => message.id === noticeId);
    if (!notice?.compaction) return bad(reply, '压缩提示不存在', 404);
    const backup = readCompactionBackup(host.home, id);
    if (!backup || backup.noticeId !== noticeId) {
      return bad(reply, '原文已不可用（只保留最近一次压缩的原文）', 409);
    }
    return { summary: notice.compaction.summary, messages: backup.messages };
  });

  // 撤销压缩：恢复压缩前的消息；只允许撤销最近一次压缩。
  app.post('/api/sessions/:id/compaction/:noticeId/undo', async (req, reply) => {
    const { id, noticeId } = req.params as { id: string; noticeId: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    if (host.isRunning(id)) return bad(reply, '会话正在运行，结束后才能撤销压缩', 409);
    const index = rec.messages.findIndex((message) => message.id === noticeId);
    if (index < 0 || !rec.messages[index]?.compaction) return bad(reply, '压缩提示不存在', 404);
    const backup = readCompactionBackup(host.home, id);
    if (!backup || backup.noticeId !== noticeId) {
      return bad(reply, '原文已不可用（只保留最近一次压缩的原文）', 409);
    }
    rec.messages = [
      ...backup.messages.filter((message) => message.id !== noticeId),
      ...rec.messages.slice(index + 1),
    ];
    for (const message of rec.messages) {
      if (message.compaction) {
        if (message.compaction.canUndo) delete message.compaction.canUndo;
      }
    }
    host.store.markDirty(id, true);
    host.broadcastSnapshot(rec);
    host.broadcastSummary(rec);
    clearCompactionBackup(host.home, id);
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

  // 额度将尽：从交接卡选择切换备用分组 / 等待重置 / 暂停
  app.post('/api/sessions/:id/handoff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.store.get(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const action = (req.body as { action?: unknown } | null)?.action;
    if (action !== 'switch' && action !== 'wait' && action !== 'pause') {
      return bad(reply, 'action 必须是 switch / wait / pause', 400);
    }
    try {
      await host.chooseHandoff(rec, action);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
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
      const existing = host.store.get(id);
      if (!existing) return bad(reply, '会话不存在', 404);
      if (existing.demo && typeof patch.cwd === 'string' && !host.demo.isDemoPath(patch.cwd)) {
        return bad(reply, '演示会话只能使用演示仓库目录');
      }
      const rec = host.updateSession(id, patch);
      if (!rec) return bad(reply, '会话不存在', 404);
      if (typeof patch.cwd === 'string') await host.refreshEnv(id);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/sessions/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.markRead(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSummary(rec);
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
        ...(typeof body.messageId === 'string' ? { messageId: body.messageId } : {}),
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

  // ---------- 提交前 AI 评审 ----------
  app.post('/api/sessions/:id/ai-review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { paths?: unknown };
    return { review: host.aiReviews.start(rec, body.paths) };
  });

  app.get('/api/sessions/:id/ai-review', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const review = host.aiReviews.latestFor(id);
    return review ? { review } : {};
  });

  app.get('/api/sessions/:id/ai-review/:reviewId', async (req, reply) => {
    const { id, reviewId } = req.params as { id: string; reviewId: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const review = host.aiReviews.get(id, reviewId);
    if (!review) return bad(reply, '评审记录不存在', 404);
    return { review };
  });

  app.post('/api/sessions/:id/ai-review/:reviewId/false-positive', async (req, reply) => {
    const { id, reviewId } = req.params as { id: string; reviewId: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { findingId?: unknown };
    const findingId = str(body.findingId);
    if (!findingId) return bad(reply, 'findingId 不能为空');
    const ok = host.aiReviews.recordFalsePositive(id, reviewId, findingId);
    if (!ok) return bad(reply, '没有找到这条评审意见', 404);
    return { ok: true };
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
