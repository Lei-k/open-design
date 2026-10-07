import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { runSseEventToPersistedAgentEvent } from '../runtimes/chat-run-messages.js';
import { serializeRunEventsForStorage } from '../runtimes/run-event-payload-budget.js';
import { getMessage, upsertMessage } from '../db.js';
import { PROJECT_OWNERS_TABLE } from './project-ownership.js';

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
      user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
    );
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

  ids(runId: string): { userMessageId: string; assistantMessageId: string } {
    const digest = createHash('sha256').update(runId).digest('hex');
    return { userMessageId: `mu_user_${digest}`, assistantMessageId: `mu_assistant_${digest}` };
  }

  reconcile(run: StudioRunMessageInput): void {
    const ids = this.ids(run.id);
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
