/** Account preferences exposed on the standard app-config API in Studio.
 * Host paths, runtime environments and provider credentials are never fields.
 */
export interface StudioSettingsConfig {
  customInstructions: string;
}

export interface StudioSettingsResponse {
  config: StudioSettingsConfig;
  revision: number;
}

export interface UpdateStudioSettingsRequest extends StudioSettingsConfig {
  revision: number;
}

export const STUDIO_MEMORY_MAX_ENTRY_BYTES = 64 * 1024;
export const STUDIO_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;
export const STUDIO_MEMORY_MAX_ENTRIES = 100;
