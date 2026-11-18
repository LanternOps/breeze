/**
 * Wisp depth-one guard (w00 A11; Wisp design §4.5) — shared by run admission
 * (`runService.createAndEnqueueAgentRun`) and Operator task admission
 * (`aiOperator/taskService.admitTask`), so the predicate exists once.
 *
 * Grant-bearing work naming a requesting run is a specialist child. Only Wisp's
 * own assessment — a depth-0 run of profile `assessment` under the SAME grant
 * and org — may request one; a child (depth 1) never can, so depth stays one.
 *
 * Leaf module (schema-free): callers load the requester row themselves.
 */

/**
 * A grant-bearing admission whose requester is not Wisp's own assessment run
 * under the same grant and org. A THROW, not a skip — the W07 coordinator
 * checks depth before admission, so reaching this is a caller bug.
 */
export class GrantDepthExceededError extends Error {
  readonly code = 'grant_depth_exceeded' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GrantDepthExceededError';
  }
}

export type DepthGuardRequester = {
  grantId: string | null;
  orgId: string;
  depth: number;
  profile: string;
};

/** True iff `requester` may request grant-bearing work under (grantId, orgId). */
export function isDepthZeroAssessmentRequester(
  requester: DepthGuardRequester | null | undefined,
  grantId: string,
  orgId: string,
): boolean {
  return !!requester
    && requester.depth === 0
    && requester.profile === 'assessment'
    && requester.grantId === grantId
    && requester.orgId === orgId;
}

export function assertDepthOneRequester(
  requester: DepthGuardRequester | null | undefined,
  grantId: string,
  orgId: string,
  where: string,
): void {
  if (!isDepthZeroAssessmentRequester(requester, grantId, orgId)) {
    throw new GrantDepthExceededError(
      `${where}: grant-bearing work may only be requested by Wisp's own assessment run (depth 0) under the same grant and org (depth 1)`,
    );
  }
}

/** The lineage stamped on an admitted row (`*_depth_chk`). */
export function lineageFor(
  grant: { grantRevisionId: string; requestedByRunId?: string | null } | null | undefined,
): { requestedByRunId: string | null; parentGrantRevisionId: string | null; depth: 0 | 1 } {
  return grant?.requestedByRunId
    ? { requestedByRunId: grant.requestedByRunId, parentGrantRevisionId: grant.grantRevisionId, depth: 1 }
    : { requestedByRunId: null, parentGrantRevisionId: null, depth: 0 };
}
