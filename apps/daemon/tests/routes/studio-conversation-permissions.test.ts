import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDatabase, getProject, insertConversation, insertProject, listConversations, openDatabase } from '../../src/db.js';
import { multiUserActorOf, type ProjectOwnershipRouteHooks } from '../../src/http/multiuser-gate.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerProjectConversationRoutes, type RegisterProjectConversationRoutesDeps } from '../../src/routes/project/conversations.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';

let root: string;
let db: ReturnType<typeof openDatabase>;
let access: ProjectAccessStore;
const active = new Set<string>();
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
function register(hook = true) {
  routes.clear();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  registerProjectConversationRoutes(app, { db, http: {}, paths: {}, projectStore: { getProject },
    conversations: { listConversations }, ids: {}, appConfig: {}, agents: {}, design: {},
    projectOwnership: (hook ? { conversationCanWrite(res: Response, pid: string, cid: string) {
      return access.canWriteConversation(pid, cid, multiUserActorOf(res)!.accountId);
    } } : {}) as ProjectOwnershipRouteHooks,
  } as unknown as RegisterProjectConversationRoutesDeps);
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'studio-conversation-permissions-'));
  db = openDatabase(root, { dataDir: root });
  active.clear(); for (const id of ['owner', 'editor', 'viewer', 'commenter']) active.add(id);
  access = new ProjectAccessStore(db, { accountActive: (id) => active.has(id) });
  insertProject(db, { id: 'project', name: 'Shared', createdAt: 1, updatedAt: 1 });
  access.ownership.bindOwner('project', 'owner', 1);
  for (const id of ['owner', 'editor']) {
    insertConversation(db, { id: `${id}-thread`, projectId: 'project', title: id, createdAt: 1, updatedAt: 1 });
  }
  access.bindConversationAuthor('editor-thread', 'editor');
  access.setGrant('project', 'editor', 'edit', 1);
  access.setGrant('project', 'viewer', 'view', 1);
  access.setGrant('project', 'commenter', 'comment', 1);
  register();
});
afterEach(() => { closeDatabase(); rmSync(root, { recursive: true, force: true }); });
async function list(owner: string) {
  const response = internalMultiUserResponse({ accountId: owner, username: owner, role: 'user', sessionId: 'fixture', sessionExpiresAt: Date.now() + 60_000 }, () => true);
  await routes.get('GET /api/projects/:id/conversations')!({ params: { id: 'project' } } as unknown as Request, response.res);
  return (response.result()!.body as { conversations: Array<{ id: string; studioCanWrite: boolean }> }).conversations
    .map((item) => [item.id, item.studioCanWrite]).sort();
}
it('projects live per-conversation authorship into the actual list response', async () => {
  expect(await list('owner')).toEqual([['editor-thread', false], ['owner-thread', true]]);
  expect(await list('editor')).toEqual([['editor-thread', true], ['owner-thread', false]]);
  for (const id of ['viewer', 'commenter']) expect(await list(id)).toEqual([['editor-thread', false], ['owner-thread', false]]);
  access.setGrant('project', 'editor', 'view', 2);
  expect(await list('editor')).toEqual([['editor-thread', false], ['owner-thread', false]]);
});
it('does not project write authority from a suspended owner or a missing permission hook', async () => {
  active.delete('owner');
  expect(await list('editor')).toEqual([['editor-thread', false], ['owner-thread', false]]);
  active.add('owner'); register(false);
  expect(await list('owner')).toEqual([['editor-thread', false], ['owner-thread', false]]);
});
