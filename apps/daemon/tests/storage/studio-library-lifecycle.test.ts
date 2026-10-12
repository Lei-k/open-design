import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { StudioLibrary } from '../../src/services/studio-library.js';
import type { AuthActor } from '../../src/services/auth-service.js';

const roots: string[] = []; const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const actor: AuthActor = { accountId: 'a', username: 'a', role: 'user', sessionId: 'session-a', sessionExpiresAt: 900000 };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'library-lifecycle-')); roots.push(root);
  const db = new Database(':memory:'); databases.push(db);
  const sessions = new Set([actor.sessionId]); const active = new Set(['a', 'b']); let now = 1000;
  const store = new StudioLibrary({ db, dataRoot: root, accountActive: (id) => active.has(id), sessionCurrent: (snapshot: AuthActor) => sessions.has(snapshot.sessionId), clock: () => now });
  return { store, db, root, sessions, active, advance: () => { now += 60001; } };
}
const exchange = (store: StudioLibrary, code: string) => store.confirm({ code, extensionOrigin: 'chrome-extension://abc' });
it('refuses a pending code when its creating session is no longer current', () => {
  const { store, sessions } = fixture(); const pending = store.pair('a', actor);
  sessions.delete(actor.sessionId);
  expect(() => exchange(store, pending.code)).toThrow();
});
it('fails closed on pending codes upgraded without a creating-session snapshot', () => {
  const { store, db } = fixture(); const pending = store.pair('a', actor);
  db.prepare('UPDATE studio_library_pairing SET session_snapshot=NULL').run();
  expect(() => exchange(store, pending.code)).toThrow();
  const fresh = store.pair('a', actor); expect(exchange(store, fresh.code).token).toMatch(/^odlt_/);
  expect(JSON.stringify(db.prepare('SELECT * FROM studio_library_tokens').all())).not.toContain(fresh.code);
});
it('cancels pending codes on every revocation but retires tokens only for all-session security actions', () => {
  const { store, active } = fixture(); const token = exchange(store, store.pair('a', actor).code).token;
  const logoutCode = store.pair('a', actor).code; store.invalidateAccount('a');
  expect(() => exchange(store, logoutCode)).toThrow(); expect(store.tokenOwner(token)).toBe('a');
  const inactiveCode = store.pair('a', actor).code; active.delete('a'); store.invalidateAccount('a');
  expect(() => exchange(store, inactiveCode)).toThrow(); expect(store.tokenOwner(token)).toBeNull();
  active.add('a'); expect(store.tokenOwner(token)).toBe('a'); expect(() => exchange(store, inactiveCode)).toThrow();
  for (const reason of ['password reset', 'revoke all sessions']) {
    const pending = store.pair('a', actor).code; store.invalidateAccount('a', true);
    expect(() => exchange(store, pending), reason).toThrow(); expect(store.tokenOwner(token), reason).toBeNull();
    const fresh = exchange(store, store.pair('a', actor).code); expect(store.tokenOwner(fresh.token)).toBe('a');
    expect(JSON.stringify(store.connection('a'))).not.toContain(fresh.token);
  }
});
it('bounds concurrent admission, releases errors and counts rate slots before decoding', async () => {
  const { store, db, advance } = fixture(); const first = store.admitIngest('a'); const second = store.admitIngest('a');
  expect(() => store.admitIngest('a')).toThrow(); first(); first(); const third = store.admitIngest('a'); third(); second();
  await expect(store.ingest('a', { dataUrl: 'malformed' }, () => true)).rejects.toMatchObject({ status: 400 });
  const released = store.admitIngest('a'); released();
  expect((db.prepare('SELECT count FROM studio_library_rate WHERE owner_account_id=?').get('a') as { count: number }).count).toBe(5);
  for (let i = 5; i < 60; i++) store.admitIngest('a')();
  expect(() => store.admitIngest('a')).toThrow(); store.admitIngest('b')(); advance(); store.admitIngest('a')();
});
it('throttles pairing exchange per source and globally before a write transaction', () => {
  const { store, advance } = fixture();
  for (let i = 0; i < 60; i++) store.admitPair('source-a');
  expect(() => store.admitPair('source-a')).toThrow(); store.admitPair('source-b');
  for (let i = 61; i < 300; i++) store.admitPair(`source-${i}`);
  expect(() => store.admitPair('fresh-source')).toThrow(); advance(); store.admitPair('source-a');
});
it('cleans every precommit object and sidecar, and reports success once the registry commits', async () => {
  for (let revokeAt = 1; revokeAt <= 14; revokeAt++) {
    const { store, root } = fixture(); let checks = 0; let committed = false;
    try {
      const saved = await store.ingest('a', { text: 'capture', mime: 'text/html', elementHtml: '<div>reference</div>', figmaCapture: '{}' }, () => ++checks < revokeAt);
      committed = true; expect(saved.asset.id).toBeTruthy();
    } catch (error) { expect(error).toMatchObject({ status: 401 }); }
    const rows = await store.list('a'); expect(rows.length).toBe(committed ? 1 : 0);
    const objects = path.join(root, 'studio-accounts', createHash('sha256').update('a').digest('hex'), 'library', 'objects');
    const files = existsSync(objects) ? readdirSync(objects, { recursive: true, withFileTypes: true }).filter((item) => item.isFile()) : [];
    expect(files.length, `authority check ${revokeAt}`).toBe(committed ? 3 : 0);
  }
});
it('restores existing sidecars and metadata when a deduplicated capture loses authority', async () => {
  for (let revokeAt = 1; revokeAt <= 10; revokeAt++) {
    const { store } = fixture();
    const first = await store.ingest('a', { text: 'same capture', mime: 'text/html', figmaCapture: '{"version":"old"}', elementHtml: '<div>old</div>' }, () => true);
    let checks = 0; let committed = false;
    try {
      const second = await store.ingest('a', { text: 'same capture', mime: 'text/html', figmaCapture: '{"version":"new"}', elementHtml: '<div>new</div>' }, () => ++checks < revokeAt);
      committed = true; expect(second.deduped).toBe(true);
    } catch (error) { expect(error).toMatchObject({ status: 401 }); }
    expect(await store.bytes('a', first.asset.id, 'figma')).toMatchObject({ bytes: Buffer.from(`{"version":"${committed ? 'new' : 'old'}"}`) });
    expect(await store.bytes('a', first.asset.id, 'element')).toMatchObject({ bytes: Buffer.from(`<div>${committed ? 'new' : 'old'}</div>`) });
    expect(await store.list('a')).toHaveLength(1);
  }
});
it('rolls back registry/source/task failures and removes all uncommitted capture files', async () => {
  const { store, root } = fixture(); await store.list('a');
  const library = path.join(root, 'studio-accounts', createHash('sha256').update('a').digest('hex'), 'library');
  const db = new Database(path.join(library, 'library.sqlite')); databases.push(db);
  db.exec("CREATE TRIGGER refuse_source BEFORE INSERT ON library_asset_sources BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
  await expect(store.ingest('a', { text: 'capture', figmaCapture: '{}', elementHtml: '<div>capture</div>' }, () => true)).rejects.toThrow();
  expect(await store.list('a')).toEqual([]);
  expect(readdirSync(path.join(library, 'objects'), { recursive: true, withFileTypes: true }).filter((item) => item.isFile())).toEqual([]);
});
