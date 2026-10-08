import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { MULTIUSER_ROUTE_CLASSIFICATION, matchMultiUserRoute } from '../../apps/daemon/src/http/multiuser-route-classes.js';
const runtime = fileURLToPath(new URL('../../apps/web/src/runtime/studio-transport.ts', import.meta.url));
const { studioRequestAvailable } = await import(runtime) as {
  studioRequestAvailable(method: string, path: string, usable?: (lane: string) => boolean, renderedExports?: boolean): boolean;
};

it('classifies every observed request from the real App and cookie entry lifecycle', () => {
  // Component execution stays in web; only this cross-runtime oracle imports
  // daemon authority. Threads keep the bounded child free of worker processes.
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run', '-c', 'vitest.config.ts', 'tests/multiuser/studio-app-boot.test.tsx', '--pool=threads', '--maxWorkers=1',
  ], { cwd: fileURLToPath(new URL('../../apps/web', import.meta.url)), encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const match = /STUDIO_BOOT_REQUESTS=(\[[^\n]+\])/.exec(child.stdout);
  expect(match, 'real UI scenario must finish and publish its observations').not.toBeNull();
  const requests = JSON.parse(match![1]!) as Array<{ source: string; method: string; path: string }>;
  expect(new Set(requests.map(({ source }) => source))).toEqual(new Set(['fetch', 'CookieSession', 'EventSource', 'StudioAttempt']));
  expect(requests.length).toBeGreaterThan(10);
  for (const { source, method, path } of requests) {
    const matches = matchMultiUserRoute(method, path);
    expect(matches.length, `${source}: ${method} ${path} unclassified`).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass !== 'blocked-in-multiuser'), `${source}: ${method} ${path} blocked`).toBe(true);
  }
}, 100_000);

it('keeps the pilot transport within the real daemon route classifications', () => {
  let checked = 0;
  for (const entry of MULTIUSER_ROUTE_CLASSIFICATION) {
    if (!entry.path.startsWith('/api/') || entry.method === 'USE') continue;
    const path = entry.path.replace(/:[\w]+/g, 'test-id').replace(/\*[\w]+/g, 'nested/test');
    if (entry.routeClass === 'blocked-in-multiuser') {
      expect(studioRequestAvailable(entry.method, path), entry.key).toBe(false);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(100);
  for (const [method, path] of [['GET', '/api/projects'], ['POST', '/api/projects'],
    ['GET', '/api/projects/p'], ['PATCH', '/api/projects/p'], ['DELETE', '/api/projects/p'],
    ['GET', '/api/projects/p/conversations'], ['POST', '/api/projects/p/conversations'],
    ['PATCH', '/api/projects/p/conversations/c'], ['DELETE', '/api/projects/p/conversations/c'],
    ['GET', '/api/projects/p/conversations/c/messages'], ['GET', '/api/projects/p/tabs'],
    ['PUT', '/api/projects/p/tabs'], ['GET', '/api/projects/p/events'], ['POST', '/api/active']]) {
    expect(studioRequestAvailable(method!, path!)).toBe(true);
    const matches = matchMultiUserRoute(method!, path!);
    expect(matches.length, `${method} ${path}`).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass !== 'blocked-in-multiuser')).toBe(true);
  }
  expect(studioRequestAvailable('POST', '/api/unknown')).toBe(false);
});

it('opens run endpoints only with a usable execution lane, and only where the daemon classifies them', () => {
  const runs = [['POST', '/api/runs'], ['GET', '/api/runs'], ['GET', '/api/runs/r'], ['GET', '/api/runs/r/events'],
    ['POST', '/api/runs/r/cancel'], ['POST', '/api/runs/r/steer'], ['POST', '/api/runs/r/feedback'],
    ['PUT', '/api/projects/p/conversations/c/messages/m']] as const;
  for (const [method, path] of runs) {
    expect(studioRequestAvailable(method, path, (lane) => lane === 'execution'), `${method} ${path}`).toBe(true);
    const matches = matchMultiUserRoute(method, path);
    expect(matches.length, `${method} ${path}`).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass !== 'blocked-in-multiuser'), `${method} ${path}`).toBe(true);
    if (path.startsWith('/api/runs')) expect(studioRequestAvailable(method, path, () => false), `${method} ${path} without execution`).toBe(false);
  }
  // Every blocked route stays closed even when every lane is usable: lanes never open daemon-blocked domains.
  for (const entry of MULTIUSER_ROUTE_CLASSIFICATION) {
    if (entry.routeClass !== 'blocked-in-multiuser' || !entry.path.startsWith('/api/') || entry.method === 'USE') continue;
    const path = entry.path.replace(/:[\w]+/g, 'test-id').replace(/\*[\w]+/g, 'nested/test');
    expect(studioRequestAvailable(entry.method, path, () => true), entry.key).toBe(false);
  }
  for (const [method, path] of [['DELETE', '/api/runs/r'], ['GET', '/api/runs/r/cancel'], ['POST', '/api/runs/r/replay'], ['GET', '/api/runs/r/agui']]) {
    expect(studioRequestAvailable(method!, path!, () => true), `${method} ${path}`).toBe(false);
  }
});

it('opens owner file endpoints only with a usable files lane, and only where the daemon classifies them', () => {
  const files = [['GET', '/api/projects/p/files'], ['POST', '/api/projects/p/files'], ['POST', '/api/projects/p/files/rename'],
    ['DELETE', '/api/projects/p/files/a.txt'], ['GET', '/api/projects/p/files/dir/a.txt'], ['GET', '/api/projects/p/files/a.html/versions'],
    ['POST', '/api/projects/p/files/a.html/versions'], ['GET', '/api/projects/p/files/a.html/versions/v1'],
    ['POST', '/api/projects/p/files/a.html/versions/v1/restore'], ['GET', '/api/projects/p/folders'], ['POST', '/api/projects/p/folders'],
    ['DELETE', '/api/projects/p/folders'], ['GET', '/api/projects/p/search'], ['POST', '/api/projects/p/upload'],
    ['GET', '/api/projects/p/raw/a/b.png'], ['DELETE', '/api/projects/p/raw/a.txt'], ['GET', '/api/projects/p/text-preview/a.md'],
    ['GET', '/api/projects/p/file-content/a.md']] as const;
  for (const [method, path] of files) {
    expect(studioRequestAvailable(method, path, (lane) => lane === 'files'), `${method} ${path}`).toBe(true);
    expect(studioRequestAvailable(method, path, () => false), `${method} ${path} without files`).toBe(false);
    const matches = matchMultiUserRoute(method, path);
    expect(matches.length, `${method} ${path}`).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass === 'owner-scoped-project'), `${method} ${path}`).toBe(true);
  }
  for (const [method, path] of [['POST', '/api/projects/p/files/a.html/publish-public'],
    ['OPTIONS', '/api/projects/p/raw/a.txt'], ['GET', '/api/projects/p/powered/a.js'], ['PUT', '/api/projects/p/files']]) {
    expect(studioRequestAvailable(method!, path!, () => true), `${method} ${path}`).toBe(false);
  }
});

it('opens only reviewed owner artifact reads with a usable preview lane', () => {
  for (const path of ['/api/projects/p/chat-artifact-snapshots/s', '/api/projects/p/chat-artifact-snapshots/s/content',
    '/api/projects/p/chat-artifact-snapshots/s/thumbnail', '/api/projects/p/workspace-artifacts/a',
    '/api/projects/p/conversations/c/messages/m/artifacts']) {
    expect(studioRequestAvailable('GET', path, (lane) => lane === 'preview'), path).toBe(true);
    expect(studioRequestAvailable('GET', path, () => false), path).toBe(false);
    expect(studioRequestAvailable('POST', path, () => true), path).toBe(false);
    const matches = matchMultiUserRoute('GET', path);
    expect(matches.length, path).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass === 'owner-scoped-project'), path).toBe(true);
  }
});

it('opens only reviewed text skill operations with a usable catalog lane', () => {
  for (const prefix of ['/api/skills', '/api/multiuser/catalog/skills']) {
    for (const [method, suffix] of [['GET', ''], ['GET', '/s'], ['GET', '/s/files'],
      ['POST', '/import'], ['PUT', '/s'], ['DELETE', '/s']] as const) {
      const path = prefix + suffix;
      expect(studioRequestAvailable(method, path, (lane) => lane === 'catalogs'), path).toBe(true);
      expect(studioRequestAvailable(method, path, () => false), path).toBe(false);
      const matches = matchMultiUserRoute(method, path);
      expect(matches.length, path).toBeGreaterThan(0);
      expect(matches.every(({ entry }) => entry.routeClass === 'actor-scoped'), path).toBe(true);
    }
  }
  for (const [method, path] of [['POST', '/api/skills/install'], ['GET', '/api/skills/s/assets/file'],
    ['POST', '/api/skills/s/examples'], ['GET', '/api/plugins'], ['POST', '/api/design-systems/install']]) {
    expect(studioRequestAvailable(method!, path!, () => true), path).toBe(false);
  }
});

it('opens only actor instructions and manual memory when settings is usable', () => {
  const endpoints = [['GET', '/api/app-config'], ['PUT', '/api/app-config'], ['GET', '/api/memory'],
    ['POST', '/api/memory'], ['GET', '/api/memory/tree'], ['PATCH', '/api/memory/tree/user_fact'],
    ['GET', '/api/memory/user_fact'], ['PUT', '/api/memory/user_fact'], ['DELETE', '/api/memory/user_fact'],
    ['GET', '/api/memory/events'], ['GET', '/api/memory/system-prompt'], ['PUT', '/api/memory/index'],
    ['PATCH', '/api/memory/config']] as const;
  for (const [method, standard] of endpoints) {
    const alias = standard.replace('/api/app-config', '/api/multiuser/settings/config').replace('/api/memory', '/api/multiuser/settings/memory');
    for (const path of [standard, alias]) {
      expect(studioRequestAvailable(method, path, (lane) => lane === 'settings'), path).toBe(true);
      expect(studioRequestAvailable(method, path, () => false), path).toBe(false);
      const matches = matchMultiUserRoute(method, path);
      expect(matches.length, path).toBeGreaterThan(0);
      expect(matches.every(({ entry }) => entry.routeClass === 'actor-scoped'), path).toBe(true);
    }
  }
  for (const path of ['/api/memory/extractions', '/api/memory/verifications', '/api/mcp/config', '/api/connectors/discovery', '/api/library/assets', '/api/agents']) {
    expect(studioRequestAvailable('GET', path, () => true), path).toBe(false);
  }
});


it('opens only reviewed document and bundled catalog operations', () => {
  const keys = ['GET /api/design-systems', 'POST /api/design-systems', 'GET /api/design-systems/user:studio_x',
    'PATCH /api/design-systems/user:studio_x', 'DELETE /api/design-systems/user:studio_x',
    ...['revisions', 'files', 'file', 'preview', 'showcase'].map((resource) => `GET /api/design-systems/user:studio_x/${resource}`),
    'GET /api/design-templates', 'GET /api/design-templates/web', 'GET /api/prompt-templates',
    'GET /api/prompt-templates/image/editorial', 'GET /api/craft', 'GET /api/craft/web'];
  for (const key of keys) {
    const [method, standard] = key.split(' ') as [string, string];
    for (const path of [standard, standard.replace('/api/', '/api/multiuser/catalog/')]) {
      expect(studioRequestAvailable(method, path, (lane) => lane === 'catalogs'), key).toBe(true);
      expect(studioRequestAvailable(method, path, () => false), key).toBe(false);
      expect(matchMultiUserRoute(method, path).every(({ entry }) => entry.routeClass === 'actor-scoped'), key).toBe(true);
    }
  }
});

it('opens reviewed creation/import and private template operations without exposing host imports', () => {
  const endpoints = [
    ['home', 'POST', '/api/projects/p/duplicate', 'owner-scoped-project'],
    ['home', 'POST', '/api/multiuser/projects/p/duplicate', 'owner-scoped-project'],
    ['home', 'POST', '/api/import/files', 'actor-scoped'],
    ['home', 'POST', '/api/import/claude-design', 'actor-scoped'],
    ['home', 'POST', '/api/multiuser/import/claude-design', 'actor-scoped'],
    ...['/api/templates', '/api/multiuser/catalog/templates'].flatMap((prefix) => [
      ['catalogs', 'GET', prefix, 'actor-scoped'], ['catalogs', 'POST', prefix, 'actor-scoped'],
      ['catalogs', 'GET', `${prefix}/snapshot`, 'actor-scoped'], ['catalogs', 'DELETE', `${prefix}/snapshot`, 'actor-scoped'],
    ]),
  ];
  for (const [lane, method, path, routeClass] of endpoints) {
    expect(studioRequestAvailable(method!, path!, (allowed) => allowed === lane), path).toBe(true);
    expect(studioRequestAvailable(method!, path!, () => false), path).toBe(false);
    const matches = matchMultiUserRoute(method!, path!);
    expect(matches.length, path).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass === routeClass), path).toBe(true);
  }
  for (const [method, path] of [['POST', '/api/import/folder'], ['POST', '/api/dialog/open-folder'],
    ['PUT', '/api/templates/snapshot'], ['POST', '/api/templates/snapshot'], ['GET', '/api/import/files']]) {
    expect(studioRequestAvailable(method!, path!, () => true), path).toBe(false);
  }
});


it('opens only captured owner ZIP downloads in the partial delivery lane', () => {
  for (const prefix of ['/api/projects/p', '/api/multiuser/projects/p']) {
    for (const [method, suffix] of [['GET', '/archive'], ['POST', '/archive/batch'], ['POST', '/export/html']]) {
      const path = prefix + suffix;
      expect(studioRequestAvailable(method!, path, (lane) => lane === 'delivery'), path).toBe(true);
      expect(studioRequestAvailable(method!, path, () => false), path).toBe(false);
      expect(matchMultiUserRoute(method!, path).every(({ entry }) => entry.routeClass === 'owner-scoped-project'), path).toBe(true);
    }
  }
  for (const [method, path] of [['GET', '/api/projects/p/export/html'], ['POST', '/api/projects/p/export/pdf'], ['POST', '/api/projects/p/archive'], ['GET', '/api/projects/p/archive/batch']])
    expect(studioRequestAvailable(method!, path!, () => true), path).toBe(false);
});

it('opens preview comments only with a usable preview lane, and only where the daemon classifies them', () => {
  for (const prefix of ['/api/projects/p', '/api/multiuser/projects/p']) {
    const base = `${prefix}/conversations/c/comments`;
    for (const [method, path] of [['GET', base], ['POST', base], ['PATCH', `${base}/k`], ['DELETE', `${base}/k`],
      ['PATCH', `${base}/k/anchor`], ['PATCH', `${base}/k/reorder`]] as const) {
      expect(studioRequestAvailable(method, path, (lane) => lane === 'preview'), `${method} ${path}`).toBe(true);
      expect(studioRequestAvailable(method, path, (lane) => lane !== 'preview'), `${method} ${path}`).toBe(false);
      const matches = matchMultiUserRoute(method, path);
      expect(matches.length, path).toBeGreaterThan(0);
      expect(matches.every(({ entry }) => entry.routeClass === 'owner-scoped-project'), path).toBe(true);
    }
    for (const [method, path] of [['DELETE', base], ['GET', `${base}/k`], ['DELETE', `${base}/k/anchor`], ['POST', `${base}/k/reorder`]] as const)
      expect(studioRequestAvailable(method, path, () => true), `${method} ${path}`).toBe(false);
  }
});

it('opens project sharing and presence only with a usable collaboration lane, never Vela collab sync', () => {
  const open = [['GET', '/api/multiuser/projects/p/access'], ['DELETE', '/api/multiuser/projects/p/access'],
    ['PUT', '/api/multiuser/projects/p/shares'], ['DELETE', '/api/multiuser/projects/p/shares/a'],
    ['GET', '/api/projects/p/presence'], ['POST', '/api/projects/p/presence/heartbeat'], ['POST', '/api/projects/p/presence/leave']] as const;
  for (const [method, path] of open) {
    expect(studioRequestAvailable(method, path, (lane) => lane === 'collaboration'), `${method} ${path}`).toBe(true);
    expect(studioRequestAvailable(method, path, (lane) => lane !== 'collaboration'), `${method} ${path}`).toBe(false);
    const matches = matchMultiUserRoute(method, path);
    expect(matches.length, path).toBeGreaterThan(0);
    expect(matches.every(({ entry }) => entry.routeClass === 'owner-scoped-project'), path).toBe(true);
  }
  for (const [method, path] of [['GET', '/api/multiuser/projects/p/shares'], ['POST', '/api/projects/p/collab/publish'], ['GET', '/api/projects/p/collab/status'],
    ['GET', '/api/workspace/members'], ['POST', '/api/projects/p/presence'], ['GET', '/api/projects/p/workspace-scope']] as const) {
    expect(studioRequestAvailable(method, path, () => true), `${method} ${path}`).toBe(false);
  }
});

it('opens only the bundled pet catalog with a usable settings lane; community sync stays closed', () => {
  for (const path of ['/api/codex-pets', '/api/codex-pets/tux/spritesheet', '/api/multiuser/catalog/codex-pets', '/api/multiuser/catalog/codex-pets/tux/spritesheet']) {
    expect(studioRequestAvailable('GET', path, (lane) => lane === 'settings'), path).toBe(true);
    expect(studioRequestAvailable('GET', path, (lane) => lane !== 'settings'), path).toBe(false);
    expect(matchMultiUserRoute('GET', path).every(({ entry }) => entry.routeClass === 'actor-scoped'), path).toBe(true);
  }
  expect(studioRequestAvailable('POST', '/api/codex-pets/sync', () => true)).toBe(false);
  expect(matchMultiUserRoute('POST', '/api/codex-pets/sync').every(({ entry }) => entry.routeClass === 'blocked-in-multiuser')).toBe(true);
});

it('opens server-rendered exports only when delivery is usable and the deployment advertises a renderer', () => {
  for (const prefix of ['/api/projects/p', '/api/multiuser/projects/p']) for (const format of ['pptx', 'pdf-image', 'image']) {
    const path = `${prefix}/export/${format}`;
    expect(studioRequestAvailable('POST', path, (lane) => lane === 'delivery', true), path).toBe(true);
    expect(studioRequestAvailable('POST', path, (lane) => lane === 'delivery', false), path).toBe(false);
    expect(studioRequestAvailable('POST', path, () => false, true), path).toBe(false);
    expect(studioRequestAvailable('GET', path, () => true, true), path).toBe(false);
    expect(matchMultiUserRoute('POST', path).every(({ entry }) => entry.routeClass === 'owner-scoped-project'), path).toBe(true);
  }
  expect(studioRequestAvailable('POST', '/api/projects/p/export/pdf', () => true, true)).toBe(false);
});
