import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { MULTIUSER_ROUTE_CLASSIFICATION, matchMultiUserRoute } from '../../apps/daemon/src/http/multiuser-route-classes.js';
const runtime = fileURLToPath(new URL('../../apps/web/src/runtime/studio-transport.ts', import.meta.url));
const { studioRequestAvailable } = await import(runtime) as {
  studioRequestAvailable(method: string, path: string, usable?: (lane: string) => boolean): boolean;
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
  for (const [method, path] of [['GET', '/api/projects/p/archive'], ['POST', '/api/projects/p/files/a.html/publish-public'],
    ['OPTIONS', '/api/projects/p/raw/a.txt'], ['GET', '/api/projects/p/powered/a.js'], ['PUT', '/api/projects/p/files']]) {
    expect(studioRequestAvailable(method!, path!, () => true), `${method} ${path}`).toBe(false);
  }
});
