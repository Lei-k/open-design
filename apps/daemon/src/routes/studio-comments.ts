import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { PreviewComment } from '@open-design/contracts';
import {
  deletePreviewComment, getConversation, getPreviewComment, isProjectCommentAnchorConversationId, listPreviewComments,
  reorderPreviewComment, updatePreviewCommentAnchor, updatePreviewCommentStatus, updateProject, upsertPreviewComment,
} from '../db.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';

/** Per-conversation ceiling; comments are an overlay, not a document store. */
export const STUDIO_COMMENTS_PER_CONVERSATION_MAX = 500;

/**
 * Owner-only preview comments (#59, #65). Standard comment endpoints rewrite
 * here in multi-user mode, so the workspace/collab identity resolution of the
 * host handler never runs for a remote actor. The project owner is the only
 * author: no member id is stamped or accepted, nothing is relayed, and a
 * client-chosen id is honored only to edit a comment that already exists in
 * this project's conversation. Foreign, missing and admin requests share one
 * refusal (the gate has already resolved project ownership; this rechecks it).
 */
export function registerStudioCommentRoutes(app: Express, input: { db: Database.Database }): void {
  const { db } = input;
  const ownership = new ProjectOwnershipStore(db);
  const base = '/api/multiuser/projects/:id/conversations/:cid/comments';
  /** The owned project/conversation pair, or null after sending the shared refusal. */
  const scope = (req: Request, res: Response): { projectId: string; conversationId: string } | null => {
    const projectId = String(req.params.id); const conversationId = String(req.params.cid);
    const owner = multiUserActorOf(res)?.accountId;
    const conversation = owner && ownership.isOwnedBy(projectId, owner) && !isProjectCommentAnchorConversationId(conversationId)
      ? getConversation(db, conversationId) as { projectId?: string } | null : null;
    if (conversation?.projectId !== projectId) { sendApiError(res, 404, 'NOT_FOUND', 'resource not found'); return null; }
    return { projectId, conversationId };
  };
  const existing = (projectId: string, conversationId: string, commentId: string) =>
    getPreviewComment(db, projectId, conversationId, commentId) as PreviewComment | null;
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'comment not found');

  app.get(base, (req, res) => {
    const target = scope(req, res); if (!target) return;
    res.set('Cache-Control', 'no-store').json({ comments: listPreviewComments(db, target.projectId, target.conversationId) });
  });

  app.post(base, (req, res) => {
    const target = scope(req, res); if (!target) return;
    const body = req.body as { id?: string; target: unknown; note?: string; attachments?: unknown };
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    if (id && !existing(target.projectId, target.conversationId, id)) return notFound(res);
    if (!id) {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM preview_comments WHERE project_id = ? AND conversation_id = ?')
        .get(target.projectId, target.conversationId) as { n: number }).n;
      if (count >= STUDIO_COMMENTS_PER_CONVERSATION_MAX) return sendApiError(res, 409, 'CONFLICT', 'comment limit reached for this conversation');
    }
    try {
      const comment = db.transaction(() => {
        // Never a client-chosen id on create and never an author stamp: the owner is the only author.
        const saved = upsertPreviewComment(db, target.projectId, target.conversationId,
          { target: body.target, note: body.note ?? '', ...(body.attachments !== undefined ? { attachments: body.attachments } : {}), ...(id ? { id } : {}) });
        if (saved) updateProject(db, target.projectId, {});
        return saved;
      })();
      if (!comment) return notFound(res);
      res.json({ comment });
    } catch {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid comment');
    }
  });

  app.patch(`${base}/:commentId`, (req, res) => {
    const target = scope(req, res); if (!target) return;
    const comment = db.transaction(() => {
      const saved = updatePreviewCommentStatus(db, target.projectId, target.conversationId, String(req.params.commentId), (req.body as { status: string }).status);
      if (saved) updateProject(db, target.projectId, {});
      return saved;
    })();
    return comment ? res.json({ comment }) : notFound(res);
  });

  app.patch(`${base}/:commentId/anchor`, (req, res) => {
    const target = scope(req, res); if (!target) return;
    const comment = updatePreviewCommentAnchor(db, target.projectId, target.conversationId, String(req.params.commentId), req.body ?? {});
    return comment ? res.json({ comment }) : notFound(res);
  });

  app.patch(`${base}/:commentId/reorder`, (req, res) => {
    const target = scope(req, res); if (!target) return;
    const comment = reorderPreviewComment(db, target.projectId, target.conversationId, String(req.params.commentId), Number((req.body as { sortKey: number }).sortKey));
    return comment ? res.json({ comment }) : notFound(res);
  });

  app.delete(`${base}/:commentId`, (req, res) => {
    const target = scope(req, res); if (!target) return;
    const deleted = db.transaction(() => {
      const ok = deletePreviewComment(db, target.projectId, target.conversationId, String(req.params.commentId));
      if (ok) updateProject(db, target.projectId, {});
      return ok;
    })();
    return deleted ? res.json({ ok: true }) : notFound(res);
  });
}
