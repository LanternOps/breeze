import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  organizationUsers,
  organizations,
  partnerUsers,
  permissions,
  rolePermissions,
  users,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { normalizeBaselineScanSchedule } from './networkBaseline';

/**
 * SEC-2026-09-05-146 — creator-bound versioned authority for recurring
 * network-baseline scans.
 *
 * A `scan_schedule` is a standing effect: once armed, the scheduler keeps
 * dispatching discovery jobs on its own, with no request and no principal. The
 * table used to record only org/site/subnet/schedule, so a schedule armed by a
 * user who was later disabled, deleted, removed from the org, moved out of the
 * site or stripped of `devices:write` kept firing indefinitely.
 *
 * The fix binds every enabled schedule to the exact principal that armed it,
 * the site ceiling that principal held at arm time, its permission/MFA epochs,
 * a fingerprint of the effect and a monotonic generation. The scheduler
 * re-resolves all of that LIVE, under a row lock, immediately before any
 * discovery-job / profile / queue effect. Anything that does not resolve is not
 * dispatched.
 *
 * Deliberately fail-closed: a row without a complete envelope (every row that
 * predates the migration) is never dispatched. Backfilling a creator would
 * invent the very provenance the finding is about.
 */

/** The permission an interactive baseline create/update already requires. */
export const BASELINE_AUTHORITY_PERMISSION = { resource: 'devices', action: 'write' } as const;

export const BASELINE_BLOCKED_REASON = {
  /** No envelope, or an incomplete one — a pre-migration row. */
  REAPPROVAL_REQUIRED: 'reapproval_required',
  /** The principal is gone, disabled, or no longer reaches this org. */
  AUTHORITY_REVOKED: 'authority_revoked',
  /** The principal no longer holds devices:write here. */
  PERMISSION_REVOKED: 'permission_revoked',
  /** The baseline's site is outside the armed or the current site ceiling. */
  SITE_OUT_OF_SCOPE: 'site_out_of_scope',
  /** users.permissions_epoch / users.mfa_epoch advanced since arming. */
  EPOCH_CHANGED: 'epoch_changed',
  /** org/site/subnet/schedule changed since arming — re-approval required. */
  EFFECT_CHANGED: 'effect_changed',
  /** The tick was issued against an older envelope than the row now carries. */
  STALE_GENERATION: 'stale_generation',
  /** The schedule was turned off. */
  SCHEDULE_DISABLED: 'schedule_disabled',
} as const;

export type BaselineBlockedReason =
  typeof BASELINE_BLOCKED_REASON[keyof typeof BASELINE_BLOCKED_REASON];

/** The subset of a `network_baselines` row the gate needs. */
export interface BaselineAuthorityRow {
  id: string;
  orgId: string;
  siteId: string;
  subnet: string;
  scanSchedule: unknown;
  authorityUserId: string | null;
  authoritySiteIds: string[] | null;
  authorityPermissionsEpoch: number | null;
  authorityMfaEpoch: number | null;
  authorityFingerprint: string | null;
  authorityGeneration: number;
}

/** Live authority state of the arming principal, resolved at dispatch time. */
export interface BaselineAuthoritySubject {
  userId: string;
  status: 'active' | 'invited' | 'disabled';
  permissionsEpoch: number;
  mfaEpoch: number;
  /** null = the principal no longer reaches the baseline's organization. */
  membership: null | {
    /** Current site ceiling; null = unrestricted within the org. */
    allowedSiteIds: string[] | null;
    hasRequiredPermission: boolean;
  };
}

export type BaselineAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: BaselineBlockedReason };

export interface BaselineAuthorityEnvelope {
  authorityUserId: string;
  authoritySiteIds: string[] | null;
  authorityPermissionsEpoch: number;
  authorityMfaEpoch: number;
  authorityFingerprint: string;
  authorityArmedAt: Date;
  scheduleBlockedReason: null;
}

/** Raised when a context that cannot own a recurring effect tries to arm one. */
export class BaselineAuthorityUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineAuthorityUnsupportedError';
  }
}

/**
 * sha256 over the locators plus the EFFECTIVE schedule.
 *
 * `nextScanAt` is excluded on purpose: the scheduler rewrites it on every tick
 * and `compareBaselineScan` re-normalises the whole schedule after each scan, so
 * including it would make every envelope invalidate itself one tick after being
 * armed. What must not drift silently is which network gets scanned, for whom,
 * and how often.
 */
export function computeBaselineAuthorityFingerprint(input: {
  orgId: string;
  siteId: string;
  subnet: string;
  scanSchedule: unknown;
}): string {
  const schedule = normalizeBaselineScanSchedule(input.scanSchedule);
  const canonical = [
    input.orgId,
    input.siteId,
    input.subnet,
    JSON.stringify({ enabled: schedule.enabled, intervalHours: schedule.intervalHours }),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Pure dispatch decision. Split from the DB reader so every denial branch is
 * exhaustively unit-testable without a database.
 */
export function evaluateBaselineDispatchAuthority(
  row: BaselineAuthorityRow,
  subject: BaselineAuthoritySubject | null,
  options: { expectedGeneration?: number | null },
): BaselineAuthorityDecision {
  const deny = (reason: BaselineBlockedReason): BaselineAuthorityDecision => ({ allowed: false, reason });

  // 1. Envelope completeness. A partial envelope is as untrustworthy as none.
  if (
    !row.authorityUserId ||
    !row.authorityFingerprint ||
    row.authorityPermissionsEpoch === null ||
    row.authorityPermissionsEpoch === undefined ||
    row.authorityMfaEpoch === null ||
    row.authorityMfaEpoch === undefined
  ) {
    return deny(BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED);
  }

  // 2. The schedule must still be on.
  if (!normalizeBaselineScanSchedule(row.scanSchedule).enabled) {
    return deny(BASELINE_BLOCKED_REASON.SCHEDULE_DISABLED);
  }

  // 3. Generation: the row must be the exact envelope the tick was issued for.
  if (
    options.expectedGeneration !== null &&
    options.expectedGeneration !== undefined &&
    options.expectedGeneration !== row.authorityGeneration
  ) {
    return deny(BASELINE_BLOCKED_REASON.STALE_GENERATION);
  }

  // 4. Effect fingerprint — a site or org move, or a subnet/interval change,
  //    lands here and requires explicit re-approval.
  if (computeBaselineAuthorityFingerprint(row) !== row.authorityFingerprint) {
    return deny(BASELINE_BLOCKED_REASON.EFFECT_CHANGED);
  }

  // 5. The principal must still exist and be active.
  if (!subject || subject.userId !== row.authorityUserId || subject.status !== 'active') {
    return deny(BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED);
  }

  // 6. Epochs unchanged since arming.
  if (
    subject.permissionsEpoch !== row.authorityPermissionsEpoch ||
    subject.mfaEpoch !== row.authorityMfaEpoch
  ) {
    return deny(BASELINE_BLOCKED_REASON.EPOCH_CHANGED);
  }

  // 7. Still a member of the baseline's organization.
  if (!subject.membership) {
    return deny(BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED);
  }

  // 8. Still holds devices:write.
  if (!subject.membership.hasRequiredPermission) {
    return deny(BASELINE_BLOCKED_REASON.PERMISSION_REVOKED);
  }

  // 9. The baseline's site must be inside BOTH the ceiling recorded at arm time
  //    and the ceiling the principal holds right now. The armed ceiling is not
  //    redundant: a later widening of the principal's access must not silently
  //    extend an old schedule's reach.
  if (row.authoritySiteIds !== null && !row.authoritySiteIds.includes(row.siteId)) {
    return deny(BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE);
  }
  const currentCeiling = subject.membership.allowedSiteIds;
  if (currentCeiling !== null && !currentCeiling.includes(row.siteId)) {
    return deny(BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE);
  }

  return { allowed: true };
}

async function roleHasRequiredPermission(roleId: string): Promise<boolean> {
  const rows = await db
    .select({ id: permissions.id })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        eq(rolePermissions.roleId, roleId),
        eq(permissions.resource, BASELINE_AUTHORITY_PERMISSION.resource),
        eq(permissions.action, BASELINE_AUTHORITY_PERMISSION.action),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Live read of the arming principal's authority for one organization.
 *
 * Deliberately uncached — `getUserPermissions` memoises per process, and a gate
 * whose whole job is to notice a revocation must not read a cached grant. Must
 * run inside a system DB access context (the worker already does): resolving a
 * principal's own membership is an identity question, and an org-scoped context
 * would be blind to the partner-axis row.
 */
export async function loadBaselineAuthoritySubject(
  userId: string,
  orgId: string,
): Promise<BaselineAuthoritySubject | null> {
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      permissionsEpoch: users.permissionsEpoch,
      mfaEpoch: users.mfaEpoch,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return null;

  const base = {
    userId: user.id,
    status: user.status,
    permissionsEpoch: user.permissionsEpoch,
    mfaEpoch: user.mfaEpoch,
  };

  // Org axis first — same precedence as getUserPermissions.
  const [orgUser] = await db
    .select({ roleId: organizationUsers.roleId, siteIds: organizationUsers.siteIds })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgId)))
    .limit(1);

  if (orgUser?.roleId) {
    return {
      ...base,
      membership: {
        allowedSiteIds: orgUser.siteIds ?? null,
        hasRequiredPermission: await roleHasRequiredPermission(orgUser.roleId),
      },
    };
  }

  // Partner axis — a partner-scope tech may have armed the schedule. Their reach
  // to this org must still be live (org_access, and the org must still belong to
  // that partner). Partner memberships carry no site ceiling.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org?.partnerId) return { ...base, membership: null };

  const [partnerUser] = await db
    .select({
      roleId: partnerUsers.roleId,
      orgAccess: partnerUsers.orgAccess,
      orgIds: partnerUsers.orgIds,
    })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, org.partnerId)))
    .limit(1);

  if (!partnerUser?.roleId) return { ...base, membership: null };
  if (partnerUser.orgAccess === 'none') return { ...base, membership: null };
  if (partnerUser.orgAccess === 'selected' && !(partnerUser.orgIds ?? []).includes(orgId)) {
    return { ...base, membership: null };
  }

  return {
    ...base,
    membership: {
      allowedSiteIds: null,
      hasRequiredPermission: await roleHasRequiredPermission(partnerUser.roleId),
    },
  };
}

/** DB-backed dispatch gate: live subject + pure decision. */
export async function resolveBaselineDispatchAuthority(
  row: BaselineAuthorityRow,
  options: { expectedGeneration?: number | null } = {},
): Promise<BaselineAuthorityDecision> {
  if (!row.authorityUserId) {
    return { allowed: false, reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED };
  }
  const subject = await loadBaselineAuthoritySubject(row.authorityUserId, row.orgId);
  return evaluateBaselineDispatchAuthority(row, subject, options);
}

/**
 * Build the envelope to persist alongside a schedule create/change, from the
 * CURRENT authenticated user.
 *
 * System-scope contexts cannot arm a recurring scan: there is no principal whose
 * revocation would ever stop it, which is exactly the finding. That path fails
 * closed rather than synthesising an owner.
 */
export async function buildBaselineAuthorityEnvelope(
  auth: AuthContext,
  effect: { orgId: string; siteId: string; subnet: string; scanSchedule: unknown },
): Promise<BaselineAuthorityEnvelope> {
  if (auth.scope === 'system' || !auth.user?.id) {
    throw new BaselineAuthorityUnsupportedError(
      'A recurring network baseline schedule must be armed by a user principal; system-issued arming is not supported.',
    );
  }

  const [user] = await db
    .select({ permissionsEpoch: users.permissionsEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    throw new BaselineAuthorityUnsupportedError('Arming principal not found');
  }

  return {
    authorityUserId: auth.user.id,
    // undefined = unrestricted; persist NULL for that, and the explicit list
    // (including an empty one) otherwise.
    authoritySiteIds: auth.allowedSiteIds === undefined ? null : [...auth.allowedSiteIds],
    authorityPermissionsEpoch: user.permissionsEpoch,
    authorityMfaEpoch: user.mfaEpoch,
    authorityFingerprint: computeBaselineAuthorityFingerprint(effect),
    authorityArmedAt: new Date(),
    scheduleBlockedReason: null,
  };
}
