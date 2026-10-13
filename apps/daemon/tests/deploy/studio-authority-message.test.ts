import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import type { StudioDeployment } from '@open-design/contracts';
import { registerStudioDeployRoutes } from '../../src/routes/studio-deploy.js';
import { bindMultiUserActor } from '../../src/http/multiuser-gate.js';
import { ProjectOwnershipStore } from '../../src/storage/project-ownership.js';
import { StudioDeployStore } from '../../src/storage/studio-deploy.js';

it.each(['deploy', 'redeploy', 'preflight', 'status', 'check-link', 'settings'] as const)(
  '%s authority refusal only discloses a remote deployment when it could create one', async (action) => {
    const root = mkdtempSync(path.join(tmpdir(), 'studio-authority-message-'));
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, skill_id TEXT, design_system_id TEXT,
        pending_prompt TEXT, metadata_json TEXT, applied_plugin_snapshot_id TEXT, custom_instructions TEXT,
        created_at INTEGER, updated_at INTEGER);
        INSERT INTO projects (id, name) VALUES ('p', 'Project');`);
      new ProjectOwnershipStore(db).bindOwner('p', 'a', 1);
      const store = new StudioDeployStore(db, root);
      store.update('a', 'vercel', { token: 'fixture-token-0123456789', revision: 0 });
      const record: StudioDeployment = { id: 'd', projectId: 'p', providerId: 'vercel',
        fileName: 'index.html', target: 'preview', deploymentId: 'remote', status: 'ready', url: 'https://site.vercel.app',
        digest: 'a'.repeat(64), createdAt: 1, updatedAt: 1, lastLinkCheck: null };
      store.create('a', record, {}, () => {});
      const routes = new Map<string, (req: Request, res: Response) => unknown>();
      const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method,
        (route: string, handler: (req: Request, res: Response) => unknown) => routes.set(`${method}:${route}`, handler)]));
      registerStudioDeployRoutes(app as unknown as Express, { db, dataRoot: root, projectsRoot: root,
        accountActive: () => true, sessionCurrent: () => false });
      const res = { locals: {}, status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
      res.status.mockReturnValue(res);
      bindMultiUserActor(res as unknown as Response, { accountId: 'a', username: 'a', role: 'user', sessionId: 's', sessionExpiresAt: 100 });
      const route = action === 'settings' ? 'put:/api/multiuser/deploy/config'
        : `post:/api/multiuser/projects/:id/${action === 'deploy' ? 'deploy' : action === 'preflight' ? 'deploy/preflight' : `deployments/:deploymentId/${action}`}`;
      await routes.get(route)!({ params: { id: 'p', deploymentId: 'd' }, body: { providerId: 'vercel', fileName: 'index.html' } } as unknown as Request,
        res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(409);
      const result = res.json.mock.calls[0]![0];
      expect(result.error.code).toBe('MULTIUSER_DEPLOY_AUTHORITY_CHANGED');
      expect(result.error.message.includes('remote deployment')).toBe(action === 'deploy' || action === 'redeploy');
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
