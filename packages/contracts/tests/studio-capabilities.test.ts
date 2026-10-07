import { expect, it } from 'vitest';
import { isStudioMessageIdInNamespace, parseStudioMessageFeedback, parseStudioRuntimeCapabilities, STUDIO_PARITY_LANES } from '../src/api/studio-parity.js';
const features = Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: 'Not yet available', privateData: 'must not emit' }]));
it('projects only declared public fields and every lane', () => {
  const result = parseStudioRuntimeCapabilities({ schemaVersion: 1, shell: 'studio', features, privateData: 'must not emit' });
  expect(result?.shell).toBe('studio');
  expect(Object.keys(result!.features)).toHaveLength(STUDIO_PARITY_LANES.length);
  expect(JSON.stringify(result)).not.toContain('must not emit');
});
it.each([null, {}, { schemaVersion: 1, shell: 'studio', features: {} }, { schemaVersion: 1, shell: 'invalid', features },
  { schemaVersion: 1, shell: 'studio', features: { ...features, baseline: { status: 'unavailable' } } }])('rejects malformed capability records', (value) => {
  expect(parseStudioRuntimeCapabilities(value)).toBeNull();
});
it('accepts pilot lanes only on a studio shell and keeps their reason', () => {
  const pilot = { ...features, chat: { status: 'pilot', reason: 'Pilot chat' } };
  expect(parseStudioRuntimeCapabilities({ schemaVersion: 1, shell: 'studio', features: pilot })?.features.chat)
    .toEqual({ status: 'pilot', reason: 'Pilot chat' });
  expect(parseStudioRuntimeCapabilities({ schemaVersion: 1, shell: 'legacy-multiuser', features: pilot })).toBeNull();
  expect(parseStudioRuntimeCapabilities({ schemaVersion: 1, shell: 'studio', features: { ...features, chat: { status: 'pilot' } } })).toBeNull();
});
it('validates owner feedback writes strictly', () => {
  expect(parseStudioMessageFeedback(null)).toBeNull();
  expect(parseStudioMessageFeedback({ rating: 'positive', createdAt: 1, reasonCodes: ['other', 'other'] }))
    .toEqual({ rating: 'positive', createdAt: 1, reasonCodes: ['other'] });
  for (const bad of [{}, { rating: 'meh', createdAt: 1 }, { rating: 'positive' }, { rating: 'positive', createdAt: -1 },
    { rating: 'positive', createdAt: 1, reasonCodes: ['nope'] }, { rating: 'positive', createdAt: 1, extra: 1 },
    { rating: 'positive', createdAt: 1, customReason: 'x'.repeat(2001) }, []]) {
    expect(parseStudioMessageFeedback(bad)).toBeUndefined();
  }
});
it('accepts transcript ids only inside the given namespace', () => {
  const prefix = `mua_${'a'.repeat(24)}_`;
  expect(isStudioMessageIdInNamespace(`${prefix}0d6c1e7e-3b6a-4d42-9a3e-1e2a3b4c5d6e`, prefix)).toBe(true);
  for (const id of [`mua_${'b'.repeat(24)}_x`, `${prefix}`, `${prefix}../x`, `${prefix}${'x'.repeat(97)}`, 'mu_user_x', 42]) {
    expect(isStudioMessageIdInNamespace(id, prefix)).toBe(false);
  }
});

it('accepts only declared server execution choices and rejects duplicates or credential fields', () => {
  const base = { schemaVersion: 1, shell: 'studio', features };
  const choices = [{ source: 'company_pool', agentId: 'openai' }];
  expect(parseStudioRuntimeCapabilities({ ...base, executionSources: choices })?.executionSources).toEqual(choices);
  for (const executionSources of [[...choices, ...choices], [{ source: 'company_pool', agentId: 'codex' }],
    [{ ...choices[0], apiKey: 'private' }], {}, [{ source: 'unknown', agentId: 'openai' }]]) {
    expect(parseStudioRuntimeCapabilities({ ...base, executionSources })).toBeNull();
  }
});
