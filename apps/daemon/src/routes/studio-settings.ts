import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  STUDIO_MEMORY_CONFIG_FIELDS, parseStudioSettingsWrite, type AnnotationDistillInput, type MemoryEntry, type UpsertMemoryRequest,
} from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { StudioSettings, readStudioMemoryEntry, saveStudioMemoryEntry } from '../storage/studio-settings.js';
import { StudioMemoryAutomation } from '../services/studio-memory-automation.js';
import { distillRulesFromAnnotations } from '../memory-rules.js';
import {
  buildMemoryTree, composeMemoryBody, deleteMemoryEntry,
  listMemoryEntries, readMemoryConfig, readMemoryIndex,
  writeMemoryConfig, writeMemoryIndex,
} from '../memory.js';

export { readStudioMemoryEntry, saveStudioMemoryEntry };
/** The account's own memory switches (#62). The host provider override is never exposed: extraction uses the turn's own source. */
const flags = (config: { enabled: boolean; profileEnabled: boolean; chatExtractionEnabled: boolean; rewriteEnabled: boolean; verifyEnabled: boolean }) => ({
  enabled: config.enabled, profileEnabled: config.profileEnabled, chatExtractionEnabled: config.chatExtractionEnabled,
  rewriteEnabled: config.rewriteEnabled, verifyEnabled: config.verifyEnabled, extraction: null,
});

/** Standard aliases terminate here, ahead of all host-global settings routes. */
export function registerStudioSettingsRoutes(app: Express, input: { db: Database.Database; dataRoot: string; fetch?: typeof fetch; clock?: () => number }):
  StudioSettings & { automation: StudioMemoryAutomation } {
  const store = new StudioSettings(input.db, input.dataRoot);
  const automation = new StudioMemoryAutomation({ db: input.db, settings: store,
    ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.clock ? { clock: input.clock } : {}) });
  const handle = (operation: (req: Request, res: Response, owner: string) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch { if (!res.headersSent && multiUserStreamAllowed(res)) sendApiError(res, 500, 'INTERNAL_ERROR', 'settings operation failed'); }
  };
  const prefix = '/api/multiuser/settings';
  app.get(`${prefix}/config`, handle((_req, res, owner) => { res.json(store.read(owner)); }));
  app.put(`${prefix}/config`, handle((req, res, owner) => {
    const draft = parseStudioSettingsWrite(req.body);
    if (!draft) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid account preferences');
    const updated = store.update(owner, draft);
    if (!updated) return sendApiError(res, 409, 'CONFLICT', 'settings changed; reload before saving');
    res.json(updated);
  }));
  const memory = `${prefix}/memory`;
  const inMemory = (operation: (req: Request, res: Response, owner: string, root: string) => Promise<unknown>) =>
    handle((req, res, owner) => store.withMemory(owner, async (root) => {
      if (!multiUserStreamAllowed(res)) return;
      await operation(req, res, owner, root);
    }));
  app.get(memory, inMemory(async (_req, res, _owner, root) => {
    const [config, index, entries] = await Promise.all([readMemoryConfig(root), readMemoryIndex(root), listMemoryEntries(root)]);
    if (multiUserStreamAllowed(res)) res.json({ ...flags(config), index, entries, rootDir: '' });
  }));
  app.get(`${memory}/tree`, inMemory(async (_req, res, _owner, root) => {
    const [config, tree] = await Promise.all([readMemoryConfig(root), buildMemoryTree(root)]);
    if (multiUserStreamAllowed(res)) res.json({ enabled: config.enabled, rootDir: '', tree });
  }));
  app.get(`${memory}/system-prompt`, inMemory(async (_req, res, _owner, root) => {
    const body = await composeMemoryBody(root);
    if (multiUserStreamAllowed(res)) res.json({ body });
  }));
  app.put(`${memory}/index`, inMemory(async (req, res, owner, root) => {
    await writeMemoryIndex(root, req.body.index, { silent: true });
    store.publish(owner, { kind: 'index' });
    if (multiUserStreamAllowed(res)) res.json({ index: req.body.index });
  }));
  app.patch(`${memory}/config`, inMemory(async (req, res, owner, root) => {
    const patch = Object.fromEntries(STUDIO_MEMORY_CONFIG_FIELDS.filter((key) => typeof req.body?.[key] === 'boolean').map((key) => [key, req.body[key]]));
    const config = await writeMemoryConfig(root, { ...patch, extraction: null });
    store.publish(owner, { kind: 'config', enabled: config.enabled });
    if (multiUserStreamAllowed(res)) res.json(flags(config));
  }));
  app.get(`${memory}/events`, handle((_req, res, owner) => {
    if (!multiUserStreamAllowed(res)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    bindMultiUserStream(res);
    res.write('event: connected\ndata: {}\n\n');
    const unsubscribe = store.subscribe(owner, (event) => {
      if (multiUserStreamAllowed(res)) res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // Extraction and verification records of this account only (#62).
    const unsubscribeChannels = store.subscribeChannels(owner, (channel, data) => {
      if (multiUserStreamAllowed(res)) res.write(`event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    res.once('close', () => { unsubscribe(); unsubscribeChannels(); });
  }));
  // Automatic memory history (#62): registered ahead of the `:id` entry routes.
  for (const kind of ['extractions', 'verifications'] as const) {
    app.get(`${memory}/${kind}`, handle((_req, res, owner) => {
      if (multiUserStreamAllowed(res)) res.json({ [kind]: automation.list(owner, kind) });
    }));
    app.delete(`${memory}/${kind}`, handle((_req, res, owner) => {
      if (multiUserStreamAllowed(res)) res.json({ removed: automation.remove(owner, kind) });
    }));
    // A foreign or unknown id removes nothing: the same `{ removed: 0 }`.
    app.delete(`${memory}/${kind}/:id`, handle((req, res, owner) => {
      if (multiUserStreamAllowed(res)) res.json({ removed: automation.remove(owner, kind, String(req.params.id)) });
    }));
  }
  // Rule proposals from annotations: the deterministic distiller only. There is
  // no turn here, so no provider is billed and no host key can be reached.
  app.post(`${memory}/rules/suggest`, inMemory(async (req, res, _owner, root) => {
    const annotations = (Array.isArray(req.body?.annotations) ? req.body.annotations : []) as AnnotationDistillInput[];
    const result = await distillRulesFromAnnotations(root, { annotations }, { suggest: async () => null as never });
    if (multiUserStreamAllowed(res)) res.json(result);
  }));
  // Imperative extract: the regex pack on the user's own text. LLM extraction
  // happens after a turn on that turn's source, never from a request body.
  app.post(`${memory}/extract`, handle(async (req, res, owner) => {
    const changed = await automation.extractUserText(owner, typeof req.body?.userMessage === 'string' ? req.body.userMessage : '');
    if (multiUserStreamAllowed(res)) res.json({ changed, attemptedLLM: false });
  }));
  const read = readStudioMemoryEntry;
  const save = (root: string, draft: UpsertMemoryRequest) => saveStudioMemoryEntry(root, draft);
  const saveResponse = async (req: Request, res: Response, owner: string, root: string, partial = false) => {
    const id = req.params.id === undefined ? undefined : String(req.params.id);
    const previous = id === undefined ? null : await read(root, id);
    if (id !== undefined && !previous && !(id === 'user_profile' && req.body.type === 'profile')) return sendApiError(res, 404, 'NOT_FOUND', 'memory not found');
    const draft = { ...(partial ? previous : {}), ...req.body, ...(id === undefined ? {} : { id }) } as UpsertMemoryRequest;
    // Body ids never retarget a path-qualified write.
    if (req.body.id !== undefined && id !== undefined && req.body.id !== id) return sendApiError(res, 400, 'BAD_REQUEST', 'memory id mismatch');
    if (!multiUserStreamAllowed(res)) return;
    const entry = await save(root, draft);
    if (entry === 'invalid' || entry === 'limit') return sendApiError(res, 400, 'BAD_REQUEST', entry === 'limit' ? 'memory limit reached' : 'invalid memory entry');
    store.publish(owner, { kind: 'upsert', id: entry.id });
    const tree = partial ? await buildMemoryTree(root) : undefined;
    if (multiUserStreamAllowed(res)) res.json({ entry, ...(tree ? { tree } : {}) });
  };
  app.patch(`${memory}/tree/:id`, inMemory((req, res, owner, root) => saveResponse(req, res, owner, root, true)));
  app.post(memory, inMemory((req, res, owner, root) => saveResponse(req, res, owner, root)));
  app.get(`${memory}/:id`, inMemory(async (req, res, _owner, root) => {
    const entry = await read(root, String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!entry) return sendApiError(res, 404, 'NOT_FOUND', 'memory not found');
    res.json({ entry });
  }));
  app.put(`${memory}/:id`, inMemory((req, res, owner, root) => saveResponse(req, res, owner, root)));
  app.delete(`${memory}/:id`, inMemory(async (req, res, owner, root) => {
    const id = String(req.params.id);
    if (!await read(root, id)) return sendApiError(res, 404, 'NOT_FOUND', 'memory not found');
    if (!multiUserStreamAllowed(res)) return;
    await deleteMemoryEntry(root, id);
    store.publish(owner, { kind: 'delete', id });
    if (multiUserStreamAllowed(res)) res.json({ ok: true });
  }));
  return Object.assign(store, { automation });
}
