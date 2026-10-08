/**
 * Account-private provider API keys for the shared Studio (#62/#63).
 *
 * The key is write-only: no response carries it, only whether one is stored
 * and its last four characters. Runs and media that use it are billed to the
 * account's own provider account, never silently to the company pool.
 */
export type StudioProviderKeyProvider = 'openai';

export interface StudioProviderKeySummary {
  provider: StudioProviderKeyProvider;
  configured: boolean;
  last4: string | null;
  /** The chat model the account's own key runs. */
  model: string;
  /** Optimistic concurrency for updates. */
  revision: number;
  /** Increments whenever the key itself is added, replaced or removed. */
  credentialRevision: number;
  updatedAt: number | null;
}

export interface StudioProviderKeysResponse { keys: StudioProviderKeySummary[] }

/** `apiKey` omitted keeps the stored key; `null` removes it. */
export interface UpdateStudioProviderKeyRequest {
  revision: number;
  apiKey?: string | null;
  model?: string;
}
export interface StudioProviderKeyResponse { key: StudioProviderKeySummary }

export const STUDIO_PROVIDER_KEY_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Suggested chat models; any provider model name matching the pattern is accepted. */
export const STUDIO_PROVIDER_KEY_MODELS = ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1'] as const;
