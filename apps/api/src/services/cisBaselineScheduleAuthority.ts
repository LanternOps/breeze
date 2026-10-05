import type { cisBaselines } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { captureException } from './sentry';
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
> & Partial<Pick<
  CisBaselineRow,
  'executionAuthorityLegacy' | 'createdBy' | 'executionAuthorityStatus' | 'executionAuthorityStatusAt'
>>;

export type CisAuthorityCheckStatus = 'ok' | 'approver_invalid' | 'lookup_failed';

export type CisScheduleApproval = {
  status: 'approved' | 'legacy_grandfathered' | 'reapproval_required' | 'not_scheduled';
  /**
   * Why re-approval is required: the approver (or legacy creator) failed the
   * live check ('approver_invalid'), the row was never approved
   * ('not_approved'), or its stored approval is malformed ('invalid_approval').
   */
  reason: 'approver_invalid' | 'not_approved' | 'invalid_approval' | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Last dispatch-time check outcome and when it last changed (null = not checked yet). */
  checkStatus: CisAuthorityCheckStatus | null;
  checkStatusSince: string | null;
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
  const check = {
    checkStatus: row.executionAuthorityStatus ?? null,
    checkStatusSince: row.executionAuthorityStatusAt ? row.executionAuthorityStatusAt.toISOString() : null,
  };
  const result = (
    status: CisScheduleApproval['status'],
    reason: CisScheduleApproval['reason'],
    approvedBy: string | null = null,
    approvedAt: string | null = null,
  ): CisScheduleApproval => ({ status, reason, approvedBy, approvedAt, ...check });

  if (!isCisBaselineScheduled(row)) return result('not_scheduled', null);
  if (!hasEnvelope(row)) {
    if (row.executionAuthorityLegacy === 'grandfathered') {
      return result('legacy_grandfathered', null, row.createdBy ?? null);
    }
    if (row.executionAuthorityLegacy === 'revoked') {
      return result('reapproval_required', 'approver_invalid', row.createdBy ?? null);
    }
    return result('reapproval_required', 'not_approved');
  }
  const decoded = decodeSensitiveDataAuthority(persisted(row));
  if (!decoded) return result('reapproval_required', 'invalid_approval');
  const approvedAt = row.executionAuthorityCapturedAt ? row.executionAuthorityCapturedAt.toISOString() : null;
  // The stamp itself is intact, but the last dispatch found its approver no
  // longer qualifies: the schedule is paused, so say so instead of "approved".
  // A transient 'lookup_failed' does not claim the approval is gone.
  if (row.executionAuthorityStatus === 'approver_invalid') {
    return result('reapproval_required', 'approver_invalid', decoded.userId, approvedAt);
  }
  return result('approved', null, decoded.userId, approvedAt);
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
    executionAuthorityStatus: _status,
    executionAuthorityStatusAt: _statusAt,
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
    captureException(error);
    return null;
  }
}

export type CisScheduleDispatch =
  | { ok: true; mode: 'stamped' | 'legacy'; authority: EffectiveSensitiveDataAuthority; checkStatus: 'ok' }
  | {
      ok: false;
      reason: 'reapproval_required' | 'authority_unavailable';
      revokeLegacy?: true;
      /** Absent when no live check ran (row never approved, or legacy already revoked). */
      checkStatus?: 'approver_invalid' | 'lookup_failed';
    };

/**
 * The scheduler's decision for one baseline: stamped envelope (re-resolved
 * live), else the legacy creator path for a grandfathered row, else paused.
 * `checkStatus` is what the caller persists on the row (on change) so the API
 * can say why a schedule stopped; `revokeLegacy` asks it to flip a
 * grandfathered row to 'revoked'. A lookup failure is transient: it is
 * reported to Sentry and retried next tick, never revoked.
 */
export async function resolveCisScheduleDispatch(
  row: CisBaselineAuthorityColumns,
): Promise<CisScheduleDispatch> {
  const lookupFailed = (error: unknown): CisScheduleDispatch => {
    console.error('[CisBaselineScheduleAuthority] authority lookup failed:', error);
    captureException(error);
    return { ok: false, reason: 'authority_unavailable', checkStatus: 'lookup_failed' };
  };

  if (hasEnvelope(row)) {
    if (!decodeSensitiveDataAuthority(persisted(row))) {
      return { ok: false, reason: 'reapproval_required', checkStatus: 'approver_invalid' };
    }
    try {
      const authority = await resolveSensitiveDataAuthorityInCurrentSystemContext(persisted(row));
      return authority
        ? { ok: true, mode: 'stamped', authority, checkStatus: 'ok' }
        : { ok: false, reason: 'reapproval_required', checkStatus: 'approver_invalid' };
    } catch (error) {
      return lookupFailed(error);
    }
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
      ? { ok: true, mode: 'legacy', authority, checkStatus: 'ok' }
      : { ok: false, reason: 'reapproval_required', revokeLegacy: true, checkStatus: 'approver_invalid' };
  } catch (error) {
    return lookupFailed(error);
  }
}
