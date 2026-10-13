import type { ProjectMetadata } from './projects.js';

/** Account-owned project setup. Resource ids are resolved by the daemon;
 * filesystem locations and host catalog provenance are never client inputs.
 */
export type StudioProjectMetadata = Pick<ProjectMetadata,
  'kind' | 'intent' | 'fidelity' | 'speakerNotes' | 'slideCount' | 'animations' |
  'includeLandingPage' | 'includeOsWidgets' | 'platform' | 'platformTargets' | 'nameSource' | 'templateId'>;
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

/** The daemon captures owned source bytes; callers cannot supply snapshot files. */
export interface StudioTemplateSaveRequest {
  name: string;
  description?: string;
  sourceProjectId: string;
}

/** Scalar multipart fields accompanying browser/CLI directory bytes. */
export interface StudioDirectoryImportFields { name?: string }

/** Paths refer only to files in the actor's managed project. */
export interface StudioArchiveBatchRequest { files: string[] }
export interface StudioArchiveDownload {
  projectId: string;
  path: string;
  bytes: number;
  sha256: string;
}
export const STUDIO_ARCHIVE_SHA256_HEADER = 'x-od-archive-sha256';
