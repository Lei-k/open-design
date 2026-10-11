import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import { cleanupIsolatedDataRoot, multiUserOptions, provisionAccounts, startMultiUserDaemon } from './multiuser-harness.js';

it('R6 ships and serves Jury artifacts when TMPDIR and the data root contain a symlink', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'jury-symlink-'));
  const real = path.join(scratch, 'real'); const link = path.join(scratch, 'link');
  mkdirSync(real); symlinkSync(real, link);
  const previous = process.env.TMPDIR; process.env.TMPDIR = link;
  const fixture: typeof fetch = async () => {
    const text = syntheticGoodTranscript();
    return new Response([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed',
      response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture }));
  try {
    const { users: [owner] } = await provisionAccounts(daemon, ['symlink-owner']);
    expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: owner!.cookie,
      body: { revision: 0, apiKey: 'sk-symlink-fixture-only-0123456789' } })).status).toBe(200);
    const projectId = randomUUID();
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: owner!.cookie, body: { id: projectId, name: 'Symlink Jury' } });
    expect(project.status, project.text).toBe(200);
    const base = `/api/projects/${projectId}/critique`;
    const run = await daemon.request({ method: 'POST', path: base, cookie: owner!.cookie,
      body: { conversationId: project.json.conversationId, agentId: 'openai-byok', message: 'Review' } });
    expect(run.status).toBe(202);
    const replay = await daemon.request({ path: `${base}/${run.json.runId}/events`, cookie: owner!.cookie });
    expect(replay.text).toContain('critique.ship');
    expect((await daemon.request({ path: `${base}/${run.json.runId}`, cookie: owner!.cookie })).json.critique.status).toBe('shipped');
    expect((await daemon.request({ path: `${base}/${run.json.runId}/artifact`, cookie: owner!.cookie })).status).toBe(200);
  } finally {
    await daemon.close(); cleanupIsolatedDataRoot();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
