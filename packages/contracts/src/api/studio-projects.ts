import type { ProjectMetadata } from './projects.js';

/** Account-owned project setup. Resource ids are resolved by the daemon;
 * filesystem locations and host catalog provenance are never client inputs.
 */
export type StudioProjectMetadata = Pick<ProjectMetadata,
  'kind' | 'intent' | 'fidelity' | 'speakerNotes' | 'slideCount' | 'animations' |
  'includeLandingPage' | 'includeOsWidgets' | 'platform' | 'platformTargets' | 'nameSource'>;
export interface StudioProjectCreateRequest {
  id: string;
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string;
  customInstructions?: string | null;
  metadata?: StudioProjectMetadata;
  conversationMode?: 'design' | 'chat' | 'plan';
}
