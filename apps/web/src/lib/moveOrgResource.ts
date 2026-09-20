/**
 * The canonical `{ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }`
 * a device_move_org step-up grant is bound to (spec D2/D5).
 *
 * The server hashes
 *   JSON.stringify({ acceptCurrencyMismatch, deviceId, targetOrgId, targetSiteId })
 * in `moveOrgResourceDigest` (apps/api/src/services/mfaStepUpGrant.ts) — once
 * when minting the grant and once when spending it. The client builds ONE
 * object here and uses it for BOTH the mint resource and the request body, so
 * the two hashed inputs cannot drift.
 *
 * The move-org route answers missing / stale / mismatched grants with the SAME
 * 403 STEP_UP_REQUIRED so the response is not a probing oracle for the
 * binding. A client that minted against even a slightly different target is a
 * 403 loop the technician cannot diagnose.
 *
 * This module has no dependencies on purpose: it is imported by the dialog, and
 * component tests that mock `services/deviceActions` must still get the real
 * canonicalization.
 */
export interface MoveOrgResource {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptCurrencyMismatch: boolean;
}

export function canonicalMoveOrgResource(input: {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptCurrencyMismatch?: boolean;
}): MoveOrgResource {
  // Enumerated, never spread: the server digests exactly these four keys, so an
  // extra field on the input must not reach the mint resource.
  return {
    deviceId: input.deviceId,
    targetOrgId: input.targetOrgId,
    targetSiteId: input.targetSiteId,
    acceptCurrencyMismatch: input.acceptCurrencyMismatch === true,
  };
}

/** The body `POST /devices/:id/move-org` takes (routes/devices/schemas.ts moveOrgSchema + W01 stepUpGrant). */
export function moveOrgRequestBody(
  resource: MoveOrgResource,
  stepUpGrant?: string,
): { orgId: string; siteId: string; acceptCurrencyMismatch: boolean; stepUpGrant?: string } {
  return {
    orgId: resource.targetOrgId,
    siteId: resource.targetSiteId,
    acceptCurrencyMismatch: resource.acceptCurrencyMismatch,
    ...(stepUpGrant ? { stepUpGrant } : {}),
  };
}
