import { createContext, useContext, useId, type MouseEventHandler, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import { StudioCapabilityMessage, useStudioCapabilityState } from './StudioCapabilityState';

/** Native popup completion cannot be inferred from window.open(..., noopener).
 * Give users a normal HTTP(S) anchor and a same-tab alternative. */
const LinkGroupDescription = createContext<string | undefined>(undefined);
export function StudioExternalLinkGroup({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const studio = useStudioCapabilities();
  const state = useStudioCapabilityState('external-link');
  const id = useId();
  if (studio.hostServices || !enabled) return <>{children}</>;
  return <LinkGroupDescription.Provider value={id}>
    {children}
    <StudioCapabilityMessage state={state} id={id} />
  </LinkGroupDescription.Provider>;
}
export function StudioExternalLink({ href, children, onClick }: { href: string; children: ReactNode; onClick?: MouseEventHandler<HTMLAnchorElement> }) {
  const studio = useStudioCapabilities();
  const t = useT();
  const state = useStudioCapabilityState('external-link');
  const groupDescription = useContext(LinkGroupDescription);
  const ownDescription = useId();
  const description = studio.hostServices ? undefined : groupDescription ?? ownDescription;
  let safe = '';
  try { const url = new URL(href); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) safe = url.href; } catch { /* untrusted URL refused */ }
  if (!safe) return null;
  return <>
    <a href={safe} target="_blank" rel="noopener noreferrer" onClick={onClick} aria-describedby={description} style={studio.hostServices ? undefined : { display: 'inline-flex', alignItems: 'center', minHeight: 40 }}>{children}</a>
    {!studio.hostServices && <>
      <a href={safe} onClick={onClick} aria-describedby={description} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 40 }}>{t('studio.capability.sameTab')}</a>
      {!groupDescription && <StudioCapabilityMessage state={state} id={ownDescription} />}
    </>}
  </>;
}
