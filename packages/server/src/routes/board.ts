// 任务看板 REST：看板/卡片 CRUD、动作、列内排序、AI 拆分草稿。协议见 protocol 的「任务看板」段。
import type { FastifyInstance } from 'fastify';
import type { BoardCardAction, BoardCardInput, BoardInput, BoardPlanDraft, BoardPrInput } from '@tandem/protocol';
import { getVcsState } from '../vcs.js';
import { errorMessage } from '../util/text.js';
import { bad, statusOf, type RouteDeps } from './common.js';

const ACTIONS = new Set<BoardCardAction>(['start', 'unqueue', 'stop', 'retry', 'approve', 'reject', 'merge', 'resolve']);

export function registerBoardRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;
  const boards = () => host.boards;

  app.get('/api/boards', async () => boards().list());

  app.post('/api/boards', async (req, reply) => {
    try {
      return await boards().createBoard((req.body ?? {}) as BoardInput);
    } catch (err) {
      return bad(reply, errorMessage(err));
    }
  });

  app.get('/api/boards/:id', async (req, reply) => {
    const board = boards().get((req.params as { id: string }).id);
    return board ?? bad(reply, '看板不存在', 404);
  });

  app.put('/api/boards/:id', async (req, reply) => {
    try {
      return boards().updateBoard((req.params as { id: string }).id, (req.body ?? {}) as BoardInput);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.delete('/api/boards/:id', async (req, reply) => {
    try {
      await boards().deleteBoard((req.params as { id: string }).id);
      return { ok: true };
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/cards', async (req, reply) => {
    try {
      return boards().createCard((req.params as { id: string }).id, (req.body ?? {}) as BoardCardInput);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.put('/api/boards/:id/cards/:cid', async (req, reply) => {
    const params = req.params as { id: string; cid: string };
    try {
      return boards().updateCard(params.id, params.cid, (req.body ?? {}) as BoardCardInput);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.delete('/api/boards/:id/cards/:cid', async (req, reply) => {
    const params = req.params as { id: string; cid: string };
    try {
      await boards().deleteCard(params.id, params.cid);
      return { ok: true };
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/cards/:cid/action', async (req, reply) => {
    const params = req.params as { id: string; cid: string };
    const body = (req.body ?? {}) as { action?: BoardCardAction; note?: string; strategy?: 'merge' | 'squash' };
    if (!body.action || !ACTIONS.has(body.action)) return bad(reply, 'action 无效');
    try {
      return await boards().act(params.id, params.cid, body.action, {
        ...(body.note ? { note: body.note } : {}),
        ...(body.strategy ? { strategy: body.strategy } : {}),
      });
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/cards/:cid/move', async (req, reply) => {
    const params = req.params as { id: string; cid: string };
    const body = (req.body ?? {}) as { beforeId?: string | null };
    try {
      return boards().move(params.id, params.cid, body.beforeId);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/merge-all', async (req, reply) => {
    const body = (req.body ?? {}) as { strategy?: 'merge' | 'squash' };
    try {
      return await boards().mergeAll((req.params as { id: string }).id, body.strategy === 'merge' ? 'merge' : 'squash');
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/plan', async (req, reply) => {
    const body = (req.body ?? {}) as { goal?: string };
    try {
      return { drafts: await boards().plan((req.params as { id: string }).id, body.goal ?? '') };
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.post('/api/boards/:id/pr', async (req, reply) => {
    const body = (req.body ?? {}) as BoardPrInput;
    try {
      return await boards().openPr((req.params as { id: string }).id, body.cardIds, body.base);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.get('/api/boards/:id/pr', async (req, reply) => {
    try {
      return await boards().refreshPr((req.params as { id: string }).id);
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });

  app.get('/api/boards/:id/vcs', async (req, reply) => {
    const board = boards().get((req.params as { id: string }).id);
    if (!board) return bad(reply, '看板不存在', 404);
    return getVcsState(board.cwd);
  });

  app.post('/api/boards/:id/plan/apply', async (req, reply) => {
    const body = (req.body ?? {}) as { drafts?: BoardPlanDraft[] };
    try {
      return { cards: boards().applyPlan((req.params as { id: string }).id, body.drafts ?? []) };
    } catch (err) {
      return bad(reply, errorMessage(err), statusOf(err));
    }
  });
}
