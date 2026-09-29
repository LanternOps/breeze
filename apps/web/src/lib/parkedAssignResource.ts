/**
 * The resources a parked-device assignment step-up grant is bound to, and the
 * request bodies that spend them. Built from ONE object per request so the
 * minted binding and the body the server re-hashes cannot drift
 * (apps/api/src/services/mfaStepUpGrant.ts parkedAssignResourceDigest /
 * parkedBulkAssignResourceDigest).
 *
 * Dependency-free on purpose, like lib/moveOrgResource.ts.
 */
export interface ParkedAssignResource {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
}

export function canonicalParkedAssignResource(input: ParkedAssignResource): ParkedAssignResource {
  // Enumerated, never spread: the server digests exactly these keys.
  return { deviceId: input.deviceId, targetOrgId: input.targetOrgId, targetSiteId: input.targetSiteId };
}

/** Body for `POST /pre-assignment/devices/:id/assign`. */
export function parkedAssignRequestBody(
  resource: ParkedAssignResource,
  opts: { stepUpGrant?: string; acceptIdentityCollision?: boolean },
): { orgId: string; siteId: string; possessionConfirmed: true; stepUpGrant?: string; acceptIdentityCollision?: boolean } {
  return {
    orgId: resource.targetOrgId,
    siteId: resource.targetSiteId,
    possessionConfirmed: true,
    ...(opts.stepUpGrant ? { stepUpGrant: opts.stepUpGrant } : {}),
    ...(opts.acceptIdentityCollision ? { acceptIdentityCollision: true } : {}),
  };
}

/** Body for `POST /pre-assignment/devices/assign-bulk`. */
export function parkedBulkAssignRequestBody(
  items: ParkedAssignResource[],
  stepUpGrant?: string,
): {
  items: Array<{ deviceId: string; orgId: string; siteId: string }>;
  possessionConfirmed: true;
  stepUpGrant?: string;
} {
  return {
    items: items.map((i) => ({ deviceId: i.deviceId, orgId: i.targetOrgId, siteId: i.targetSiteId })),
    possessionConfirmed: true,
    ...(stepUpGrant ? { stepUpGrant } : {}),
  };
}
