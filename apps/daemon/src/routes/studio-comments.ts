import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { PreviewComment } from '@open-design/contracts';
import {
  deletePreviewComment, getConversation, getPreviewComment, isProjectCommentAnchorConversationId, listPreviewComments,
  reorderPreviewComment, updatePreviewCommentAnchor, updatePreviewCommentStatus, updateProject, upsertPreviewComment,
} from '../db.js';
import { ProjectAccessStore, projectRoleAtLeast, type ProjectAccessRole, type ProjectAccessOptions } from '../storage/project-access.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';

/** Per-conversation ceiling; comments are an overlay, not a document store. */
export const STUDIO_COMMENTS_PER_CONVERSATION_MAX = 500;

/**
 * Preview comments for the owner and the accounts the project is shared with
 * (#59, #65). Standard comment endpoints rewrite here in multi-user mode, so
 * the workspace/collab identity resolution of the host handler never runs for
 * a remote actor. The author is stamped from the session (`authorMemberId` is
 * the account id) and never accepted from the client. Any member reads; a
 * comment role creates and moves comments; only the author edits a note; the
 * author, the owner or an editor changes status; the author or the owner
 * deletes. A comment without an author predates sharing and is the owner's.
 * A client-chosen id is honored only to edit a comment that already exists in
 * this project's conversation. Foreign, missing and admin requests share one
 * refusal, and so does a member acting beyond its role.
 */
export function registerStudioCommentRoutes(app: Express, input: {
  db: Database.Database;
  /** Tell the other members' open project views to re-read comments. */
  onChanged?: (projectId: string) => void;
} & ProjectAccessOptions): void {
  const { db } = input;
  const changed = (projectId: string) => { try { input.onChanged?.(projectId); } catch { /* best-effort signal */ } };
  const access = new ProjectAccessStore(db, input);
  const base = '/api/multiuser/projects/:id/conversations/:cid/comments';
  type Scope = { projectId: string; conversationId: string; actor: string; role: ProjectAccessRole };
  /** The readable project/conversation pair, or null after sending the shared refusal. */
  const scope = (req: Request, res: Response, required: ProjectAccessRole): Scope | null => {
    const projectId = String(req.params.id); const conversationId = String(req.params.cid);
    const actor = multiUserActorOf(res)?.accountId;
    const role = actor ? access.roleOf(projectId, actor) : null;
    const conversation = actor && projectRoleAtLeast(role, required) && !isProjectCommentAnchorConversationId(conversationId)
      ? getConversation(db, conversationId) as { projectId?: string } | null : null;
    if (!actor || !role || conversation?.projectId !== projectId) { sendApiError(res, 404, 'NOT_FOUND', 'resource not found'); return null; }
    return { projectId, conversationId, actor, role };
  };
  const existing = (target: Scope, commentId: string) =>
    getPreviewComment(db, target.projectId, target.conversationId, commentId) as PreviewComment | null;
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'comment not found');
  const authoredBy = (target: Scope, comment: PreviewComment) =>
    comment.authorMemberId ? comment.authorMemberId === target.actor : target.role === 'owner';
  /** The existing comment when the actor may act on it with `rule`, else null. */
  const permitted = (target: Scope, commentId: string, rule: 'author' | 'author-or-owner' | 'author-owner-or-editor') => {
    const comment = existing(target, commentId);
    if (!comment) return null;
    if (authoredBy(target, comment)) return comment;
    if (rule !== 'author' && target.role === 'owner') return comment;
    return rule === 'author-owner-or-editor' && target.role === 'edit' ? comment : null;
  };

  app.get(base, (req, res) => {
    const target = scope(req, res, 'view'); if (!target) return;
    res.set('Cache-Control', 'no-store').json({ comments: listPreviewComments(db, target.projectId, target.conversationId) });
  });

  app.post(base, (req, res) => {
    const target = scope(req, res, 'comment'); if (!target) return;
    const body = req.body as { id?: string; target: unknown; note?: string; attachments?: unknown };
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    const previous = id ? permitted(target, id, 'author') : null;
    if (id && !previous) return notFound(res);
    if (!id) {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM preview_comments WHERE project_id = ? AND conversation_id = ?')
        .get(target.projectId, target.conversationId) as { n: number }).n;
      if (count >= STUDIO_COMMENTS_PER_CONVERSATION_MAX) return sendApiError(res, 409, 'CONFLICT', 'comment limit reached for this conversation');
    }
    // A new comment is authored by the session's account; an edit keeps its author.
    const authorMemberId = previous ? previous.authorMemberId : target.actor;
    try {
      const comment = db.transaction(() => {
        const saved = upsertPreviewComment(db, target.projectId, target.conversationId,
          { target: body.target, note: body.note ?? '', ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
            ...(id ? { id } : {}), ...(authorMemberId ? { authorMemberId } : {}) });
        if (saved) updateProject(db, target.projectId, {});
        return saved;
      })();
      if (!comment) return notFound(res);
      changed(target.projectId);
      res.json({ comment });
    } catch {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid comment');
    }
  });

  app.patch(`${base}/:commentId`, (req, res) => {
    const target = scope(req, res, 'comment'); if (!target) return;
    const commentId = String(req.params.commentId);
    if (!permitted(target, commentId, 'author-owner-or-editor')) return notFound(res);
    const comment = db.transaction(() => {
      const saved = updatePreviewCommentStatus(db, target.projectId, target.conversationId, commentId, (req.body as { status: string }).status);
      if (saved) updateProject(db, target.projectId, {});
      return saved;
    })();
    if (comment) changed(target.projectId);
    return comment ? res.json({ comment }) : notFound(res);
  });

  // Anchors and order are shared layout every commenter's viewer maintains.
  app.patch(`${base}/:commentId/anchor`, (req, res) => {
    const target = scope(req, res, 'comment'); if (!target) return;
    const comment = updatePreviewCommentAnchor(db, target.projectId, target.conversationId, String(req.params.commentId), req.body ?? {});
    return comment ? res.json({ comment }) : notFound(res);
  });

  app.patch(`${base}/:commentId/reorder`, (req, res) => {
    const target = scope(req, res, 'comment'); if (!target) return;
    const comment = reorderPreviewComment(db, target.projectId, target.conversationId, String(req.params.commentId), Number((req.body as { sortKey: number }).sortKey));
    if (comment) changed(target.projectId);
    return comment ? res.json({ comment }) : notFound(res);
  });

  app.delete(`${base}/:commentId`, (req, res) => {
    const target = scope(req, res, 'comment'); if (!target) return;
    const commentId = String(req.params.commentId);
    if (!permitted(target, commentId, 'author-or-owner')) return notFound(res);
    const deleted = db.transaction(() => {
      const ok = deletePreviewComment(db, target.projectId, target.conversationId, commentId);
      if (ok) updateProject(db, target.projectId, {});
      return ok;
    })();
    if (deleted) changed(target.projectId);
    return deleted ? res.json({ ok: true }) : notFound(res);
  });
}
