// #62 (S38 review repair): background memory extraction re-checks the turn's
// authority and its pinned credential after every yield. The memory read and
// the provider response are the two waits: a key removed or a pilot withdrawn
// during the read means no provider call, and a key removed (or extraction
// switched off) while the provider answers means no memory write.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MemoryExtractionRecord } from '@open-design/contracts';
import { listMemoryEntries, writeMemoryConfig } from '../src/memory.js';
import { StudioMemoryAutomation, type StudioMemoryTurn, type StudioMemoryTurnKey } from '../src/services/studio-memory-automation.js';
import { StudioSettings } from '../src/storage/studio-settings.js';

/**
 * Holds a save inside its preparatory phase: after the extraction's last
 * pre-save checks and the save's own reads, before the entry is written.
 */
const saveGate = vi.hoisted(() => ({ armed: false, hold: null as null | { reached: Promise<void>; release(): void } }));
vi.mock('../src/memory.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/memory.js')>();
  return { ...real, upsertMemoryEntry: async (...args: Parameters<typeof real.upsertMemoryEntry>) => {
    if (saveGate.armed) {
      saveGate.armed = false;
      let release!: () => void; let reached!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      saveGate.hold = { release, reached: new Promise<void>((resolve) => { reached = resolve; }) };
      reached(); await gate;
    }
    return real.upsertMemoryEntry(...args);
  } };
});

const OWNER = 'account-a';
const KEY: StudioMemoryTurnKey = { apiKey: 'sk-turn-pinned-key-0123456789', model: 'turn-model', credentialSource: 'account-key' };

/** Holds the next account-memory operation once armed, so a test can act while it waits. */
class GatedSettings extends StudioSettings {
  armed = false;
  held: { release(): void; reached: Promise<void> } | null = null;
  override withMemory<T>(owner: string, operation: (root: string) => Promise<T>): Promise<T> {
    if (!this.armed) return super.withMemory(owner, operation);
    this.armed = false;
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.held = { release, reached: new Promise<void>((resolve) => { reached = resolve; }) };
    return super.withMemory(owner, async (root) => { reached(); await gate; return operation(root); });
  }
}

let dir: string; let db: Database.Database; let settings: GatedSettings; let automation: StudioMemoryAutomation;
let calls: Array<{ authorization: string }>; let providerGate: Promise<void> | null; let releaseProvider: () => void;
let providerReached: Promise<void>; let markProviderReached: () => void; let lastSignal: AbortSignal | undefined;
let state: { key: StudioMemoryTurnKey | null; pilot: boolean };

const extraction = JSON.stringify({ entries: [{ type: 'feedback', name: 'Prefers dense dashboards', description: 'Layout',
  body: 'REVOCATION_MARKER likes dense dashboards.' }] });
const provider: typeof fetch = async (_url, init) => {
  calls.push({ authorization: new Headers(init?.headers).get('authorization') ?? '' });
  lastSignal = init?.signal ?? undefined;
  markProviderReached();
  if (providerGate) await providerGate;
  if (lastSignal?.aborted) throw lastSignal.reason;
  const events = [{ type: 'response.output_text.delta', delta: extraction },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 2 } } }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'od-studio-memory-automation-'));
  db = new Database(':memory:');
  settings = new GatedSettings(db, dir);
  automation = new StudioMemoryAutomation({ db, settings, fetch: provider });
  calls = []; providerGate = null; lastSignal = undefined; state = { key: KEY, pilot: true };
  saveGate.armed = false; saveGate.hold = null;
  providerReached = new Promise<void>((resolve) => { markProviderReached = resolve; });
  // Extraction on, verification off: the only background work is extraction.
  await settings.withMemory(OWNER, (root) => writeMemoryConfig(root, { enabled: true, chatExtractionEnabled: true, verifyEnabled: false }));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const turn = (): StudioMemoryTurn => ({ owner: OWNER, runId: 'run-1', projectId: 'project-1', source: 'personal_api_key',
  userText: 'Build me a dense dashboard.', assistantText: 'Done.', hadArtifact: false,
  resolveKey: () => state.key, allowed: () => state.pilot });
const records = () => automation.list(OWNER, 'extractions') as MemoryExtractionRecord[];
const entries = () => settings.withMemory(OWNER, (root) => listMemoryEntries(root) as Promise<unknown[]>);
/** Holds the memory read that follows the "running" record (the read just before the provider call). */
const holdMemoryReadAfterRunning = () => {
  const stop = settings.subscribeChannels(OWNER, (_channel, data) => {
    if ((data as MemoryExtractionRecord).phase === 'running') { settings.armed = true; stop(); }
  });
};
const holdProvider = () => { providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; }); };

it('makes no provider call when the key is removed during a delayed memory read', async () => {
  holdMemoryReadAfterRunning();
  const done = automation.afterTurn(turn());
  await until(() => settings.held !== null); await settings.held!.reached;
  state.key = null;
  settings.held!.release(); await done;
  expect(calls).toEqual([]);
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
  expect(await entries()).toEqual([]);
});

it('makes no provider call when the key is replaced during a delayed memory read', async () => {
  holdMemoryReadAfterRunning();
  const done = automation.afterTurn(turn());
  await until(() => settings.held !== null); await settings.held!.reached;
  state.key = { ...KEY, apiKey: 'sk-a-different-key-at-a-new-revision' };
  settings.held!.release(); await done;
  expect(calls).toEqual([]);
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
});

it('makes no provider call when the pilot is withdrawn during a delayed memory read', async () => {
  holdMemoryReadAfterRunning();
  const done = automation.afterTurn(turn());
  await until(() => settings.held !== null); await settings.held!.reached;
  state.pilot = false;
  settings.held!.release(); await done;
  expect(calls).toEqual([]);
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
});

it('writes no memory when the key is removed while the provider answers', async () => {
  holdProvider();
  const done = automation.afterTurn(turn());
  await providerReached;
  expect(calls).toEqual([{ authorization: `Bearer ${KEY.apiKey}` }]);
  state.key = null;
  releaseProvider(); await done;
  expect(await entries()).toEqual([]);
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
});

it('writes no memory when extraction is switched off while the provider answers', async () => {
  holdProvider();
  const done = automation.afterTurn(turn());
  await providerReached;
  await settings.withMemory(OWNER, (root) => writeMemoryConfig(root, { chatExtractionEnabled: false }));
  releaseProvider(); await done;
  expect(await entries()).toEqual([]);
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'chat-disabled' });
});

it('aborts an in-flight extraction on close and writes nothing', async () => {
  holdProvider();
  const done = automation.afterTurn(turn());
  await providerReached;
  automation.close();
  expect(lastSignal?.aborted).toBe(true);
  releaseProvider(); await done;
  expect(await entries()).toEqual([]);
  expect(records()[0]?.phase).not.toBe('success');
  // A closed service starts no further background work.
  calls.length = 0;
  await automation.afterTurn(turn());
  expect(calls).toEqual([]);
});

/** Holds the extraction's own memory save, then revokes while it waits in its pre-write I/O. */
async function revokeDuringSave(revoke: () => void) {
  saveGate.armed = true;
  const done = automation.afterTurn(turn());
  await until(() => saveGate.hold !== null); await saveGate.hold!.reached;
  revoke();
  saveGate.hold!.release(); await done;
  expect(calls).toHaveLength(1);
  expect(await entries()).toEqual([]);
  expect(records()[0]?.phase).not.toBe('success');
}

it('writes no memory when the key is removed while the save prepares its write', async () => {
  await revokeDuringSave(() => { state.key = null; });
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
});

it('writes no memory when the pilot is withdrawn while the save prepares its write', async () => {
  await revokeDuringSave(() => { state.pilot = false; });
  expect(records()[0]).toMatchObject({ phase: 'skipped', reason: 'source-unavailable' });
});

it('writes no memory when the daemon shuts down while the save prepares its write', async () => {
  await revokeDuringSave(() => { automation.close(); });
});

it('still extracts on an unchanged source (control)', async () => {
  await automation.afterTurn(turn());
  expect(calls).toHaveLength(1);
  expect(records()[0]).toMatchObject({ phase: 'success', writtenCount: 1 });
  expect(await entries()).toHaveLength(1);
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}
