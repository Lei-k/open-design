import { STUDIO_DEFAULT_CODEX_MODEL, isStudioCodexModel, isStudioCodexReasoning,
  type StudioCodexModelChoice, type StudioSettingsConfig, type StudioSettingsResponse } from '@open-design/contracts';
import type { AgentModelChoice, AppConfig } from '../types';
import { studioFetch } from './studio-transport';

/** Apply the closed account DTO to the shared App config. The personal Codex
 * choice is the App's `agentModels.codex`, so the shared composer and request
 * builder need no Studio fork. */
export function withStudioAccountConfig(current: AppConfig, saved: StudioSettingsConfig): AppConfig {
  const { codexModel, ...rest } = saved;
  return { ...current, ...rest, agentModels: { ...current.agentModels, codex: {
    model: codexModel.model, ...(codexModel.reasoning === 'default' ? {} : { reasoning: codexModel.reasoning }) } } };
}

/** The account field for a composer choice; anything outside the lists is the default. */
export function studioCodexModelChoice(choice: AgentModelChoice | undefined): StudioCodexModelChoice {
  return { model: isStudioCodexModel(choice?.model) ? choice.model : STUDIO_DEFAULT_CODEX_MODEL.model,
    reasoning: isStudioCodexReasoning(choice?.reasoning) ? choice.reasoning : STUDIO_DEFAULT_CODEX_MODEL.reasoning };
}

/** Revision-checked single-field write; one retry after a concurrent save. */
export async function saveStudioCodexModel(choice: StudioCodexModelChoice): Promise<StudioSettingsResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await studioFetch('/api/app-config');
    if (!current.ok) return null;
    const { revision } = await current.json() as StudioSettingsResponse;
    const response = await studioFetch('/api/app-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, codexModel: choice }) });
    if (response.ok) return await response.json() as StudioSettingsResponse;
    if (response.status !== 409) return null;
  }
  return null;
}
