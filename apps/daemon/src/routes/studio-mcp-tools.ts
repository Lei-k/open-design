import type { Express } from 'express';
import { StudioMcpRuntimeError, type StudioMcpRuntime } from '../mcp-client/studio-runtime.js';
import { toolTokenRegistry } from '../tool-tokens.js';
import { sendApiError } from '../http/api-errors.js';

/** Exact bearer-only run endpoints. Desktop/host MCP configuration never enters these routes. */
export function registerStudioMcpToolRoutes(app: Express, runtime: StudioMcpRuntime): void {
  for (const operation of ['list', 'execute'] as const) {
    const path = `/api/tools/mcp/${operation}`;
    const handle: import('express').RequestHandler = async (req, res) => {
      const validation = toolTokenRegistry.validate(/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1], { endpoint: path, operation: `mcp:${operation}` });
      if (!validation.ok) return sendApiError(res, 401, validation.code, validation.message);
      try {
        if (!validation.grant.studioMcp) throw new StudioMcpRuntimeError('NOT_FOUND', 404);
        if (operation === 'list' && Object.keys(req.query).length) throw new StudioMcpRuntimeError('BAD_REQUEST', 400);
        if (operation === 'execute' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) throw new StudioMcpRuntimeError('BAD_REQUEST', 400);
        const result = operation === 'list' ? await runtime.list(validation.grant) : await runtime.execute(validation.grant, req.body);
        if (!res.destroyed) res.json(result);
      } catch (error) {
        const safe = error instanceof StudioMcpRuntimeError ? error : new StudioMcpRuntimeError('MULTIUSER_MCP_PROVIDER_FAILED', 502);
        if (!res.destroyed) sendApiError(res, safe.status, safe.code, 'account MCP call refused');
      }
    };
    if (operation === 'list') app.get(path, handle); else app.post(path, handle);
  }
}
