import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { migrateLibrary, listLibraryAssets } from '../src/library-store.js';
import { registerLibraryAsset } from '../src/library.js';
it('rechecks account authority before any byte or registry write', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'library-authority-')); const db = new Database(':memory:'); migrateLibrary(db);
  try {
    await expect(registerLibraryAsset({ db, libraryDir: root, storage: 'owned', text: 'MUST_NOT_STORE', source: { sourceKind: 'clipper' },
      authorize: () => { throw new Error('authority lost'); } })).rejects.toThrow('authority lost');
    expect(listLibraryAssets(db)).toEqual([]); expect(readdirSync(root)).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
