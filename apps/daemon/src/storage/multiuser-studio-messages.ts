import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { runSseEventToPersistedAgentEvent } from '../runtimes/chat-run-messages.js';
import { serializeRunEventsForStorage } from '../runtimes/run-event-payload-budget.js';
import { appendMessageAgentEvents, clearMessageAgentEventBatches, getMessage, upsertMessage } from '../db.js';
import { PROJECT_OWNERS_TABLE } from './project-ownership.js';

export interface StudioTurnIds { userMessageId: string; assistantMessageId: string }

export interface StudioRunMessageInput {
  id: string;
  owner_account_id: string;
  project_id: string;
  conversation_id: string;
  status: 'queued' | 'active' | 'succeeded' | 'failed' | 'canceled';
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  execution_source: 'personal_subscription' | 'company_pool';
  request_json: string | null;
  output: string | null;
}

/** Fixed, observable recovery codes (#72). A recorded row is skipped, never retried on every boot. */
export type MultiUserRecoveryIssue = 'MULTIUSER_STUDIO_BINDING_CONFLICT' | 'MULTIUSER_STUDIO_PROJECTION_FAILED' | 'MULTIUSER_LEDGER_ENTRY_MISSING';
/** Only a binding conflict quarantines; a failed projection is recorded and retried on the next boot. */
const QUARANTINED = (runId: string) => `SELECT 1 FROM multiuser_recovery_issues i WHERE i.run_id = ${runId} AND i.code = 'MULTIUSER_STUDIO_BINDING_CONFLICT'`;

/** #54/#55: run admission and the standard transcript share the main DB transaction. */
export class MultiUserStudioMessages {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS multiuser_studio_turns (
      run_id TEXT PRIMARY KEY REFERENCES multiuser_runs(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
    );`);
    // S4 (additive): a retry is another run answering the same user turn, so a
    // user row may back several runs. Rebuild an S3 table that still carries
    // UNIQUE(user_message_id); every binding row is copied unchanged.
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiuser_studio_turns'").get() as { sql: string }).sql;
    if (/user_message_id TEXT NOT NULL UNIQUE/.test(ddl)) {
      db.transaction(() => {
        db.exec(`DROP TRIGGER IF EXISTS multiuser_studio_turns_immutable;
          CREATE TABLE multiuser_studio_turns_next (
            run_id TEXT PRIMARY KEY REFERENCES multiuser_runs(id) ON DELETE CASCADE,
            user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
          );
          INSERT INTO multiuser_studio_turns_next (run_id, user_message_id, assistant_message_id)
            SELECT run_id, user_message_id, assistant_message_id FROM multiuser_studio_turns;
          DROP TABLE multiuser_studio_turns;
          ALTER TABLE multiuser_studio_turns_next RENAME TO multiuser_studio_turns;`);
      }).immediate();
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_multiuser_studio_turns_user ON multiuser_studio_turns(user_message_id);
    CREATE TRIGGER IF NOT EXISTS multiuser_studio_turns_immutable BEFORE UPDATE ON multiuser_studio_turns
      BEGIN SELECT RAISE(ABORT, 'Studio turn binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_recovery_issues (
      run_id TEXT NOT NULL REFERENCES multiuser_runs(id) ON DELETE CASCADE,
      code TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, code)
    );`);
    // #39 compatibility is additive and idempotent. Unbound or damaged parent
    // rows are never claimed; the legacy run/event tables remain intact.
    // #72: only rows that can still change are visited — unfinished, unbound,
    // or a transcript cursor behind its durable frames — so a boot costs the
    // live work, not every run ever stored. Each row is its own unit: one
    // damaged row is quarantined and never blocks another account or startup.
    const events = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'multiuser_run_events'").get();
    const rows = db.prepare(`SELECT r.* FROM multiuser_runs r
      JOIN ${PROJECT_OWNERS_TABLE} o ON o.project_id = r.project_id AND o.owner_account_id = r.owner_account_id
      JOIN conversations c ON c.id = r.conversation_id AND c.project_id = r.project_id
      LEFT JOIN multiuser_studio_turns t ON t.run_id = r.id
      WHERE NOT EXISTS (${QUARANTINED('r.id')}) AND (r.status IN ('queued', 'active') OR t.run_id IS NULL${events ? `
        OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = t.assistant_message_id AND COALESCE(m.last_run_event_id, '')
          = COALESCE((SELECT CAST(MAX(e.seq) AS TEXT) FROM multiuser_run_events e WHERE e.run_id = r.id), ''))` : ''})
      ORDER BY r.created_at, r.queue_seq, r.id`).all() as StudioRunMessageInput[];
    for (const run of rows) this.reconcile(run);
  }

  /** Durable, idempotent and logged once with a fixed code; never carries row content. */
  recordIssue(runId: string, code: MultiUserRecoveryIssue): void {
    if (this.db.prepare('INSERT OR IGNORE INTO multiuser_recovery_issues (run_id, code, created_at) VALUES (?, ?, ?)').run(runId, code, Date.now()).changes) {
      console.warn(`[od] multiuser_recovery code=${code} runId=${runId}`);
    }
  }

  /** The stored binding wins; unbound legacy runs keep their derived ids. */
  ids(runId: string): StudioTurnIds {
    const bound = this.db.prepare('SELECT user_message_id AS userMessageId, assistant_message_id AS assistantMessageId FROM multiuser_studio_turns WHERE run_id = ?')
      .get(runId) as StudioTurnIds | undefined;
    if (bound) return bound;
    const digest = createHash('sha256').update(runId).digest('hex');
    return { userMessageId: `mu_user_${digest}`, assistantMessageId: `mu_assistant_${digest}` };
  }

  /** The newest run bound to `userMessageId` in this conversation, if any. */
  runForUserMessage(conversationId: string, userMessageId: string): string | null {
    return (this.db.prepare(`SELECT t.run_id AS id FROM multiuser_studio_turns t JOIN multiuser_runs r ON r.id = t.run_id
      WHERE t.user_message_id = ? AND r.conversation_id = ? ORDER BY r.queue_seq DESC LIMIT 1`).get(userMessageId, conversationId) as { id: string } | undefined)?.id ?? null;
  }

  /**
   * Project one run into its standard transcript pair. False when the run is
   * (or just became) quarantined: its durable frames and SSE stay intact, only
   * the transcript projection is withheld. Never throws into the run engine.
   * `proposed` ids are honored only on the run's first projection (admission),
   * after the caller has checked them against the actor's namespace;
   * afterwards the stored binding is final.
   */
  reconcile(run: StudioRunMessageInput, proposed?: StudioTurnIds): boolean {
    if (this.db.prepare(QUARANTINED('?')).get(run.id)) return false;
    const bound = this.db.prepare('SELECT 1 FROM multiuser_studio_turns WHERE run_id = ?').get(run.id);
    const ids = bound || !proposed ? this.ids(run.id) : proposed;
    // This guard also protects a restored database with corrupted turn ids.
    if ([ids.userMessageId, ids.assistantMessageId].some((id) => this.db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id IS NOT ?').get(id, run.conversation_id))) {
      this.recordIssue(run.id, 'MULTIUSER_STUDIO_BINDING_CONFLICT');
      return false;
    }
    try { this.db.transaction(() => this.project(run, ids))(); return true; }
    catch { this.recordIssue(run.id, 'MULTIUSER_STUDIO_PROJECTION_FAILED'); return false; }
  }

  private project(run: StudioRunMessageInput, ids: StudioTurnIds): void {
    const parse = (raw: string | null): Record<string, unknown> => {
      try { const value: unknown = JSON.parse(raw ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
      catch { return {}; }
    };
    const request = parse(run.request_json);
    const output = parse(run.output);
    const stored = getMessage(this.db, ids.assistantMessageId, run.conversation_id);
    const hasEvents = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'multiuser_run_events'").get();
    const frames = hasEvents ? this.db.prepare('SELECT seq, event, data FROM multiuser_run_events WHERE run_id = ? ORDER BY seq').all(run.id) as Array<{ seq: number; event: string; data: string }> : [];
    const events = frames.map((frame) => runSseEventToPersistedAgentEvent(frame.event, parse(frame.data))).filter((event) => event !== null);
    const text = events.filter((event) => event.kind === 'text').map((event) => event.text).join('');
    const terminal = run.status !== 'active' && run.status !== 'queued';
    if (!getMessage(this.db, ids.userMessageId, run.conversation_id)) {
      const attachments = Array.isArray(request.attachments) ? request.attachments.filter((value): value is string => typeof value === 'string') : [];
      upsertMessage(this.db, run.conversation_id, {
        id: ids.userMessageId, role: 'user', content: typeof request.message === 'string' ? request.message : '', createdAt: run.created_at,
        ...(attachments.length ? { attachments: attachments.map((file, order) => ({ path: file, name: file.split('/').at(-1) ?? file,
          kind: /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file) ? 'image' as const : 'file' as const, order })) } : {}),
      });
    }
    upsertMessage(this.db, run.conversation_id, {
      ...stored,
      id: ids.assistantMessageId, role: 'assistant', runId: run.id,
      agentId: run.execution_source === 'personal_subscription' ? 'codex' : 'test-mock',
      content: frames.some((frame) => frame.event === 'agent' && parse(frame.data).type === 'text_delta') ? text : typeof output.text === 'string' ? output.text : stored?.content ?? '',
      ...(frames.length ? { events, lastRunEventId: String(frames.at(-1)!.seq) } : {}),
      runStatus: run.status === 'active' ? 'running' : run.status,
      createdAt: run.created_at,
      ...(run.started_at === null ? {} : { startedAt: run.started_at }),
      ...(terminal ? { endedAt: run.ended_at ?? run.updated_at } : {}),
      ...(Array.isArray(output.files) ? { producedFiles: output.files } : {}),
    });
    // upsertMessage protects active daemon events from browser snapshots. This
    // is the owning daemon's durable projection, so update its active snapshot
    // explicitly as well; otherwise a mid-run reload has a cursor but no events.
    if (frames.length) {
      this.db.prepare('UPDATE messages SET events_json = ?, content = ? WHERE id = ? AND conversation_id = ?')
        .run(serializeRunEventsForStorage(events), text || (typeof output.text === 'string' ? output.text : stored?.content ?? ''), ids.assistantMessageId, run.conversation_id);
    }
    // The rebuild above already contains every incrementally appended frame.
    clearMessageAgentEventBatches(this.db, ids.assistantMessageId);
    this.db.prepare(`INSERT OR IGNORE INTO multiuser_studio_turns (run_id, user_message_id, assistant_message_id) VALUES (?, ?, ?)`)
      .run(run.id, ids.userMessageId, ids.assistantMessageId);
  }

  /**
   * #76: the per-frame path between lifecycle edges. One durable frame costs
   * one append-only batch row plus a cursor bump — the standard daemon's own
   * active-run storage — never a re-read of the run's earlier frames. The
   * next `reconcile` (start, terminal, startup) folds batches into the rebuild.
   * An unbound (quarantined or not yet projected) run is left to `reconcile`.
   */
  append(runId: string, conversationId: string, seq: number, event: string, data: unknown): void {
    const bound = this.db.prepare('SELECT assistant_message_id AS id FROM multiuser_studio_turns WHERE run_id = ?').get(runId) as { id: string } | undefined;
    if (!bound) return;
    const persisted = runSseEventToPersistedAgentEvent(event, data);
    if (persisted) appendMessageAgentEvents(this.db, bound.id, [persisted]);
    this.db.prepare('UPDATE messages SET last_run_event_id = ? WHERE id = ? AND conversation_id = ?').run(String(seq), bound.id, conversationId);
  }
}
