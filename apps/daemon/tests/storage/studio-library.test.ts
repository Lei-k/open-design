import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { StudioLibrary, StudioLibraryError } from '../../src/services/studio-library.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-library-')); roots.push(root);
  const db = new Database(':memory:'); const active = new Set(['a', 'b', 'admin']); let now = 1000;
  const store = new StudioLibrary({ db, dataRoot: root, accountActive: (id) => active.has(id), clock: () => now });
  return { store, db, active, advance: () => { now += 300001; } };
};
it('uses account-isolated content hashes and safe private paths', async () => {
  const { store, db } = setup();
  const a = await store.ingest('a', { text: 'same bytes' }, () => true);
  const b = await store.ingest('b', { text: 'same bytes' }, () => true);
  expect(a.asset.id).not.toBe(b.asset.id); expect(b.deduped).toBe(false);
  expect((await store.list('a')).map((item) => item.id)).toEqual([a.asset.id]);
  expect(await store.get('b', a.asset.id)).toBeNull(); expect(await store.get('admin', a.asset.id)).toBeNull();
  expect(JSON.stringify(a)).not.toMatch(/filePath|studio-accounts/);
  expect((await store.ingest('a', { text: 'same bytes' }, () => true)).deduped).toBe(true); db.close();
});
it('hashes codes and tokens, consumes once, expires, scopes list/revoke and checks deactivation', () => {
  const { store, db, active, advance } = setup();
  const pending = store.pair('a'); const paired = store.confirm({ code: pending.code, extensionOrigin: 'chrome-extension://abc', label: 'A' });
  expect(paired.token).toMatch(/^odlt_/); expect(store.tokenOwner(paired.token)).toBe('a');
  expect(JSON.stringify(store.connection('a'))).not.toContain(paired.token);
  expect(JSON.stringify(db.prepare('SELECT * FROM studio_library_tokens').all())).not.toContain(paired.token);
  expect(() => store.confirm({ code: pending.code, extensionOrigin: 'chrome-extension://abc' })).toThrow(StudioLibraryError);
  const expired = store.pair('a'); advance(); expect(() => store.confirm({ code: expired.code, extensionOrigin: 'chrome-extension://abc' })).toThrow();
  expect(store.connection('b').tokens).toEqual([]); const id = store.connection('a').tokens[0]!.id;
  expect(store.revoke('b', id)).toBe(false); active.delete('a'); expect(store.tokenOwner(paired.token)).toBeNull(); active.add('a');
  expect(store.revoke('a', id)).toBe(true); expect(store.tokenOwner(paired.token)).toBeNull(); db.close();
});
it('rejects payload size, rates and authority changes before storage', async () => {
  const { store, db } = setup();
  await expect(store.ingest('a', { text: 'x'.repeat(26 * 1024 * 1024) }, () => true)).rejects.toMatchObject({ status: 413 });
  await expect(store.ingest('a', { text: 'secret' }, () => false)).rejects.toMatchObject({ status: 401 });
  expect(await store.list('a')).toEqual([]);
  let limited = false;
  for (let i = 0; i < 65; i++) { try { await store.ingest('a', { text: 'rate' }, () => true); } catch (error) { expect(error).toMatchObject({ status: 429 }); limited = true; break; } }
  expect(limited).toBe(true); expect((await store.ingest('b', { text: 'other' }, () => true)).deduped).toBe(false); db.close();
});
it('accounts for sidecars in quota, persists across reconstruction and rejects symlink substitution', async () => {
  const { createHash } = await import('node:crypto'); const { writeFileSync, truncateSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { store, db } = setup(); const saved = await store.ingest('a', { text: 'persist' }, () => true);
  const hash = createHash('sha256').update('a').digest('hex'); const root = path.join(roots.at(-1)!, 'studio-accounts', hash, 'library');
  const objects = path.join(root, 'objects', 'ff'); mkdirSync(objects, { recursive: true }); const large = path.join(objects, 'quota-fixture');
  writeFileSync(large, ''); truncateSync(large, 256 * 1024 * 1024);
  await expect(store.ingest('a', { text: 'new' }, () => true)).rejects.toMatchObject({ code: 'MULTIUSER_LIBRARY_LIMIT_REACHED' });
  expect((await store.ingest('b', { text: 'new' }, () => true)).asset).toBeTruthy();
  rmSync(large); const reopened = new StudioLibrary({ db, dataRoot: roots.at(-1)!, accountActive: () => true }); expect(await reopened.get('a', saved.asset.id)).toBeTruthy();
  rmSync(objects, { recursive: true }); symlinkSync(path.join(root, '..'), objects);
  await expect(store.ingest('a', { text: 'new' }, () => true)).rejects.toMatchObject({ status: 409 }); db.close();
});
