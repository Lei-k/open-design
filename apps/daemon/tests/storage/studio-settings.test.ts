import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { STUDIO_DEFAULT_NOTIFICATIONS, STUDIO_DEFAULT_CODEX_MODEL } from '@open-design/contracts';
import { StudioSettings } from '../../src/storage/studio-settings.js';

it('upgrades the existing instruction schema and preserves preferences across store reconstruction', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE multiuser_settings (owner_account_id TEXT PRIMARY KEY,
      custom_instructions TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0));
      INSERT INTO multiuser_settings VALUES ('alice', 'Keep my existing instructions', 7)`);
    const first = new StudioSettings(db, 'unused-by-preference-store');
    expect(first.read('alice')).toEqual({ config: { customInstructions: 'Keep my existing instructions',
      accentColor: '#353535', notifications: STUDIO_DEFAULT_NOTIFICATIONS, codexModel: STUDIO_DEFAULT_CODEX_MODEL }, revision: 7 });
    const saved = first.update('alice', { revision: 7, accentColor: '#1A74FF' });
    expect(saved?.revision).toBe(8);
    expect(first.update('alice', { revision: 7, customInstructions: 'stale' })).toBeNull();
    const restarted = new StudioSettings(db, 'unused-by-preference-store');
    expect(restarted.read('alice')).toEqual(saved);
    expect(restarted.read('bob').config.accentColor).toBe('#353535');
    expect(restarted.update('alice', { revision: 8, accentColor: null })?.config.customInstructions).toBe('Keep my existing instructions');
  } finally { db.close(); }
});
