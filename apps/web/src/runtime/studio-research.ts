import { useEffect, useState } from 'react';
import type { StudioProviderKeysResponse } from '@open-design/contracts';
import { useStudioCapabilities } from './studio-capabilities';
import { studioFetch } from './studio-transport';

const PATH = '/api/multiuser/settings/provider-keys';
const listeners = new Set<() => void>();

/** Settings saved or removed an account key; research readiness re-reads. */
export function notifyStudioProviderKeysChanged(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Whether this Studio account can run research now (#63): the server
 * advertises research on the account's own Tavily key and the account has
 * saved one. The composer offers `/search` only then, so it never presents a
 * control the server must refuse. Local mode keeps its own rule.
 */
export function useStudioResearchReady(): boolean {
  const studio = useStudioCapabilities();
  const capable = !studio.hostServices && studio.capabilities?.researchSearch === true && studio.available('execution');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!capable) return;
    let active = true;
    const load = async () => {
      try {
        const response = await studioFetch(PATH);
        if (!response.ok) return;
        const keys = (await response.json() as StudioProviderKeysResponse).keys;
        if (active) setReady(keys.some((key) => key.provider === 'tavily' && key.configured));
      } catch { /* withdrawn or offline: keep the last state */ }
    };
    void load();
    listeners.add(load);
    return () => { active = false; listeners.delete(load); };
  }, [capable]);
  return ready;
}
