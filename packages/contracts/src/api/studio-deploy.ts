/** S63: account-owned cloud deployment. Desktop provider id vercel-self is accepted as an alias. */
export type StudioDeployProvider = 'vercel' | 'cloudflare-pages';
export interface StudioDeployFields {
  teamId?: string | undefined;
  teamSlug?: string | undefined;
  accountId?: string | undefined;
  projectName?: string | undefined;
  lastZoneId?: string | undefined;
  lastZoneName?: string | undefined;
  lastDomainPrefix?: string | undefined;
}
export interface StudioDeployConfig extends StudioDeployFields {
  providerId: StudioDeployProvider;
  configured: boolean;
  last4: string | null;
  revision: number;
}
export interface StudioDeployConfigUpdate extends StudioDeployFields {
  providerId: StudioDeployProvider | 'vercel-self';
  revision: number;
  token?: string | null;
}
export interface StudioDeployment {
  id: string;
  projectId: string;
  fileName: string;
  providerId: StudioDeployProvider;
  target: 'preview' | 'production';
  deploymentId: string;
  url: string;
  status: 'ready' | 'building' | 'failed';
  digest: string;
  createdAt: number;
  updatedAt: number;
  lastLinkCheck: { reachable: boolean; statusCode: number; checkedAt: number } | null;
}
export interface StudioDeployRequest {
  fileName: string;
  providerId: StudioDeployProvider | 'vercel-self';
  target?: 'preview' | 'production';
}
export const STUDIO_DEPLOY_MISSING_REASON = 'Configure your own provider token in Settings → Deploy before deploying.';
export const STUDIO_DEPLOY_OWNER_REASON = 'Only the project owner may deploy or view deployment history.';
export const STUDIO_DEPLOY_DOMAIN_REASON =
  'Cloudflare custom domains and zone discovery are unavailable on multi-user Web; use the provider-managed pages.dev link.';
