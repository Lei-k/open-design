import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STUDIO_DEFAULT_ACCENT_COLOR, STUDIO_DEFAULT_CODEX_MODEL, STUDIO_DEFAULT_NOTIFICATIONS, STUDIO_DEFAULT_PET, isStudioCodexModel, isStudioCodexReasoning, isStudioPetPreference,
  MEMORY_TYPES, STUDIO_MEMORY_MAX_ENTRIES, STUDIO_MEMORY_MAX_ENTRY_BYTES, STUDIO_MEMORY_MAX_TOTAL_BYTES,
  type MemoryEntry, type MemoryEntrySource, type StudioSettingsResponse, type StudioSettingsWrite, type UpsertMemoryRequest } from '@open-design/contracts';
import { composeMemoryBody, deriveMemoryId, listMemoryEntries, readMemoryConfig, readMemoryEntry, upsertMemoryEntry, type MemoryChangeEvent } from '../memory.js';

const reservedMemoryIds = new Set(['tree', 'index', 'config', 'events', 'extract', 'extractions', 'verifications', 'rules', 'connectors']);
/** An account memory id: the standard slug shape, never a reserved route segment. */
export const validStudioMemoryId = (id: string) => typeof id === 'string' && /^[a-z0-9_]{1,128}$/.test(id) && !reservedMemoryIds.has(id);
const memoryText = (value: unknown, max: number) => typeof value === 'string' && Buffer.byteLength(value) <= max && !value.includes('\0');
const validEntry = (value: UpsertMemoryRequest) => memoryText(value.name, 512) && value.name.trim().length > 0
  && memoryText(value.description, 2000) && memoryText(value.body, STUDIO_MEMORY_MAX_ENTRY_BYTES)
  && MEMORY_TYPES.includes(value.type) && (value.id === undefined || validStudioMemoryId(value.id));
const validId = validStudioMemoryId;


/** Private preferences and manual memory. Every operation is serialized per
 * actor, including prompt capture, so admission sees a complete mutation.
 * This bus deliberately never subscribes to the host-global memory bus.
 */
export class StudioSettings {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly events = new EventEmitter();
  constructor(private readonly db: Database.Database, private readonly dataRoot: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS multiuser_settings (
      owner_account_id TEXT PRIMARY KEY, custom_instructions TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0), preferences_json TEXT NOT NULL DEFAULT '{}'
    )`);
    const columns = db.prepare('PRAGMA table_info(multiuser_settings)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'preferences_json')) {
      db.exec("ALTER TABLE multiuser_settings ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}'");
    }
    this.events.setMaxListeners(0);
  }

  read(owner: string): StudioSettingsResponse {
    const row = this.db.prepare('SELECT custom_instructions, revision, preferences_json FROM multiuser_settings WHERE owner_account_id = ?')
      .get(owner) as { custom_instructions: string; revision: number; preferences_json: string } | undefined;
    const preferences = JSON.parse(row?.preferences_json ?? '{}') as Partial<StudioSettingsResponse['config']>;
    return { config: { customInstructions: row?.custom_instructions ?? '',
      accentColor: preferences.accentColor ?? STUDIO_DEFAULT_ACCENT_COLOR,
      notifications: { ...STUDIO_DEFAULT_NOTIFICATIONS, ...preferences.notifications },
      // A stored choice outside the current list (a retired model) reads as the default.
      codexModel: isStudioCodexModel(preferences.codexModel?.model) && isStudioCodexReasoning(preferences.codexModel?.reasoning)
        ? { model: preferences.codexModel.model, reasoning: preferences.codexModel.reasoning } : { ...STUDIO_DEFAULT_CODEX_MODEL },
      pet: isStudioPetPreference(preferences.pet) ? preferences.pet : { ...STUDIO_DEFAULT_PET, custom: { ...STUDIO_DEFAULT_PET.custom } } },
    revision: row?.revision ?? 0 };
  }

  update(owner: string, input: StudioSettingsWrite): StudioSettingsResponse | null {
    return this.db.transaction(() => {
      const current = this.read(owner);
      if (current.revision !== input.revision) return null;
      const config = { customInstructions: input.customInstructions === undefined ? current.config.customInstructions : input.customInstructions ?? '',
        accentColor: input.accentColor === undefined ? current.config.accentColor : input.accentColor?.toLowerCase() ?? STUDIO_DEFAULT_ACCENT_COLOR,
        notifications: input.notifications === undefined ? current.config.notifications : input.notifications ?? STUDIO_DEFAULT_NOTIFICATIONS,
        codexModel: input.codexModel === undefined ? current.config.codexModel : input.codexModel ?? STUDIO_DEFAULT_CODEX_MODEL,
        pet: input.pet === undefined ? current.config.pet : input.pet ?? STUDIO_DEFAULT_PET };
      this.db.prepare(`INSERT INTO multiuser_settings (owner_account_id, custom_instructions, revision, preferences_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_account_id) DO UPDATE SET custom_instructions = excluded.custom_instructions, revision = excluded.revision,
        preferences_json = excluded.preferences_json`)
        .run(owner, config.customInstructions, input.revision + 1, JSON.stringify({ accentColor: config.accentColor, notifications: config.notifications, codexModel: config.codexModel, pet: config.pet }));
      return this.read(owner);
    }).immediate();
  }

  async withMemory<T>(owner: string, operation: (root: string) => Promise<T>): Promise<T> {
    const previous = this.pending.get(owner) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const parent = path.join(this.dataRoot, 'studio-accounts');
      const root = path.join(parent, createHash('sha256').update(owner).digest('hex'));
      // Runtime children never receive these directories in their filesystem
      // sandbox. Reject symlink substitutions instead of resolving through them.
      for (const directory of [parent, root, path.join(root, 'memory')]) {
        await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid memory store');
        await fs.chmod(directory, 0o700);
      }
      return operation(root);
    });
    this.pending.set(owner, next);
    try { return await next; }
    finally { if (this.pending.get(owner) === next) this.pending.delete(owner); }
  }

  /** Admission capture: instructions, the account's own memory and its memory hooks (#62). */
  capture(owner: string): Promise<{ userInstructions: string; memoryBody: string;
    memoryHooks: { profile: boolean; rewrite: boolean; verify: boolean } }> {
    return this.withMemory(owner, async (root) => {
      const config = await readMemoryConfig(root);
      return {
        userInstructions: this.read(owner).config.customInstructions,
        memoryBody: await composeMemoryBody(root),
        memoryHooks: { profile: config.profileEnabled, rewrite: config.rewriteEnabled, verify: config.verifyEnabled },
      };
    });
  }

  publish(owner: string, event: Omit<MemoryChangeEvent, 'at'>): void {
    this.events.emit(owner, { ...event, at: Date.now() });
  }
  subscribe(owner: string, listener: (event: MemoryChangeEvent) => void): () => void {
    this.events.on(owner, listener);
    return () => { this.events.off(owner, listener); };
  }
  /** Extraction and verification records for this account's own stream (#62). */
  publishChannel(owner: string, channel: 'extraction' | 'verify', data: unknown): void {
    this.events.emit(`${owner}\0channel`, channel, data);
  }
  subscribeChannels(owner: string, listener: (channel: 'extraction' | 'verify', data: unknown) => void): () => void {
    this.events.on(`${owner}\0channel`, listener);
    return () => { this.events.off(`${owner}\0channel`, listener); };
  }
}

/** One account memory entry, or null for an invalid or missing id. Callers hold the account's memory lock. */
export async function readStudioMemoryEntry(root: string, id: string): Promise<MemoryEntry | null> {
  return validId(id) ? await readMemoryEntry(root, id) as MemoryEntry | null : null;
}

/**
 * Write one entry into an account memory root within the account limits
 * (entry size, entry count and total body bytes). Callers hold the account's
 * memory lock (`StudioSettings.withMemory`). `source` records who wrote it.
 */
export async function saveStudioMemoryEntry(root: string, draft: UpsertMemoryRequest,
  source: MemoryEntrySource = 'manual'): Promise<MemoryEntry | 'invalid' | 'limit'> {
  if (!validEntry(draft)) return 'invalid';
  const id = draft.id ?? deriveMemoryId(draft.type, draft.name);
  if (!validId(id)) return 'invalid';
  const entries = await listMemoryEntries(root) as MemoryEntry[];
  if (!entries.some((entry) => entry.id === id) && entries.length >= STUDIO_MEMORY_MAX_ENTRIES) return 'limit';
  const current = await Promise.all(entries.filter((entry) => entry.id !== id).map((entry) => readStudioMemoryEntry(root, entry.id)));
  const total = current.reduce((bytes, entry) => bytes + Buffer.byteLength(entry?.body ?? ''), Buffer.byteLength(draft.body));
  if (total > STUDIO_MEMORY_MAX_TOTAL_BYTES) return 'limit';
  return await upsertMemoryEntry(root, { ...draft, id }, { source, silent: true }) as MemoryEntry;
}
