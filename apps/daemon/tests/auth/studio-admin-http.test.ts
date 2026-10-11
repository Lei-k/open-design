import { afterEach, beforeEach, expect, it } from 'vitest';
import { ManualClock, cookiePairFrom, makeTempDataRoot, openTestAuth, startAuthHarness, type AuthHarness } from './helpers.js';

let harness: AuthHarness;
let store: ReturnType<typeof openTestAuth>['store'];
let cleanup: () => void;
let admin: string;
let adminId: string;
let targetId: string;
let observed: number;
beforeEach(async () => {
  const temp = makeTempDataRoot(); cleanup = temp.cleanup;
  const auth = openTestAuth(temp.dataRoot, new ManualClock()); store = auth.store;
  harness = await startAuthHarness({ auth: auth.service, bootstrapSecret: 's68-bootstrap-fixture-secret-123456789' });
  const boot = await harness.request({ method: 'POST', path: '/api/auth/bootstrap', body: { bootstrapToken: 's68-bootstrap-fixture-secret-123456789', username: 'root', password: 'fixture-password-1234' } });
  adminId = boot.json.account.id;
  admin = cookiePairFrom((await harness.request({ method: 'POST', path: '/api/auth/login', body: { username: 'root', password: 'fixture-password-1234' } })).setCookies)!;
  const created = await harness.request({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: 'second', role: 'admin', password: 'fixture-password-5678' } });
  targetId = created.json.account.id; observed = created.json.account.updatedAt;
});
afterEach(async () => { await harness.close(); store.close(); cleanup(); });
const patch = (id: string, body: unknown, cookie = admin) => harness.request({ method: 'PATCH', path: `/api/auth/users/${id}`, cookie, body });
it('requires the observed revision and admits exactly one concurrent access update, even within one clock tick', async () => {
  expect((await patch(targetId, { role: 'user' })).status).toBe(400);
  const results = await Promise.all([patch(targetId, { role: 'user', revision: observed }), patch(targetId, { active: false, revision: observed })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const current = (await harness.request({ path: '/api/auth/users', cookie: admin })).json.accounts.find((a: { id: string }) => a.id === targetId);
  expect(current.updatedAt).toBeGreaterThan(observed);
  expect((await patch(targetId, { active: current.active, revision: observed })).status).toBe(409);
});
it('protects the last administrator and refuses self-demotion/self-disable even with another usable admin', async () => {
  const own = (await harness.request({ path: '/api/auth/me', cookie: admin })).json.account;
  for (const flags of [{ role: 'user' }, { active: false }]) expect((await patch(adminId, { ...flags, revision: own.updatedAt })).status).toBe(403);
  expect((await patch(targetId, { role: 'user', revision: observed })).status).toBe(200);
  // Last-admin protection precedes the self restriction, making recovery failure explicit.
  expect((await patch(adminId, { role: 'user', revision: own.updatedAt })).status).toBe(409);
});
it('authorizes before validation and preserves missing/foreign refusal for ordinary callers', async () => {
  const user = cookiePairFrom((await harness.request({ method: 'POST', path: '/api/auth/login', body: { username: 'second', password: 'fixture-password-5678' } })).setCookies)!;
  await patch(targetId, { role: 'user', revision: observed });
  expect((await patch(adminId, {}, user)).status).toBe(401);
  const live = cookiePairFrom((await harness.request({ method: 'POST', path: '/api/auth/login', body: { username: 'second', password: 'fixture-password-5678' } })).setCookies)!;
  expect((await patch(adminId, {}, live)).status).toBe(403);
  expect((await patch('missing', {}, live)).status).toBe(403);
});
it('does not reuse an observed access revision after same-tick password resets', async () => {
  const changed = await patch(targetId, { role: 'user', revision: observed });
  expect(changed.status).toBe(200);
  const revision = changed.json.account.updatedAt;
  expect((await harness.request({ method: 'POST', path: `/api/auth/users/${targetId}/password`, cookie: admin, body: { revision } })).status).toBe(201);
  expect((await patch(targetId, { role: 'admin', revision })).status).toBe(409);
  expect((await patch(targetId, { role: 'admin', revision: observed })).status).toBe(409);
});
