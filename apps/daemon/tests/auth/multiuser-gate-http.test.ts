// Issue #3/#4 — multi-user authorization gate at the daemon HTTP boundary.
//
// One real daemon (startServer, port 0, isolated temp OD_DATA_DIR) in
// multi-user mode, two ordinary users and one admin. Everything goes through
// real HTTP from a loopback peer, which must NOT act as a bypass.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MULTIUSER_ROUTE_CLASSIFICATION,
  findStaleClassifications,
  findUnclassifiedRegistrations,
  routeKey,
} from '../../src/http/multiuser-route-classes.js';
import {
  cleanupIsolatedDataRoot,
  loadIsolatedServerModule,
  login,
  provisionAccounts,
  startMultiUserDaemon,
  type Principal,
  type StartedMultiUserDaemon,
} from './multiuser-harness.js';

const SAVED_ENV = {
  OD_API_TOKEN: process.env.OD_API_TOKEN,
  OD_DISABLE_API_AUTH: process.env.OD_DISABLE_API_AUTH,
  OD_BIND_HOST: process.env.OD_BIND_HOST,
};

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let staticDir: string;
let admin: Principal;
let alice: Principal;
let bob: Principal;
const plantedProjectId = randomUUID();
const plantedFile = 'STATIC_FILE_MUST_NOT_WIN';

interface CreatedProject {
  id: string;
  conversationId: string;
}

async function createProject(user: Principal, name: string, extra: Record<string, unknown> = {}): Promise<CreatedProject> {
  const id = randomUUID();
  const res = await daemon.request({
    method: 'POST',
    path: '/api/projects',
    cookie: user.cookie,
    body: { id, name, ...extra },
  });
  expect(res.status, res.text).toBe(200);
  return { id, conversationId: res.json.conversationId };
}

async function listProjectIds(user: Principal): Promise<string[]> {
  const res = await daemon.request({ path: '/api/projects', cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return (res.json.projects as Array<{ id: string }>).map((p) => p.id);
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  delete process.env.OD_BIND_HOST;
  ({ dataRoot } = await loadIsolatedServerModule());
  staticDir = path.join(dataRoot, 'static-fixture');
  mkdirSync(path.join(staticDir, 'api', 'projects'), { recursive: true });
  writeFileSync(path.join(staticDir, 'api', 'projects', 'index.html'), plantedFile);
  writeFileSync(path.join(staticDir, 'api', 'projects', plantedProjectId), plantedFile);
  daemon = await startMultiUserDaemon(undefined, staticDir);
  const accounts = await provisionAccounts(daemon, ['alice', 'bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  cleanupIsolatedDataRoot();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** S5 (#58): the reviewed owner file routes, including the matched regex routes. */
const S5_OWNER_FILE_ROUTES = [
  // S6 (#59): reviewed alias to the owner/session-bound preview capability.
  'owner-scoped-project GET /api/projects/:id/preview-url',
  'owner-scoped-project GET /api/projects/:id/conversations/:cid/messages/:mid/artifacts',
  'owner-scoped-project GET /api/projects/:id/chat-artifact-snapshots/:sid',
  'owner-scoped-project GET /api/projects/:id/chat-artifact-snapshots/:sid/content',
  'owner-scoped-project GET /api/projects/:id/chat-artifact-snapshots/:sid/thumbnail',
  'owner-scoped-project GET /api/projects/:id/workspace-artifacts/:aid',
  'owner-scoped-project DELETE /^\\/api\\/projects\\/([^/]+)\\/raw\\/(.+)$/u',
  'owner-scoped-project DELETE /api/projects/:id/files/:name',
  // #66 deployment-local public links.
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/publish-public$/u',
  'owner-scoped-project POST /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/publish-public$/u',
  'owner-scoped-project DELETE /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/publish-public$/u',
  'owner-scoped-project GET /api/multiuser/projects/:id/public-links',
  'owner-scoped-project GET /api/multiuser/projects/:id/public-links/:path',
  'owner-scoped-project POST /api/multiuser/projects/:id/public-links/:path',
  'owner-scoped-project DELETE /api/multiuser/projects/:id/public-links/:path',
  'preview-capability GET /api/multiuser/public/:slug/*path',
  'owner-scoped-project DELETE /api/projects/:id/folders',
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)$/u',
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/versions$/u',
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/versions\\/([^/]+)$/u',
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/raw\\/(.+)$/u',
  'owner-scoped-project GET /^\\/api\\/projects\\/([^/]+)\\/text-preview\\/(.+)$/u',
  'owner-scoped-project GET /api/projects/:id/folders',
  'owner-scoped-project GET /api/projects/:id/search',
  'owner-scoped-project POST /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/versions$/u',
  'owner-scoped-project POST /^\\/api\\/projects\\/([^/]+)\\/files\\/(.+)\\/versions\\/([^/]+)\\/restore$/u',
  'owner-scoped-project POST /api/projects/:id/files',
  'owner-scoped-project POST /api/projects/:id/files/rename',
  'owner-scoped-project POST /api/projects/:id/folders',
  'owner-scoped-project POST /api/projects/:id/upload',
];

describe('route classification covers the real inventory', () => {
  it('classifies every registered route and has no stale entries', () => {
    const registrations = [...daemon.routeInventory, ...daemon.patternRouteInventory, ...daemon.pathlessRouteInventory];
    expect(daemon.pathlessRouteInventory.length).toBeGreaterThan(0);
    expect(findUnclassifiedRegistrations(registrations)).toEqual([]);
    expect(findStaleClassifications(registrations)).toEqual([]);
  });

  it('allows exactly the reviewed actor-safe set; everything else is blocked or middleware', () => {
    const allowed = MULTIUSER_ROUTE_CLASSIFICATION
      .filter((entry) => entry.routeClass !== 'blocked-in-multiuser' && entry.routeClass !== 'middleware')
      .map((entry) => `${entry.routeClass} ${entry.key}`)
      .sort();
    expect(allowed).toEqual([...S5_OWNER_FILE_ROUTES, ...[
      'actor-scoped GET /api/app-config',
      'actor-scoped GET /api/multiuser/settings/config',
      'actor-scoped PUT /api/app-config',
      'actor-scoped PUT /api/multiuser/settings/config',
      'actor-scoped GET /api/codex-pets',
      'actor-scoped GET /api/multiuser/catalog/codex-pets',
      'actor-scoped GET /api/codex-pets/:id/spritesheet',
      'actor-scoped GET /api/multiuser/catalog/codex-pets/:id/spritesheet',
      'actor-scoped GET /api/memory',
      'actor-scoped GET /api/multiuser/settings/memory',
      'actor-scoped GET /api/memory/tree',
      'actor-scoped GET /api/multiuser/settings/memory/tree',
      'actor-scoped PATCH /api/memory/tree/:id',
      'actor-scoped PATCH /api/multiuser/settings/memory/tree/:id',
      'actor-scoped PUT /api/memory/index',
      'actor-scoped PUT /api/multiuser/settings/memory/index',
      'actor-scoped PATCH /api/memory/config',
      'actor-scoped PATCH /api/multiuser/settings/memory/config',
      'actor-scoped GET /api/memory/events',
      'actor-scoped GET /api/multiuser/settings/memory/events',
      'actor-scoped GET /api/memory/system-prompt',
      'actor-scoped GET /api/multiuser/settings/memory/system-prompt',
      'actor-scoped POST /api/memory',
      'actor-scoped POST /api/multiuser/settings/memory',
      'actor-scoped GET /api/memory/:id',
      'actor-scoped GET /api/multiuser/settings/memory/:id',
      'actor-scoped PUT /api/memory/:id',
      'actor-scoped PUT /api/multiuser/settings/memory/:id',
      'actor-scoped DELETE /api/memory/:id',
      'actor-scoped DELETE /api/multiuser/settings/memory/:id',
      'actor-scoped GET /api/craft',
      'actor-scoped GET /api/multiuser/catalog/craft',
      'actor-scoped GET /api/craft/:id',
      'actor-scoped GET /api/multiuser/catalog/craft/:id',
      'actor-scoped GET /api/design-templates',
      'actor-scoped GET /api/multiuser/catalog/design-templates',
      'actor-scoped GET /api/design-templates/:id',
      'actor-scoped GET /api/multiuser/catalog/design-templates/:id',
      'actor-scoped GET /api/prompt-templates',
      'actor-scoped GET /api/multiuser/catalog/prompt-templates',
      'actor-scoped GET /api/prompt-templates/:surface/:id',
      'actor-scoped GET /api/multiuser/catalog/prompt-templates/:surface/:id',
      'actor-scoped GET /api/design-systems',
      'actor-scoped GET /api/multiuser/catalog/design-systems',
      'actor-scoped POST /api/design-systems',
      'actor-scoped POST /api/multiuser/catalog/design-systems',
      'actor-scoped PATCH /api/design-systems/:id',
      'actor-scoped PATCH /api/multiuser/catalog/design-systems/:id',
      'actor-scoped DELETE /api/design-systems/:id',
      'actor-scoped DELETE /api/multiuser/catalog/design-systems/:id',
      'actor-scoped GET /api/design-systems/:id',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id',
      'actor-scoped GET /api/design-systems/:id/revisions',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id/revisions',
      'actor-scoped GET /api/design-systems/:id/files',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id/files',
      'actor-scoped GET /api/design-systems/:id/file',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id/file',
      'actor-scoped GET /api/design-systems/:id/preview',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id/preview',
      'actor-scoped GET /api/design-systems/:id/showcase',
      'actor-scoped GET /api/multiuser/catalog/design-systems/:id/showcase',
      'actor-scoped GET /api/skills',
      'actor-scoped GET /api/skills/:id',
      'actor-scoped GET /api/skills/:id/files',
      'actor-scoped POST /api/skills/import',
      'actor-scoped PUT /api/skills/:id',
      'actor-scoped DELETE /api/skills/:id',
      'actor-scoped GET /api/multiuser/catalog/skills',
      'actor-scoped GET /api/multiuser/catalog/skills/:id',
      'actor-scoped GET /api/multiuser/catalog/skills/:id/files',
      'actor-scoped POST /api/multiuser/catalog/skills/import',
      'actor-scoped PUT /api/multiuser/catalog/skills/:id',
      'actor-scoped DELETE /api/multiuser/catalog/skills/:id',
      'actor-scoped POST /api/skills/import-files',
      'actor-scoped POST /api/multiuser/catalog/skills/import-files',
      'actor-scoped GET /api/routines',
      'actor-scoped GET /api/multiuser/routines',
      'actor-scoped POST /api/routines',
      'actor-scoped POST /api/multiuser/routines',
      'actor-scoped GET /api/routines/:id',
      'actor-scoped GET /api/multiuser/routines/:id',
      'actor-scoped PATCH /api/routines/:id',
      'actor-scoped PATCH /api/multiuser/routines/:id',
      'actor-scoped DELETE /api/routines/:id',
      'actor-scoped DELETE /api/multiuser/routines/:id',
      'actor-scoped POST /api/routines/:id/run',
      'actor-scoped POST /api/multiuser/routines/:id/run',
      'actor-scoped GET /api/routines/:id/runs',
      'actor-scoped GET /api/multiuser/routines/:id/runs',
      'actor-scoped GET /api/automation-templates',
      'actor-scoped GET /api/multiuser/automation-templates',
      'actor-scoped GET /api/automation-templates/:id',
      'actor-scoped GET /api/multiuser/automation-templates/:id',
      'actor-scoped GET /api/automation-source-packets',
      'actor-scoped GET /api/multiuser/automation-source-packets',
      'actor-scoped GET /api/automation-source-packets/:id',
      'actor-scoped GET /api/multiuser/automation-source-packets/:id',
      'actor-scoped POST /api/automation-ingestions',
      'actor-scoped POST /api/multiuser/automation-ingestions',
      'actor-scoped GET /api/automation-proposals',
      'actor-scoped GET /api/multiuser/automation-proposals',
      'actor-scoped POST /api/automation-proposals',
      'actor-scoped POST /api/multiuser/automation-proposals',
      'actor-scoped GET /api/automation-proposals/:id',
      'actor-scoped GET /api/multiuser/automation-proposals/:id',
      'actor-scoped POST /api/automation-proposals/:id/apply',
      'actor-scoped POST /api/multiuser/automation-proposals/:id/apply',
      'actor-scoped POST /api/automation-proposals/:id/reject',
      'actor-scoped POST /api/multiuser/automation-proposals/:id/reject',
      'actor-scoped POST /api/routines/:id/runs/:runId/crystallize',
      'actor-scoped POST /api/multiuser/routines/:id/runs/:runId/crystallize',
      'actor-scoped GET /api/active',
      'actor-scoped GET /api/agent-accounts',
      'actor-scoped GET /api/multiuser/design-catalog',
      'actor-scoped GET /api/projects',
      'actor-scoped GET /api/runs',
      'actor-scoped POST /api/active',
      'actor-scoped POST /api/agent-accounts/codex/logins',
      'actor-scoped POST /api/projects',
      'actor-scoped POST /api/multiuser/projects',
      'actor-scoped POST /api/import/claude-design',
      'actor-scoped POST /api/multiuser/import/claude-design',
      'actor-scoped POST /api/import/files',
      'actor-scoped GET /api/templates',
      'actor-scoped GET /api/templates/:id',
      'actor-scoped POST /api/templates',
      'actor-scoped DELETE /api/templates/:id',
      'actor-scoped GET /api/multiuser/catalog/templates',
      'actor-scoped GET /api/multiuser/catalog/templates/:id',
      'actor-scoped POST /api/multiuser/catalog/templates',
      'actor-scoped DELETE /api/multiuser/catalog/templates/:id',
      'actor-scoped POST /api/runs',
      'admin-only GET /api/admin/agent-accounts',
      'admin-only GET /api/admin/pool',
      'admin-only GET /api/admin/pool/openai',
      'admin-only PUT /api/admin/pool/openai',
      'admin-only GET /api/admin/users/:id/studio-pilot',
      'admin-only PUT /api/admin/agent-accounts/personal-capacity',
      'admin-only PUT /api/admin/pool/providers/:providerId',
      'admin-only PUT /api/admin/pool/users/:id/quota',
      'admin-only PUT /api/admin/users/:id/studio-pilot',
      'auth GET /api/auth/audit',
      'auth GET /api/auth/me',
      'auth GET /api/auth/users',
      'auth PATCH /api/auth/users/:id',
      'auth POST /api/auth/bootstrap',
      'auth POST /api/auth/login',
      'auth POST /api/auth/logout',
      'auth POST /api/auth/password',
      'auth POST /api/auth/session/rotate',
      'auth POST /api/auth/setup',
      'auth POST /api/auth/users',
      'auth POST /api/auth/users/:id/password',
      'auth POST /api/auth/users/:id/sessions/revoke',
      'owner-scoped-agent-account DELETE /api/agent-accounts/codex/accounts/:accountId',
      'owner-scoped-agent-account GET /api/agent-accounts/codex/logins/:attemptId',
      'owner-scoped-agent-account POST /api/agent-accounts/codex/accounts/:accountId/verify',
      'owner-scoped-agent-account POST /api/agent-accounts/codex/logins/:attemptId/cancel',
      'owner-scoped-project DELETE /api/projects/:id',
      'owner-scoped-project DELETE /api/projects/:id/conversations/:cid',
      'owner-scoped-project GET /api/multiuser/projects/:id/conversations/:cid/design',
      'owner-scoped-project GET /api/multiuser/projects/:id/design-selections',
      'owner-scoped-project GET /api/multiuser/projects/:id/preview-url',
      'owner-scoped-project GET /api/projects/:id',
      'owner-scoped-project GET /api/projects/:id/conversations',
      'owner-scoped-project GET /api/projects/:id/conversations/:cid/messages',
      'owner-scoped-project GET /api/projects/:id/events',
      'owner-scoped-project GET /api/projects/:id/file-content/*path',
      'owner-scoped-project GET /api/projects/:id/files',
      'owner-scoped-project GET /api/projects/:id/tabs',
      'owner-scoped-project PATCH /api/projects/:id',
      'owner-scoped-project PATCH /api/projects/:id/conversations/:cid',
      'owner-scoped-project POST /api/multiuser/projects/:id/conversations',
      'owner-scoped-project POST /api/multiuser/projects/:id/preview/:scope/renew',
      'owner-scoped-project POST /api/projects/:id/conversations',
      'owner-scoped-project GET /api/projects/:id/archive',
      'owner-scoped-project POST /api/projects/:id/archive/batch',
      'owner-scoped-project GET /api/multiuser/projects/:id/archive',
      'owner-scoped-project POST /api/multiuser/projects/:id/archive/batch',
      'owner-scoped-project POST /api/projects/:id/export/html',
      'owner-scoped-project POST /api/multiuser/projects/:id/export/html',
      'owner-scoped-project POST /api/projects/:id/export/pptx',
      'owner-scoped-project POST /api/multiuser/projects/:id/export/pptx',
      'owner-scoped-project POST /api/projects/:id/export/pdf-image',
      'owner-scoped-project POST /api/multiuser/projects/:id/export/pdf-image',
      'owner-scoped-project POST /api/projects/:id/export/image',
      'owner-scoped-project POST /api/multiuser/projects/:id/export/image',
      'owner-scoped-project GET /api/projects/:id/conversations/:cid/comments',
      'owner-scoped-project GET /api/multiuser/projects/:id/conversations/:cid/comments',
      'owner-scoped-project POST /api/projects/:id/conversations/:cid/comments',
      'owner-scoped-project POST /api/multiuser/projects/:id/conversations/:cid/comments',
      'owner-scoped-project PATCH /api/projects/:id/conversations/:cid/comments/:commentId',
      'owner-scoped-project PATCH /api/multiuser/projects/:id/conversations/:cid/comments/:commentId',
      'owner-scoped-project PATCH /api/projects/:id/conversations/:cid/comments/:commentId/anchor',
      'owner-scoped-project PATCH /api/multiuser/projects/:id/conversations/:cid/comments/:commentId/anchor',
      'owner-scoped-project PATCH /api/projects/:id/conversations/:cid/comments/:commentId/reorder',
      'owner-scoped-project PATCH /api/multiuser/projects/:id/conversations/:cid/comments/:commentId/reorder',
      'owner-scoped-project DELETE /api/projects/:id/conversations/:cid/comments/:commentId',
      'owner-scoped-project DELETE /api/multiuser/projects/:id/conversations/:cid/comments/:commentId',
      'actor-scoped POST /api/research/search',
      'actor-scoped POST /api/multiuser/research/search',
      'actor-scoped GET /api/multiuser/settings/provider-keys',
      'actor-scoped PUT /api/multiuser/settings/provider-keys/:provider',
      'owner-scoped-project PUT /api/multiuser/projects/:id/shares',
      'owner-scoped-project DELETE /api/multiuser/projects/:id/shares/:accountId',
      'owner-scoped-project GET /api/multiuser/projects/:id/access',
      'owner-scoped-project DELETE /api/multiuser/projects/:id/access',
      'owner-scoped-project GET /api/projects/:id/presence',
      'owner-scoped-project GET /api/multiuser/projects/:id/presence',
      'owner-scoped-project POST /api/projects/:id/presence/heartbeat',
      'owner-scoped-project POST /api/multiuser/projects/:id/presence/heartbeat',
      'owner-scoped-project POST /api/projects/:id/presence/leave',
      'owner-scoped-project POST /api/multiuser/projects/:id/presence/leave',
      'owner-scoped-project POST /api/projects/:id/duplicate',
      'owner-scoped-project POST /api/multiuser/projects/:id/duplicate',
      'owner-scoped-project PUT /api/projects/:id/conversations/:cid/messages/:mid',
      'owner-scoped-project PUT /api/projects/:id/tabs',
      'owner-scoped-run GET /api/runs/:id',
      'owner-scoped-run GET /api/runs/:id/events',
      'owner-scoped-run POST /api/runs/:id/cancel',
      'owner-scoped-run POST /api/runs/:id/feedback',
      'owner-scoped-run POST /api/runs/:id/steer',
      'preview-capability GET /api/multiuser/projects/:id/preview/:scope/*path',
      'public-probe GET /api/health',
      'public-probe GET /api/ready',
      'public-probe GET /api/version',
      'public-web GET /',
      'public-web GET /_next/static/*asset',
      'public-web GET /account/agents',
      'public-web GET /admin/audit',
      'public-web GET /admin/users',
      'public-web GET /agent-icons/:icon',
      'public-web GET /all-projects',
      'public-web GET /app-icon.png',
      'public-web GET /automations',
      'public-web GET /board',
      'public-web GET /brands',
      'public-web GET /brands/:brandId',
      'public-web GET /collab-demo',
      'public-web GET /collab-demo/:projectId',
      'public-web GET /community',
      'public-web GET /design-systems',
      'public-web GET /design-systems/:designSystemId',
      'public-web GET /design-systems/create',
      'public-web GET /drafts',
      'public-web GET /editor-icons/:icon',
      'public-web GET /fonts/AlbertSans-Italic-VariableFont_wght.ttf',
      'public-web GET /fonts/AlbertSans-VariableFont_wght.ttf',
      'public-web GET /fonts/JiduMonoPro-Regular.otf',
      'public-web GET /integrations',
      'public-web GET /library',
      'public-web GET /login',
      'public-web GET /marketplace',
      'public-web GET /marketplace/:pluginId',
      'public-web GET /members',
      'public-web GET /onboarding',
      'public-web GET /plugins',
      'public-web GET /projects',
      'public-web GET /projects/:projectId',
      'public-web GET /projects/:projectId/conversations/:conversationId',
      'public-web GET /projects/:projectId/conversations/:conversationId/files/*file',
      'public-web GET /projects/:projectId/files/*file',
      'public-web GET /settings',
      'public-web GET /setup',
      'public-web GET /workspace-settings',
    ]].sort());
  });

  it('keeps static mounts, the SPA fallback, global SSE streams and regex preview routes blocked', () => {
    const byKey = new Map(MULTIUSER_ROUTE_CLASSIFICATION.map((entry) => [entry.key, entry]));
    for (const key of [
      'USE /artifacts',
      'USE /frames',
      'USE /api/plugin-previews',
      'GET /*splat',
      'GET /api/library/events',
      'GET /api/workspace/events',
      'GET /api/plugins/events',
    ]) {
      expect(byKey.get(key)?.routeClass, key).toBe('blocked-in-multiuser');
    }
    // Every regex route is blocked unless it is a reviewed owner-scoped entry with its exact pattern.
    for (const pattern of daemon.patternRouteInventory) {
      const entry = byKey.get(routeKey(pattern.method, pattern.path));
      if (entry?.pattern) {
        expect([entry.key, entry.routeClass]).toEqual([entry.key, 'owner-scoped-project']);
        expect(String(entry.pattern)).toBe(pattern.path);
      } else expect(entry?.routeClass, pattern.path).toBe('blocked-in-multiuser');
    }
    for (const blockedPattern of ['GET /^\\/api\\/projects\\/([^/]+)\\/preview\\/([^/]+)\\/(.+)$/u', 'GET /^\\/api\\/projects\\/([^/]+)\\/powered\\/(.+)$/u',
      'OPTIONS /^\\/api\\/projects\\/([^/]+)\\/raw\\/(.+)$/u']) {
      expect(byKey.get(blockedPattern)?.routeClass, blockedPattern).toBe('blocked-in-multiuser');
    }
    expect(daemon.patternRouteInventory.length).toBeGreaterThan(0);
  });

  it('never lets a regex- or array-registered route shadow an allowed route', () => {
    const allowed = MULTIUSER_ROUTE_CLASSIFICATION.filter(
      (entry) => entry.routeClass !== 'blocked-in-multiuser' && entry.routeClass !== 'middleware',
    );
    const samples = allowed.map((entry) => ({ entry, sample: entry.path.replace(/:[A-Za-z_]+/g, 'p1') }));
    for (const pattern of daemon.patternRouteInventory) {
      const applies = (method: string) => pattern.method === method || pattern.method === 'ALL';
      if (pattern.path.startsWith('/^')) {
        const parsed = /^\/(.*)\/([a-z]*)$/su.exec(pattern.path);
        expect(parsed, pattern.path).not.toBeNull();
        const re = new RegExp(parsed![1]!, parsed![2]);
        for (const { entry, sample } of samples) {
          if (applies(entry.method)) expect(re.test(sample), `${pattern.path} vs ${entry.key}`).toBe(false);
        }
      } else {
        // Path arrays: compare each member's static prefix.
        for (const member of pattern.path.split(',')) {
          const prefix = member.split(/[:*]/u, 1)[0]!.replace(/\/$/u, '');
          for (const { entry, sample } of samples) {
            if (applies(entry.method)) expect(sample.startsWith(prefix), `${member} vs ${entry.key}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('static files cannot shadow project authorization', () => {
  it('serves actor-filtered JSON and gate denials over planted API files', async () => {
    const created = await daemon.request({
      method: 'POST', path: '/api/projects', cookie: alice.cookie,
      body: { id: plantedProjectId, name: 'owner project' },
    });
    expect(created.status, created.text).toBe(200);

    const ownList = await daemon.request({ path: '/api/projects', cookie: alice.cookie });
    expect(ownList.status).toBe(200);
    expect(ownList.json.projects.map((project: { id: string }) => project.id)).toContain(plantedProjectId);
    expect(ownList.text).not.toContain(plantedFile);

    const otherList = await daemon.request({ path: '/api/projects', cookie: bob.cookie });
    expect(otherList.status).toBe(200);
    expect(otherList.json.projects.map((project: { id: string }) => project.id)).not.toContain(plantedProjectId);
    expect(otherList.text).not.toContain(plantedFile);

    const ownDetail = await daemon.request({ path: `/api/projects/${plantedProjectId}`, cookie: alice.cookie });
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.text).not.toContain(plantedFile);
    const otherDetail = await daemon.request({ path: `/api/projects/${plantedProjectId}`, cookie: bob.cookie });
    expect(otherDetail.status).toBe(404);
    expect(otherDetail.json.error.code).toBe('PROJECT_NOT_FOUND');
    expect((await daemon.request({ path: '/api/projects' })).status).toBe(401);

    // The filesystem cannot hold a file and a directory at the same path.
    // Replace the nested fixture with a literal api/projects file as well.
    rmSync(path.join(staticDir, 'api', 'projects'), { recursive: true });
    writeFileSync(path.join(staticDir, 'api', 'projects'), plantedFile);
    const flatList = await daemon.request({ path: '/api/projects', cookie: alice.cookie });
    expect(flatList.status).toBe(200);
    expect(flatList.json.projects.map((project: { id: string }) => project.id)).toContain(plantedProjectId);
    expect(flatList.text).not.toContain(plantedFile);
  });
});

describe('authentication is required (loopback is not a bypass)', () => {
  it('keeps health/version probes public', async () => {
    expect((await daemon.request({ path: '/api/health' })).status).toBe(200);
    expect((await daemon.request({ path: '/api/version' })).status).toBe(200);
  });

  it('answers 401 on allowed, blocked and unclassified routes without a session', async () => {
    const project = await createProject(alice, 'alice-anon-probe');
    const probes: Array<[string, string]> = [
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', `/api/projects/${project.id}`],
      ['DELETE', `/api/projects/${project.id}`],
      ['GET', `/api/projects/${project.id}/conversations`],
      ['GET', '/api/app-config'],
      ['POST', '/api/runs'],
      ['GET', '/api/mcp/servers'],
      ['GET', '/artifacts/anything.html'],
      ['GET', '/api/definitely-not-a-route'],
    ];
    for (const [method, probePath] of probes) {
      const res = await daemon.request({
        method,
        path: probePath,
        ...(method === 'POST' ? { body: { id: randomUUID(), name: 'x' } } : {}),
      });
      expect(res.status, `${method} ${probePath}`).toBe(401);
    }
    // An explicit public shell route with no emitted index is a 404, not API auth.
    expect((await daemon.request({ path: '/' })).status).toBe(404);
    // Still there: the anonymous DELETE never reached the handler.
    expect(await listProjectIds(alice)).toContain(project.id);
  });

  it('does not accept forged identity headers or bearer tokens in place of a session', async () => {
    const res = await daemon.request({
      path: '/api/projects',
      headers: {
        authorization: 'Bearer not-a-session',
        'x-od-app-user-id': alice.id,
        'x-od-workspace-id': 'ws-1',
        'x-od-workspace-member-id': alice.id,
        'x-od-workspace-role': 'owner',
      },
    });
    expect(res.status).toBe(401);
  });
});

describe('project ownership (#3)', () => {
  it('lists only the actor\'s own projects; the admin sees none of them', async () => {
    const a = await createProject(alice, 'alice-list');
    const b = await createProject(bob, 'bob-list');
    const aliceIds = await listProjectIds(alice);
    const bobIds = await listProjectIds(bob);
    const adminIds = await listProjectIds(admin);
    expect(aliceIds).toContain(a.id);
    expect(aliceIds).not.toContain(b.id);
    expect(bobIds).toContain(b.id);
    expect(bobIds).not.toContain(a.id);
    expect(adminIds).not.toContain(a.id);
    expect(adminIds).not.toContain(b.id);
  });

  it('answers another user\'s project exactly like a nonexistent one (404, non-enumerating)', async () => {
    const b = await createProject(bob, 'bob-private');
    const missing = randomUUID();
    const attempts = (projectId: string, conversationId: string) => [
      { method: 'GET', path: `/api/projects/${projectId}` },
      { method: 'PATCH', path: `/api/projects/${projectId}`, body: { name: 'pwned' } },
      { method: 'DELETE', path: `/api/projects/${projectId}` },
      { method: 'GET', path: `/api/projects/${projectId}/conversations` },
      { method: 'POST', path: `/api/projects/${projectId}/conversations`, body: { title: 'x' } },
      { method: 'GET', path: `/api/projects/${projectId}/conversations/${conversationId}/messages` },
    ];
    const foreign = attempts(b.id, b.conversationId);
    const absent = attempts(missing, b.conversationId);
    for (let i = 0; i < foreign.length; i++) {
      const got = await daemon.request({ ...foreign[i]!, cookie: alice.cookie });
      const none = await daemon.request({ ...absent[i]!, cookie: alice.cookie });
      expect(got.status, `${foreign[i]!.method} ${foreign[i]!.path}`).toBe(404);
      expect(got.text).toBe(none.text.replaceAll(missing, b.id));
      expect(got.text).not.toContain('bob-private');
    }
    // Bob's project is untouched.
    const own = await daemon.request({ path: `/api/projects/${b.id}`, cookie: bob.cookie });
    expect(own.status).toBe(200);
    expect(own.json.project.name).toBe('bob-private');
    const convs = await daemon.request({ path: `/api/projects/${b.id}/conversations`, cookie: bob.cookie });
    expect(convs.json.conversations).toHaveLength(1);
  });

  it('does not grant the admin role access to user project content', async () => {
    const a = await createProject(alice, 'alice-secret');
    for (const probe of [
      { method: 'GET', path: `/api/projects/${a.id}` },
      { method: 'GET', path: `/api/projects/${a.id}/conversations` },
      { method: 'GET', path: `/api/projects/${a.id}/conversations/${a.conversationId}/messages` },
      { method: 'PATCH', path: `/api/projects/${a.id}`, body: { name: 'admin-rename' } },
      { method: 'DELETE', path: `/api/projects/${a.id}` },
    ]) {
      const res = await daemon.request({ ...probe, cookie: admin.cookie });
      expect(res.status, `${probe.method} ${probe.path}`).toBe(404);
    }
    const still = await daemon.request({ path: `/api/projects/${a.id}`, cookie: alice.cookie });
    expect(still.status).toBe(200);
    expect(still.json.project.name).toBe('alice-secret');
  });

  it('lets the owner use the minimum allowed project/conversation surface', async () => {
    const a = await createProject(alice, 'alice-crud');
    const get = await daemon.request({ path: `/api/projects/${a.id}`, cookie: alice.cookie });
    expect(get.status).toBe(200);
    const patch = await daemon.request({
      method: 'PATCH',
      path: `/api/projects/${a.id}`,
      cookie: alice.cookie,
      body: { name: 'alice-crud-renamed' },
    });
    expect(patch.status, patch.text).toBe(200);
    expect(patch.json.project.name).toBe('alice-crud-renamed');
    const conv = await daemon.request({
      method: 'POST',
      path: `/api/projects/${a.id}/conversations`,
      cookie: alice.cookie,
      body: { title: 'second' },
    });
    expect(conv.status, conv.text).toBe(200);
    const list = await daemon.request({ path: `/api/projects/${a.id}/conversations`, cookie: alice.cookie });
    expect(list.status).toBe(200);
    expect(list.json.conversations.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([a.conversationId, conv.json.conversation.id]),
    );
    const messages = await daemon.request({
      path: `/api/projects/${a.id}/conversations/${a.conversationId}/messages`,
      cookie: alice.cookie,
    });
    expect(messages.status, messages.text).toBe(200);
    expect(Array.isArray(messages.json.messages)).toBe(true);
    const del = await daemon.request({ method: 'DELETE', path: `/api/projects/${a.id}`, cookie: alice.cookie });
    expect(del.status, del.text).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${a.id}`, cookie: alice.cookie })).status).toBe(404);
    expect(await listProjectIds(alice)).not.toContain(a.id);
    // The owner binding went with the row: nobody can resurrect access to it.
    const db = new Database(path.join(dataRoot, 'app.sqlite'), { readonly: true });
    try {
      const row = db.prepare('SELECT 1 FROM multiuser_project_owners WHERE project_id = ?').get(a.id);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('keeps unbound (legacy) project rows invisible and never auto-claims them', async () => {
    const legacyId = randomUUID();
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try {
      db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(legacyId, 'legacy-unbound', Date.now(), Date.now());
    } finally {
      db.close();
    }
    for (const user of [alice, bob, admin]) {
      expect(await listProjectIds(user)).not.toContain(legacyId);
      expect((await daemon.request({ path: `/api/projects/${legacyId}`, cookie: user.cookie })).status).toBe(404);
    }
    // Re-creating the same id does not claim the existing row.
    const claim = await daemon.request({
      method: 'POST',
      path: '/api/projects',
      cookie: alice.cookie,
      body: { id: legacyId, name: 'claim-attempt' },
    });
    expect(claim.status).not.toBe(200);
    expect(await listProjectIds(alice)).not.toContain(legacyId);
    expect((await daemon.request({ path: `/api/projects/${legacyId}`, cookie: alice.cookie })).status).toBe(404);
  });
});

describe('client-supplied identity is never authority', () => {
  it('ignores spoofed workspace/member/user headers on reads and creates', async () => {
    const b = await createProject(bob, 'bob-spoof-target');
    const spoof = {
      authorization: `Bearer ${randomUUID()}`,
      'x-od-app-user-id': bob.id,
      'x-od-workspace-id': 'spoofed-workspace',
      'x-od-workspace-member-id': bob.id,
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
      'x-od-workspace-member-status': 'active',
    };
    const list = await daemon.request({ path: '/api/projects', cookie: alice.cookie, headers: spoof });
    expect(list.status).toBe(200);
    expect(list.json.projects.map((p: { id: string }) => p.id)).not.toContain(b.id);
    const direct = await daemon.request({ path: `/api/projects/${b.id}`, cookie: alice.cookie, headers: spoof });
    expect(direct.status).toBe(404);

    const id = randomUUID();
    const created = await daemon.request({
      method: 'POST',
      path: '/api/projects',
      cookie: alice.cookie,
      headers: spoof,
      body: { id, name: 'alice-with-spoofed-headers' },
    });
    expect(created.status, created.text).toBe(200);
    expect(created.json.project.workspaceId ?? null).toBeNull();
    expect(await listProjectIds(alice)).toContain(id);
    expect(await listProjectIds(bob)).not.toContain(id);
    const detail = await daemon.request({ path: `/api/projects/${id}`, cookie: alice.cookie });
    expect(detail.json.project.workspaceId).toBeNull();
  });

  it('refuses state-changing requests from a foreign browser origin', async () => {
    const byOrigin = await daemon.request({
      method: 'POST',
      path: '/api/projects',
      cookie: alice.cookie,
      headers: { origin: 'https://evil.example' },
      body: { id: randomUUID(), name: 'csrf' },
    });
    expect(byOrigin.status).toBe(403);
    const byFetchSite = await daemon.request({
      method: 'POST',
      path: '/api/projects',
      cookie: alice.cookie,
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { id: randomUUID(), name: 'csrf' },
    });
    expect(byFetchSite.status).toBe(403);
  });
});

describe('fail-closed classification', () => {
  it('answers 404 for unclassified routes even for a signed-in owner', async () => {
    const a = await createProject(alice, 'alice-unclassified');
    for (const probe of [
      { method: 'GET', path: `/api/projects/${a.id}/raw/index.html` },
      { method: 'GET', path: `/api/projects/${a.id}/preview/scope/index.html` },
      { method: 'GET', path: '/api/definitely-not-a-route' },
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/assets/app.js' },
      { method: 'OPTIONS', path: '/api/projects' },
    ]) {
      const res = await daemon.request({ ...probe, cookie: alice.cookie });
      expect(res.status, `${probe.method} ${probe.path}`).toBe(404);
    }
  });

  it('denies blocked-in-multiuser families to signed-in users and admins alike', async () => {
    const a = await createProject(alice, 'alice-blocked');
    const blocked: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/strategies/od-next/rollout' },
      { method: 'POST', path: '/api/memory/extract', body: {} },
      { method: 'POST', path: '/api/import/folder', body: { baseDir: '/' } },
      { method: 'POST', path: '/api/dialog/open-folder', body: {} },
      { method: 'GET', path: '/api/mcp/servers' },
      { method: 'GET', path: '/api/connectors' },
      { method: 'POST', path: '/api/plugins/install', body: {} },
      { method: 'POST', path: '/api/chat', body: {} },
      { method: 'GET', path: '/api/daemon/status' },
      { method: 'GET', path: '/api/daemon/db' },
      { method: 'GET', path: `/api/projects/${a.id}/workspace-scope` },
      { method: 'POST', path: `/api/projects/${a.id}/terminals`, body: {} },
      { method: 'GET', path: '/api/workspaces/w/projects' },
      { method: 'GET', path: '/artifacts/anything.html' },
      { method: 'GET', path: '/frames/anything.html' },
      { method: 'GET', path: '/api/plugin-previews/x.png' },
    ];
    for (const user of [alice, admin]) {
      for (const probe of blocked) {
        const res = await daemon.request({ ...probe, cookie: user.cookie });
        expect(res.status, `${user.username} ${probe.method} ${probe.path}`).toBe(403);
      }
    }
  });

  it('refuses host-level or cross-account fields on project create and patch', async () => {
    const before = await listProjectIds(alice);
    for (const body of [
      { metadata: { kind: 'prototype', linkedDirs: ['/etc'] } },
      { projectLocationId: 'some-location' },
      { metadata: { kind: 'template', templateId: 'tpl' } },
      { pluginId: 'some-plugin' },
    ]) {
      const res = await daemon.request({
        method: 'POST',
        path: '/api/projects',
        cookie: alice.cookie,
        body: { id: randomUUID(), name: 'refused', ...body },
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ skillId: 'some-skill' }, { designSystemId: 'some-design-system' }]) {
      const result = await daemon.request({ method: 'POST', path: '/api/projects', cookie: alice.cookie,
        body: { id: randomUUID(), name: 'unavailable resource', ...body } });
      expect(result.status, JSON.stringify(body)).toBe(404);
    }
    expect(await listProjectIds(alice)).toEqual(before);

    const a = await createProject(alice, 'alice-patch-policy');
    for (const body of [
      { metadata: { kind: 'prototype', linkedDirs: ['/etc'] } },
      { skillId: 'x' },
    ]) {
      const res = await daemon.request({
        method: 'PATCH',
        path: `/api/projects/${a.id}`,
        cookie: alice.cookie,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('session lifecycle takes effect immediately', () => {
  it('revocation, deactivation and logout cut access on the very next request', async () => {
    const created = await daemon.request({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin.cookie,
      body: { username: 'carol', password: 'carol-password-battery-staple', role: 'user' },
    });
    expect(created.status).toBe(201);
    const carolId = created.json.account.id as string;
    let carol = await login(daemon, 'carol', 'carol-password-battery-staple');
    expect((await daemon.request({ path: '/api/projects', cookie: carol })).status).toBe(200);

    const revoke = await daemon.request({
      method: 'POST',
      path: `/api/auth/users/${carolId}/sessions/revoke`,
      cookie: admin.cookie,
      body: {},
    });
    expect(revoke.status).toBe(200);
    expect((await daemon.request({ path: '/api/projects', cookie: carol })).status).toBe(401);

    carol = await login(daemon, 'carol', 'carol-password-battery-staple');
    expect((await daemon.request({ path: '/api/projects', cookie: carol })).status).toBe(200);
    const disable = await daemon.request({
      method: 'PATCH',
      path: `/api/auth/users/${carolId}`,
      cookie: admin.cookie,
      body: { active: false },
    });
    expect(disable.status).toBe(200);
    expect((await daemon.request({ path: '/api/projects', cookie: carol })).status).toBe(401);

    const dave = await daemon.request({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin.cookie,
      body: { username: 'dave', password: 'dave-password-battery-staple', role: 'user' },
    });
    expect(dave.status).toBe(201);
    const daveCookie = await login(daemon, 'dave', 'dave-password-battery-staple');
    expect((await daemon.request({ path: '/api/projects', cookie: daveCookie })).status).toBe(200);
    const logout = await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: daveCookie, body: {} });
    expect(logout.status).toBe(204);
    expect((await daemon.request({ path: '/api/projects', cookie: daveCookie })).status).toBe(401);
  });
});
