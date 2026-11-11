import type { IsolationState } from '@breeze/shared';

export interface IsolationEpisode {
  id: string;
  deviceId: string;
  incidentId: string | null;
  state: IsolationState;
  expiresAt: string;
  generation?: number;
  lastReportedGeneration?: number | null;
}
export interface IsolationListResponse {
  episodes: IsolationEpisode[];
  startEligibility: {
    allowed: boolean;
    reason: string | null;
    networkIsolationUnsupportedReason?: string | null;
  };
}
