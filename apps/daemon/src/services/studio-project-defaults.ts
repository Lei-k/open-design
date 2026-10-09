type Defaults = { skillId?: string | null; designSystemId?: string | null };
export interface StudioProjectDefaultsObservation { skill?: string | null; design?: string | null }

/** Capture only defaults the turn inherits, including an absent default. */
export function observeStudioProjectDefaults(project: Defaults | null, selections: { skillId: string | null; designSystemId: string | null },
  independent: boolean): StudioProjectDefaultsObservation {
  if (independent) return {};
  return { ...(selections.skillId === null ? { skill: project?.skillId ?? null } : {}),
    ...(selections.designSystemId === null ? { design: project?.designSystemId ?? null } : {}) };
}

/** Synchronous with admission commit; explicit/captured selections are independent. */
export function studioProjectDefaultsUnchanged(observed: StudioProjectDefaultsObservation, current: Defaults | null): boolean {
  return (!Object.hasOwn(observed, 'skill') || observed.skill === (current?.skillId ?? null))
    && (!Object.hasOwn(observed, 'design') || observed.design === (current?.designSystemId ?? null));
}
