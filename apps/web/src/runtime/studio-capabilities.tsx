import { createContext, useContext, type ReactNode } from 'react';
import type { AuthAccount, StudioRuntimeCapabilities, StudioParityLaneId } from '@open-design/contracts';
import type { CookieSession } from '../multiuser/session';
import { activateStudioTransport, studioRequestAvailable } from './studio-transport';

interface StudioCapabilities {
  actor: AuthAccount | null;
  hostServices: boolean;
  capabilities: StudioRuntimeCapabilities | null;
  session: CookieSession | null;
  generation: number;
  available(lane: StudioParityLaneId): boolean;
  reason(lane: StudioParityLaneId): string;
  /** The agent this actor's usable execution source runs; null when it cannot run. */
  executionAgentId: 'codex' | null;
}
const local: StudioCapabilities = { actor: null, hostServices: true, capabilities: null, session: null, generation: 0,
  available: () => true, reason: () => '', executionAgentId: null };
const Context = createContext<StudioCapabilities>(local);
export function StudioCapabilitiesProvider({ session, generation, actor, capabilities, messageIdPrefix, children }: {
  session: CookieSession; generation: number; actor: AuthAccount; capabilities: StudioRuntimeCapabilities;
  messageIdPrefix?: string | undefined; children: ReactNode;
}) {
  // A `pilot` lane is usable by this authenticated actor; it is still not a
  // deployment-wide `supported` promise, and its reason stays readable.
  const usable = (lane: StudioParityLaneId) => ['supported', 'pilot'].includes(capabilities.features[lane].status);
  // The session owns this lifetime (including StrictMode remounts). It releases
  // the transport and module registry before publishing another generation.
  activateStudioTransport(session, generation, { messageIdPrefix, usable });
  const value: StudioCapabilities = { actor, session, generation, capabilities, hostServices: false,
    // Multi-user execution is personal Codex only (MultiUserRun.agentId); the company pool has no real provider yet.
    executionAgentId: usable('execution') ? 'codex' : null,
    available: usable,
    reason: (lane) => { const feature = capabilities.features[lane]; return feature.status === 'supported' ? '' : feature.reason; } };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useStudioCapabilities() { return useContext(Context); }
/** Partial pilot lanes expose only the operations reviewed by the transport. */
export function useStudioRequestAvailable() {
  const studio = useStudioCapabilities();
  return (method: string, path: string) => studio.hostServices || studioRequestAvailable(method, path, studio.available);
}
export function StudioUnavailable({ lane }: { lane: StudioParityLaneId }) {
  const studio = useStudioCapabilities();
  return <p role="status" className="studio-unavailable muted">{studio.reason(lane)}</p>;
}
export function StudioLane({ lane, children }: { lane: StudioParityLaneId; children: ReactNode }) {
  return useStudioCapabilities().available(lane) ? <>{children}</> : <StudioUnavailable lane={lane} />;
}
