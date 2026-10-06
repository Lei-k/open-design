import { randomUUID } from 'node:crypto';
import { matchMultiUserRoute } from '../../src/http/multiuser-route-classes.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let admin: Principal;
let alice: Principal;
let bob: Principal;
beforeAll(async () => {
  daemon = await startMultiUserDaemon();
  const accounts = await provisionAccounts(daemon, ['pilot-alice', 'pilot-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
const route = (id: string) => `/api/admin/users/${id}/studio-pilot`;

it('defaults off, changes only the target effective shell, and rejects stale writes without auditing them', async () => {
  const initial = await daemon.request({ path: route(alice.id), cookie: admin.cookie });
  expect(initial.status).toBe(200);
  expect(initial.json).toEqual({ studioPilot: false, revision: 0 });
  const before = await daemon.request({ path: '/api/auth/me', cookie: alice.cookie });
  expect(before.json.studio.shell).toBe('legacy-multiuser');
  const set = await daemon.request({ method: 'PUT', path: route(alice.id), cookie: admin.cookie, body: { studioPilot: true, revision: 0 } });
  expect(set.status).toBe(200);
  expect(set.json).toEqual({ studioPilot: true, revision: 1 });
  const own = await daemon.request({ path: '/api/auth/me', cookie: alice.cookie });
  expect(own.json.studio.shell).toBe('studio');
  expect(own.json.studioRevision).toBe(1);
  expect(own.json.studio.features).toEqual(before.json.studio.features);
  expect((await daemon.request({ path: '/api/auth/me', cookie: bob.cookie })).json.studio.shell).toBe('legacy-multiuser');
  expect((await daemon.request({ path: '/api/version' })).json.version.capabilities.studio.shell).toBe('legacy-multiuser');
  expect((await daemon.request({ method: 'PUT', path: route(alice.id), cookie: admin.cookie, body: { studioPilot: false, revision: 0 } })).status).toBe(409);
  const audit = await daemon.request({ path: '/api/auth/audit', cookie: admin.cookie });
  expect(audit.json.events.filter((event: { action: string }) => event.action === 'studio_pilot_update')).toEqual([
    expect.objectContaining({ actorAccountId: admin.id, targetAccountId: alice.id, metadata: { studioPilot: true, revision: 1 } }),
  ]);
  expect((await daemon.request({ method: 'PUT', path: route(alice.id), cookie: admin.cookie, body: { studioPilot: false, revision: 1 } })).json).toEqual({ studioPilot: false, revision: 2 });
  expect((await daemon.request({ path: '/api/auth/me', cookie: alice.cookie })).json.studio.shell).toBe('legacy-multiuser');
});

it('checks admin authority before target lookup, rejects client identity and enforces a closed body', async () => {
  for (const caller of [alice, bob]) {
    const denials: unknown[] = [];
    for (const target of [alice.id, bob.id, admin.id, randomUUID()]) {
      for (const method of ['GET', 'PUT']) {
        const response = await daemon.request({ method, path: route(target), cookie: caller.cookie,
          headers: { 'x-od-account-id': admin.id }, ...(method === 'PUT' ? { body: { studioPilot: true, revision: 0 } } : {}) });
        expect(response.status).toBe(403);
        denials.push(response.json);
      }
    }
    for (const denial of denials) expect(denial).toEqual(denials[0]);
  }
  expect((await daemon.request({ path: route(alice.id) })).status).toBe(401);
  expect((await daemon.request({ path: route(randomUUID()), cookie: admin.cookie })).status).toBe(404);
  for (const body of [{ studioPilot: true }, { studioPilot: 'true', revision: 0 }, { studioPilot: true, revision: -1 },
    { studioPilot: true, revision: 0, role: 'admin' }, { studioPilot: true, revision: 0, ownerAccountId: alice.id }]) {
    expect((await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie, body })).status).toBe(400);
  }
  for (const rawBody of ['{"studioPilot":false,"studioPilot":true,"revision":0}', '{"studioPilot":true,"revision":0,"rev\\u0069sion":0}']) {
    const response = await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie,
      headers: { 'content-type': 'application/json' }, rawBody });
    expect(response.status).toBe(400);
  }
  expect((await daemon.request({ path: route(bob.id), cookie: admin.cookie })).json).toEqual({ studioPilot: false, revision: 0 });
  for (const method of ['GET', 'PUT']) expect(matchMultiUserRoute(method, route(alice.id)).map(({ entry }) => entry.routeClass)).toEqual(['admin-only']);
  const pilot = await daemon.request({ path: route(alice.id), cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: route(alice.id), cookie: admin.cookie, body: { studioPilot: true, revision: pilot.json.revision } })).status).toBe(200);
  const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: alice.cookie, body: { id: randomUUID(), name: 'Private pilot project' } });
  expect(project.status).toBe(200);
  expect((await daemon.request({ path: `/api/projects/${project.json.project.id}`, cookie: alice.cookie })).status).toBe(200);
  for (const caller of [bob, admin]) {
    const foreign = await daemon.request({ path: `/api/projects/${project.json.project.id}`, cookie: caller.cookie });
    const missing = await daemon.request({ path: `/api/projects/${randomUUID()}`, cookie: caller.cookie });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(missing.json);
  }
});

it('applies auth body and origin hardening to the pilot registrar before parsing', async () => {
  const before = (await daemon.request({ path: route(bob.id), cookie: admin.cookie })).json;
  const valid = { studioPilot: true, revision: before.revision };
  const denied = await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie,
    headers: { origin: 'https://foreign.invalid' }, body: valid });
  expect(denied.status).toBe(403);
  const oversized = await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie,
    headers: { 'content-type': 'application/json' }, rawBody: ' '.repeat(17 * 1024) });
  expect(oversized.status).toBe(413);
  const encoded = await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, rawBody: '{}' });
  expect(encoded.status).toBe(415);
  const utf16 = await daemon.request({ method: 'PUT', path: route(bob.id), cookie: admin.cookie,
    headers: { 'content-type': 'application/json; charset=utf-16le' },
    rawBody: Buffer.from('{"studioPilot":false,"studioPilot":true,"revision":0}', 'utf16le') });
  expect(utf16.status).toBe(415);
  expect((await daemon.request({ path: route(bob.id), cookie: admin.cookie })).json).toEqual(before);
});
