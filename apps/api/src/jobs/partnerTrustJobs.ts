import type { Queue } from 'bullmq';
import { and, asc, eq, gt } from 'drizzle-orm';

import { ipClassifyProvider } from '../config/env';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, partners } from '../db/schema';
import { classifyIp, type IpClassifyTarget } from '../services/ipClassify';
import { partnerForDevice } from '../services/partnerTrust.repo';
import { restrictOnHardDeny, tryAutoPromote } from '../services/partnerTrustPromotion';
import { jobSchedule } from './scheduleRegistry';

export const IP_CLASSIFY_JOB = 'ip-classify';
export const PARTNER_TRUST_PROMOTE_JOB = 'partner-trust-promote';
const PROMOTE_REPEAT_ID = 'partner-trust-promote-repeat';

/**
 * Minimum gap between signup-IP classification attempts for one partner. The
 * promote job runs every 15 minutes; without this bound a provider outage
 * would hammer the classification API once per partner per run.
 */
const IP_BACKFILL_RETRY_MS = 60 * 60 * 1_000;

type ProbationPartner = {
  id: string;
  signupIp: string | null;
  signupIpClass: string;
  signupIpClassifiedAt: Date | null;
};

/**
 * Signup IPs are classified once, at email verification. A deployment that
 * configures a provider afterwards would otherwise leave every existing
 * partner on `signup_ip_class='unknown'` forever — which
 * `promotionDecision` blocks as `signup_ip_unclassified`, so auto-promotion
 * could never fire. Backfill those partners here, bounded by
 * IP_BACKFILL_RETRY_MS. A failed lookup yields `unknown` again (preserved, not
 * upgraded); partners with no recorded signup IP stay blocked for manual
 * review.
 */
async function backfillSignupIpClass(partner: ProbationPartner): Promise<void> {
  if (ipClassifyProvider() === 'none') return;
  if (!partner.signupIp || partner.signupIpClass !== 'unknown') return;
  const lastAttempt = partner.signupIpClassifiedAt?.getTime();
  if (lastAttempt !== undefined && Date.now() - lastAttempt < IP_BACKFILL_RETRY_MS) return;

  const classification = await classifyIp(partner.signupIp);
  await runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(partners).set({
    signupIpClass: classification.ipClass,
    signupIpAsn: classification.asn,
    // Stamped even when the result is still `unknown`: this column is what
    // bounds the retry cadence above.
    signupIpClassifiedAt: new Date(),
  }).where(eq(partners.id, partner.id)), 'partnerTrustJobs.backfillSignupIpClass'));
}

export async function runPartnerTrustPromote(): Promise<{ processed: number; promoted: number }> {
  let cursor: string | undefined;
  let processed = 0;
  let promoted = 0;
  do {
    const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({
        id: partners.id,
        signupIp: partners.signupIp,
        signupIpClass: partners.signupIpClass,
        signupIpClassifiedAt: partners.signupIpClassifiedAt,
      })
      .from(partners)
      .where(cursor
        ? and(eq(partners.trustState, 'probation'), gt(partners.id, cursor))
        : eq(partners.trustState, 'probation'))
      .orderBy(asc(partners.id))
      .limit(200), 'partnerTrustJobs.promote'));
    for (const partner of batch) {
      processed += 1;
      try {
        try {
          await backfillSignupIpClass(partner);
        } catch (error) {
          // The backfill is an enhancement: on failure the partner keeps
          // `signup_ip_class='unknown'`, which promotionDecision still blocks
          // as `signup_ip_unclassified`. Don't skip the hard-deny evaluation
          // that tryAutoPromote performs just because the lookup failed.
          console.warn(`[partnerTrustJobs] signup-IP backfill failed for partner ${partner.id}`, error);
        }
        // tryAutoPromote evaluates hard denies itself (and restricts when one
        // matches), so this is the single evaluation per partner — a failure
        // anywhere in it skips this partner rather than aborting the batch,
        // and never falls through to a promotion we couldn't justify.
        if (await tryAutoPromote(partner.id)) promoted += 1;
      } catch (error) {
        console.warn(`[partnerTrustJobs] promotion evaluation failed for partner ${partner.id}`, error);
        continue;
      }
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
  const partnerId = target.kind === 'partner'
    ? target.partnerId
    : await partnerForDevice(target.deviceId);
  if (partnerId) {
    try {
      await restrictOnHardDeny(partnerId);
    } catch (error) {
      // Same as runPartnerTrustPromote: a hard-deny evaluation failure must
      // not fail the ip-classify job itself — the classification above is
      // still valid and should be returned.
      console.warn(`[partnerTrustJobs] hard-deny evaluation failed for partner ${partnerId}`, error);
    }
  }
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
