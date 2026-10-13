import type Database from 'better-sqlite3';
import {
  STUDIO_RESEARCH_MAX_SOURCES, STUDIO_RESEARCH_QUERY_MAX, type ApiErrorCode, type ResearchFindings, type ResearchSource,
} from '@open-design/contracts';
import type { PersonalProviderKeyStore } from '../storage/personal-provider-keys.js';
import { tavilyOutputFrom } from './tavily.js';

/** Fixed provider endpoint: no client, deployment or host override reaches a Web account's key. */
export const STUDIO_TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 30_000;
const DEFAULT_SOURCES = 5;

export class StudioResearchError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) { super(message); }
}

export interface StudioResearch {
  /** Search for `owner` on its own Tavily key; records the use against the account. */
  search(owner: string, query: string, maxSources?: number, signal?: AbortSignal): Promise<ResearchFindings>;
}

/**
 * Research for Studio accounts (#63). Each search uses only the account's own
 * encrypted Tavily key (S33 custody), never a daemon or host key, and calls the
 * fixed endpoint without following redirects. Provider bodies are never echoed:
 * refusals map to secret-free typed codes. Every provider call is recorded
 * against the account (outcome and source count, never the query or key).
 */
export function createStudioResearch(input: {
  db: Database.Database; keys: PersonalProviderKeyStore | null; fetch?: typeof fetch; clock?: () => number;
}): StudioResearch {
  const { db } = input;
  const now = input.clock ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS multiuser_research_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, provider TEXT NOT NULL,
      outcome TEXT NOT NULL, sources INTEGER NOT NULL, credential_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS multiuser_research_usage_account ON multiuser_research_usage(account_id, created_at);
    CREATE TRIGGER IF NOT EXISTS multiuser_research_usage_immutable BEFORE UPDATE ON multiuser_research_usage
      BEGIN SELECT RAISE(ABORT, 'research usage rows are immutable'); END;`);
  const record = (owner: string, outcome: string, sources: number, credentialRevision: number) => {
    db.prepare('INSERT INTO multiuser_research_usage (account_id, provider, outcome, sources, credential_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, 'tavily', outcome, sources, credentialRevision, now());
  };
  const http = input.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async search(owner, rawQuery, maxSources, signal) {
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      if (!query || query.length > STUDIO_RESEARCH_QUERY_MAX || query.includes('\0')) throw new StudioResearchError(400, 'BAD_REQUEST', 'a research query is required');
      const limit = maxSources === undefined ? DEFAULT_SOURCES : maxSources;
      if (!Number.isInteger(limit) || limit < 1 || limit > STUDIO_RESEARCH_MAX_SOURCES) throw new StudioResearchError(400, 'BAD_REQUEST', 'invalid source count');
      if (!input.keys) throw new StudioResearchError(403, 'MULTIUSER_PROVIDER_DISABLED', 'account provider keys are not enabled on this server');
      const key = input.keys.execution(owner, 'tavily');
      if (!key) throw new StudioResearchError(403, 'MULTIUSER_PROVIDER_KEY_MISSING', 'add your Tavily API key in Settings first');
      let response: Response;
      try {
        response = await http(STUDIO_TAVILY_SEARCH_URL, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key.apiKey}` },
          body: JSON.stringify({ query, search_depth: 'basic', max_results: limit, include_answer: true, include_raw_content: false }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        record(owner, 'failed', 0, key.credentialRevision);
        throw new StudioResearchError(502, 'UPSTREAM_UNAVAILABLE', 'the research provider did not answer');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const rejected = response.status === 401 || response.status === 403;
        const limited = response.status === 429;
        record(owner, rejected ? 'rejected' : limited ? 'rate_limited' : 'failed', 0, key.credentialRevision);
        if (rejected) throw new StudioResearchError(403, 'MULTIUSER_PROVIDER_KEY_REJECTED', 'Tavily refused your API key');
        if (limited) throw new StudioResearchError(429, 'MULTIUSER_PROVIDER_RATE_LIMITED', 'Tavily is rate limiting your API key');
        throw new StudioResearchError(502, 'UPSTREAM_UNAVAILABLE', 'the research provider failed');
      }
      let parsed: unknown;
      try { parsed = await response.json(); }
      catch {
        record(owner, 'failed', 0, key.credentialRevision);
        throw new StudioResearchError(502, 'UPSTREAM_UNAVAILABLE', 'the research provider answered with an unreadable body');
      }
      const output = tavilyOutputFrom(parsed);
      // External, untrusted evidence: only http(s) links, bounded text.
      const sources: ResearchSource[] = output.sources.filter((source) => /^https?:\/\//i.test(source.url) && source.url.length <= 2048)
        .slice(0, limit).map((source) => ({ ...source, title: source.title.slice(0, 300), snippet: source.snippet.slice(0, 800) }));
      record(owner, 'ok', sources.length, key.credentialRevision);
      return { query, summary: output.answer.slice(0, 4000), sources, provider: 'tavily', depth: 'shallow', fetchedAt: now() };
    },
  };
}
