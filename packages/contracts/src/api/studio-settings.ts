/** Account preferences exposed on the standard app-config API in Studio.
 * Host paths, runtime environments and provider credentials are never fields.
 */
export interface StudioSettingsConfig {
  customInstructions: string;
  accentColor: string;
  notifications: StudioNotificationPreferences;
  /** Model for runs on the account's personal Codex subscription. */
  codexModel: StudioCodexModelChoice;
  /** In-page pet (#67). The OS desktop overlay is Web-not-applicable. */
  pet: StudioPetPreference;
}

/** Mirrors the App's pet config. `custom.imageUrl` is an inline image data
 * URL (an adopted bundled atlas or the user's own upload), never a host path
 * or remote URL. */
export interface StudioPetPreference {
  adopted: boolean;
  enabled: boolean;
  petId: string;
  custom: {
    name: string;
    glyph: string;
    accent: string;
    greeting: string;
    imageUrl?: string;
    frames?: number;
    fps?: number;
    atlas?: { cols: number; rows: number; rowsDef: Array<{ index: number; id: string; frames: number; fps: number }> };
  };
}
export const STUDIO_PET_IMAGE_MAX_CHARS = 2 * 1024 * 1024;
export const STUDIO_DEFAULT_PET: Readonly<StudioPetPreference> = {
  adopted: false, enabled: false, petId: 'mochi',
  custom: { name: 'Buddy', glyph: '🦄', accent: '#353535', greeting: 'Hi! I am here whenever you need me.' },
};

const boundedText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const smallInt = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
/** Closed shape check for an account pet; refuses unknown keys and remote images. */
export function isStudioPetPreference(value: unknown): value is StudioPetPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pet = value as Record<string, unknown>;
  if (Object.keys(pet).some((key) => !['adopted', 'enabled', 'petId', 'custom'].includes(key))
      || typeof pet.adopted !== 'boolean' || typeof pet.enabled !== 'boolean' || !boundedText(pet.petId, 128)) return false;
  const custom = pet.custom as Record<string, unknown> | null;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)
      || Object.keys(custom).some((key) => !['name', 'glyph', 'accent', 'greeting', 'imageUrl', 'frames', 'fps', 'atlas'].includes(key))
      || !boundedText(custom.name, 80) || !boundedText(custom.glyph, 16) || !boundedText(custom.greeting, 280)
      || typeof custom.accent !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(custom.accent)) return false;
  if (custom.imageUrl !== undefined && (typeof custom.imageUrl !== 'string' || custom.imageUrl.length > STUDIO_PET_IMAGE_MAX_CHARS
      || !/^data:image\/(?:png|webp|gif|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(custom.imageUrl))) return false;
  if (custom.frames !== undefined && !smallInt(custom.frames, 1, 64)) return false;
  if (custom.fps !== undefined && !smallInt(custom.fps, 1, 60)) return false;
  if (custom.atlas !== undefined) {
    const atlas = custom.atlas as Record<string, unknown> | null;
    if (!atlas || typeof atlas !== 'object' || Array.isArray(atlas) || Object.keys(atlas).some((key) => !['cols', 'rows', 'rowsDef'].includes(key))
        || !smallInt(atlas.cols, 1, 64) || !smallInt(atlas.rows, 1, 64) || !Array.isArray(atlas.rowsDef) || atlas.rowsDef.length > 64) return false;
    if (!atlas.rowsDef.every((row: unknown) => {
      const def = row as Record<string, unknown> | null;
      return !!def && typeof def === 'object' && Object.keys(def).every((key) => ['index', 'id', 'frames', 'fps'].includes(key))
        && smallInt(def.index, 0, 63) && boundedText(def.id, 64) && smallInt(def.frames, 0, 64) && smallInt(def.fps, 0, 60);
    })) return false;
  }
  return true;
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
export const STUDIO_SETTINGS_FIELDS = ['customInstructions', 'accentColor', 'notifications', 'codexModel', 'pet'] as const;

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
  if (body.pet !== undefined && body.pet !== null && !isStudioPetPreference(body.pet)) return null;
  return body as StudioSettingsWrite;
}

export const STUDIO_MEMORY_MAX_ENTRY_BYTES = 64 * 1024;
export const STUDIO_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;
export const STUDIO_MEMORY_MAX_ENTRIES = 100;
/**
 * Automatic memory for Studio accounts (#62). The account switches its own
 * hooks on the standard `PATCH /api/memory/config`; the host extraction
 * provider override (`extraction`, with its key and base URL) is never a
 * field: extraction runs only on the turn's own OpenAI source (company pool or
 * the account's key) and bills it. Personal Codex turns are recorded as
 * skipped (`source-has-no-extraction`). Extraction and verification history
 * is per account, newest first, capped at {@link STUDIO_MEMORY_HISTORY_LIMIT}.
 */
export const STUDIO_MEMORY_CONFIG_FIELDS = ['enabled', 'profileEnabled', 'chatExtractionEnabled', 'rewriteEnabled', 'verifyEnabled'] as const;
export const STUDIO_MEMORY_HISTORY_LIMIT = 50;
/** `POST /api/memory/extract` for Studio: the regex pack on the user text only; never a provider call. */
export const STUDIO_MEMORY_EXTRACT_FIELDS = ['userMessage', 'assistantMessage'] as const;
