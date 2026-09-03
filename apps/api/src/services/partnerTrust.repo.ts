import { eq } from 'drizzle-orm';
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

export async function writeTrust(
  partnerId: string,
  next: PartnerTrustState,
  reason: string,
  actorUserId: string | null,
): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.update(partners).set({
      trustState: next,
      trustReason: reason,
      trustChangedBy: actorUserId,
      trustChangedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(partners.id, partnerId)),
  'partnerTrust.writeTrust'));
}

export async function partnerForDevice(deviceId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ partnerId: organizations.partnerId }).from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(eq(devices.id, deviceId)).limit(1);
    return row?.partnerId ?? null;
  }, 'partnerTrust.partnerForDevice'));
}
