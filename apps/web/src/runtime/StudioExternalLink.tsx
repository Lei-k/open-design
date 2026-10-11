import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import { StudioCapabilityMessage, useStudioCapabilityState } from './StudioCapabilityState';

/** Native popup completion cannot be inferred from window.open(..., noopener).
 * Give users a normal HTTP(S) anchor and a same-tab alternative. */
export function StudioExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const studio = useStudioCapabilities();
  const t = useT();
  const state = useStudioCapabilityState('external-link');
  let safe = '';
  try { const url = new URL(href); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) safe = url.href; } catch { /* untrusted URL refused */ }
  if (!safe) return null;
  return <>
    <a href={safe} target="_blank" rel="noopener noreferrer" style={studio.hostServices ? undefined : { display: 'inline-flex', alignItems: 'center', minHeight: 40 }}>{children}</a>
    {!studio.hostServices && <StudioCapabilityMessage state={{ ...state, reasonKey: 'studio.capability.popup' }}>
      <a href={safe}>{t('studio.capability.sameTab')}</a>
    </StudioCapabilityMessage>}
  </>;
}
