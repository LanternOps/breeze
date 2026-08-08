import type { FleetFindingKind, FleetFindingSeverity } from '../../db/schema/fleetFindings';

export interface CandidateMember {
  deviceId: string;
  sourceKind: string;
  sourceRowId: string | null;
  memberEvidence: Record<string, unknown>;
}

export interface CandidateFinding {
  kind: FleetFindingKind;
  semanticKey: string;
  severity: FleetFindingSeverity;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  members: CandidateMember[];
}
