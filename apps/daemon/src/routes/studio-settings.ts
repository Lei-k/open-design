import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  MEMORY_TYPES, STUDIO_MEMORY_MAX_ENTRIES, STUDIO_MEMORY_MAX_ENTRY_BYTES, STUDIO_MEMORY_MAX_TOTAL_BYTES,
  type MemoryEntry, type UpdateStudioSettingsRequest, type UpsertMemoryRequest,
} from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { StudioSettings } from '../storage/studio-settings.js';
import {
  buildMemoryTree, composeMemoryBody, deleteMemoryEntry, deriveMemoryId,
  listMemoryEntries, readMemoryConfig, readMemoryEntry, readMemoryIndex,
  upsertMemoryEntry, writeMemoryConfig, writeMemoryIndex,
} from '../memory.js';

const reservedIds = new Set(['tree', 'index', 'config', 'events', 'extract', 'extractions', 'verifications', 'rules', 'connectors']);
const validId = (id: string) => typeof id === 'string' && /^[a-z0-9_]{1,128}$/.test(id) && !reservedIds.has(id);
const text = (value: unknown, max: number) => typeof value === 'string' && Buffer.byteLength(value) <= max && !value.includes('\0');
const validEntry = (value: UpsertMemoryRequest) => text(value.name, 512) && value.name.trim().length > 0
  && text(value.description, 2000) && text(value.body, STUDIO_MEMORY_MAX_ENTRY_BYTES)
  && MEMORY_TYPES.includes(value.type) && (value.id === undefined || validId(value.id));
const flags = (config: { enabled: boolean; profileEnabled: boolean }) => ({
  enabled: config.enabled, profileEnabled: config.profileEnabled,
  chatExtractionEnabled: false, rewriteEnabled: false, verifyEnabled: false, extraction: null,
});

/** Standard aliases terminate here, ahead of all host-global settings routes. */
export function registerStudioSettingsRoutes(app: Express, input: { db: Database.Database; dataRoot: string }): StudioSettings {
  const store = new StudioSettings(input.db, input.dataRoot);
  const handle = (operation: (req: Request, res: Response, owner: string) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch { if (!res.headersSent && multiUserStreamAllowed(res)) sendApiError(res, 500, 'INTERNAL_ERROR', 'settings operation failed'); }
  };
  const prefix = '/api/multiuser/settings';
  app.get(`${prefix}/config`, handle((_req, res, owner) => { res.json(store.read(owner)); }));
  app.put(`${prefix}/config`, handle((req, res, owner) => {
    const updated = store.update(owner, req.body as UpdateStudioSettingsRequest);
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
    const config = await writeMemoryConfig(root, { ...req.body, chatExtractionEnabled: false, rewriteEnabled: false, verifyEnabled: false, extraction: null });
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
    res.once('close', unsubscribe);
  }));
  const read = async (root: string, id: string): Promise<MemoryEntry | null> => validId(id) ? await readMemoryEntry(root, id) as MemoryEntry | null : null;
  const save = async (root: string, draft: UpsertMemoryRequest): Promise<MemoryEntry | 'invalid' | 'limit'> => {
    if (!validEntry(draft)) return 'invalid';
    const id = draft.id ?? deriveMemoryId(draft.type, draft.name);
    if (!validId(id)) return 'invalid';
    const entries = await listMemoryEntries(root) as MemoryEntry[];
    if (!entries.some((entry) => entry.id === id) && entries.length >= STUDIO_MEMORY_MAX_ENTRIES) return 'limit';
    const current = await Promise.all(entries.filter((entry) => entry.id !== id).map((entry) => read(root, entry.id)));
    const total = current.reduce((bytes, entry) => bytes + Buffer.byteLength(entry?.body ?? ''), Buffer.byteLength(draft.body));
    if (total > STUDIO_MEMORY_MAX_TOTAL_BYTES) return 'limit';
    return await upsertMemoryEntry(root, { ...draft, id }, { source: 'manual', silent: true }) as MemoryEntry;
  };
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
  return store;
}
