import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { currentAccountRevision } from './helpers.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const call = (user: Principal | null, method: string, route: string, body?: unknown, headers = {}) => daemon.request({ method, path: route,
  ...(user ? { cookie: user.cookie } : {}), ...(body === undefined ? {} : { body }), headers });
const ingest = (user: Principal, text: string, extra = {}) => call(user, 'POST', '/api/library/ingest', { text, mime: 'text/html', ...extra });
async function pair(user = a) {
  const code = await call(user, 'POST', '/api/library/pair', {}); expect(code.status, code.text).toBe(200);
  const token = await call(null, 'POST', '/api/library/pair/confirm', { code: code.json.code, extensionOrigin: origin, label: 'My clipper' }, { origin });
  expect(token.status, token.text).toBe(200); return { code: code.json.code, token: token.json.token as string };
}
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); daemon = await startMultiUserDaemon(multiUserOptions());
  const accounts = await provisionAccounts(daemon, ['library-a', 'library-b']); [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
it('isolates identical bytes and every asset route with no admin bypass', async () => {
  const saved = await ingest(a, '<html>A_PRIVATE_LIBRARY</html>', { kind: 'html', figmaCapture: '{"private":"A_FIGMA"}', elementHtml: '<div>A_ELEMENT</div>' });
  expect(saved.status, saved.text).toBe(200); const id = saved.json.asset.id;
  const duplicate = await ingest(b, '<html>A_PRIVATE_LIBRARY</html>'); expect(duplicate.status).toBe(200);
  expect(duplicate.json.asset.id).not.toBe(id); expect(duplicate.json.deduped).toBe(false);
  for (const user of [b, admin]) {
    const list = await call(user, 'GET', '/api/library/assets'); expect(list.status).toBe(200); expect(list.text).not.toContain(id);
    for (const [method, suffix, body] of [['GET', '', undefined], ['GET', '/raw', undefined], ['GET', '/figma', undefined], ['GET', '/element', undefined],
      ['DELETE', '', {}], ['POST', '/apply', { projectId: randomUUID() }], ['POST', '/edit-as-page', {}]] as const) {
      const foreign = await call(user, method, `/api/library/assets/${id}${suffix}`, body);
      const missing = await call(user, method, `/api/library/assets/${randomUUID()}${suffix}`, body);
      expect(foreign.status, foreign.text).toBe(404); expect(foreign.json).toEqual(missing.json);
    }
  }
  for (const suffix of ['', '/raw', '/figma', '/element']) {
    const own = await call(a, 'GET', `/api/library/assets/${id}${suffix}`); expect(own.status, own.text).toBe(200); expect(own.text).not.toContain(root);
    if (suffix === '/raw' || suffix === '/element') expect(own.headers['content-security-policy']).toContain('sandbox');
  }
  expect((await call(a, 'POST', '/api/library/sync', {})).status).toBe(403);
});
it('exchanges single-use codes and only exposes token metadata after creation', async () => {
  const paired = await pair();
  expect((await call(null, 'POST', '/api/library/pair/confirm', { code: paired.code, extensionOrigin: origin }, { origin })).status).toBe(401);
  const connection = await call(a, 'GET', '/api/library/connection'); expect(connection.status).toBe(200);
  expect(connection.json.tokens.at(-1)).toMatchObject({ id: expect.any(String), label: 'My clipper', lastUsedAt: expect.any(Number) });
  expect(connection.text).not.toContain(paired.token); expect(connection.text).not.toContain(createHash('sha256').update(paired.token).digest('hex'));
  expect((await call(b, 'GET', '/api/library/connection')).json.tokens).toEqual([]);
  const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  try { expect(JSON.stringify(db.prepare('SELECT * FROM studio_library_tokens').all())).not.toContain(paired.token); } finally { db.close(); }
});
it('refuses expired codes and web-origin code exchanges', async () => {
  const pending = await call(a, 'POST', '/api/library/pair', {}); expect(pending.status).toBe(200);
  const db = new Database(path.join(root, 'app.sqlite'));
  try { db.prepare('UPDATE studio_library_pairing SET expires_at = 0').run(); } finally { db.close(); }
  expect((await call(null, 'POST', '/api/library/pair/confirm', { code: pending.json.code, extensionOrigin: origin }, { origin })).status).toBe(401);
  const fresh = await call(a, 'POST', '/api/library/pair', {});
  expect((await call(null, 'POST', '/api/library/pair/confirm', { code: fresh.json.code, extensionOrigin: origin }, { origin: 'https://evil.test' })).status).toBe(403);
});
it('pins token owner despite cookies and supports owner-only session-independent revocation', async () => {
  const paired = await pair();
  expect((await call(null, 'POST', '/api/library/ingest', { text: 'UNPAIRED' }, { origin })).status).toBe(401);
  const captured = await call(b, 'POST', '/api/library/ingest', { text: 'TOKEN_A_ONLY' }, { origin, authorization: `Bearer ${paired.token}` });
  expect(captured.status, captured.text).toBe(200); const id = captured.json.asset.id;
  expect((await call(a, 'GET', `/api/library/assets/${id}`)).status).toBe(200); expect((await call(b, 'GET', `/api/library/assets/${id}`)).status).toBe(404);
  const tokens = (await call(a, 'GET', '/api/library/connection')).json.tokens; const tokenId = tokens.at(-1).id;
  const foreign = await call(b, 'DELETE', `/api/library/tokens/${tokenId}`); const missing = await call(b, 'DELETE', `/api/library/tokens/${randomUUID()}`);
  expect(foreign.status).toBe(404); expect(foreign.json).toEqual(missing.json);
  expect((await call(a, 'DELETE', `/api/library/tokens/${tokenId}`)).status).toBe(200);
  expect((await call(null, 'POST', '/api/library/ingest', { text: 'REVOKED' }, { origin, authorization: `Bearer ${paired.token}` })).status).toBe(401);
});
it('refuses deactivated accounts immediately for extension ingest', async () => {
  const paired = await pair(b); const revision = await currentAccountRevision(daemon.request, b.id, admin.cookie);
  expect((await call(admin, 'PATCH', `/api/auth/users/${b.id}`, { active: false, revision })).status).toBe(200);
  expect((await call(null, 'POST', '/api/library/ingest', { text: 'DEACTIVATED' }, { origin, authorization: `Bearer ${paired.token}` })).status).toBe(401);
});
it('enforces ingest size and per-account rate limits', async () => {
  const paired = await pair();
  expect((await call(null, 'POST', '/api/library/ingest', { text: 'x'.repeat(26 * 1024 * 1024) }, { origin, authorization: `Bearer ${paired.token}` })).status).toBe(413);
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const response = await call(null, 'POST', '/api/library/ingest', { text: 'rate' }, { origin, authorization: `Bearer ${paired.token}` });
    if (response.status === 429) { limited = true; break; } expect(response.status, response.text).toBe(200);
  }
  expect(limited).toBe(true);
});
it('creates an owned page and refuses applying into foreign and read-only projects while permitting shared editable projects', async () => {
  const saved = await ingest(admin, '<html>EDIT_PAGE</html>', { kind: 'html' }); expect(saved.status).toBe(200);
  const edited = await call(admin, 'POST', `/api/library/assets/${saved.json.asset.id}/edit-as-page`, {}); expect(edited.status, edited.text).toBe(200);
  expect((await call(admin, 'GET', `/api/projects/${edited.json.projectId}`)).status).toBe(200);
  expect((await call(a, 'GET', `/api/projects/${edited.json.projectId}`)).status).toBe(404);
  const targetId = randomUUID();
  expect((await call(a, 'POST', '/api/projects', { id: targetId, name: 'A target' })).status).toBe(200);
  const apply = `/api/library/assets/${saved.json.asset.id}/apply`;
  expect((await call(admin, 'POST', apply, { projectId: targetId })).status).toBe(404);
  const share = `/api/multiuser/projects/${targetId}/shares`;
  const view = await call(a, 'PUT', share, { username: admin.username, role: 'view' });
  expect(view.status, view.text).toBe(200);
  expect(view.json.member).toMatchObject({ accountId: admin.id, role: 'view' });
  expect((await call(admin, 'POST', apply, { projectId: targetId })).status).toBe(404);
  const edit = await call(a, 'PUT', share, { username: admin.username, role: 'edit' });
  expect(edit.status, edit.text).toBe(200);
  expect(edit.json.member).toMatchObject({ accountId: admin.id, role: 'edit' });
  const applied = await call(admin, 'POST', apply, { projectId: targetId });
  expect(applied.status, applied.text).toBe(200);
  expect(applied.json.relPath).toEqual(expect.any(String));
  expect((await call(admin, 'POST', apply, { projectId: edited.json.projectId })).status).toBe(200);
  // Use admin's asset: a foreign asset is refused before project authorization.
  expect((await call(a, 'POST', `/api/library/assets/${saved.json.asset.id}/apply`, { projectId: edited.json.projectId })).status).toBe(404);
});
