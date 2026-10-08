import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  STUDIO_MEMORY_HISTORY_LIMIT, STUDIO_MEMORY_MAX_ENTRIES,
  type MemoryEntry, type MemoryExtractionRecord, type MemoryVerifyRecord,
} from '@open-design/contracts';
import type { StudioSettings } from '../storage/studio-settings.js';
import { composeMemoryBody, heuristicMemoryDrafts, listMemoryEntries, readMemoryConfig, readMemoryEntry } from '../memory.js';
import {
  MEMORY_EXTRACTION_SYSTEM_PROMPT, memoryCandidateKnown, memoryDraftFromCandidate, parseMemoryExtractionEntries,
  renderMemoryExtractionPayload,
} from '../memory-llm.js';
import { enforceVerify } from '../memory-verify.js';
import { parseRuleBody } from '../memory-rules.js';
import { saveStudioMemoryEntry } from '../storage/studio-settings.js';

/** The official Responses endpoint, fixed: no client or host override reaches a turn's key. */
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 30_000;
const RESPONSE_BYTES = 512 * 1024;

export type StudioTurnSource = 'personal_subscription' | 'company_pool' | 'personal_api_key';
export interface StudioMemoryTurnKey { apiKey: string; model: string; credentialSource: 'company-pool' | 'account-key' }
export interface StudioMemoryTurn {
  owner: string; runId: string; projectId: string; source: StudioTurnSource;
  userText: string; assistantText: string; hadArtifact: boolean;
  /** The turn's own key, re-resolved at extraction time; null when it changed, was removed or its quota ran out. */
  resolveKey(): StudioMemoryTurnKey | null;
  /** The owner may still run background work: active, Studio pilot, still owns the project. */
  allowed(): boolean;
}

type Kind = 'extractions' | 'verifications';

/**
 * Automatic memory for Studio accounts (#62). Everything is keyed by the
 * account: the memory root (S10), the extraction and verification history,
 * and the event stream. Extraction runs only on the turn's own OpenAI source
 * and bills it — the company pool (while the owner still has quota) or the
 * account's own key — re-resolved after the turn, never a daemon, host or
 * other account's key. Personal Codex has no extraction function: those turns
 * are recorded as skipped. Verification is the deterministic scorecard check
 * against the account's own rules; it calls no provider.
 */
export class StudioMemoryAutomation {
  private readonly now: () => number;
  private readonly http: typeof fetch;
  constructor(private readonly input: { db: Database.Database; settings: StudioSettings; fetch?: typeof fetch; clock?: () => number }) {
    this.now = input.clock ?? Date.now;
    this.http = input.fetch ?? globalThis.fetch.bind(globalThis);
    for (const kind of ['extractions', 'verifications'] as const) {
      input.db.exec(`CREATE TABLE IF NOT EXISTS studio_memory_${kind} (
        id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, at INTEGER NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS studio_memory_${kind}_owner ON studio_memory_${kind}(owner_account_id, at);`);
    }
  }

  list(owner: string, kind: Kind): Array<MemoryExtractionRecord | MemoryVerifyRecord> {
    return (this.input.db.prepare(`SELECT record_json FROM studio_memory_${kind} WHERE owner_account_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(owner, STUDIO_MEMORY_HISTORY_LIMIT) as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json));
  }
  /** Removes only the owner's rows; an unknown or foreign id removes nothing. */
  remove(owner: string, kind: Kind, id?: string): number {
    const removed = id === undefined
      ? this.input.db.prepare(`DELETE FROM studio_memory_${kind} WHERE owner_account_id = ?`).run(owner).changes
      : this.input.db.prepare(`DELETE FROM studio_memory_${kind} WHERE owner_account_id = ? AND id = ?`).run(owner, id).changes;
    if (removed) this.input.settings.publishChannel(owner, kind === 'extractions' ? 'extraction' : 'verify',
      { id: id ?? 'all', phase: id === undefined ? 'cleared' : 'deleted', status: id === undefined ? 'cleared' : 'deleted', at: this.now() });
    return removed;
  }
  private record(owner: string, kind: Kind, record: MemoryExtractionRecord | MemoryVerifyRecord): void {
    const { db } = this.input;
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO studio_memory_${kind} (id, owner_account_id, at, record_json) VALUES (?, ?, ?, ?)`)
        .run(record.id, owner, 'startedAt' in record ? record.startedAt : record.at, JSON.stringify(record));
      db.prepare(`DELETE FROM studio_memory_${kind} WHERE owner_account_id = ? AND id NOT IN (
        SELECT id FROM studio_memory_${kind} WHERE owner_account_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`).run(owner, owner, STUDIO_MEMORY_HISTORY_LIMIT);
    })();
    this.input.settings.publishChannel(owner, kind === 'extractions' ? 'extraction' : 'verify', record);
  }
  private extraction(owner: string, base: Omit<MemoryExtractionRecord, 'id' | 'startedAt' | 'userMessagePreview'> & { userText: string }): MemoryExtractionRecord {
    const { userText, ...rest } = base;
    const record: MemoryExtractionRecord = { id: `studio-extraction-${randomUUID()}`, startedAt: this.now(),
      userMessagePreview: userText.replace(/\s+/g, ' ').trim().slice(0, 120), ...rest };
    this.record(owner, 'extractions', record);
    return record;
  }

  /**
   * The regex pack on the user's own text (no provider), opt-in like the
   * single-user extractor and bounded by the account limits. Admission runs
   * it before capturing the prompt, so an explicit "remember: …" reaches the
   * same turn; `POST /api/memory/extract` runs the same pass.
   */
  async extractUserText(owner: string, userText: string): Promise<Array<Pick<MemoryEntry, 'id' | 'name' | 'description' | 'type' | 'updatedAt'>>> {
    return this.input.settings.withMemory(owner, async (root) => {
      const config = await readMemoryConfig(root);
      if (!config.enabled || !config.chatExtractionEnabled || !userText.trim()) return [];
      const drafts = heuristicMemoryDrafts(userText) as Array<{ id: string; type: MemoryEntry['type']; name: string; description: string; body: string }>;
      const written: MemoryEntry[] = [];
      let full = false;
      for (const draft of drafts) {
        const entry = await saveStudioMemoryEntry(root, draft, 'heuristic');
        if (entry === 'limit') { full = true; break; }
        if (entry !== 'invalid') written.push(entry);
      }
      this.extraction(owner, { kind: 'heuristic', userText, finishedAt: this.now(),
        ...(written.length ? { phase: 'success', writtenCount: written.length, writtenIds: written.map((entry) => entry.id) }
          : { phase: 'skipped', reason: full ? 'memory-full' : 'no-match' }) });
      if (written.length) this.input.settings.publish(owner, { kind: 'extract', count: written.length, source: 'heuristic' });
      return written.map(({ id, name, description, type, updatedAt }) => ({ id, name, description, type, updatedAt }));
    });
  }
  beforeTurn(owner: string, userText: string): Promise<unknown> { return this.extractUserText(owner, userText); }

  /** After a succeeded turn: verification, then extraction on the turn's own source. Never throws. */
  async afterTurn(turn: StudioMemoryTurn): Promise<void> {
    try {
      const config = await this.input.settings.withMemory(turn.owner, (root) => readMemoryConfig(root));
      if (!config.enabled) return;
      if (config.verifyEnabled) await this.verify(turn);
      if (config.chatExtractionEnabled) await this.extract(turn);
    } catch { /* background memory work never fails the turn */ }
  }

  private async verify(turn: StudioMemoryTurn): Promise<void> {
    const rules = await this.input.settings.withMemory(turn.owner, async (root) => {
      const entries = (await listMemoryEntries(root) as MemoryEntry[]).filter((entry) => entry.type === 'rule');
      const bodies = await Promise.all(entries.map((entry) => readMemoryEntry(root, entry.id)));
      return entries.map((entry, index) => ({ name: entry.name, check: parseRuleBody(String((bodies[index] as { body?: unknown } | null)?.body ?? '')).check }));
    });
    const result = enforceVerify({ assistantOutput: turn.assistantText, activeRules: rules, hadArtifact: turn.hadArtifact, verifyEnabled: true });
    // Only enforced turns are history; "no rules / no artifact" says nothing about the turn.
    if (result.status === 'skipped') return;
    this.record(turn.owner, 'verifications', { ...result, id: `studio-verify-${randomUUID()}`, at: this.now(), runId: turn.runId, projectId: turn.projectId });
  }

  private async extract(turn: StudioMemoryTurn): Promise<void> {
    if (turn.source === 'personal_subscription') {
      this.extraction(turn.owner, { kind: 'llm', userText: turn.userText, runId: turn.runId, phase: 'skipped', reason: 'source-has-no-extraction', finishedAt: this.now() });
      return;
    }
    if (!turn.userText.trim()) {
      this.extraction(turn.owner, { kind: 'llm', userText: '', runId: turn.runId, phase: 'skipped', reason: 'empty-message', finishedAt: this.now() });
      return;
    }
    // Re-resolved after the turn: the owner and the turn's own key, nothing else.
    const key = turn.allowed() ? turn.resolveKey() : null;
    if (!key) {
      this.extraction(turn.owner, { kind: 'llm', userText: turn.userText, runId: turn.runId, phase: 'skipped', reason: 'source-unavailable', finishedAt: this.now() });
      return;
    }
    const provider = { kind: 'openai' as const, model: key.model, credentialSource: key.credentialSource };
    const running = this.extraction(turn.owner, { kind: 'llm', userText: turn.userText, runId: turn.runId, phase: 'running', provider });
    const settle = (patch: Partial<MemoryExtractionRecord>) => this.record(turn.owner, 'extractions', { ...running, ...patch, finishedAt: this.now() });
    const memory = await this.input.settings.withMemory(turn.owner, async (root) => ({ body: await composeMemoryBody(root) }));
    let text = ''; const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const response = await this.http(RESPONSES_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: key.model, store: false, stream: true, max_output_tokens: 1024, input: [
          { role: 'developer', content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: renderMemoryExtractionPayload({ userMessage: turn.userText, assistantMessage: turn.assistantText, currentMemory: memory.body }) },
        ] }) });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        // Secret-free classes only; the provider's body is never kept.
        return settle({ phase: 'failed', error: response.status === 401 || response.status === 403 ? `OpenAI ${response.status} unauthorized`
          : response.status === 429 ? 'OpenAI 429 rate limited' : `OpenAI ${response.status} request failed` });
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      let bytes = 0; let buffer = ''; let completedText = '';
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > RESPONSE_BYTES) { await reader.cancel(); throw new Error('response too large'); }
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const data = buffer.slice(0, end).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          buffer = buffer.slice(end + 2);
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data) as { type?: string; delta?: unknown; response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>; usage?: Record<string, unknown> } };
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
          if (event.type === 'response.completed') {
            completedText = (event.response?.output ?? []).filter((item) => item.type === 'message')
              .flatMap((item) => item.content ?? []).map((part) => typeof part.text === 'string' ? part.text : '').join('');
            for (const [wire, field] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
              const value = event.response?.usage?.[wire]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[field] = value;
            }
          }
          if (event.type === 'error' || event.type === 'response.failed') throw new Error('provider stream failed');
        }
      }
      text = text || completedText;
    } catch {
      return settle({ phase: 'failed', error: 'OpenAI request failed', usage });
    }
    const proposed = (parseMemoryExtractionEntries(text) as Array<{ type: string; name: string; description?: string; body: string }>);
    // The owner may have lost access while the provider answered: nothing is written then.
    if (!turn.allowed()) return settle({ phase: 'skipped', reason: 'source-unavailable', proposedCount: proposed.length, usage });
    const written = await this.input.settings.withMemory(turn.owner, async (root) => {
      const out: string[] = [];
      const known = await listMemoryEntries(root);
      if (known.length >= STUDIO_MEMORY_MAX_ENTRIES) return null;
      for (const candidate of proposed) {
        if (memoryCandidateKnown(known, candidate)) continue;
        const entry = await saveStudioMemoryEntry(root, memoryDraftFromCandidate(candidate), 'llm');
        if (entry === 'limit') break;
        if (entry !== 'invalid') out.push(entry.id);
      }
      return out;
    });
    if (written === null) return settle({ phase: 'skipped', reason: 'memory-full', proposedCount: proposed.length, usage });
    if (written.length) this.input.settings.publish(turn.owner, { kind: 'extract', count: written.length, source: 'llm' });
    settle({ phase: 'success', proposedCount: proposed.length, writtenCount: written.length, writtenIds: written, usage });
  }
}
