import type { PanelEvent, CritiquePersistedStatus, CritiqueRoundSummary } from '../critique.js';
/** Private Design Jury endpoints. Run identity is the ordinary actor-bound run. */
export interface StudioCritiqueRunsResponse { runs: Array<{ id: string }> }
export interface StudioCritiqueResponse {
  runId: string;
  status: 'queued' | 'active' | 'succeeded' | 'failed' | 'canceled';
  critique: { status: CritiquePersistedStatus; score: number | null; rounds: CritiqueRoundSummary[];
    protocolVersion: number; artifactAvailable: boolean } | null;
}
export interface StudioCritiqueTranscriptResponse { events: PanelEvent[] }
