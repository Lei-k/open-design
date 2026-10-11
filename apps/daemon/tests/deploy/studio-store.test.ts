import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { StudioDeployStore } from '../../src/storage/studio-deploy.js';
it('account/provider/purpose sealing refuses copied ciphertext and configuration sizes are bounded', () => {
  const root = mkdtempSync(path.join(tmpdir(), 's63-store-'));
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');
    const store = new StudioDeployStore(db, root);
    const token = 'S63-storage-private-token-1283';
    store.update('a', 'vercel', { revision: 0, token });
    expect(store.token('a', 'vercel')).toBe(token);
    const row = db.prepare('SELECT sealed FROM studio_deploy_credentials WHERE account_id=?').get('a') as {
      sealed: string;
    };
    db.prepare('INSERT INTO studio_deploy_credentials VALUES(?,?,?,?,?,?)').run(
      'b',
      'vercel',
      row.sealed,
      '1283',
      1,
      '{}',
    );
    expect(store.token('b', 'vercel')).toBeNull();
    db.prepare('INSERT INTO studio_deploy_credentials VALUES(?,?,?,?,?,?)').run(
      'a',
      'cloudflare-pages',
      row.sealed,
      '1283',
      1,
      '{}',
    );
    expect(store.token('a', 'cloudflare-pages')).toBeNull();
    for (const input of [
      { revision: 1, token: 'x'.repeat(4097) },
      { revision: 1, token: 'short' },
      { revision: 1, teamId: 'x'.repeat(129) },
      { revision: 1, teamId: '../private' },
      { revision: 1, token: token + '\r\n' },
    ])
      expect(() => store.update('a', 'vercel', input)).toThrow();
    expect(() => store.update('b', 'cloudflare-pages', { revision: 0, token })).toThrow();
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});
