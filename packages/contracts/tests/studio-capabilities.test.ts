import { expect, it } from 'vitest';
import { parseStudioRuntimeCapabilities, STUDIO_PARITY_LANES } from '../src/api/studio-parity.js';
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
