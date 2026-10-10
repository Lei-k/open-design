import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  STUDIO_PROVIDER_KEY_MODEL_PATTERN, STUDIO_PROVIDER_KEY_PROVIDERS, type StudioProviderKeyProvider, type StudioProviderKeySummary, type UpdateStudioProviderKeyRequest,
} from '@open-design/contracts';

export const PERSONAL_PROVIDER_KEYS_TABLE = 'multiuser_personal_provider_keys';
export const PERSONAL_PROVIDER_DEFAULT_MODEL = 'gpt-5.1';
const AAD = 'open-design-personal-provider-v1';

interface Row {
  account_id: string; provider: StudioProviderKeyProvider; credential: string | null; last4: string | null;
  model: string; revision: number; credential_revision: number; updated_at: number;
}
export class PersonalProviderKeyError extends Error {
  constructor(readonly status: 400 | 409) { super('Personal provider key refused'); }
}

/**
 * Read the deployment master key. An operator-supplied `OD_CREDENTIAL_MASTER_KEY`
 * (32 bytes, base64 or hex) wins, so the key can live outside the data volume;
 * otherwise a 0600 key file is generated once under the resolved data root.
 */
function masterKey(dataRoot: string, configured: string | undefined): Buffer {
  if (configured !== undefined && configured.trim()) {
    const value = configured.trim();
    const bytes = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    if (bytes.length !== 32) throw new Error('OD_CREDENTIAL_MASTER_KEY must be 32 bytes (base64 or hex)');
    return bytes;
  }
  const dir = path.join(dataRoot, 'personal-providers');
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('Invalid personal credential directory');
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'master.key');
  try {
    const created = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(created, randomBytes(32)); } finally { closeSync(created); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) {
      throw new Error('Invalid personal credential master key');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Account-private secrets other than provider keys (S60: remote MCP header
 * values, OAuth tokens and pending authorizations), sealed exactly like the
 * provider keys below: the same deployment master key, an HKDF-SHA256 subkey
 * per account under this sealer's own label, and AES-256-GCM authenticated
 * against the account and the caller's purpose. Ciphertext copied to another
 * account, label or purpose fails to open.
 */
export class AccountSecretSealer {
  private readonly master: Buffer;
  constructor(dataRoot: string, private readonly label: string, configuredMasterKey = process.env.OD_CREDENTIAL_MASTER_KEY) {
    if (!/^open-design-[a-z0-9-]+-v\d+$/.test(label) || label === AAD) throw new Error('invalid account secret label');
    this.master = masterKey(dataRoot, configuredMasterKey);
  }
  private subkey(accountId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.from(accountId, 'utf8'), Buffer.from(this.label), 32));
  }
  seal(accountId: string, purpose: string, plaintext: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.subkey(accountId), iv);
    cipher.setAAD(Buffer.from(`${this.label}:${purpose}:${accountId}`));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  /** Null when absent or not openable for this account and purpose. */
  open(accountId: string, purpose: string, sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    try {
      const bytes = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.subkey(accountId), bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${this.label}:${purpose}:${accountId}`)); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { return null; }
  }
}

/**
 * Account-private provider API keys (#62/#63). Each account's ciphertext is
 * sealed with a key derived from the deployment master key and the account id,
 * and authenticated against the account and provider, so a row copied to
 * another account fails to open. No route returns the key: reads expose only
 * whether one is configured and its last four characters, and admin surfaces
 * never read this table. The audit records actions, never values.
 */
export class PersonalProviderKeyStore {
  private readonly master: Buffer;
  constructor(private readonly db: Database.Database, dataRoot: string, configuredMasterKey = process.env.OD_CREDENTIAL_MASTER_KEY) {
    this.master = masterKey(dataRoot, configuredMasterKey);
    const columns = `account_id TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('openai', 'tavily')),
      credential TEXT, last4 TEXT, model TEXT NOT NULL, revision INTEGER NOT NULL,
      credential_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, provider)`;
    // One-time widening of the S33 provider CHECK (#63 research keys); rows, ciphertext and revisions are kept.
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(PERSONAL_PROVIDER_KEYS_TABLE) as { sql: string } | undefined;
    if (existing && !existing.sql.includes("'tavily'")) {
      db.transaction(() => {
        db.exec(`CREATE TABLE ${PERSONAL_PROVIDER_KEYS_TABLE}_next (${columns});
          INSERT INTO ${PERSONAL_PROVIDER_KEYS_TABLE}_next SELECT account_id, provider, credential, last4, model, revision, credential_revision, updated_at FROM ${PERSONAL_PROVIDER_KEYS_TABLE};
          DROP TABLE ${PERSONAL_PROVIDER_KEYS_TABLE};
          ALTER TABLE ${PERSONAL_PROVIDER_KEYS_TABLE}_next RENAME TO ${PERSONAL_PROVIDER_KEYS_TABLE};`);
      }).immediate();
    }
    db.exec(`CREATE TABLE IF NOT EXISTS ${PERSONAL_PROVIDER_KEYS_TABLE} (${columns});
    CREATE TABLE IF NOT EXISTS multiuser_personal_provider_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, provider TEXT NOT NULL,
      action TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_personal_provider_audit_immutable BEFORE UPDATE ON multiuser_personal_provider_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }
  private subkey(accountId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.from(accountId, 'utf8'), Buffer.from(AAD), 32));
  }
  private aad(accountId: string, provider: string) { return Buffer.from(`${AAD}:${provider}:${accountId}`); }
  private row(accountId: string, provider: StudioProviderKeyProvider): Row | undefined {
    return this.db.prepare(`SELECT * FROM ${PERSONAL_PROVIDER_KEYS_TABLE} WHERE account_id = ? AND provider = ?`).get(accountId, provider) as Row | undefined;
  }
  private summary(provider: StudioProviderKeyProvider, row: Row | undefined): StudioProviderKeySummary {
    return { provider, configured: Boolean(row?.credential), last4: row?.credential ? row.last4 : null,
      model: provider === 'openai' ? row?.model ?? PERSONAL_PROVIDER_DEFAULT_MODEL : '', revision: row?.revision ?? 0,
      credentialRevision: row?.credential_revision ?? 0, updatedAt: row?.updated_at ?? null };
  }
  read(accountId: string, provider: StudioProviderKeyProvider = 'openai'): StudioProviderKeySummary {
    return this.summary(provider, this.row(accountId, provider));
  }
  list(accountId: string): StudioProviderKeySummary[] { return STUDIO_PROVIDER_KEY_PROVIDERS.map((provider) => this.read(accountId, provider)); }
  configured(accountId: string, provider: StudioProviderKeyProvider = 'openai'): boolean { return Boolean(this.row(accountId, provider)?.credential); }

  /** The decrypted key, for a worker the account itself admitted. Null when absent or unreadable. */
  execution(accountId: string, provider: StudioProviderKeyProvider = 'openai'): { apiKey: string; model: string; credentialRevision: number } | null {
    const row = this.row(accountId, provider);
    if (!row?.credential) return null;
    try {
      const bytes = Buffer.from(row.credential, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.subkey(accountId), bytes.subarray(0, 12));
      decipher.setAAD(this.aad(accountId, provider)); decipher.setAuthTag(bytes.subarray(12, 28));
      const apiKey = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
      return { apiKey, model: row.model, credentialRevision: row.credential_revision };
    } catch { return null; }
  }

  update(accountId: string, provider: StudioProviderKeyProvider, input: UpdateStudioProviderKeyRequest, at = Date.now()): { summary: StudioProviderKeySummary; credentialChanged: boolean } {
    if (!(STUDIO_PROVIDER_KEY_PROVIDERS as readonly string[]).includes(provider)
      || !input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.revision) || input.revision < 0
      // Only the OpenAI key has a model choice.
      || input.model !== undefined && (provider !== 'openai' || typeof input.model !== 'string' || !STUDIO_PROVIDER_KEY_MODEL_PATTERN.test(input.model))
      || input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 16
        || input.apiKey.length > 4096 || /\s/.test(input.apiKey.trim()))
      || Object.keys(input).some((key) => !['revision', 'apiKey', 'model'].includes(key))) throw new PersonalProviderKeyError(400);
    return this.db.transaction(() => {
      const previous = this.row(accountId, provider);
      if ((previous?.revision ?? 0) !== input.revision) throw new PersonalProviderKeyError(409);
      const credentialChanged = input.apiKey !== undefined;
      let credential = previous?.credential ?? null;
      let last4 = previous?.last4 ?? null;
      if (input.apiKey === null) { credential = null; last4 = null; }
      else if (typeof input.apiKey === 'string') {
        const value = input.apiKey.trim();
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.subkey(accountId), iv);
        cipher.setAAD(this.aad(accountId, provider));
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        credential = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        last4 = value.slice(-4);
      }
      const revision = (previous?.revision ?? 0) + 1;
      const credentialRevision = (previous?.credential_revision ?? 0) + Number(credentialChanged);
      this.db.prepare(`INSERT INTO ${PERSONAL_PROVIDER_KEYS_TABLE} (account_id, provider, credential, last4, model, revision, credential_revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, provider) DO UPDATE SET credential = excluded.credential, last4 = excluded.last4,
        model = excluded.model, revision = excluded.revision, credential_revision = excluded.credential_revision, updated_at = excluded.updated_at`)
        .run(accountId, provider, credential, last4, provider === 'openai' ? input.model ?? previous?.model ?? PERSONAL_PROVIDER_DEFAULT_MODEL : '', revision, credentialRevision, at);
      const action = input.apiKey === null ? 'key_removed' : credentialChanged ? (previous?.credential ? 'key_replaced' : 'key_added') : 'model_changed';
      this.db.prepare('INSERT INTO multiuser_personal_provider_audit (account_id, provider, action, revision, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(accountId, provider, action, revision, at);
      return { summary: this.read(accountId, provider), credentialChanged };
    }).immediate();
  }
}
