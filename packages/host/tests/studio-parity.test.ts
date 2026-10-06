import { describe, expect, it } from 'vitest';
import { STUDIO_HOST_PARITY } from '../src/index.js';
import { createMockOpenDesignHost } from '../src/testing.js';

describe('Studio host parity decisions (#52)', () => {
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
    }
  });
});
