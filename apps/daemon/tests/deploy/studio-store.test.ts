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

it('validates provider path fields before persistence, allowing only canonical Cloudflare IDs and Pages names', () => {
  const root = mkdtempSync(path.join(tmpdir(), 's64-store-'));
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)');
    const store = new StudioDeployStore(db, root);
    for (const field of ['accountId', 'projectName'])
      for (const value of ['.', '..', '%2e', '%2E%2e', 'a/b', 'a\\b', 'a?b', 'a#b'])
        expect(() => store.update('a', 'cloudflare-pages', { revision: 0, [field]: value })).toThrow();
    for (const accountId of ['short', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)])
      expect(() => store.update('a', 'cloudflare-pages', { revision: 0, accountId })).toThrow();
    for (const projectName of ['UPPER', 'a_b', '-site', 'a.b', 'a'.repeat(64)])
      expect(() => store.update('a', 'cloudflare-pages', { revision: 0, projectName })).toThrow();
    expect(store.update('a', 'cloudflare-pages', { revision: 0, accountId: 'ABCDEF0123456789'.repeat(2), projectName: 'site-123' }))
      .toMatchObject({ revision: 1, projectName: 'site-123' });
    expect(store.update('a', 'cloudflare-pages', { revision: 1, projectName: '' }).projectName).toBe('');
  } finally { db.close(); rmSync(root, { recursive: true }); }
});
