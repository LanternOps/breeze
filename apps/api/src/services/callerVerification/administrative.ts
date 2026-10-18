/**
 * Live eligibility of an administrative step-up (#6354 W05).
 *
 * A stored administrative row is only as good as the session that proved it.
 * This re-checks, against live state: the refresh-token family (`sid` is
 * `refreshTokenFamilies.familyId`) is unrevoked and unexpired, the user is
 * active, the live `authEpoch`/`mfaEpoch` still equal the proof's, the proof
 * is inside the TTL, and the user still holds ORGS_WRITE with access to the org.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema/users';
import { organizations } from '../../db/schema/orgs';
import { refreshTokenFamilies } from '../../db/schema/refreshTokenFamilies';
import { getUserPermissions, hasPermission, canAccessOrg, PERMISSIONS } from '../permissions';
import { getEffectivePolicy } from './policy';
import type { VerificationRow } from './types';

export async function administrativeEligible(input: {
  orgId: string; userId: string; sid: string; authEpoch: number; mfaEpoch: number;
  verifiedAt: Date; ttlMinutes: number;
}): Promise<boolean> {
  const now = new Date();
  const proofTime = input.verifiedAt.getTime();
  if (!Number.isFinite(proofTime) || proofTime > now.getTime() ||
      proofTime <= now.getTime() - input.ttlMinutes * 60_000) return false;
  const [live] = await db.select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users).innerJoin(refreshTokenFamilies, and(
      eq(refreshTokenFamilies.userId, users.id), eq(refreshTokenFamilies.familyId, input.sid),
      isNull(refreshTokenFamilies.revokedAt), gt(refreshTokenFamilies.absoluteExpiresAt, now),
    )).where(and(eq(users.id, input.userId), eq(users.status, 'active'))).limit(1);
  if (!live || live.authEpoch !== input.authEpoch || live.mfaEpoch !== input.mfaEpoch) return false;
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) return false;
  const permissions = await getUserPermissions(input.userId, { orgId: input.orgId, partnerId: org.partnerId });
  return !!permissions && canAccessOrg(permissions, input.orgId)
    && hasPermission(permissions, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)
    && (permissions.scope !== 'partner' || permissions.partnerId === org.partnerId);
}

/**
 * Row adapter for the gate's default `ports.administrativeEligible`: reads the
 * policy TTL itself and refuses any row missing a stored proof field.
 */
export async function administrativeEligibleForRow(r: VerificationRow): Promise<boolean> {
  if (!r.initiatedByUserId || !r.stepupSessionId || r.stepupAuthEpoch === null || r.stepupMfaEpoch === null
      || !r.stepupVerifiedAt) return false;
  const policy = await getEffectivePolicy(r.orgId);
  return administrativeEligible({
    orgId: r.orgId, userId: r.initiatedByUserId, sid: r.stepupSessionId,
    authEpoch: r.stepupAuthEpoch, mfaEpoch: r.stepupMfaEpoch, verifiedAt: r.stepupVerifiedAt,
    ttlMinutes: policy.verificationTtlMinutes,
  });
}
