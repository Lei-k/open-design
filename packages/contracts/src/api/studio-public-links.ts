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

/**
 * Publishing reads only the entry and the same-project assets it references
 * (#119). When one of those files may not be published, the daemon answers
 * 409 (413 for size) with this code and the project-relative path at fault;
 * never a host path or file contents.
 */
export const PUBLIC_LINK_FILE_REFUSED = 'PUBLIC_LINK_FILE_REFUSED' as const;
export const PUBLIC_LINK_FILE_REFUSAL_REASONS = [
  'symlink', 'hard_link', 'not_regular', 'too_large', 'bundle_too_large', 'changed', 'invalid_path',
] as const;
export type PublicLinkFileRefusalReason = (typeof PUBLIC_LINK_FILE_REFUSAL_REASONS)[number];
export interface PublicLinkFileRefusedData { path: string; reason: PublicLinkFileRefusalReason }
export interface PublicLinkFileRefusedResponse {
  error: { code: typeof PUBLIC_LINK_FILE_REFUSED; message: string; data: PublicLinkFileRefusedData };
}
