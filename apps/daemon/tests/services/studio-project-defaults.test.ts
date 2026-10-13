import { describe, expect, it } from 'vitest';
import { observeStudioProjectDefaults, studioProjectDefaultsUnchanged } from '../../src/services/studio-project-defaults.js';

describe('Studio inherited project defaults at admission', () => {
  it.each(['skill', 'design'] as const)('detects empty, replaced and removed %s defaults without observing explicit selections', (kind) => {
    const key = kind === 'skill' ? 'skillId' : 'designSystemId';
    const inherit = { skillId: null, designSystemId: null };
    for (const [before, after] of [[null, 'new'], ['old', 'new'], ['old', null]] as const) {
      const observed = observeStudioProjectDefaults({ [key]: before }, inherit, false);
      expect(observed[kind]).toBe(before);
      expect(studioProjectDefaultsUnchanged(observed, { [key]: before })).toBe(true);
      expect(studioProjectDefaultsUnchanged(observed, { [key]: after })).toBe(false);
      const explicit = observeStudioProjectDefaults({ [key]: before }, { ...inherit, [key]: 'selected' }, false);
      expect(Object.hasOwn(explicit, kind)).toBe(false);
      expect(studioProjectDefaultsUnchanged(explicit, { [key]: after })).toBe(true);
    }
  });
  it('keeps fixed designs and question continuations independent of the live project defaults', () => {
    const observed = observeStudioProjectDefaults({ skillId: 'old', designSystemId: 'old' }, { skillId: null, designSystemId: null }, true);
    expect(observed).toEqual({});
    expect(studioProjectDefaultsUnchanged(observed, { skillId: 'new', designSystemId: 'new' })).toBe(true);
  });
  it('captures values once so later selection never reads a different default', () => {
    const project = { skillId: 'first', designSystemId: 'first' };
    const observed = observeStudioProjectDefaults(project, { skillId: null, designSystemId: null }, false);
    project.skillId = 'second'; project.designSystemId = 'second';
    expect(observed).toEqual({ skill: 'first', design: 'first' });
    expect(studioProjectDefaultsUnchanged(observed, project)).toBe(false);
  });
});
