import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { PersonalProviderKeyStore } from '../../src/storage/personal-provider-keys.js';
import { CompanyOpenAIStore } from '../../src/storage/company-openai.js';
import { WorkerQuotaLedger } from '../../src/storage/worker-quota-ledger.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerMultiUserRunRoutes } from '../../src/routes/multiuser-runs.js';
import { registerStudioSynthesisRoutes } from '../../src/routes/studio-synthesis.js';
import { StudioDesignSystems } from '../../src/storage/studio-design-systems.js';
import { StudioCatalogGrants } from '../../src/storage/studio-catalog-grants.js';
import { StudioSynthesisStore } from '../../src/storage/studio-synthesis.js';
import { callFinalizeProviderWithRetry } from '../../src/design/finalize-design.js';

let root: string; let db: Database.Database; let accounts: AuthStore;
let pool: ReturnType<typeof registerMultiUserRunRoutes>;
let access: ProjectAccessStore;
const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
const key = 'sk-s71-account-A-private-0123456789';
const companyKey = 'sk-s71-company-private-9876543210';
const keyB = 'sk-s71-account-B-private-1234598760';
let fetcher: ReturnType<typeof vi.fn>;
let live: boolean;
const actor = (id = 'A') => ({ accountId: id, username: id, role: id === 'admin' ? 'admin' as const : 'user' as const, sessionId: 'fixture', sessionExpiresAt: Date.now() + 60000 });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 's71-registrar-'));
  const projectsRoot = path.join(root, 'projects'); fs.mkdirSync(path.join(projectsRoot, 'p'), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, 'p', 'index.html'), '<h1>Design</h1>');
  db = openDatabase(root, { dataDir: root }); accounts = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B', 'admin']) {
    accounts.insertAccount({ id, username: id, passwordHash: '', role: id === 'admin' ? 'admin' : 'user', passwordState: 'setup_required', active: true, createdAt: 1, updatedAt: 1 });
    accounts.setStudioPilot(id, { studioPilot: true, revision: 1 });
  }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p','Design',1,1);
  db.prepare('INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run('c','p','Design',1,1);
  db.prepare('INSERT INTO messages (id,conversation_id,role,content,position,created_at) VALUES (?,?,?,?,?,?)').run('m','c','user','Make a calm page',0,1);
  access = new ProjectAccessStore(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
  access.ownership.bindOwner('p','A',1);
  handlers.clear(); live = true;
  const app = Object.fromEntries(['get','post','put','patch','delete'].map((method) => [method,
    (url: string, handler: (req: Request,res: Response) => Promise<void>) => handlers.set(`${method.toUpperCase()} ${url}`, handler)])) as unknown as Express;
  pool = registerMultiUserRunRoutes(app, { db, dataRoot: root, dataRootCanonical: root, projectsRoot, repositoryRoot: path.resolve('../..'), sessionCurrent: () => live });
  const keys = new PersonalProviderKeyStore(db, root);
  keys.update('A', 'openai', { revision: 0, apiKey: key, model: 'gpt-own-s71' });
  keys.update('B', 'openai', { revision: 0, apiKey: keyB, model: 'gpt-editor-s71' });
  new CompanyOpenAIStore(db, root).update('admin', { revision: 0, enabled: true, apiKey: companyKey, model: 'gpt-company-s71', capacity: 2 });
  fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '# Design\nContinue here.' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  registerStudioSynthesisRoutes(app, { db, projectsRoot, designSystemsRoot: root, pool, sessionCurrent: () => live,
    accountActive: (id) => accounts.getAccountById(id)?.active === true, fetch: fetcher as typeof fetch,
    designCatalog: { readSystem: async (_actor, id) => new StudioDesignSystems(db).readLive(id)?.document ?? null,
      readSystemAssets: async () => ({}) } });
});
afterEach(async () => { await pool?.shutdown(); accounts?.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function invoke(action: string, body: Record<string, unknown> = {}, user = 'A', project = 'p') {
  const response = internalMultiUserResponse(actor(user), () => live);
  const suffix = action === 'finalize' ? 'finalize/:provider' : action;
  await handlers.get(`${action === 'synthesis' ? 'GET' : 'POST'} /api/multiuser/projects/:id/${suffix}`)!({ params: { id: project, provider: 'openai' },
    body: { ...(action === 'handoff' ? { conversationId: 'c' } : {}), ...body } } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}
const request = (source = 'personal_api_key') => ({ executionSource: source });
it.each(['finalize', 'handoff'])('%s uses both sources, counts usage and marks edited output stale', async (action) => {
  for (const source of ['personal_api_key', 'company_pool']) {
    const response = await invoke(action, request(source));
    expect(response, JSON.stringify(response)).toMatchObject({ status: 200, body: { executionSource: source, inputTokens: 11, outputTokens: 7, current: true } });
    expect(response.body.digest).toMatch(/^[a-f0-9]{64}$/);
    const outbound = fetcher.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(outbound[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(new Headers(outbound[1].headers).get('authorization')).toBe(`Bearer ${source === 'personal_api_key' ? key : companyKey}`);
    expect(JSON.stringify(response)).not.toContain(root);
    expect(db.prepare('SELECT input_tokens,output_tokens FROM studio_synthesis_jobs WHERE id = ?').get(response.body.id)).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect((await invoke('synthesis')).body.results[action].current).toBe(true);
    fs.writeFileSync(path.join(root,'projects/p/index.html'), `<h1>${source}</h1>`);
    expect((await invoke('synthesis')).body.results[action].current).toBe(false);
  }
});
it.each(['finalize','handoff'])('%s refuses personal Codex, missing selection and credential fields without outbound', async (action) => {
  expect(await invoke(action, request('personal_subscription'))).toMatchObject({ status: 409, body: { error: { code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { reason: 'personal-codex' } } } });
  expect(await invoke(action)).toMatchObject({ status: 409, body: { error: { details: { reason: 'source-required' } } } });
  for (const field of ['apiKey','baseUrl','protocol','model']) expect((await invoke(action, { ...request(), [field]: 'unsafe' })).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['finalize','handoff'])('%s refuses foreign, missing, admin and viewer alike, allows editor own key', async (action) => {
  const missing = await invoke(action, request(), 'B', 'missing');
  for (const user of ['B','admin']) expect(await invoke(action, request(), user)).toEqual(missing);
  access.setGrant('p','B','view',1);
  expect(await invoke(action,request(),'B')).toEqual(missing);
  access.setGrant('p','B','edit',2);
  expect((await invoke(action,request(),'B')).status).toBe(200);
  expect(new Headers((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].headers).get('authorization')).toBe(`Bearer ${keyB}`);
});
it.each(['finalize','handoff'])('%s preserves locks, refuses exhausted quota before provider and leaves own key uncharged', async (action) => {
  const filename = path.join(root,'projects/p',action === 'finalize' ? '.finalize.lock' : '.transcript.lock');
  fs.writeFileSync(filename,'busy');
  expect((await invoke(action,request())).status).toBe(409); fs.unlinkSync(filename);
  const ledger = new WorkerQuotaLedger({ dataRoot: root });
  try {
    ledger.setBudgetMs('A',0,'admin');
    expect(await invoke(action,request('company_pool'))).toMatchObject({ status: 429, body: { error: { code: 'MULTIUSER_QUOTA_EXHAUSTED' } } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await invoke(action,request())).status).toBe(200);
    expect(ledger.balance('A').usedMs).toBe(0);
  } finally { ledger.close(); }
});
it.each(['finalize','handoff'])('%s refuses deactivated actors and changed sessions, grants, keys and bytes before commit', async (action) => {
  accounts.updateAccountFlags('A',{ role: 'user',active: false },2);
  expect((await invoke(action,request())).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  accounts.updateAccountFlags('A',{ role: 'user',active: true },3);
  fetcher.mockImplementationOnce(async () => { live = false; return Response.json({}); });
  expect(await invoke(action,request())).toMatchObject({ status: 409, body: { error: { code: 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED' } } });
  live = true;
  fetcher.mockImplementationOnce(async () => { fs.writeFileSync(path.join(root,'projects/p/index.html'),'changed'); return Response.json({ choices:[{ finish_reason:'stop', message:{ content:'stale' } }] }); });
  expect(await invoke(action,request())).toMatchObject({ status: 409, body: { error: { code: 'MULTIUSER_SYNTHESIS_STALE' } } });
  expect(fs.existsSync(path.join(root,'projects/p',action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'))).toBe(false);
});
it.each(['finalize','handoff'])('%s redacts errors and successful credential echoes without logging provider text', async (action) => {
  const errorLog = vi.spyOn(console,'error');
  fetcher.mockImplementationOnce(async () => { throw new Error(`${key} ${Buffer.from(key).toString('base64')}`); });
  const response = await invoke(action,request());
  expect(response.status).toBe(502); expect(JSON.stringify(response)).not.toContain(key); expect(errorLog).not.toHaveBeenCalled();
  fetcher.mockImplementationOnce(async () => Response.json({ choices:[{ finish_reason:'stop', message:{ content:`Context ${key} ${Buffer.from(key).toString('base64')}` } }] }));
  const success = await invoke(action,request()); expect(success.status).toBe(200);
  const written = fs.readFileSync(path.join(root,'projects/p',success.body.fileName),'utf8');
  expect(written).not.toContain(key); expect(written).not.toContain(Buffer.from(key).toString('base64'));
});
it.each(['revision', 'grant', 'owner'])('refuses changed design-system %s after admission', async (change) => {
  const designs = new StudioDesignSystems(db);
  const design = designs.create('B', { title: 'Shared design', body: 'Calm spacing' });
  const grants = new StudioCatalogGrants(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
  grants.set('design-system', design.id, 'A', 1);
  db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run(design.id, 'p');
  fetcher.mockImplementationOnce(async () => {
    if (change === 'revision') designs.update('B', design.id, { body: 'New spacing' });
    if (change === 'grant') grants.remove('design-system', design.id, 'A');
    if (change === 'owner') accounts.updateAccountFlags('B', { role: 'user', active: false }, 2);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '# Stale design' } }] });
  });
  expect((await invoke('finalize', request())).status).toBe(409);
  expect(fs.existsSync(path.join(root, 'projects/p/DESIGN.md'))).toBe(false);
});
it.each(['key', 'account', 'grant'])('aborts a hanging provider when %s authority is revoked', async (change) => {
  access.setGrant('p', 'B', 'edit', 1);
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  fetcher.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
    admitted();
    return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const job = invoke('handoff', request(), 'B');
  await started;
  if (change === 'key') new PersonalProviderKeyStore(db, root).update('B', 'openai', { revision: 1, apiKey: null });
  if (change === 'account') accounts.updateAccountFlags('B', { role: 'user', active: false }, 2);
  if (change === 'grant') access.removeGrant('p', 'B');
  expect((await job).status).toBe(409);
  expect(fs.existsSync(path.join(root, 'projects/p/HANDOFF.md'))).toBe(false);
});
it('refuses symlink inputs before provider admission', async () => {
  fs.symlinkSync(path.join(root, 'app.sqlite'), path.join(root, 'projects/p/leak.txt'));
  expect((await invoke('finalize', request())).status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});
it('fences synthesis admission while a project deletion is in progress', async () => {
  const release = await pool.cancelProjectRuns(null, 'p');
  try { expect((await invoke('finalize', request())).status).toBe(409); expect(fetcher).not.toHaveBeenCalled(); }
  finally { release(); }
  expect((await invoke('finalize', request())).status).toBe(200);
});
it('defaults to the actor latest OpenAI pin without inheriting a shared owner pin', async () => {
  db.prepare(`INSERT INTO multiuser_runs (id,owner_account_id,project_id,conversation_id,status,created_at,updated_at,queue_seq,execution_source,request_json)
    VALUES ('pin','A','p','c','succeeded',1,1,1,'company_pool','{"companyProvider":"openai"}')`).run();
  expect((await invoke('synthesis')).body.defaultSource).toBe('company_pool');
  expect((await invoke('finalize')).body.executionSource).toBe('company_pool');
  access.setGrant('p', 'B', 'edit', 1);
  expect((await invoke('synthesis', {}, 'B')).body.defaultSource).toBe(null);
  expect((await invoke('handoff', {}, 'B')).body.error.details.reason).toBe('source-required');
});
it('finalizes the captured active artifact rather than the first HTML file', async () => {
  fs.writeFileSync(path.join(root, 'projects/p/selected.html'), '<h1>ACTIVE_ARTIFACT_WITNESS</h1>');
  db.prepare('INSERT INTO tabs (project_id,name,position,is_active) VALUES (?,?,?,?)').run('p','selected.html',0,1);
  expect((await invoke('finalize', request())).status).toBe(200);
  const outbound = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(String(outbound[1].body)).toContain('ACTIVE_ARTIFACT_WITNESS');
});

const actions = ['finalize', 'handoff'] as const;
const openaiSources = ['personal_api_key', 'company_pool'] as const;
const modelFamilies = [
  ['gpt-5.1', 'max_completion_tokens'], ['o1', 'max_completion_tokens'],
  ['o3-mini', 'max_completion_tokens'], ['o4-mini', 'max_completion_tokens'], ['gpt-4o', 'max_tokens'],
] as const;
it('A: legacy desktop OpenAI requests and transient retry remain unchanged', async () => {
  const legacy = { choices: [{ message: { content: 'Legacy response without finish metadata' } }] };
  const http = vi.fn().mockResolvedValueOnce(new Response('transient', {status:500})).mockResolvedValueOnce(Response.json(legacy));
  const response = await callFinalizeProviderWithRetry({protocol:'openai',apiKey:key,baseUrl:'https://api.openai.com',model:'gpt-5.1',
    maxTokens:37,systemPrompt:'System',userPrompt:'User',fetchImpl:http,_sleepMs:async()=>{}});
  expect(http).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(http.mock.calls[0]![1].body))).toEqual({model:'gpt-5.1',max_tokens:37,stream:false,messages:[{role:'system',content:'System'},{role:'user',content:'User'}]});
  expect(await response.json()).toEqual(legacy);
});
it.each(actions.flatMap((action) => openaiSources.flatMap((source) => modelFamilies.map(([model, field]) =>
  ({ action, source, model, field })))))('A: $action on $source/$model uses the compatible exact token cap', async ({ action, source, model, field }) => {
  new PersonalProviderKeyStore(db, root).update('A', 'openai', { revision: 1, model });
  new CompanyOpenAIStore(db, root).update('admin', { revision: 1, enabled: true, capacity: 2, model });
  fetcher.mockImplementation(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (field === 'max_completion_tokens' && 'max_tokens' in body) return Response.json({ error: {
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter',
    } }, { status: 400 });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: `# ${action} ${model}` } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } });
  });
  const response = await invoke(action, { ...request(source), maxTokens: 37 });
  expect(response).toMatchObject({ status: 200, body: { model, inputTokens: 11, outputTokens: 7, current: true } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.openai.com/v1/chat/completions');
  expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
  const body = JSON.parse(String(init.body));
  expect(body).toEqual({ model, stream: false, messages: [{ role: 'system', content: expect.any(String) },
    { role: 'user', content: expect.any(String) }], [field]: 37 });
  expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${source === 'company_pool' ? companyKey : key}`);
  expect(fs.readFileSync(path.join(root, 'projects/p', action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'), 'utf8')).toBe(`# ${action} ${model}`);
});
it.each(actions.flatMap((action) => openaiSources.map((source) => ({ action, source }))))('A: $action/$source retains its default GPT-5 budget', async ({ action, source }) => {
  new PersonalProviderKeyStore(db, root).update('A', 'openai', { revision: 1, model: 'gpt-5.1' });
  new CompanyOpenAIStore(db, root).update('admin', { revision: 1, enabled: true, capacity: 2, model: 'gpt-5.1' });
  expect((await invoke(action, request(source))).status).toBe(200);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toMatchObject({ model: 'gpt-5.1', max_completion_tokens: action === 'finalize' ? 16000 : 4096 });
});
it.each(actions.flatMap((action) => ['blank', 'reasoning-only', 'length', 'content_filter', 'missing-finish', 'refusal', 'error'].map((kind) => ({ action, kind }))))('A: $action refuses $kind provider results without a successful document', async ({ action, kind }) => {
  fetcher.mockResolvedValueOnce(Response.json(kind === 'error' ? { error: { message: key } } : { choices: [{
    ...(kind === 'missing-finish' ? {} : { finish_reason: ['length', 'content_filter'].includes(kind) ? kind : 'stop' }),
    message: { content: kind === 'reasoning-only' ? null : kind === 'blank' ? '  \n' : 'Incomplete output', ...(kind === 'refusal' ? { refusal: 'Refused' } : {}) },
  }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  expect(await invoke(action, request())).toMatchObject({ status: 502, body: { error: { code: 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED' } } });
  expect(fs.existsSync(path.join(root, 'projects/p', action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'))).toBe(false);
  expect(db.prepare("SELECT 1 FROM studio_synthesis_jobs WHERE status = 'succeeded'").get()).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(actions)('A: %s makes no automatic retry on an upstream transient failure', async (action) => {
  fetcher.mockResolvedValue(Response.json({ error: { message: key } }, { status: 500 }));
  expect((await invoke(action, request())).status).toBe(502);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('A: editor handoff does not read an unshared owner design system; finalize still denies it', async () => {
  const design = new StudioDesignSystems(db).create('A', { title: 'Private design', body: 'PRIVATE_DESIGN_BODY' });
  db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run(design.id, 'p');
  access.setGrant('p', 'B', 'edit', 1);
  const read = vi.spyOn(StudioDesignSystems.prototype, 'readLive');
  expect((await invoke('handoff', request(), 'B')).status).toBe(200);
  expect(String(fetcher.mock.calls[0]![1].body)).not.toContain('PRIVATE_DESIGN_BODY');
  expect(read).not.toHaveBeenCalled();
  fetcher.mockClear();
  expect((await invoke('finalize', request(), 'B')).status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([['finalize','handoff'], ['handoff','finalize']] as const)('B: %s then %s keeps distinct outputs current through reload and regeneration', async (first, second) => {
  let serial = 0;
  fetcher.mockImplementation(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: `# Distinct output ${++serial}` } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  const initial = (await invoke('synthesis')).body.digest;
  for (const action of [first, second, first, second]) {
    const response = await invoke(action, { ...request(), digest: initial });
    expect(response.status).toBe(200); expect(response.body.digest).toBe(initial);
    const state = (await invoke('synthesis')).body;
    expect(state.digest).toBe(initial);
    for (const result of Object.values(state.results) as Array<{ current: boolean }>) expect(result.current).toBe(true);
  }
  // Reopen the receipt owner against the existing DB (startup/migration path).
  const reloaded = new StudioSynthesisStore(db).results('p', initial, {
    'DESIGN.md': createHash('sha256').update(fs.readFileSync(path.join(root,'projects/p/DESIGN.md'))).digest('hex'),
    'HANDOFF.md': createHash('sha256').update(fs.readFileSync(path.join(root,'projects/p/HANDOFF.md'))).digest('hex'),
  });
  expect(reloaded.finalize?.current).toBe(true); expect(reloaded.handoff?.current).toBe(true);
  expect(fs.readFileSync(path.join(root,'projects/p/DESIGN.md'),'utf8')).not.toBe(fs.readFileSync(path.join(root,'projects/p/HANDOFF.md'),'utf8'));
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it.each(actions.flatMap((action) => ['edit','delete'].map((change) => ({ action, change }))))('B: $change of $action output stales only that receipt without changing inputs or spending', async ({ action, change }) => {
  for (const item of actions) expect((await invoke(item, request())).status).toBe(200);
  const before = (await invoke('synthesis')).body;
  const file = path.join(root,'projects/p',action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md');
  if (change === 'edit') fs.writeFileSync(file, 'Corrupted manually'); else fs.unlinkSync(file);
  const after = (await invoke('synthesis')).body;
  expect(after.digest).toBe(before.digest);
  expect(after.results[action].current).toBe(false);
  expect(after.results[action === 'finalize' ? 'handoff' : 'finalize'].current).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('B: legacy receipts without output integrity fail closed on reload', async () => {
  expect((await invoke('finalize', request())).status).toBe(200);
  const columns = db.prepare('PRAGMA table_info(studio_synthesis_jobs)').all() as Array<{name:string}>;
  if (columns.some((column) => column.name === 'output_sha256')) db.exec('ALTER TABLE studio_synthesis_jobs DROP COLUMN output_sha256');
  new StudioSynthesisStore(db);
  expect(db.prepare('SELECT status,output_sha256 FROM studio_synthesis_jobs').get()).toEqual({status:'succeeded',output_sha256:null});
  expect((await invoke('synthesis')).body.results.finalize.current).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['index.html','conversation','defaults','design','artifact'])('B: genuine %s input edits stale both receipts without spending', async (change) => {
  for (const action of actions) expect((await invoke(action, request())).status).toBe(200);
  if (change === 'index.html') fs.writeFileSync(path.join(root,'projects/p/index.html'),'changed');
  if (change === 'conversation') db.prepare("UPDATE messages SET content = 'changed' WHERE id = 'm'").run();
  if (change === 'defaults') db.prepare("UPDATE projects SET metadata_json = '{\"kind\":\"slides\"}' WHERE id = 'p'").run();
  if (change === 'design') {
    const design = new StudioDesignSystems(db).create('A', { title: 'Changed design', body: 'Changed' });
    db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run(design.id,'p');
  }
  if (change === 'artifact') db.prepare('INSERT INTO tabs (project_id,name,position,is_active) VALUES (?,?,?,?)').run('p','index.html',0,1);
  const state = (await invoke('synthesis')).body;
  expect(state.results.finalize.current).toBe(false); expect(state.results.handoff.current).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(actions)('B: %s refuses an input edit while provider I/O is held', async (action) => {
  let started!: () => void; let release!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  fetcher.mockImplementationOnce(async () => {
    started(); await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '# Paid stale document' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  });
  const job = invoke(action, request()); await pending;
  fs.writeFileSync(path.join(root,'projects/p/index.html'),'Changed during provider I/O'); release();
  expect(await job).toMatchObject({ status: 409, body: { error: { code: 'MULTIUSER_SYNTHESIS_STALE' } } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(root,'projects/p',action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'))).toBe(false);
  expect(db.prepare('SELECT status,input_tokens,output_tokens FROM studio_synthesis_jobs').get()).toEqual({status:'failed',input_tokens:11,output_tokens:7});
});
it.each(['DESIGN.md','HANDOFF.md'].flatMap((name) => ['symlink','hardlink'].map((kind) => ({name,kind}))))('B: excluded $name $kind still refuses capture before spend', async ({ name, kind }) => {
  const outside = path.join(root,'secret'); fs.writeFileSync(outside,'Outside');
  if (kind === 'symlink') fs.symlinkSync(outside,path.join(root,'projects/p',name)); else fs.linkSync(outside,path.join(root,'projects/p',name));
  expect((await invoke('handoff',request())).status).toBe(409); expect(fetcher).not.toHaveBeenCalled();
  expect(fs.readFileSync(outside,'utf8')).toBe('Outside');
});
