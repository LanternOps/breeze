import type { Queue } from 'bullmq';
import { and, asc, eq, gt } from 'drizzle-orm';

import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, partners } from '../db/schema';
import { classifyIp, type IpClassifyTarget } from '../services/ipClassify';
import { tryAutoPromote } from '../services/partnerTrustPromotion';
import { jobSchedule } from './scheduleRegistry';

export const IP_CLASSIFY_JOB = 'ip-classify';
export const PARTNER_TRUST_PROMOTE_JOB = 'partner-trust-promote';
const PROMOTE_REPEAT_ID = 'partner-trust-promote-repeat';

export async function runPartnerTrustPromote(): Promise<{ processed: number; promoted: number }> {
  let cursor: string | undefined;
  let processed = 0;
  let promoted = 0;
  do {
    const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ id: partners.id })
      .from(partners)
      .where(cursor
        ? and(eq(partners.trustState, 'probation'), gt(partners.id, cursor))
        : eq(partners.trustState, 'probation'))
      .orderBy(asc(partners.id))
      .limit(200), 'partnerTrustJobs.promote'));
    for (const partner of batch) {
      processed += 1;
      if (await tryAutoPromote(partner.id)) promoted += 1;
    }
    cursor = batch.at(-1)?.id;
    if (batch.length < 200) break;
  } while (cursor);
  return { processed, promoted };
}

export async function processPartnerTrustJob(
  job: { name: string; data: unknown },
): Promise<unknown | undefined> {
  if (job.name === PARTNER_TRUST_PROMOTE_JOB) {
    if (partnerTrustMode() === 'off') return { skipped: true };
    return runPartnerTrustPromote();
  }
  if (job.name !== IP_CLASSIFY_JOB) return undefined;
  if (partnerTrustMode() === 'off') return { skipped: true };

  const target = job.data as IpClassifyTarget;

  const classification = await classifyIp(target.ip);
  const classifiedAt = new Date();
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    if (target.kind === 'partner') {
      await db.update(partners).set({
        signupIpClass: classification.ipClass,
        signupIpAsn: classification.asn,
        signupIpClassifiedAt: classifiedAt,
      }).where(eq(partners.id, target.partnerId));
      return;
    }
    await db.update(devices).set({
      enrollmentIpClass: classification.ipClass,
      enrollmentIpAsn: classification.asn,
      enrollmentIpClassifiedAt: classifiedAt,
    }).where(eq(devices.id, target.deviceId));
  }));
  return classification;
}

export async function schedulePartnerTrustJobs(queue: Queue): Promise<void> {
  if (partnerTrustMode() === 'off') return;
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === PARTNER_TRUST_PROMOTE_JOB) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(PARTNER_TRUST_PROMOTE_JOB, {}, {
    jobId: PROMOTE_REPEAT_ID,
    repeat: { pattern: jobSchedule('partner-trust-promote') },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}
