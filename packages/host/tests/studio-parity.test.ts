import { describe, expect, it } from 'vitest';
import { STUDIO_HOST_PARITY, STUDIO_WEB_CONDITIONS, STUDIO_WEB_ACTION_CONDITIONS, STUDIO_WEB_CONDITION_DECISIONS } from '../src/index.js';
import { createMockOpenDesignHost } from '../src/testing.js';

describe('Studio host parity decisions (#52)', () => {
  it('every bridge and shipped Web replacement names owned, tested condition handling (#67)', () => {
    const covered = new Set(Object.values(STUDIO_WEB_ACTION_CONDITIONS).flat());
    expect([...covered].sort()).toEqual([...STUDIO_WEB_CONDITIONS].sort());
    expect(Object.keys(STUDIO_WEB_CONDITION_DECISIONS).sort()).toEqual([...STUDIO_WEB_CONDITIONS].sort());
    for (const decision of Object.values(STUDIO_HOST_PARITY)) {
      expect(STUDIO_WEB_ACTION_CONDITIONS[decision.webAction].length).toBeGreaterThan(0);
      for (const condition of STUDIO_WEB_ACTION_CONDITIONS[decision.webAction]) {
        const policy = STUDIO_WEB_CONDITION_DECISIONS[condition];
        expect(policy.owner).toBeTruthy(); expect(policy.handling.length).toBeGreaterThan(30); expect(policy.test).toBeTruthy();
      }
    }
    for (const shipped of ['notifications', 'clipboard', 'directory', 'file-upload', 'download', 'about', 'pet', 'clear-data', 'rendered-export', 'public-link', 'deploy'])
      expect(Object.keys(STUDIO_WEB_ACTION_CONDITIONS)).toContain(shipped);
  });
  it('covers every native action, including optional bridge actions', () => {
    const host = createMockOpenDesignHost({ appearance: { setTheme() {} }, project: { async pickWorkingDir() { return { ok: false, canceled: true }; } } });
    const actions = Object.entries(host).flatMap(([domain, value]) => {
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).filter(([, action]) => typeof action === 'function').map(([action]) => `${domain}.${action}`);
    });
    expect(Object.keys(STUDIO_HOST_PARITY).sort()).toEqual(actions.sort());
    for (const decision of Object.values(STUDIO_HOST_PARITY)) {
      expect(decision.equivalent.length).toBeGreaterThan(30);
      expect(decision.strategy).not.toBe('not-applicable');
      if ('nativeApplicability' in decision) {
        expect(decision.nativeApplicability).toBe('not-applicable');
        expect(decision.productDecision).toContain('#67');
        expect(decision.strategy).toBe('browser');
      }
    }
  });
});
