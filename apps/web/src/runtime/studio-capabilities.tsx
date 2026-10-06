import { createContext, useContext, type ReactNode } from 'react';
import type { AuthAccount, StudioRuntimeCapabilities, StudioParityLaneId } from '@open-design/contracts';
import type { CookieSession } from '../multiuser/session';
import { activateStudioTransport } from './studio-transport';

interface StudioCapabilities {
  actor: AuthAccount | null;
  hostServices: boolean;
  capabilities: StudioRuntimeCapabilities | null;
  session: CookieSession | null;
  generation: number;
  available(lane: StudioParityLaneId): boolean;
  reason(lane: StudioParityLaneId): string;
}
const local: StudioCapabilities = { actor: null, hostServices: true, capabilities: null, session: null, generation: 0,
  available: () => true, reason: () => '' };
const Context = createContext<StudioCapabilities>(local);
export function StudioCapabilitiesProvider({ session, generation, actor, capabilities, children }: {
  session: CookieSession; generation: number; actor: AuthAccount; capabilities: StudioRuntimeCapabilities; children: ReactNode;
}) {
  // The session owns this lifetime (including StrictMode remounts). It releases
  // the transport and module registry before publishing another generation.
  activateStudioTransport(session, generation);
  const value: StudioCapabilities = { actor, session, generation, capabilities, hostServices: false,
    available: (lane) => capabilities.features[lane].status === 'supported',
    reason: (lane) => { const feature = capabilities.features[lane]; return feature.status === 'supported' ? '' : feature.reason; } };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useStudioCapabilities() { return useContext(Context); }
export function StudioUnavailable({ lane }: { lane: StudioParityLaneId }) {
  const studio = useStudioCapabilities();
  return <p role="status" className="studio-unavailable muted">{studio.reason(lane)}</p>;
}
export function StudioLane({ lane, children }: { lane: StudioParityLaneId; children: ReactNode }) {
  return useStudioCapabilities().available(lane) ? <>{children}</> : <StudioUnavailable lane={lane} />;
}
