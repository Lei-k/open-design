import type { Express } from 'express';
import type { StudioResearchSearchRequest, StudioResearchSearchResponse } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { StudioResearchError, type StudioResearch } from '../research/studio-research.js';

/**
 * `POST /api/research/search` for Studio accounts (#63), reached through the
 * gate alias. The search runs on the actor's own Tavily key only; the host
 * research handler and its daemon-level key never run for a cookie actor.
 */
export function registerStudioResearchRoutes(app: Express, input: { research: StudioResearch }): void {
  app.post('/api/multiuser/research/search', async (req, res) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const body = (req.body ?? {}) as Partial<StudioResearchSearchRequest>;
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const findings: StudioResearchSearchResponse = await input.research.search(owner, String(body.query ?? ''), body.maxSources, abort.signal);
      // The provider call yields; a revoked session or withdrawn pilot receives nothing.
      if (!multiUserStreamAllowed(res)) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json(findings);
    } catch (error) {
      if (res.headersSent || !multiUserStreamAllowed(res)) return;
      if (error instanceof StudioResearchError) return sendApiError(res, error.status, error.code, error.message);
      sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'research failed');
    }
  });
}
