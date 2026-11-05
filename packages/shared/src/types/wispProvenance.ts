/**
 * "Wisp for <user>" provenance (W07 Task 7): present on a run/task admitted
 * under a Wisp grant. `grantorName` is null when the user row is not visible
 * or has no name. `depth` is 0 for an assessment run, 1 for a specialist child.
 */
export interface WispProvenanceDto {
  grantId: string;
  grantorUserId: string;
  grantorName: string | null;
  depth: 0 | 1;
  requestedByRunId: string | null;
}
