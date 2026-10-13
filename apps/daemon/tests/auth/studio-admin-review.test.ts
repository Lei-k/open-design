import { afterEach, beforeEach, expect, it } from 'vitest';
import { ManualClock, currentAccountRevision, cookiePairFrom, makeTempDataRoot, openTestAuth, startAuthHarness, type AuthHarness } from './helpers.js';

let harness: AuthHarness;
let store: ReturnType<typeof openTestAuth>['store'];
let cleanup: () => void;
let clock: ManualClock;
let root: string; let rootId: string;
let second: string; let secondId: string;
const login = async (username: string, password: string) => cookiePairFrom((await harness.request({ method: 'POST', path: '/api/auth/login', body: { username, password } })).setCookies)!;
const list = async (cookie = root) => (await harness.request({ path: '/api/auth/users?limit=100', cookie })).json.accounts as Array<{ id: string; role: string; active: boolean; updatedAt: number; passwordState: string }>;
const rev = async (id: string) => (await list()).find((a) => a.id === id)!.updatedAt;
const patch = (id: string, body: unknown, cookie = root) => harness.request({ method: 'PATCH', path: `/api/auth/users/${id}`, cookie, body });

beforeEach(async () => {
  const temp = makeTempDataRoot(); cleanup = temp.cleanup; clock = new ManualClock();
  const auth = openTestAuth(temp.dataRoot, clock); store = auth.store;
  harness = await startAuthHarness({ auth: auth.service, bootstrapSecret: 's68-review-bootstrap-secret-1234567890' });
  rootId = (await harness.request({ method: 'POST', path: '/api/auth/bootstrap', body: { bootstrapToken: 's68-review-bootstrap-secret-1234567890', username: 'root', password: 'fixture-password-1234' } })).json.account.id;
  root = await login('root', 'fixture-password-1234');
  secondId = (await harness.request({ method: 'POST', path: '/api/auth/users', cookie: root, body: { username: 'second', role: 'admin', password: 'fixture-password-5678' } })).json.account.id;
  second = await login('second', 'fixture-password-5678');
});
afterEach(async () => { await harness.close(); store.close(); cleanup(); });

it('R1 two admins demoting each other concurrently leave exactly one usable admin', async () => {
  const [rr, rs] = [await rev(rootId), await rev(secondId)];
  const results = await Promise.all([patch(secondId, { role: 'user', revision: rs }, root), patch(rootId, { role: 'user', revision: rr }, second)]);
  const statuses = results.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  const admins = store.listAccounts().filter((a) => a.role === 'admin' && a.active && a.passwordState === 'set');
  expect(admins).toHaveLength(1);
});

it('R2 two admins disabling each other concurrently leave exactly one usable admin', async () => {
  const [rr, rs] = [await rev(rootId), await rev(secondId)];
  const results = await Promise.all([patch(secondId, { active: false, revision: rs }, root), patch(rootId, { active: false, revision: rr }, second)]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(store.listAccounts().filter((a) => a.role === 'admin' && a.active)).toHaveLength(1);
});

it('R3 refuses stale and malformed reset revisions before retiring sessions or issuing credentials', async () => {
  const user = (await harness.request({ method: 'POST', path: '/api/auth/users', cookie: root, body: { username: 'carol', role: 'user', password: 'fixture-password-9999' } })).json.account;
  const stale = user.updatedAt;
  // Another admin changes the account first (role change) — the view held by root is now stale.
  expect((await patch(user.id, { role: 'admin', revision: stale }, second)).status).toBe(200);
  const userCookie = await login('carol', 'fixture-password-9999');
  // The stale reset must retire no sessions and issue no credential.
  const reset = await harness.request({ method: 'POST', path: `/api/auth/users/${user.id}/password`, cookie: root, body: { revision: stale } });
  expect(reset.status).toBe(409);
  expect(reset.json.error.code).toBe('CONFLICT');
  expect(store.getAccountById(user.id)?.passwordState).toBe('set');
  expect((await harness.request({ path: '/api/auth/me', cookie: userCookie })).status).toBe(200);
  // Arbitrary garbage is refused before any mutation.
  clock.advance(10);
  const reset2 = await harness.request({ method: 'POST', path: `/api/auth/users/${user.id}/password`, cookie: root, body: { revision: 'nonsense' } });
  expect(reset2.status).toBe(400);
});

it('R4 refuses self-reset with a valid revision and preserves the own-password flow', async () => {
  const r = await harness.request({ method: 'POST', path: `/api/auth/users/${rootId}/password`, cookie: root, body: { revision: await rev(rootId) } });
  expect(r.status).toBe(403);
  expect(r.json.error.code).toBe('FORBIDDEN');
  const legacy = await harness.request({ method: 'POST', path: `/api/auth/users/${rootId}/password`, cookie: root, body: { revision: await rev(rootId), password: 'fixture-legacy-reset-0000' } });
  expect(legacy.status).toBe(403); expect(legacy.json.error.code).toBe('FORBIDDEN');
  expect((await harness.request({ path: '/api/auth/me', cookie: root })).status).toBe(200);
  expect((await harness.request({ method: 'POST', path: '/api/auth/password', cookie: root, body: { currentPassword: 'fixture-password-1234', newPassword: 'fixture-own-password-0000' } })).status).toBe(200);
});

it('R5 audit rows never contain setup tokens or passwords; error bodies carry no secrets', async () => {
  const made = await harness.request({ method: 'POST', path: '/api/auth/users', cookie: root, body: { username: 'dave', role: 'user' } });
  const token: string = made.json.setup.token;
  const reset = await harness.request({ method: 'POST', path: `/api/auth/users/${secondId}/password`, cookie: root, body: { revision: await rev(secondId) } });
  const token2: string = reset.json.setup.token;
  const conflict = await patch(made.json.account.id, { role: 'admin', revision: 1 });
  expect(conflict.status).toBe(409);
  const audit = await harness.request({ path: '/api/auth/audit?limit=100', cookie: root });
  const text = audit.text + conflict.text;
  for (const secret of [token, token2, 'fixture-password-1234', 'fixture-password-5678']) expect(text).not.toContain(secret);
});

it('R6 revision edge cases: string, negative, float, revision-only, extra fields; non-admin ordering', async () => {
  const r = await rev(secondId);
  const cases: Array<[unknown, number]> = [
    [{ role: 'user', revision: String(r) }, 400], [{ role: 'user', revision: -1 }, 400], [{ role: 'user', revision: r + 0.5 }, 400],
    [{ revision: r }, 400], [{ role: 'user', revision: r, extra: 1 }, 400], [{ role: 'user', revision: null }, 400],
  ];
  for (const [body, status] of cases) expect((await patch(secondId, body)).status, JSON.stringify(body)).toBe(status);
  // a no-op patch with a stale revision is a conflict, not silently accepted
  expect((await patch(secondId, { role: 'admin', revision: r - 1 })).status).toBe(409);
  expect((await patch(secondId, { role: 'admin', revision: r })).status).toBe(200);
  // revision unchanged by a no-op
  expect(await rev(secondId)).toBe(r);
});

it('R7 a demoted admin with a cached revision cannot act; its old cookie is dead', async () => {
  expect((await patch(secondId, { role: 'user', revision: await rev(secondId) })).status).toBe(200);
  for (const req of [
    { path: '/api/auth/users', cookie: second }, { path: '/api/auth/audit', cookie: second },
    { method: 'PATCH', path: `/api/auth/users/${rootId}`, cookie: second, body: { role: 'user', revision: 0 } },
    { method: 'POST', path: `/api/auth/users/${rootId}/password`, cookie: second, body: {} },
    { method: 'POST', path: `/api/auth/users/${rootId}/sessions/revoke`, cookie: second, body: {} },
  ]) expect((await harness.request(req)).status, req.path).toBe(401);
  const fresh = await login('second', 'fixture-password-5678');
  expect((await harness.request({ path: '/api/auth/users', cookie: fresh })).status).toBe(403);
  expect((await harness.request({ path: '/api/auth/audit', cookie: fresh })).status).toBe(403);
});

it('R8 revision churn: target changing their own password / completing setup invalidates the admin view', async () => {
  const r = await rev(secondId);
  const changed = await harness.request({ method: 'POST', path: '/api/auth/password', cookie: second, body: { currentPassword: 'fixture-password-5678', newPassword: 'fixture-password-0000' } });
  expect(changed.status).toBe(200);
  expect((await patch(secondId, { role: 'user', revision: r })).status).toBe(409);
  expect((await harness.request({ method: 'POST', path: `/api/auth/users/${secondId}/password`, cookie: root, body: { revision: r } })).status).toBe(409);
});

it.each([{}, { revision: 'nonsense' }, { revision: null }, { revision: -1 }, { revision: 0.5 }])('refuses missing/non-numeric reset revision %j', async (body) => {
  expect((await harness.request({ method: 'POST', path: `/api/auth/users/${secondId}/password`, cookie: root, body })).status).toBe(400);
  expect(store.getAccountById(secondId)?.passwordState).toBe('set');
  expect((await harness.request({ path: '/api/auth/me', cookie: second })).status).toBe(200);
});
it('observes the account revision beyond the first 100 accounts', async () => {
  const template = store.getAccountById(secondId)!;
  for (let i = 0; i < 101; i++) store.insertAccount({ ...template, id: `padding-${i}`, username: `aaa${String(i).padStart(3, '0')}`, role: 'user' });
  expect(await currentAccountRevision(harness.request, secondId, root)).toBe(template.updatedAt);
});
it('distinguishes last-admin and duplicate-username typed refusals from revision conflicts', async () => {
  const duplicate = await harness.request({ method: 'POST', path: '/api/auth/users', cookie: root, body: { username: 'second', role: 'user' } });
  expect(duplicate.status).toBe(409); expect(duplicate.json.error.code).toBe('USERNAME_TAKEN');
  expect((await patch(secondId, { role: 'user', revision: await rev(secondId) })).status).toBe(200);
  const last = await patch(rootId, { role: 'user', revision: await rev(rootId) });
  expect(last.status).toBe(409); expect(last.json.error.code).toBe('LAST_ADMIN');
});

it('binds a pending-account credential reissue to the observed revision', async () => {
  const made = await harness.request({ method: 'POST', path: '/api/auth/users', cookie: root, body: { username: 'pending', role: 'user' } });
  const reset = () => harness.request({ method: 'POST', path: `/api/auth/users/${made.json.account.id}/password`, cookie: root, body: { revision: made.json.account.updatedAt } });
  const issued = await reset();
  expect(issued.status).toBe(201);
  expect((await reset()).status).toBe(409);
  expect((await harness.request({ method: 'POST', path: '/api/auth/setup', body: { token: issued.json.setup.token, password: 'pending-fixture-password-9999' } })).status).toBe(200);
});
