import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CompanyOpenAIConfig, UpdateCompanyOpenAIConfigRequest } from '@open-design/contracts';

interface Row { revision: number; credential_revision: number; enabled: number; model: string; capacity: number; credential: string | null }
export class CompanyOpenAIConfigError extends Error {
  constructor(readonly status: 400 | 409) { super('Company provider configuration refused'); }
}

/** Company key custody is independent from both host settings and personal
 * subscriptions. SQLite stores authenticated ciphertext; the 0600 key file
 * derives exclusively from the resolved daemon data root. */
export class CompanyOpenAIStore {
  private readonly key: Buffer;
  constructor(private readonly db: Database.Database, dataRoot: string) {
    const dir = path.join(dataRoot, 'company-providers');
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('Invalid company credential directory');
    chmodSync(dir, 0o700);
    const file = path.join(dir, 'encryption.key');
    try {
      const created = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(created, randomBytes(32)); } finally { closeSync(created); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Invalid company encryption key');
      this.key = readFileSync(fd);
    } finally { closeSync(fd); }
    db.exec(`CREATE TABLE IF NOT EXISTS company_openai_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL,
      credential_revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
      model TEXT NOT NULL, capacity INTEGER NOT NULL, credential TEXT
    );
    INSERT OR IGNORE INTO company_openai_config VALUES (1, 0, 0, 0, '', 0, NULL);
    CREATE TABLE IF NOT EXISTS company_openai_audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, revision INTEGER NOT NULL,
      credential_changed INTEGER NOT NULL, enabled INTEGER NOT NULL,
      capacity INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS company_openai_audit_immutable BEFORE UPDATE ON company_openai_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS company_openai_audit_no_delete BEFORE DELETE ON company_openai_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }
  private row(): Row { return this.db.prepare('SELECT * FROM company_openai_config WHERE singleton = 1').get() as Row; }
  private summary(row: Row): CompanyOpenAIConfig {
    return { providerId: 'openai', configured: row.credential !== null, enabled: Boolean(row.enabled),
      model: row.model, capacity: row.capacity, revision: row.revision, credentialRevision: row.credential_revision };
  }
  read(): CompanyOpenAIConfig { return this.summary(this.row()); }
  enabled(): boolean { const row = this.row(); return Boolean(row.enabled && row.credential && row.model); }
  available(): boolean { const row = this.row(); return Boolean(row.enabled && row.credential && row.capacity > 0 && row.model); }
  private encrypt(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('open-design-company-openai-v1'));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  execution(): { config: CompanyOpenAIConfig; apiKey: string } | null {
    const row = this.row(); if (!row.enabled || !row.credential || !row.model || row.capacity === 0) return null;
    const bytes = Buffer.from(row.credential, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('open-design-company-openai-v1')); decipher.setAuthTag(bytes.subarray(12, 28));
    const apiKey = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    return { config: this.summary(row), apiKey };
  }
  update(actorId: string, input: UpdateCompanyOpenAIConfigRequest): CompanyOpenAIConfig {
    if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.enabled !== 'boolean'
      || typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.model)
      || !Number.isSafeInteger(input.capacity) || input.capacity < 0 || input.capacity > 16
      || input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 16 || input.apiKey.length > 4096)
      || Object.keys(input).some((key) => !['revision', 'enabled', 'model', 'capacity', 'apiKey'].includes(key))) throw new CompanyOpenAIConfigError(400);
    return this.db.transaction(() => {
      const previous = this.row(); if (previous.revision !== input.revision) throw new CompanyOpenAIConfigError(409);
      const credentialChanged = input.apiKey !== undefined;
      const credential = input.apiKey === undefined ? previous.credential : input.apiKey === null ? null : this.encrypt(input.apiKey.trim());
      if (input.enabled && credential === null) throw new CompanyOpenAIConfigError(400);
      const revision = previous.revision + 1;
      this.db.prepare(`UPDATE company_openai_config SET revision = ?, credential_revision = ?, enabled = ?, model = ?, capacity = ?, credential = ? WHERE singleton = 1`)
        .run(revision, previous.credential_revision + Number(credentialChanged), Number(input.enabled), input.model, input.capacity, credential);
      this.db.prepare('INSERT INTO company_openai_audit (actor_id, revision, credential_changed, enabled, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actorId, revision, Number(credentialChanged), Number(input.enabled), input.capacity, Date.now());
      return this.read();
    }).immediate();
  }
}
