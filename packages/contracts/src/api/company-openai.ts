/** Company credentials never appear in a read response or a run request. */
export interface CompanyOpenAIConfig {
  providerId: 'openai';
  configured: boolean;
  enabled: boolean;
  model: string;
  capacity: number;
  revision: number;
  credentialRevision: number;
}
export interface CompanyOpenAIConfigResponse { provider: CompanyOpenAIConfig }
export interface UpdateCompanyOpenAIConfigRequest {
  revision: number;
  enabled: boolean;
  model: string;
  capacity: number;
  /** Omit to retain, null to revoke. Write-only; never sent to an agent child. */
  apiKey?: string | null;
}
