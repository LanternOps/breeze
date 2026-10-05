import type { cisBaselines } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  captureSensitiveDataAuthority,
  decodeSensitiveDataAuthority,
  EMPTY_SENSITIVE_DATA_AUTHORITY,
  resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext,
  resolveSensitiveDataAuthorityInCurrentSystemContext,
  type EffectiveSensitiveDataAuthority,
  type PersistedSensitiveDataAuthority,
  type SensitiveDataAuthorityValues,
} from './sensitiveDataPolicyAuthority';

/**
 * Stored execution authority for recurring CIS baseline scans.
 *
 * A scheduled baseline keeps queueing `cis_benchmark` commands with no request
 * and no principal behind it, so it carries the same creator-bound envelope as a
 * recurring sensitive-data policy (`sensitiveDataPolicyAuthority.ts`): who
 * approved it, the site ceiling they held, a fingerprint and a random
 * generation. The envelope is minted when a user with devices:execute + MFA
 * saves the baseline, and re-resolved LIVE (user active, still holds
 * devices:execute in the owning org/partner) before every scheduled dispatch.
 *
 * Legacy rows (saved before the envelope existed) are grandfathered on their
 * creator: `execution_authority_legacy = 'grandfathered'` keeps the schedule
 * dispatching while `created_by` is active and holds devices:execute for the
 * owner, checked live with the same resolution as a stamp. `created_by` is the
 * only principal `cis_baselines` records (there is no updated_by); it is set
 * from the authenticated user on insert and never rewritten. The first failed
 * check flips the row to 'revoked' — paused, `reapproval_required` — and a
 * save (which always stamps) clears the legacy marker for good.
 */

type CisBaselineRow = typeof cisBaselines.$inferSelect;

export type CisBaselineAuthorityColumns = Pick<
  CisBaselineRow,
  | 'orgId'
  | 'partnerId'
  | 'executionAuthorityVersion'
  | 'executionAuthorityKind'
  | 'executionAuthoritySiteIds'
  | 'executionAuthorityUserId'
  | 'executionAuthorityPrincipalKind'
  | 'executionAuthorityFingerprint'
  | 'executionAuthorityCapturedAt'
  | 'executionAuthorityGeneration'
> & Partial<Pick<CisBaselineRow, 'executionAuthorityLegacy' | 'createdBy'>>;

export type CisScheduleApproval = {
  status: 'approved' | 'legacy_grandfathered' | 'reapproval_required' | 'not_scheduled';
  approvedBy: string | null;
  approvedAt: string | null;
};

export const EMPTY_CIS_BASELINE_AUTHORITY = EMPTY_SENSITIVE_DATA_AUTHORITY;

/** True when any envelope column is set — such a row never takes the legacy path. */
function hasEnvelope(row: CisBaselineAuthorityColumns): boolean {
  return row.executionAuthorityVersion !== null
    || row.executionAuthorityKind !== null
    || row.executionAuthoritySiteIds !== null
    || row.executionAuthorityUserId !== null
    || row.executionAuthorityPrincipalKind !== null
    || row.executionAuthorityFingerprint !== null
    || row.executionAuthorityCapturedAt !== null
    || row.executionAuthorityGeneration !== null;
}

/** True when the scheduler would pick this baseline up (null schedule = enabled default). */
export function isCisBaselineScheduled(row: { isActive: boolean; scanSchedule: unknown }): boolean {
  if (!row.isActive) return false;
  const schedule = row.scanSchedule;
  if (!schedule || typeof schedule !== 'object') return true;
  return (schedule as { enabled?: unknown }).enabled !== false;
}

function persisted(row: CisBaselineAuthorityColumns): PersistedSensitiveDataAuthority {
  return {
    orgId: row.orgId,
    partnerId: row.partnerId,
    executionAuthorityVersion: row.executionAuthorityVersion,
    executionAuthorityKind: row.executionAuthorityKind,
    executionAuthoritySiteIds: row.executionAuthoritySiteIds,
    executionAuthorityUserId: row.executionAuthorityUserId,
    executionAuthorityPrincipalKind: row.executionAuthorityPrincipalKind,
    executionAuthorityFingerprint: row.executionAuthorityFingerprint,
    executionAuthorityCapturedAt: row.executionAuthorityCapturedAt,
    executionAuthorityGeneration: row.executionAuthorityGeneration,
  };
}

/**
 * Mint the envelope for a baseline save. Returns null when the caller cannot
 * own a recurring effect for this owner (the route answers 403).
 */
export function captureCisBaselineAuthority(
  auth: AuthContext,
  owner: { orgId: string | null; partnerId: string | null },
): SensitiveDataAuthorityValues | null {
  if (owner.orgId) return captureSensitiveDataAuthority(auth, { orgId: owner.orgId, partnerId: null });
  if (owner.partnerId) return captureSensitiveDataAuthority(auth, { orgId: null, partnerId: owner.partnerId });
  return null;
}

/** Static (no DB) approval state for API responses. Live revocation is checked at dispatch. */
export function describeCisScheduleApproval(
  row: CisBaselineAuthorityColumns & { isActive: boolean; scanSchedule: unknown },
): CisScheduleApproval {
  if (!isCisBaselineScheduled(row)) {
    return { status: 'not_scheduled', approvedBy: null, approvedAt: null };
  }
  if (!hasEnvelope(row) && row.executionAuthorityLegacy === 'grandfathered') {
    return { status: 'legacy_grandfathered', approvedBy: row.createdBy ?? null, approvedAt: null };
  }
  const decoded = decodeSensitiveDataAuthority(persisted(row));
  if (!decoded) return { status: 'reapproval_required', approvedBy: null, approvedAt: null };
  return {
    status: 'approved',
    approvedBy: decoded.userId,
    approvedAt: row.executionAuthorityCapturedAt ? row.executionAuthorityCapturedAt.toISOString() : null,
  };
}

/** Strip the raw envelope from a row before it leaves the API. */
export function withoutCisBaselineAuthority<T extends CisBaselineAuthorityColumns>(row: T) {
  const {
    executionAuthorityVersion: _version,
    executionAuthorityKind: _kind,
    executionAuthoritySiteIds: _siteIds,
    executionAuthorityUserId: _userId,
    executionAuthorityPrincipalKind: _principalKind,
    executionAuthorityFingerprint: _fingerprint,
    executionAuthorityCapturedAt: _capturedAt,
    executionAuthorityGeneration: _generation,
    executionAuthorityLegacy: _legacy,
    ...visible
  } = row;
  return visible;
}

/**
 * Live resolution for the scheduler. Must run inside a system DB access
 * context (the CIS worker always does). Any failure resolves to null — a
 * schedule whose authority cannot be established does not dispatch.
 */
export async function resolveCisBaselineScheduleAuthority(
  row: CisBaselineAuthorityColumns,
): Promise<EffectiveSensitiveDataAuthority | null> {
  try {
    return await resolveSensitiveDataAuthorityInCurrentSystemContext(persisted(row));
  } catch (error) {
    console.error('[CisBaselineScheduleAuthority] authority resolution failed:', error);
    return null;
  }
}

export type CisScheduleDispatch =
  | { ok: true; mode: 'stamped' | 'legacy'; authority: EffectiveSensitiveDataAuthority }
  | { ok: false; reason: 'reapproval_required' | 'authority_unavailable'; revokeLegacy?: true };

/**
 * The scheduler's decision for one baseline: stamped envelope (re-resolved
 * live), else the legacy creator path for a grandfathered row, else paused.
 * `revokeLegacy` asks the caller to flip a grandfathered row to 'revoked'.
 * A lookup failure on the legacy path skips the tick without revoking.
 */
export async function resolveCisScheduleDispatch(
  row: CisBaselineAuthorityColumns,
): Promise<CisScheduleDispatch> {
  if (hasEnvelope(row)) {
    const authority = await resolveCisBaselineScheduleAuthority(row);
    return authority
      ? { ok: true, mode: 'stamped', authority }
      : { ok: false, reason: 'reapproval_required' };
  }
  if (row.executionAuthorityLegacy !== 'grandfathered') {
    return { ok: false, reason: 'reapproval_required' };
  }
  try {
    const authority = await resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext(
      { orgId: row.orgId, partnerId: row.partnerId },
      row.createdBy ?? null,
    );
    return authority
      ? { ok: true, mode: 'legacy', authority }
      : { ok: false, reason: 'reapproval_required', revokeLegacy: true };
  } catch (error) {
    console.error('[CisBaselineScheduleAuthority] legacy authority check failed:', error);
    return { ok: false, reason: 'authority_unavailable' };
  }
}
