/** Account preferences exposed on the standard app-config API in Studio.
 * Host paths, runtime environments and provider credentials are never fields.
 */
export interface StudioSettingsConfig {
  customInstructions: string;
  accentColor: string;
  notifications: StudioNotificationPreferences;
  /** Model for runs on the account's personal Codex subscription. */
  codexModel: StudioCodexModelChoice;
}

/** Choices a personal Codex subscription run may request per turn. `default`
 * leaves the choice to the user's own Codex account. The company pool's model
 * is admin-owned and is not an account preference. */
export const STUDIO_CODEX_MODELS = ['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex'] as const;
export const STUDIO_CODEX_REASONING = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export interface StudioCodexModelChoice {
  model: (typeof STUDIO_CODEX_MODELS)[number];
  reasoning: (typeof STUDIO_CODEX_REASONING)[number];
}
export const STUDIO_DEFAULT_CODEX_MODEL: Readonly<StudioCodexModelChoice> = { model: 'default', reasoning: 'default' };
export function isStudioCodexModel(value: unknown): value is StudioCodexModelChoice['model'] {
  return typeof value === 'string' && (STUDIO_CODEX_MODELS as readonly string[]).includes(value);
}
export function isStudioCodexReasoning(value: unknown): value is StudioCodexModelChoice['reasoning'] {
  return typeof value === 'string' && (STUDIO_CODEX_REASONING as readonly string[]).includes(value);
}

export interface StudioNotificationPreferences {
  soundEnabled: boolean;
  successSoundId: 'ding' | 'chime' | 'two-tone-up' | 'pluck';
  failureSoundId: 'buzz' | 'two-tone-down' | 'thud';
  desktopEnabled: boolean;
}

// Browser permission and locale belong to the device. The shipped theme is
// light-only; it is not an account setting. Notification intent is portable,
// but permission is still checked independently on each browser.
export const STUDIO_DEFAULT_ACCENT_COLOR = '#353535';
export const STUDIO_DEFAULT_NOTIFICATIONS: Readonly<StudioNotificationPreferences> = {
  soundEnabled: false, successSoundId: 'ding', failureSoundId: 'buzz', desktopEnabled: false,
};
export const STUDIO_SETTINGS_FIELDS = ['customInstructions', 'accentColor', 'notifications', 'codexModel'] as const;

export interface StudioSettingsResponse {
  config: StudioSettingsConfig;
  revision: number;
}

/** Closed account-owned write shape. Missing fields preserve their current
 * values; null explicitly restores a default, including CLI unset. */
export type StudioSettingsWrite = { revision: number } & {
  [K in keyof StudioSettingsConfig]?: StudioSettingsConfig[K] | null;
};
export type UpdateStudioSettingsRequest = StudioSettingsWrite;

export function parseStudioSettingsWrite(value: unknown): StudioSettingsWrite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'revision' && !STUDIO_SETTINGS_FIELDS.some((field) => field === key))
      || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || Number(body.revision) >= Number.MAX_SAFE_INTEGER) return null;
  if (body.customInstructions !== undefined && body.customInstructions !== null
      && (typeof body.customInstructions !== 'string' || body.customInstructions.length > 5000 || body.customInstructions.includes('\0'))) return null;
  if (body.accentColor !== undefined && body.accentColor !== null
      && (typeof body.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.accentColor))) return null;
  if (body.notifications !== undefined && body.notifications !== null) {
    if (typeof body.notifications !== 'object' || Array.isArray(body.notifications)) return null;
    const notification = body.notifications as Record<string, unknown>;
    const keys = ['soundEnabled', 'successSoundId', 'failureSoundId', 'desktopEnabled'];
    if (Object.keys(notification).length !== keys.length || Object.keys(notification).some((key) => !keys.includes(key))
        || typeof notification.soundEnabled !== 'boolean' || typeof notification.desktopEnabled !== 'boolean'
        || typeof notification.successSoundId !== 'string' || !['ding', 'chime', 'two-tone-up', 'pluck'].includes(notification.successSoundId)
        || typeof notification.failureSoundId !== 'string' || !['buzz', 'two-tone-down', 'thud'].includes(notification.failureSoundId)) return null;
  }
  if (body.codexModel !== undefined && body.codexModel !== null) {
    const choice = body.codexModel as Record<string, unknown>;
    if (typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).length !== 2
        || !isStudioCodexModel(choice.model) || !isStudioCodexReasoning(choice.reasoning)) return null;
  }
  return body as StudioSettingsWrite;
}

export const STUDIO_MEMORY_MAX_ENTRY_BYTES = 64 * 1024;
export const STUDIO_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;
export const STUDIO_MEMORY_MAX_ENTRIES = 100;
