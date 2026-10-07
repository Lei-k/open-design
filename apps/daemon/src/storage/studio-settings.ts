import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { StudioSettingsResponse, UpdateStudioSettingsRequest } from '@open-design/contracts';
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
      revision INTEGER NOT NULL CHECK(revision >= 0)
    )`);
    this.events.setMaxListeners(0);
  }

  read(owner: string): StudioSettingsResponse {
    const row = this.db.prepare('SELECT custom_instructions, revision FROM multiuser_settings WHERE owner_account_id = ?')
      .get(owner) as { custom_instructions: string; revision: number } | undefined;
    return { config: { customInstructions: row?.custom_instructions ?? '' }, revision: row?.revision ?? 0 };
  }

  update(owner: string, input: UpdateStudioSettingsRequest): StudioSettingsResponse | null {
    return this.db.transaction(() => {
      if (this.read(owner).revision !== input.revision) return null;
      this.db.prepare(`INSERT INTO multiuser_settings (owner_account_id, custom_instructions, revision) VALUES (?, ?, ?)
        ON CONFLICT(owner_account_id) DO UPDATE SET custom_instructions = excluded.custom_instructions, revision = excluded.revision`)
        .run(owner, input.customInstructions, input.revision + 1);
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
