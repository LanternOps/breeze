/**
 * Wisp W07 — the `wisp_specialist_request` approval card (plan Task 4).
 * Placeholder until Task 4 lands in this wave; the coordinator imports it
 * lazily on the run × asks-first path only.
 */
import type { SpecialistKind } from './specialistPolicy';

export const WISP_SPECIALIST_REQUEST_TOOL = 'wisp_specialist_request';

export interface WispSpecialistRequestArguments {
  requestId: string;
  kind: SpecialistKind;
  orgId: string;
  grantId: string;
  grantRevisionId: string;
  params: Record<string, unknown>;
  reason: string;
}

export async function raiseSpecialistIntent(
  _input: { requestedByRunId: string } & WispSpecialistRequestArguments,
): Promise<{ intentId: string }> {
  throw new Error('raiseSpecialistIntent: not implemented until W07 Task 4');
}
