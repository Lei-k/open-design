import type { ResearchFindings } from './research.js';

/**
 * Research search for Studio accounts (#63). The daemon calls the fixed
 * Tavily endpoint with the account's own encrypted key (never a daemon or
 * host key), records the use against the account without the query text, and
 * returns external, untrusted findings. Missing keys are
 * `MULTIUSER_PROVIDER_KEY_MISSING`; refused keys `MULTIUSER_PROVIDER_KEY_REJECTED`;
 * provider throttling `MULTIUSER_PROVIDER_RATE_LIMITED`.
 *
 * A Studio turn may carry `research: { enabled: true, query? }`: the search
 * runs on the same key at admission and its findings accompany the turn for
 * the agent as daemon-authored, untrusted evidence (the query defaults to the
 * turn text). Retries and question answers reuse the admitted findings.
 */
export interface StudioResearchSearchRequest {
  query: string;
  /** 1 to {@link STUDIO_RESEARCH_MAX_SOURCES}; default 5. */
  maxSources?: number;
}
export type StudioResearchSearchResponse = ResearchFindings;

export const STUDIO_RESEARCH_MAX_SOURCES = 10;
export const STUDIO_RESEARCH_QUERY_MAX = 1000;
