import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { runSseEventToPersistedAgentEvent } from '../runtimes/chat-run-messages.js';
import { serializeRunEventsForStorage } from '../runtimes/run-event-payload-budget.js';
import { getMessage, upsertMessage } from '../db.js';
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
      BEGIN SELECT RAISE(ABORT, 'Studio turn binding is immutable'); END;`);
    // #39 compatibility is additive and idempotent. Unbound or damaged parent
    // rows are never claimed; the legacy run/event tables remain intact.
    db.transaction(() => {
      const rows = db.prepare(`SELECT r.* FROM multiuser_runs r
        JOIN ${PROJECT_OWNERS_TABLE} o ON o.project_id = r.project_id AND o.owner_account_id = r.owner_account_id
        JOIN conversations c ON c.id = r.conversation_id AND c.project_id = r.project_id
        ORDER BY r.created_at, r.queue_seq, r.id`).all() as StudioRunMessageInput[];
      for (const run of rows) this.reconcile(run);
    })();
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
   * Project a run into its transcript turn. `proposed` ids are honored only on
   * the run's first projection (admission), after the caller has checked them
   * against the actor's namespace; afterwards the stored binding is final.
   */
  reconcile(run: StudioRunMessageInput, proposed?: StudioTurnIds): void {
    const bound = this.db.prepare('SELECT 1 FROM multiuser_studio_turns WHERE run_id = ?').get(run.id);
    const ids = bound || !proposed ? this.ids(run.id) : proposed;
    const parse = (raw: string | null): Record<string, unknown> => {
      try { const value: unknown = JSON.parse(raw ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
      catch { return {}; }
    };
    const request = parse(run.request_json);
    const output = parse(run.output);
    const stored = getMessage(this.db, ids.assistantMessageId, run.conversation_id);
    // This guard also protects a restored database with corrupted turn ids.
    for (const id of [ids.userMessageId, ids.assistantMessageId]) {
      if (getMessage(this.db, id) && !getMessage(this.db, id, run.conversation_id)) throw new Error('Studio message binding conflict');
    }
    const hasEvents = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'multiuser_run_events'").get();
    const frames = hasEvents ? this.db.prepare('SELECT seq, event, data FROM multiuser_run_events WHERE run_id = ? ORDER BY seq').all(run.id) as Array<{ seq: number; event: string; data: string }> : [];
    const events = frames.map((frame) => runSseEventToPersistedAgentEvent(frame.event, parse(frame.data))).filter((event) => event !== null);
    const text = events.filter((event) => event.kind === 'text').map((event) => event.text).join('');
    const terminal = run.status !== 'active' && run.status !== 'queued';
    if (!getMessage(this.db, ids.userMessageId, run.conversation_id)) {
      upsertMessage(this.db, run.conversation_id, {
        id: ids.userMessageId, role: 'user', content: typeof request.message === 'string' ? request.message : '', createdAt: run.created_at,
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
    this.db.prepare(`INSERT OR IGNORE INTO multiuser_studio_turns (run_id, user_message_id, assistant_message_id) VALUES (?, ?, ?)`)
      .run(run.id, ids.userMessageId, ids.assistantMessageId);
  }
}
