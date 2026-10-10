import type { PublicProjectFilePublication } from './collab.js';

/**
 * Deployment-local public links for the shared Studio (#66). A link serves an
 * immutable capture of one file plus the same-project assets it references,
 * from the cookie-free preview origin. Republishing replaces the link.
 */
export interface StudioPublicLink extends PublicProjectFilePublication {
  createdAt: number;
  /** sha256 over the captured names and bytes. */
  digest: string;
}
export interface StudioPublicLinksResponse { links: StudioPublicLink[] }
export interface StudioPublicLinkResponse { publication: StudioPublicLink | null }
