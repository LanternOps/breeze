// Evidence readers the posture report never had (spec trust-center §5.3).
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, backupVerifications, m365PostureRollups } from '../db/schema';
import type { ControlEvidence } from '@breeze/shared';

const zero = (): ControlEvidence => ({ eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null });

/** Latest m365_posture_rollups row for the org. Registration, not enforcement (spec §5.2). */
export async function loadM365MfaEvidence(orgId: string, asOf: Date, maxAgeDays: number): Promise<ControlEvidence> {
  const [row] = await db.select({
      usersTotal: m365PostureRollups.usersTotal, usersMfaRegistered: m365PostureRollups.usersMfaRegistered,
      usersMfaUnknown: m365PostureRollups.usersMfaUnknown, adminsWithoutMfa: m365PostureRollups.adminsWithoutMfa,
      computedAt: m365PostureRollups.computedAt,
    }).from(m365PostureRollups).where(eq(m365PostureRollups.orgId, orgId))
    .orderBy(desc(m365PostureRollups.rollupDate), desc(m365PostureRollups.computedAt)).limit(1);
  if (!row || row.usersTotal == null) return { ...zero(), gate: null };
  const ageMs = asOf.getTime() - new Date(row.computedAt).getTime();
  const fresh = ageMs <= maxAgeDays * 86400000;
  const eligible = row.usersTotal;
  if (!fresh) return { ...zero(), eligible, gate: null };
  const assessed = Math.max(0, eligible - (row.usersMfaUnknown ?? 0));
  return {
    eligible, assessed, passing: Math.min(assessed, row.usersMfaRegistered ?? 0), aggregatePct: null,
    newestEvidenceAt: new Date(row.computedAt).toISOString(),
    gate: row.adminsWithoutMfa == null ? null : row.adminsWithoutMfa === 0,
  };
}

/** Breeze-managed backups only: a passed integrity check or test restore inside the window.
 *  Third-party provider "last success" is NOT a verification (spec §19.8). */
export async function loadBackupsVerifiedEvidence(orgId: string, deviceIds: string[], asOf: Date, maxAgeDays: number): Promise<ControlEvidence> {
  if (deviceIds.length === 0) return zero();
  const jobDevices = await db.select({ deviceId: backupJobs.deviceId }).from(backupJobs)
    .where(and(eq(backupJobs.orgId, orgId), inArray(backupJobs.deviceId, deviceIds))).groupBy(backupJobs.deviceId);
  const eligibleIds = new Set(jobDevices.map((r) => r.deviceId).filter((v): v is string => typeof v === 'string'));
  if (eligibleIds.size === 0) return zero();
  const windowStart = new Date(asOf.getTime() - maxAgeDays * 86400000);
  const rows = await db.select({
      deviceId: backupVerifications.deviceId, status: backupVerifications.status,
      verificationType: backupVerifications.verificationType, completedAt: backupVerifications.completedAt,
    }).from(backupVerifications)
    .where(and(eq(backupVerifications.orgId, orgId), inArray(backupVerifications.deviceId, [...eligibleIds]), gte(backupVerifications.startedAt, windowStart)));
  const byDevice = new Map<string, { passed: boolean; newest: Date }>();
  for (const r of rows) {
    if (!r.completedAt || r.completedAt < windowStart) continue;
    if (r.verificationType !== 'integrity' && r.verificationType !== 'test_restore') continue;
    const cur = byDevice.get(r.deviceId);
    const passed = (cur?.passed ?? false) || r.status === 'passed';
    const newest = cur && cur.newest > r.completedAt ? cur.newest : r.completedAt;
    byDevice.set(r.deviceId, { passed, newest });
  }
  let newest: string | null = null;
  let passing = 0;
  for (const v of byDevice.values()) {
    if (v.passed) passing += 1;
    const n = v.newest.toISOString();
    if (!newest || n > newest) newest = n;
  }
  return { eligible: eligibleIds.size, assessed: byDevice.size, passing, aggregatePct: null, newestEvidenceAt: newest };
}
