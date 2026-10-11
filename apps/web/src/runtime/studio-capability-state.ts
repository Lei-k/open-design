import type { StudioWebAction } from '@open-design/host';
import type { Dict } from '../i18n/types';

export type StudioCapabilityStatus = 'available' | 'permission-denied' | 'permission-prompt' |
  'unsupported-browser' | 'deployment-disabled' | 'narrow-viewport-alternative';
export interface StudioCapabilityFacts {
  hostServices: boolean;
  narrow?: boolean;
  notification?: NotificationPermission | 'unsupported';
  clipboard?: boolean;
  directoryInput?: boolean;
  renderedExports?: boolean;
  permissionGranted?: boolean;
  failure?: 'permission' | 'download' | 'storage';
}
export interface StudioCapabilityState {
  status: StudioCapabilityStatus;
  /** A prompt or responsive alternative can still be operated. */
  usable: boolean;
  reasonKey?: keyof Dict;
  alternativeKey?: keyof Dict;
}
/** Pure policy: browser observations and authenticated daemon advertisements
 * are inputs. Native host configuration is never deployment authority. */
export function resolveStudioCapability(action: StudioWebAction, facts: StudioCapabilityFacts): StudioCapabilityState {
  if (facts.hostServices) return { status: 'available', usable: true };
  const state = (status: StudioCapabilityStatus, usable: boolean, reasonKey: keyof Dict,
    alternativeKey?: keyof Dict): StudioCapabilityState => ({ status, usable, reasonKey, ...(alternativeKey ? { alternativeKey } : {}) });
  switch (action) {
    case 'notifications':
      if (facts.notification === 'unsupported') return state('unsupported-browser', false, 'studio.capability.notificationUnsupported', 'studio.capability.activity');
      if (facts.notification === 'denied') return state('permission-denied', false, 'studio.capability.notificationDenied', 'studio.capability.activity');
      if (facts.notification === 'default') return state('permission-prompt', true, 'studio.capability.notificationPrompt', 'studio.capability.activity');
      break;
    case 'directory':
      if (!facts.directoryInput) return state('unsupported-browser', false, 'studio.capability.directoryUnsupported', 'studio.capability.filesAlternative');
      break;
    case 'rendered-export':
      if (facts.renderedExports !== true) return state('deployment-disabled', false, 'studio.capability.rendererDisabled', 'studio.capability.htmlZipAlternative');
      // Rendered downloads share browser delivery conditions with owned archives.
      if (facts.failure === 'download') return state('permission-denied', true, 'studio.capability.download', 'studio.capability.downloadAlternative');
      break;
    case 'clipboard':
      if (!facts.clipboard) return state('unsupported-browser', false, 'studio.capability.clipboardUnsupported', 'studio.capability.manualCopy');
      if (facts.failure === 'permission') return state('permission-denied', false, 'studio.capability.clipboardDenied', 'studio.capability.manualCopy');
      break;
    case 'download':
      if (facts.failure === 'download') return state('permission-denied', true, 'studio.capability.download', 'studio.capability.downloadAlternative');
      // Anchor delivery cannot prove completion or observe browser blocking.
      return state(facts.narrow ? 'narrow-viewport-alternative' : 'available', true, 'studio.capability.download', 'studio.capability.downloadAlternative');
    case 'external-link':
      // Conditional guidance, not a claim that a popup was observed as blocked.
      return state(facts.narrow ? 'narrow-viewport-alternative' : 'available', true, 'studio.capability.popup', 'studio.capability.sameTab');
    case 'clear-data':
      if (facts.failure === 'storage') return state('permission-denied', true, 'studio.capability.storage', 'studio.capability.signOutAlternative');
      break;
    case 'deploy':
      if (facts.permissionGranted === false) return state('permission-denied', false, 'studio.deployOwnerOnly');
      break;
    case 'appearance': case 'pet': case 'preview': case 'file-upload': case 'about': case 'public-link': break;
    default: { const exhaustive: never = action; return exhaustive; }
  }
  if (facts.narrow) return state('narrow-viewport-alternative', true, 'studio.capability.narrow');
  return { status: 'available', usable: true };
}
