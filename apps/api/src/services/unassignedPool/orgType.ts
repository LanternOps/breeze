/**
 * Pre-assignment enrollment — shared vocabulary.
 *
 * The holding org (`organizations.type = 'unassigned_pool'`) is a hidden
 * per-partner org where devices enrolled with a partner deploy key sit
 * "parked" until a full partner admin assigns them. It is:
 *   - one-way: a device enters only by enrollment admission and leaves only by
 *     assignment, never back (checkPoolMembershipTransition + the
 *     devices_unassigned_pool_* triggers);
 *   - protected: never renamed, re-typed, archived, merged, deleted or given
 *     new sites through generic surfaces;
 *   - invisible: never in a human caller's accessibleOrgIds.
 *
 * Deliberately dependency-free (no db, no db/schema): middleware and routes
 * whose unit tests mock those modules import this file. Write the Drizzle
 * predicate at the call site: `ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE)`.
 *
 * Do NOT fold this into a generic "hidden org" list for execution decisions:
 * Quick Support is hidden AND remote-capable; the holding org is hidden AND
 * execution-denied.
 */
export const UNASSIGNED_POOL_ORG_TYPE = 'unassigned_pool' as const;

export function isUnassignedPoolOrgType(type: string | null | undefined): boolean {
  return type === UNASSIGNED_POOL_ORG_TYPE;
}

/**
 * Transaction-local GUC an admission path sets through
 * `declareParkedDeviceAdmission` (./admission.ts, always `is_local = true`)
 * before inserting a device into a holding org. The
 * devices_unassigned_pool_insert_guard trigger refuses the INSERT otherwise.
 * A forcing function, not an authorization boundary: the contract test in
 * src/__tests__/unassignedPoolContracts.test.ts allowlists every file that may
 * name it.
 */
export const PARKED_DEVICE_ADMISSION_GUC = 'breeze.parked_device_admission' as const;
export const PARKED_DEVICE_ADMISSION_ENROLLMENT = 'enrollment' as const;

export type PoolMembershipVia = 'generic_move' | 'org_merge' | 'pool_assignment';
export type PoolMembershipRefusalCode = 'POOL_ENTRY_FORBIDDEN' | 'POOL_EXIT_REQUIRES_ASSIGNMENT';
export interface PoolMembershipRefusal {
  code: PoolMembershipRefusalCode;
  message: string;
}

/**
 * The one-way rule. Returns a refusal, or null when the move is allowed.
 * Entry into a holding org is refused on every path (a device that has lived
 * in a real org still holds whatever it was sent there). Exit is allowed only
 * through the dedicated assignment operation.
 */
export function checkPoolMembershipTransition(input: {
  sourceOrgType: string | null | undefined;
  targetOrgType: string | null | undefined;
  via: PoolMembershipVia;
}): PoolMembershipRefusal | null {
  if (isUnassignedPoolOrgType(input.targetOrgType)) {
    return {
      code: 'POOL_ENTRY_FORBIDDEN',
      message: 'Devices cannot be moved into the unassigned-device holding area',
    };
  }
  if (isUnassignedPoolOrgType(input.sourceOrgType) && input.via !== 'pool_assignment') {
    return {
      code: 'POOL_EXIT_REQUIRES_ASSIGNMENT',
      message: 'A parked device leaves the holding area only through assignment',
    };
  }
  return null;
}

/** 409 body every generic org/site mutation returns for a holding org. */
export const PROTECTED_ORG_ERROR = {
  error: 'The unassigned-device holding area is managed by Breeze and cannot be changed here',
  code: 'ORG_PROTECTED',
} as const;
