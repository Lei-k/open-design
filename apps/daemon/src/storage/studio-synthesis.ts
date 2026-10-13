import type Database from 'better-sqlite3';
import type { StudioSynthesisAction, StudioSynthesisResult } from '@open-design/contracts';

/** Project-owned receipts and actor-attributed provider usage; no credentials or raw errors. */
export class StudioSynthesisStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_synthesis_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, action TEXT NOT NULL, execution_source TEXT NOT NULL,
      status TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ended_at INTEGER,
      result_json TEXT, output_sha256 TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_synthesis_project ON studio_synthesis_jobs(project_id, created_at);
    UPDATE studio_synthesis_jobs SET status = 'canceled', ended_at = created_at WHERE status = 'active';`);
    const columns = db.prepare('PRAGMA table_info(studio_synthesis_jobs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'output_sha256')) db.exec('ALTER TABLE studio_synthesis_jobs ADD COLUMN output_sha256 TEXT');
  }
  start(input: { id: string; projectId: string; accountId: string; action: StudioSynthesisAction; executionSource: string; model: string }) {
    this.db.prepare(`INSERT INTO studio_synthesis_jobs (id,project_id,account_id,action,execution_source,status,model,created_at)
      VALUES (?,?,?,?,?,'active',?,?)`).run(input.id, input.projectId, input.accountId, input.action, input.executionSource, input.model, Date.now());
  }
  usage(id: string, inputTokens: number, outputTokens: number): void {
    this.db.prepare('UPDATE studio_synthesis_jobs SET input_tokens = ?, output_tokens = ? WHERE id = ?')
      .run(inputTokens, outputTokens, id);
  }
  settle(id: string, result?: StudioSynthesisResult, outputSha256?: string): void {
    this.db.prepare('UPDATE studio_synthesis_jobs SET status = ?, ended_at = ?, result_json = ?, output_sha256 = ? WHERE id = ?')
      .run(result ? 'succeeded' : 'failed', Date.now(), result ? JSON.stringify(result) : null, outputSha256 ?? null, id);
  }
  results(projectId: string, digest: string, outputDigests: Readonly<Record<string, string>>): Partial<Record<StudioSynthesisAction, StudioSynthesisResult>> {
    const results: Partial<Record<StudioSynthesisAction, StudioSynthesisResult>> = {};
    for (const action of ['finalize', 'handoff'] as const) {
      const row = this.db.prepare(`SELECT result_json, output_sha256 FROM studio_synthesis_jobs WHERE project_id = ? AND action = ? AND status = 'succeeded'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId, action) as { result_json: string; output_sha256: string | null } | undefined;
      if (!row) continue;
      const result = JSON.parse(row.result_json) as StudioSynthesisResult;
      results[action] = { ...result, current: result.digest === digest && row.output_sha256 !== null && row.output_sha256 === outputDigests[result.fileName] };
    }
    return results;
  }
}
