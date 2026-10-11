import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, insertProject, insertConversation } from '../../src/db.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { CompanyOpenAIStore } from '../../src/storage/company-openai.js';
import { PersonalProviderKeyStore } from '../../src/storage/personal-provider-keys.js';
import { WorkerQuotaLedger } from '../../src/storage/worker-quota-ledger.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { registerMultiUserRunRoutes } from '../../src/routes/multiuser-runs.js';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import type { StudioPluginCapture } from '../../src/routes/studio-plugins.js';

let root: string; let db: Database.Database; let accounts: AuthStore; let ledger: WorkerQuotaLedger;
let service: ReturnType<typeof registerMultiUserRunRoutes>;
beforeEach(() => {
  // Quota mutation is the oracle, independent of both periodic watchdogs.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's70-quota-')));
  fs.mkdirSync(path.join(root, 'projects', 'project'), { recursive: true });
  db = openDatabase(root, { dataDir: root }); accounts = AuthStore.open({ dataRoot: root });
  accounts.insertAccount({ id: 'A', username: 'a', passwordHash: '', passwordState: 'set', active: true, role: 'user', createdAt: 1, updatedAt: 1 });
  accounts.setStudioPilot('A', { studioPilot: true, revision: 1 });
  insertProject(db, { id: 'project', name: 'Quota fixture', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'conversation', projectId: 'project', sessionMode: 'brainstorm', createdAt: 1, updatedAt: 1 });
  new ProjectAccessStore(db, { accountActive: () => true }).ownership.bindOwner('project', 'A', 1);
  new CompanyOpenAIStore(db, root).update('A', { revision: 0, enabled: true, apiKey: 'fixture-company-key-s70', model: 'fixture', capacity: 2 });
  new PersonalProviderKeyStore(db, root).update('A', 'openai', { revision: 0, apiKey: 'fixture-account-key-s70' });
  ledger = new WorkerQuotaLedger({ dataRoot: root });
});
afterEach(async () => { await service?.shutdown(); vi.restoreAllMocks(); ledger?.close(); accounts?.close(); closeDatabase(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

it.each([
  { flow: 'loop', loss: 'jury', source: 'company_pool', status: 'failed', calls: 2 },
  { flow: 'finite-jury', loss: 'jury', source: 'company_pool', status: 'failed', calls: 2 },
  { flow: 'finite', loss: 'worker', source: 'company_pool', status: 'failed', calls: 2 },
  { flow: 'finite', loss: 'edge', source: 'company_pool', status: 'failed', calls: 1 },
  { flow: 'loop', loss: 'edge', source: 'company_pool', status: 'failed', calls: 1 },
  { flow: 'ordinary', loss: 'worker', source: 'company_pool', status: 'failed', calls: 2 },
  { flow: 'ordinary', loss: 'cancel', source: 'company_pool', status: 'canceled', calls: 2 },
  { flow: 'standalone-jury', loss: 'jury', source: 'company_pool', status: 'failed', calls: 1 },
  { flow: 'loop', loss: 'cancel', source: 'company_pool', status: 'canceled', calls: 2 },
  { flow: 'loop', loss: 'revoke', source: 'company_pool', status: 'canceled', calls: 2 },
  { flow: 'loop', loss: 'jury', source: 'personal_api_key', status: 'succeeded', calls: 2 },
])('settles $flow / $loss / $source without relying on quota timers', async (sample) => {
  let calls = 0; let session = true; let ended = false;
  const ledgerFinish = vi.spyOn(WorkerQuotaLedger.prototype, 'finish'); const ledgerCancel = vi.spyOn(WorkerQuotaLedger.prototype, 'cancel');
  const pin: StudioPluginCapture = { snapshotId: 'pin', projectId: 'project', pluginId: 'quota-fixture', pluginVersion: '1.0.0',
    manifestSourceDigest: 'digest', prompt: 'Pinned plugin', promptSha256: 'hash', requirements: { atoms: [], capabilities: [] },
    pipeline: { stages: [{ id: 'prepare', atoms: ['file-read'] }, ...(sample.flow === 'loop' || sample.flow === 'finite-jury'
      ? [{ id: 'critique', atoms: ['critique-theater'], ...(sample.flow === 'loop' ? { repeat: true, until: 'critique.score>=4 || iterations>=3' } : {}) },
          ...(sample.flow === 'finite-jury' ? [{ id: 'finish', atoms: ['file-read'] }] : [])]
      : [{ id: 'generate', atoms: ['file-read'] }, { id: 'finish', atoms: ['file-read'] }])] } };
  const exhaust = () => ledger.setBudgetMs('A', 0, 'A');
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (sample.loss === 'edge' && sql.includes('INSERT INTO multiuser_run_events')) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: any[]) => {
        const value = run(...args);
        if (args.some((arg) => typeof arg === 'string' && arg.includes('pipeline_stage_completed'))) exhaust();
        return value;
      }) as typeof statement.run;
    }
    return statement;
  }) as typeof db.prepare);
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer fixture-${sample.source === 'personal_api_key' ? 'account' : 'company'}-key-s70`);
    if ((calls === 2 || sample.flow === 'standalone-jury') && sample.loss !== 'edge') {
      if (sample.loss === 'cancel') { exhaust(); service.cancelAccountRuns('A'); }
      else if (sample.loss === 'revoke') session = false;
      else exhaust();
    }
    const text = (['loop', 'finite-jury'].includes(sample.flow) && calls === 2) || sample.flow === 'standalone-jury'
      ? syntheticGoodTranscript() : 'Work done.';
    const output = sample.flow === 'ordinary' && calls === 1
      ? [{ type: 'function_call', name: 'list_project_files', call_id: 'read', arguments: '{}' }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
    return new Response([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {
      output, usage: { input_tokens: 11, output_tokens: 7 } } }].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
  };
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((name) => [name, () => {}])) as unknown as Express;
  service = registerMultiUserRunRoutes(app, { db, dataRoot: root, dataRootCanonical: root, projectsRoot: path.join(root, 'projects'),
    repositoryRoot: path.resolve('../..'), companyFetch: fetcher, sessionCurrent: () => session,
    plugins: { projectPin: () => ['ordinary', 'standalone-jury'].includes(sample.flow) ? null : pin } });
  const response = await service.admitInternal({ accountId: 'A', username: 'a', role: 'user', sessionId: 'session', sessionExpiresAt: Date.now() + 60_000 },
    { projectId: 'project', conversationId: 'conversation', executionSource: sample.source, message: 'Run the captured plugin',
      ...(sample.flow === 'standalone-jury' ? { critique: true } : {}) }, () => true);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const runId = (response.body as { runId: string }).runId;
  await vi.waitFor(() => { ended = !['running', 'queued'].includes(service.runState(runId, 'A')!.status); expect(ended).toBe(true); });
  const state = service.runState(runId, 'A')!;
  expect(state.status).toBe(sample.status);
  if (sample.status === 'failed') expect(state.reason).toBe('MULTIUSER_QUOTA_EXHAUSTED');
  else expect(state.reason).not.toBe('MULTIUSER_QUOTA_EXHAUSTED');
  expect(calls).toBe(sample.calls);
  expect(db.prepare("SELECT * FROM multiuser_run_events WHERE run_id = ? AND event = 'end'").all(runId)).toHaveLength(1);
  const output = JSON.parse((db.prepare('SELECT output FROM multiuser_runs WHERE id = ?').get(runId) as { output: string }).output);
  expect(output.usage).toEqual({ inputTokens: sample.flow === 'standalone-jury' ? 0 : sample.status === 'succeeded' ? 22 : 11,
    outputTokens: sample.flow === 'standalone-jury' ? 0 : sample.status === 'succeeded' ? 14 : 7 });
  expect(db.prepare('SELECT * FROM critique_runs WHERE id LIKE ? AND id != ?').all(`${runId}%`, runId)).toEqual([]);
  const internalRoot = path.join(root, 'critique-artifacts', 'studio', 'A', 'project');
  if (sample.flow !== 'standalone-jury' && fs.existsSync(internalRoot)) expect(fs.readdirSync(internalRoot).filter((name) => name.startsWith(runId))).toEqual([]);
  expect(ledger.balance('A').activeRunId).toBeNull();
  if (sample.source === 'company_pool') {
    expect(ledger.entry(runId)).toMatchObject({ status: sample.status === 'canceled' ? 'cancelled' : 'finished',
      endedAt: expect.any(Number), chargedMs: expect.any(Number) });
    expect(ledgerFinish).toHaveBeenCalledTimes(sample.status === 'canceled' ? 0 : 1);
    expect(ledgerCancel).toHaveBeenCalledTimes(sample.status === 'canceled' ? 1 : 0);
  } else {
    expect(ledger.entry(runId)).toBeUndefined();
    expect(ledgerFinish).not.toHaveBeenCalled(); expect(ledgerCancel).not.toHaveBeenCalled();
  }
});
