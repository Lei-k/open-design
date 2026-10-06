import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { MULTIUSER_ROUTE_CLASSIFICATION, matchMultiUserRoute } from '../../apps/daemon/src/http/multiuser-route-classes.js';
const runtime = fileURLToPath(new URL('../../apps/web/src/runtime/studio-transport.ts', import.meta.url));
const { studioRequestAvailable } = await import(runtime) as { studioRequestAvailable(method: string, path: string): boolean };

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
