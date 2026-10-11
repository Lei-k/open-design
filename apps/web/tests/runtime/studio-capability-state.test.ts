import { expect, it } from 'vitest';
import { STUDIO_WEB_ACTION_CONDITIONS, type StudioWebAction, type StudioWebCondition } from '@open-design/host';
import { resolveStudioCapability, type StudioCapabilityFacts, type StudioCapabilityStatus } from '../../src/runtime/studio-capability-state';
// Closed condition cases: an added condition requires a reviewed observable decision.
const decisions = {
  'notification-api': ['notifications', { notification: 'unsupported' }, 'unsupported-browser'],
  'notification-permission': ['notifications', { notification: 'denied' }, 'permission-denied'],
  'clipboard-api': ['clipboard', { clipboard: false }, 'unsupported-browser'],
  'clipboard-rejected': ['clipboard', { clipboard: true, failure: 'permission' }, 'permission-denied'],
  'directory-api': ['directory', { directoryInput: false }, 'unsupported-browser'],
  'download-blocked': ['download', { failure: 'download' }, 'permission-denied'],
  renderer: ['rendered-export', { renderedExports: false }, 'deployment-disabled'],
  'popup-blocked': ['external-link', { failure: 'popup' }, 'permission-denied'],
  'narrow-viewport': ['pet', { narrow: true }, 'narrow-viewport-alternative'],
  'site-data-blocked': ['clear-data', { failure: 'storage' }, 'permission-denied'],
  'daemon-capability': ['deploy', { deploymentAvailable: false }, 'deployment-disabled'],
  'frame-lifecycle': ['preview', {}, 'available'], // existing bounded diagnostics, no speculative browser detection
} as const satisfies Record<StudioWebCondition, readonly [StudioWebAction, Partial<StudioCapabilityFacts>, StudioCapabilityStatus]>;
it.each(Object.entries(decisions))('%s has an explicit Web resolution and native bypass', (_, [action, facts, status]) => {
  const result = resolveStudioCapability(action, { hostServices: false, ...facts });
  expect(result.status).toBe(status);
  if (status !== 'available') expect(result.reasonKey).toMatch(/^studio.capability./);
  expect(resolveStudioCapability(action, { hostServices: true, ...facts })).toEqual({ status: 'available', usable: true });
});
it('notification default is a usable gesture prompt; denial/API absence are not dead permission prompts', () => {
  expect(resolveStudioCapability('notifications', { hostServices: false, notification: 'default' })).toMatchObject({ status: 'permission-prompt', usable: true });
  for (const notification of ['denied', 'unsupported'] as const)
    expect(resolveStudioCapability('notifications', { hostServices: false, notification })).toMatchObject({ usable: false, alternativeKey: 'studio.capability.activity' });
});
it('unknown renderer advertisement fails closed while other headless actions stay available', () => {
  expect(resolveStudioCapability('rendered-export', { hostServices: false })).toMatchObject({ status: 'deployment-disabled', alternativeKey: 'studio.capability.htmlZipAlternative' });
  for (const action of ['download', 'file-upload', 'public-link', 'about', 'pet', 'deploy'] as const)
    expect(resolveStudioCapability(action, { hostServices: false })).toMatchObject({ status: 'available', usable: true });
});
it('project permission denial is separate from authenticated deployment availability', () => {
  expect(resolveStudioCapability('deploy', { hostServices: false, permissionGranted: false })).toMatchObject({ status: 'permission-denied', usable: false, reasonKey: 'studio.deployOwnerOnly' });
});
it('clipboard API absence remains unsupported when a legacy copy attempt also fails', () => {
  expect(resolveStudioCapability('clipboard', { hostServices: false, clipboard: false, failure: 'permission' }))
    .toMatchObject({ status: 'unsupported-browser', reasonKey: 'studio.capability.clipboardUnsupported' });
});
it('narrow viewport is an operable alternative across every action; stronger denial takes priority', () => {
  for (const action of Object.keys(STUDIO_WEB_ACTION_CONDITIONS) as StudioWebAction[])
    expect(resolveStudioCapability(action, { hostServices: false, narrow: true, directoryInput: true, clipboard: true, renderedExports: true, notification: 'granted' })).toMatchObject({ status: 'narrow-viewport-alternative', usable: true });
  expect(resolveStudioCapability('notifications', { hostServices: false, narrow: true, notification: 'denied' }).status).toBe('permission-denied');
});
