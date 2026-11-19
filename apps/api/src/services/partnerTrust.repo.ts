import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, devices, organizations } from '../db/schema';
import type { PartnerTrustState } from '../db/schema/orgs';

export interface TrustRow {
  trustState: PartnerTrustState;
  probationEnrollments: number;
  trustReviewRequestedAt: Date | null;
}

// System context: the request role must not need SELECT on trust columns
// for other partners, and dispatch paths run with no request context at all.
export async function readTrust(partnerId: string): Promise<TrustRow | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({
      trustState: partners.trustState,
      probationEnrollments: partners.probationEnrollments,
      trustReviewRequestedAt: partners.trustReviewRequestedAt,
    }).from(partners).where(eq(partners.id, partnerId)).limit(1);
    return row ?? null;
  }, 'partnerTrust.readTrust'));
}

/**
 * Persists a trust-state transition. When `expectedFrom` is given, the UPDATE
 * is qualified with `AND trust_state = expectedFrom` so the write is an
 * atomic compare-and-swap: a concurrent writer that already moved the row out
 * of `expectedFrom` (e.g. an admin restriction, or another auto-promotion)
 * causes this call to affect zero rows instead of clobbering that change.
 * Returns the number of rows the UPDATE affected (0 or 1).
 */
export interface WriteTrustExtra {
  /**
   * Also require the row's trust_changed_at to equal this value, so the write
   * is bound to one specific earlier transition, not just to a state.
   */
  expectedTrustChangedAt?: Date;
  /**
   * Runs in the SAME transaction as the UPDATE, only when it affected a row,
   * with the trust_changed_at the UPDATE stored. Use the ambient `db` inside
   * it (never a helper that calls runOutsideDbContext, which would run on a
   * second connection). Throwing rolls the trust write back with it.
   */
  withinWrite?: (written: { trustChangedAt: Date }) => Promise<void>;
}

export async function writeTrust(
  partnerId: string,
  next: PartnerTrustState,
  reason: string,
  actorUserId: string | null,
  expectedFrom?: PartnerTrustState,
  extra?: WriteTrustExtra,
): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const conditions = [eq(partners.id, partnerId)];
    if (expectedFrom) conditions.push(eq(partners.trustState, expectedFrom));
    if (extra?.expectedTrustChangedAt) conditions.push(eq(partners.trustChangedAt, extra.expectedTrustChangedAt));
    const changedAt = new Date();
    const rows = await db.update(partners).set({
      trustState: next,
      trustReason: reason,
      trustChangedBy: actorUserId,
      trustChangedAt: changedAt,
      updatedAt: changedAt,
    }).where(and(...conditions)).returning({ id: partners.id });
    if (rows.length > 0 && extra?.withinWrite) await extra.withinWrite({ trustChangedAt: changedAt });
    return rows.length;
  }, 'partnerTrust.writeTrust'));
}

export async function partnerForOrg(orgId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
      .where(eq(organizations.id, orgId)).limit(1);
    return row?.partnerId ?? null;
  }, 'partnerTrust.partnerForOrg'));
}

export async function partnerForDevice(deviceId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ partnerId: organizations.partnerId }).from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(eq(devices.id, deviceId)).limit(1);
    return row?.partnerId ?? null;
  }, 'partnerTrust.partnerForDevice'));
}
