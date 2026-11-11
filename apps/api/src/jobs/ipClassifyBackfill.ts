/**
 * One-off re-classification of stored signup and enrollment IPs (#11698).
 *
 * Until the offline baseline existed, a deployment with no keyed provider
 * wrote `unknown` for every address without checking anything. This job
 * re-runs the active classifier over:
 *
 *   - partners with a signup IP whose class is `unknown` and whose source is
 *     not already the active classifier (so an address the full offline
 *     baseline cleared is not re-checked), and
 *   - devices with an enrollment IP whose class is `unknown` — written back
 *     only when the result is a real class, since devices record no source.
 *
 * It runs once per classifier: on completion it sets a Redis marker, and the
 * scheduler skips the job while that marker exists. Configuring a keyed
 * provider later is a new classifier and runs it again. A run that only had
 * the partial (Tor-only) offline baseline does not set the marker, so the next
 * boot retries it. Probation partners are also retried hourly by the
 * partner-trust-promote job's own signup-IP backfill.
 */
import type { Queue } from 'bullmq';
import { and, asc, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';

import { ipClassifyProvider } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, partners } from '../db/schema';
import { classifyIp, type IpClassification } from '../services/ipClassify';
import { ensureOfflineData, offlineBaselineComplete } from '../services/ipClassifyOffline';
import { classifierFor, type IpClassifier } from '../services/ipClassifyOfflineData';
import { restrictOnHardDeny } from '../services/partnerTrustPromotion';
import { getRedis } from '../services/redis';

export const IP_CLASSIFY_BACKFILL_JOB = 'ip-classify-backfill';
const BACKFILL_VERSION = 1;
const BATCH_SIZE = 200;
/** The first offline load downloads the ASN database; give it time before classifying. */
const OFFLINE_LOAD_WAIT_MS = 150_000;

function doneKey(classifier: IpClassifier): string {
  return `ipclass:backfill:done:v${BACKFILL_VERSION}:${classifier}`;
}

export type IpClassifyBackfillResult = {
  classifier: IpClassifier;
  partners: number;
  devices: number;
  /** False when the offline baseline ran without its ASN database. */
  complete: boolean;
};

export async function runIpClassifyBackfill(): Promise<IpClassifyBackfillResult> {
  const classifier = classifierFor(ipClassifyProvider());
  if (classifier === 'offline') await ensureOfflineData({ waitMs: OFFLINE_LOAD_WAIT_MS });
  const complete = classifier !== 'offline' || offlineBaselineComplete();

  const seen = new Map<string, IpClassification>();
  const lookup = async (ip: string): Promise<IpClassification> => {
    const cached = seen.get(ip);
    if (cached) return cached;
    const result = await classifyIp(ip);
    seen.set(ip, result);
    return result;
  };

  let partnersUpdated = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ id: partners.id, ip: partners.signupIp })
      .from(partners)
      .where(and(
        isNotNull(partners.signupIp),
        eq(partners.signupIpClass, 'unknown'),
        or(isNull(partners.signupIpClassSource), ne(partners.signupIpClassSource, classifier)),
        cursor ? gt(partners.id, cursor) : undefined,
      ))
      .orderBy(asc(partners.id))
      .limit(BATCH_SIZE), 'ipClassifyBackfill.partners'));
    for (const row of batch) {
      if (!row.ip) continue;
      try {
        const result = await lookup(row.ip);
        await runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(partners).set({
          signupIpClass: result.ipClass,
          signupIpAsn: result.asn,
          signupIpClassifiedAt: new Date(),
          signupIpClassSource: result.provider,
        // Only while still unknown: a concurrent ip-classify job may have
        // written a better answer since the batch was read.
        }).where(and(eq(partners.id, row.id), eq(partners.signupIpClass, 'unknown'))), 'ipClassifyBackfill.partner'));
        partnersUpdated += 1;
      } catch (error) {
        console.warn(`[ipClassifyBackfill] partner ${row.id} could not be re-classified`, error);
        continue;
      }
      if (seen.get(row.ip)?.ipClass === 'tor') {
        // Same as the ip-classify job: a Tor signup is a hard deny. Only
        // probation partners are evaluated (the evaluation itself filters).
        try {
          await restrictOnHardDeny(row.id);
        } catch (error) {
          console.warn(`[ipClassifyBackfill] hard-deny evaluation failed for partner ${row.id}`, error);
        }
      }
    }
    cursor = batch.at(-1)?.id;
    if (batch.length < BATCH_SIZE) break;
  }

  let devicesUpdated = 0;
  cursor = undefined;
  for (;;) {
    const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ id: devices.id, ip: devices.enrollmentIp })
      .from(devices)
      .where(and(
        isNotNull(devices.enrollmentIp),
        eq(devices.enrollmentIpClass, 'unknown'),
        cursor ? gt(devices.id, cursor) : undefined,
      ))
      .orderBy(asc(devices.id))
      .limit(BATCH_SIZE), 'ipClassifyBackfill.devices'));
    for (const row of batch) {
      if (!row.ip) continue;
      try {
        const result = await lookup(row.ip);
        if (result.ipClass === 'unknown') continue;
        await runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(devices).set({
          enrollmentIpClass: result.ipClass,
          enrollmentIpAsn: result.asn,
          enrollmentIpClassifiedAt: new Date(),
        }).where(and(eq(devices.id, row.id), eq(devices.enrollmentIpClass, 'unknown'))), 'ipClassifyBackfill.device'));
        devicesUpdated += 1;
      } catch (error) {
        console.warn(`[ipClassifyBackfill] device ${row.id} could not be re-classified`, error);
      }
    }
    cursor = batch.at(-1)?.id;
    if (batch.length < BATCH_SIZE) break;
  }

  if (complete) {
    const redis = getRedis();
    try {
      await redis?.set(doneKey(classifier), new Date().toISOString());
    } catch (error) {
      // Without the marker the next boot runs the backfill again: idempotent.
      console.warn('[ipClassifyBackfill] could not record completion', error);
    }
  }
  console.log(
    `[ipClassifyBackfill] ${classifier}: re-classified ${partnersUpdated} partner(s), ${devicesUpdated} device(s)${complete ? '' : ' (partial baseline; will retry)'}`,
  );
  return { classifier, partners: partnersUpdated, devices: devicesUpdated, complete };
}

/**
 * Enqueues the backfill unless it already completed for the active
 * classifier. The fixed jobId keeps concurrent replicas from queueing it
 * twice while it waits or runs.
 */
export async function scheduleIpClassifyBackfill(queue: Queue): Promise<void> {
  const classifier = classifierFor(ipClassifyProvider());
  try {
    if (await getRedis()?.get(doneKey(classifier))) return;
  } catch {
    // Unknown completion state: enqueue; the job is idempotent.
  }
  await queue.add(IP_CLASSIFY_BACKFILL_JOB, {}, {
    jobId: `ip-classify-backfill-v${BACKFILL_VERSION}-${classifier}`,
    removeOnComplete: true,
    removeOnFail: true,
  });
}
