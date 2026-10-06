import { studioLocalStorage as localStorage } from '../runtime/studio-transport';
export const VISUAL_STABILITY_STORAGE_KEY = 'open-design:visual-stability';

export function isVisualStabilityMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(VISUAL_STABILITY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
