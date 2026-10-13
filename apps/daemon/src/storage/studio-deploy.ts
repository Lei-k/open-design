import type Database from 'better-sqlite3';
import type {
  StudioDeployProvider,
  StudioDeployConfig,
  StudioDeployFields,
  StudioDeployment,
} from '@open-design/contracts';
import { AccountSecretSealer } from './personal-provider-keys.js';
interface CredentialRow {
  sealed: string | null;
  last4: string | null;
  revision: number;
  fields: string;
}
export class StudioDeployInputError extends Error {
  constructor(readonly status: 400 | 409) {
    super('Deploy settings refused');
  }
}
export class StudioDeployRecordMissing extends Error {}
export class StudioDeployHistoryFull extends Error {}
const FIELDS = [
  'teamId',
  'teamSlug',
  'accountId',
  'projectName',
  'lastZoneId',
  'lastZoneName',
  'lastDomainPrefix',
] as const;
export function studioDeployProvider(value: unknown): StudioDeployProvider {
  if (value === 'vercel' || value === 'vercel-self') return 'vercel';
  if (value === 'cloudflare-pages') return value;
  throw new StudioDeployInputError(400);
}
/** Only sealed tokens and bounded, validated account settings enter persistence; no admin accessor. */
export class StudioDeployStore {
  private sealer: AccountSecretSealer;
  constructor(
    private db: Database.Database,
    dataRoot: string,
  ) {
    this.sealer = new AccountSecretSealer(dataRoot, 'open-design-account-deploy-v1');
    db.exec(`CREATE TABLE IF NOT EXISTS studio_deploy_credentials (
      account_id TEXT NOT NULL, provider TEXT NOT NULL, sealed TEXT, last4 TEXT, revision INTEGER NOT NULL, fields TEXT NOT NULL,
      PRIMARY KEY(account_id, provider));
      CREATE TABLE IF NOT EXISTS studio_deploy_records (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, record TEXT NOT NULL, locator TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_deploy_records_owner ON studio_deploy_records(account_id,project_id);
      CREATE TABLE IF NOT EXISTS studio_deploy_audit (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS studio_deploy_audit_immutable BEFORE UPDATE ON studio_deploy_audit BEGIN SELECT RAISE(ABORT,'audit rows are immutable'); END;`);
  }
  private row(owner: string, provider: StudioDeployProvider): CredentialRow | undefined {
    return this.db
      .prepare('SELECT * FROM studio_deploy_credentials WHERE account_id=? AND provider=?')
      .get(owner, provider) as CredentialRow | undefined;
  }
  read(owner: string, provider: StudioDeployProvider): StudioDeployConfig {
    const row = this.row(owner, provider);
    return {
      providerId: provider,
      configured: Boolean(row?.sealed),
      last4: row?.sealed ? row.last4 : null,
      revision: row?.revision ?? 0,
      ...(row ? (JSON.parse(row.fields) as StudioDeployFields) : {}),
    };
  }
  /** Called only inside the final beforeConnect authority hook. */
  token(owner: string, provider: StudioDeployProvider): string | null {
    return this.sealer.open(owner, provider, this.row(owner, provider)?.sealed);
  }
  update(owner: string, provider: StudioDeployProvider, input: Record<string, unknown>): StudioDeployConfig {
    if (
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some((k) => !['providerId', 'revision', 'token', ...FIELDS].includes(k)) ||
      (input.token !== undefined &&
        input.token !== null &&
        (typeof input.token !== 'string' ||
          input.token.length < 16 ||
          input.token.length > 4096 ||
          /[^\x21-\x7e]/.test(input.token)))
    )
      throw new StudioDeployInputError(400);
    const fields: StudioDeployFields = {};
    for (const field of FIELDS)
      if (input[field] !== undefined) {
        const value = input[field];
        if (typeof value !== 'string' || value.length > 128 || (value && !/^[a-zA-Z0-9_.-]+$/.test(value)))
          throw new StudioDeployInputError(400);
        if (value && field === 'accountId' && !/^[a-f0-9]{32}$/i.test(value))
          throw new StudioDeployInputError(400);
        if (value && field === 'projectName' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value))
          throw new StudioDeployInputError(400);
        fields[field] = value;
      }
    return this.db
      .transaction(() => {
        const row = this.row(owner, provider);
        if ((row?.revision ?? 0) !== input.revision) throw new StudioDeployInputError(409);
        const sealed =
          input.token === null
            ? null
            : typeof input.token === 'string'
              ? this.sealer.seal(owner, provider, input.token)
              : (row?.sealed ?? null);
        const last4 =
          input.token === null ? null : typeof input.token === 'string' ? input.token.slice(-4) : (row?.last4 ?? null);
        const savedFields: StudioDeployFields = {
          ...(row ? (JSON.parse(row.fields) as StudioDeployFields) : {}),
          ...fields,
        };
        if (provider === 'cloudflare-pages' && sealed && !savedFields.accountId) throw new StudioDeployInputError(400);
        const revision = (row?.revision ?? 0) + 1;
        this.db
          .prepare(
            'INSERT INTO studio_deploy_credentials VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,provider) DO UPDATE SET sealed=excluded.sealed,last4=excluded.last4,revision=excluded.revision,fields=excluded.fields',
          )
          .run(owner, provider, sealed, last4, revision, JSON.stringify(savedFields));
        this.db
          .prepare('INSERT INTO studio_deploy_audit(account_id,provider,action,revision,created_at) VALUES(?,?,?,?,?)')
          .run(
            owner,
            provider,
            input.token === null ? 'clear' : typeof input.token === 'string' ? 'set' : 'configure',
            revision,
            Date.now(),
          );
        return this.read(owner, provider);
      })
      .immediate();
  }
  list(owner: string, project: string): StudioDeployment[] {
    return (
      this.db
        .prepare('SELECT record FROM studio_deploy_records WHERE account_id=? AND project_id=? ORDER BY rowid DESC')
        .all(owner, project) as { record: string }[]
    ).map((row) => JSON.parse(row.record) as StudioDeployment);
  }
  get(owner: string, project: string, id: string): StudioDeployment | null {
    return this.list(owner, project).find((row) => row.id === id) ?? null;
  }
  locator(owner: string, project: string, id: string): StudioDeployFields {
    const row = this.db
      .prepare('SELECT locator FROM studio_deploy_records WHERE account_id=? AND project_id=? AND id=?')
      .get(owner, project, id) as { locator: string } | undefined;
    // An absent captured field means the original provider default, never a later account setting.
    return row ? {
      teamId: '', teamSlug: '', accountId: '', projectName: '',
      ...(JSON.parse(row.locator) as StudioDeployFields),
    } : {};
  }
  /** Creation never updates another record. Authority and optional redeploy source are checked atomically. */
  create(
    owner: string,
    row: StudioDeployment,
    locator: StudioDeployFields,
    authorize: () => void,
    sourceId?: string,
  ): void {
    this.db.transaction(() => {
      if (sourceId && !this.get(owner, row.projectId, sourceId)) throw new StudioDeployRecordMissing();
      authorize();
      if (this.list(owner, row.projectId).length >= 100) throw new StudioDeployHistoryFull();
      this.db.prepare('INSERT INTO studio_deploy_records VALUES(?,?,?,?,?)')
        .run(row.id, owner, row.projectId, JSON.stringify(row), JSON.stringify(locator));
    }).immediate();
  }
  /** Refresh is UPDATE-only: deletion is final and the captured locator remains immutable. */
  updateRecord(owner: string, row: StudioDeployment, authorize: () => void): void {
    this.db.transaction(() => {
      if (!this.get(owner, row.projectId, row.id)) throw new StudioDeployRecordMissing();
      authorize();
      this.db.prepare('UPDATE studio_deploy_records SET record=? WHERE id=? AND account_id=? AND project_id=?')
        .run(JSON.stringify(row), row.id, owner, row.projectId);
    }).immediate();
  }
  delete(owner: string, project: string, id: string): void {
    this.db
      .prepare('DELETE FROM studio_deploy_records WHERE account_id=? AND project_id=? AND id=?')
      .run(owner, project, id);
  }
}
