import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STUDIO_DEFAULT_ACCENT_COLOR, STUDIO_DEFAULT_NOTIFICATIONS,
  type StudioSettingsResponse, type StudioSettingsWrite } from '@open-design/contracts';
import { composeMemoryBody, type MemoryChangeEvent } from '../memory.js';

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
      notifications: { ...STUDIO_DEFAULT_NOTIFICATIONS, ...preferences.notifications } }, revision: row?.revision ?? 0 };
  }

  update(owner: string, input: StudioSettingsWrite): StudioSettingsResponse | null {
    return this.db.transaction(() => {
      const current = this.read(owner);
      if (current.revision !== input.revision) return null;
      const config = { customInstructions: input.customInstructions === undefined ? current.config.customInstructions : input.customInstructions ?? '',
        accentColor: input.accentColor === undefined ? current.config.accentColor : input.accentColor?.toLowerCase() ?? STUDIO_DEFAULT_ACCENT_COLOR,
        notifications: input.notifications === undefined ? current.config.notifications : input.notifications ?? STUDIO_DEFAULT_NOTIFICATIONS };
      this.db.prepare(`INSERT INTO multiuser_settings (owner_account_id, custom_instructions, revision, preferences_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_account_id) DO UPDATE SET custom_instructions = excluded.custom_instructions, revision = excluded.revision,
        preferences_json = excluded.preferences_json`)
        .run(owner, config.customInstructions, input.revision + 1, JSON.stringify({ accentColor: config.accentColor, notifications: config.notifications }));
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

  capture(owner: string): Promise<{ userInstructions: string; memoryBody: string }> {
    return this.withMemory(owner, async (root) => ({
      userInstructions: this.read(owner).config.customInstructions,
      memoryBody: await composeMemoryBody(root),
    }));
  }

  publish(owner: string, event: Omit<MemoryChangeEvent, 'at'>): void {
    this.events.emit(owner, { ...event, at: Date.now() });
  }
  subscribe(owner: string, listener: (event: MemoryChangeEvent) => void): () => void {
    this.events.on(owner, listener);
    return () => { this.events.off(owner, listener); };
  }
}
