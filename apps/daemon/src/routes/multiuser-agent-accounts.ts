// Personal agent subscription accounts (#18) — multi-user mode only.
//
// Every route here is actor-scoped at the gate; handlers key every lookup by
// the server-side actor, so a foreign, missing or forged attempt/account id is
// the same 404. Responses are `Cache-Control: no-store` and never carry tokens,
// auth file contents, or another user's data. Admin routes return metadata only.
import type { Express, Request, Response } from 'express';
import type { AdminPersonalAccountsResponse, PersonalAgentAccountsResponse } from '@open-design/contracts';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { PersonalAccountError, type PersonalCodexAccounts } from '../services/personal-codex-accounts.js';

export interface PersonalRunLaneControls {
  stats(): { active: number; queued: number; capacity: number; workerMsByOwner: Map<string, number> };
  setCapacity(capacity: number, adminId: string): void;
}

export function registerMultiUserAgentAccountRoutes(app: Express, deps: {
  personal: PersonalCodexAccounts;
  runs: PersonalRunLaneControls;
  listAccountIds: () => string[];
  companyPoolAvailable: boolean;
}): void {
  const { personal } = deps;
  const actor = (res: Response) => multiUserActorOf(res)?.accountId ?? '';
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'not found');
  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    Promise.resolve().then(() => fn(req, res)).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof PersonalAccountError) sendApiError(res, error.status, error.code, error.message);
      else sendApiError(res, 500, 'INTERNAL_ERROR', 'internal error');
    });
  };

  app.get('/api/agent-accounts', handle((_req, res) => {
    const body: PersonalAgentAccountsResponse = {
      mode: 'multi-user',
      personalSubscriptionsEnabled: personal.enabled,
      companyPoolAvailable: deps.companyPoolAvailable,
      codex: personal.summary(actor(res)),
      claude: { available: false },
    };
    res.json(body);
  }));

  app.post('/api/agent-accounts/codex/logins', handle(async (_req, res) => {
    res.status(202).json({ attempt: await personal.startLogin(actor(res)) });
  }));

  app.get('/api/agent-accounts/codex/logins/:attemptId', handle(async (req, res) => {
    const attempt = await personal.attempt(actor(res), String(req.params.attemptId));
    if (!attempt) return void notFound(res);
    res.json({ attempt });
  }));

  app.post('/api/agent-accounts/codex/logins/:attemptId/cancel', handle(async (req, res) => {
    const attempt = await personal.cancelLogin(actor(res), String(req.params.attemptId));
    if (!attempt) return void notFound(res);
    res.json({ attempt });
  }));

  app.post('/api/agent-accounts/codex/accounts/:accountId/verify', handle(async (req, res) => {
    const consent = (req.body as { consentToUsePlan?: unknown } | undefined)?.consentToUsePlan;
    const account = await personal.verify(actor(res), String(req.params.accountId), consent);
    if (!account) return void notFound(res);
    res.json({ account });
  }));

  app.delete('/api/agent-accounts/codex/accounts/:accountId', handle(async (req, res) => {
    if (!(await personal.unlink(actor(res), String(req.params.accountId)))) return void notFound(res);
    res.json({ unlinked: true });
  }));

  app.get('/api/admin/agent-accounts', handle((_req, res) => {
    const ids = deps.listAccountIds();
    const stats = deps.runs.stats();
    const linked = personal.adminView(ids);
    const users: AdminPersonalAccountsResponse['users'] = {};
    for (const id of ids) users[id] = { codex: linked[id]!, personalWorkerMs: stats.workerMsByOwner.get(id) ?? 0 };
    const body: AdminPersonalAccountsResponse = { personalWorkerCapacity: stats.capacity, activePersonalRuns: stats.active,
      queuedPersonalRuns: stats.queued, users };
    res.json(body);
  }));

  app.put('/api/admin/agent-accounts/personal-capacity', handle((req, res) => {
    const capacity = (req.body as { capacity?: unknown } | undefined)?.capacity;
    if (!Number.isSafeInteger(capacity) || Number(capacity) < 0 || Number(capacity) > 16) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'invalid personal worker capacity');
    }
    deps.runs.setCapacity(Number(capacity), actor(res));
    res.json({ capacity });
  }));
}
