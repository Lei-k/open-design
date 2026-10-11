import Database from 'better-sqlite3';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { registerStudioCritiqueRoutes } from '../../src/routes/studio-critique.js';

it('boots a three-terminal history, preserves the earliest frame and records one issue across reboots', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE multiuser_runs (id TEXT PRIMARY KEY, status TEXT, request_json TEXT, critique_reconciled INTEGER);
      INSERT INTO multiuser_runs VALUES ('damaged', 'succeeded', '{"critique":true}', 1), ('healthy', 'succeeded', '{"critique":true}', 1);
      CREATE TABLE studio_critique_events (run_id TEXT, seq INTEGER, event TEXT, data TEXT, PRIMARY KEY (run_id, seq));
      CREATE TABLE multiuser_recovery_issues (run_id TEXT, code TEXT, PRIMARY KEY (run_id, code));
      INSERT INTO studio_critique_events VALUES ('damaged', 2, 'critique.ship', '{"status":"shipped"}'),
        ('damaged', 4, 'critique.interrupted', '{}'), ('damaged', 6, 'critique.failed', '{}'),
        ('healthy', 2, 'critique.ship', '{"status":"shipped"}');`);
    const recordIssue = vi.fn((runId: string, code: string) => {
      db.prepare('INSERT OR IGNORE INTO multiuser_recovery_issues VALUES (?, ?)').run(runId, code);
    });
    const input = { db, dataRoot: process.env.OD_DATA_DIR!, dataRootCanonical: process.env.OD_DATA_DIR!,
      accountExists: () => true, owned: () => null, canView: () => false, start: async () => {},
      interrupt: () => {}, recover: vi.fn(), recordIssue };
    const expected = db.prepare('SELECT * FROM studio_critique_events WHERE seq = 2 ORDER BY run_id').all();
    for (let boot = 0; boot < 2; boot++) {
      expect(() => registerStudioCritiqueRoutes(express(), input)).not.toThrow();
      expect(db.prepare('SELECT * FROM studio_critique_events ORDER BY run_id').all()).toEqual(expected);
      expect(db.prepare('SELECT * FROM multiuser_recovery_issues').all()).toEqual([
        { run_id: 'damaged', code: 'MULTIUSER_CRITIQUE_DUPLICATE_TERMINAL' },
      ]);
      expect(() => db.prepare('INSERT INTO studio_critique_events VALUES (?, 8, ?, ?)').run('damaged', 'critique.failed', '{}')).toThrow(/UNIQUE/);
    }
    expect(recordIssue).toHaveBeenCalledOnce();
    expect(input.recover).not.toHaveBeenCalled();
  } finally { db.close(); }
});
