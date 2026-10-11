import { useSyncExternalStore, type ReactNode } from 'react';
import type { StudioWebAction } from '@open-design/host';
import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import { resolveStudioCapability, type StudioCapabilityFacts, type StudioCapabilityState } from './studio-capability-state';
import styles from './StudioCapabilityState.module.css';

const media = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 600px)') : null;
const subscribe = (listener: () => void) => {
  const query = media();
  if (typeof query?.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
  query?.addListener?.(listener);
  return () => query?.removeListener?.(listener);
};
const snapshot = () => media()?.matches ?? false;
const serverSnapshot = () => false;
export function useStudioCapabilityState(action: StudioWebAction, overrides: Partial<StudioCapabilityFacts> = {}) {
  const studio = useStudioCapabilities();
  const narrow = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  let storageBlocked = false;
  if (action === 'clear-data' && !studio.hostServices && typeof window !== 'undefined') {
    try { storageBlocked = !window.localStorage || !window.sessionStorage; }
    catch { storageBlocked = true; }
  }
  return resolveStudioCapability(action, {
    narrow,
    notification: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    clipboard: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    directoryInput: typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input'),
    ...(storageBlocked ? { failure: 'storage' as const } : {}),
    ...overrides,
    // Neither an override nor host discovery can invent the daemon's renderer.
    renderedExports: studio.capabilities?.renderedExports === true,
    hostServices: studio.hostServices,
  });
}
export function StudioCapabilityMessage({ state, id, children }: { state: StudioCapabilityState; id?: string; children?: ReactNode }) {
  const t = useT();
  return state.reasonKey ? <div className={styles.message} id={id} role="status" data-capability-state={state.status}>
    <span>{t(state.reasonKey)} {state.alternativeKey ? t(state.alternativeKey) : ''}</span>{children}
  </div> : null;
}
