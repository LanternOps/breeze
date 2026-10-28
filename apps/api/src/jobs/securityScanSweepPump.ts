/**
 * The IOC sweep pump (#6263 W05-2). The database is the queue: a sweep create
 * inserts `queued` scan rows and nothing else, and this single-flight job turns
 * them into `dispatch-scan` jobs as capacity allows. It runs every
 * `SECURITY_SWEEP_PUMP_INTERVAL_MS` plus once right after each create.
 *
 * One system transaction per tick, single-flight on
 * pg_try_advisory_xact_lock('security-sweep-pump') (busy = skip), in order:
 *   1. Expire   active sweeps past `expires_at`; stop their children.
 *   2. Finalize running sweep scans the agent will never answer:
 *        - the command terminalized undelivered (looked up by
 *          `security_scans.command_id`, `device_commands.executed_at IS NULL`)
 *          -> `expired`;
 *        - the command went terminal with a final result the scan never
 *          received (#10376) -> `failed`;
 *        - no result 720 + SECURITY_SWEEP_RUNNING_GRACE_MINUTES after the
 *          claim -> `failed`. The command's own 30-minute server timeout is
 *          NOT used: scans legitimately run up to 720 minutes, and a late
 *          result still lands (the result handler overwrites the status).
 *   3. Complete active sweeps with no queued or running child.
 *   4. Admit queued scans of online, unparked devices with nothing else in
 *      flight, oldest sweep first, at most
 *      min(org cap - running(org), partner cap - running(partner), batch).
 * Audits and dispatch jobs follow the commit. Every reader requires
 * `sweep.org_id = scan.org_id` (a device moved org is detached by the mover;
 * this is the backstop). State lives in rows, so a lost Redis job or a restart
 * is repaired by the next tick; the claim is a CAS.
 */
import { and, asc, eq, inArray, lte, gt, notInArray, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { devices, organizations, securityScans, securityScanSweeps } from '../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
import {
  RESULT_PROCESSING_FAILED_RESULT_STATUS,
  SERVER_TIMEOUT_RESULT_STATUS,
} from '../services/commandResultAcceptance';
import { createAuditLogAsync, type CreateAuditLogParams } from '../services/auditService';
import {
  parsePositiveIntEnv,
  SECURITY_SCAN_TIMEOUT_CEILING_MINUTES,
  sweepPartnerRunningCap,
  sweepPumpBatch,
  sweepRunningGraceMinutes,
} from '../services/securityScanSweepConfig';
import { stopSweepChildren } from '../services/securityScanSweepStop';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';
import type { SecurityScanQueueJobData } from './queueSchemas';

const { db } = dbModule;

export type SweepDispatchJob = Extract<SecurityScanQueueJobData, { type: 'dispatch-scan'; origin: 'sweep' }>;

export interface PumpResult {
  skipped: boolean;
  expired: number;
  finalized: number;
  completed: number;
  admitted: number;
}

const orgCap = () => parsePositiveIntEnv('SECURITY_SCAN_ORG_CONCURRENCY_CAP', 40);

async function defaultEnqueue(jobs: SweepDispatchJob[]): Promise<void> {
  // Dynamic: securityScanJobs imports this module for its worker.
  const { enqueueSweepDispatches } = await import('./securityScanJobs');
  await enqueueSweepDispatches(jobs);
}

function systemAudit(
  row: { id: string; orgId: string },
  action: string,
  details: Record<string, unknown>,
): CreateAuditLogParams {
  return {
    orgId: row.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action,
    resourceType: 'security_scan_sweep',
    resourceId: row.id,
    details,
    result: 'success',
    initiatedBy: 'schedule',
  };
}

export async function pumpSweeps(
  now: Date = new Date(),
  deps: { enqueue?: (jobs: SweepDispatchJob[]) => Promise<void> } = {},
): Promise<PumpResult> {
  const audits: CreateAuditLogParams[] = [];
  const jobs: SweepDispatchJob[] = [];

  const result = await dbModule.withSystemDbAccessContext(async (): Promise<PumpResult> => {
    const [lock] = (await db.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('security-sweep-pump')) AS locked`,
    )) as unknown as Array<{ locked: boolean }>;
    if (!lock?.locked) return { skipped: true, expired: 0, finalized: 0, completed: 0, admitted: 0 };

    // 1. Expire. Lock the expiring rows in id order first (a group cancel
    // locks its rows in id order too, so the two cannot deadlock); the lock
    // also waits for any in-flight claim's FOR SHARE.
    const expiring = await db
      .select({ id: securityScanSweeps.id })
      .from(securityScanSweeps)
      .where(and(eq(securityScanSweeps.state, 'active'), lte(securityScanSweeps.expiresAt, now)))
      .orderBy(asc(securityScanSweeps.id))
      .for('update');
    const expired = expiring.length
      ? await db
          .update(securityScanSweeps)
          .set({ state: 'expired', completedAt: now })
          .where(and(inArray(securityScanSweeps.id, expiring.map((r) => r.id)), eq(securityScanSweeps.state, 'active')))
          .returning({ id: securityScanSweeps.id, orgId: securityScanSweeps.orgId, groupId: securityScanSweeps.groupId })
      : [];
    for (const row of expired) {
      const stopped = await stopSweepChildren({
        sweepId: row.id,
        orgId: row.orgId,
        status: 'expired',
        reason: 'security_sweep_expired',
        now,
      });
      audits.push(
        systemAudit(row, 'security.scan_sweep.expire', {
          groupId: row.groupId,
          expiredQueued: stopped.queued,
          expiredUndelivered: stopped.undelivered,
        }),
      );
    }

    // 2. Finalize, by command id (the payload is erased on terminalization).
    const undelivered = (await db.execute(sql`
      UPDATE security_scans s SET status = 'expired', completed_at = ${now.toISOString()}
        FROM device_commands c, security_scan_sweeps w
       WHERE s.sweep_id = w.id AND w.org_id = s.org_id
         AND s.status = 'running'
         AND c.id = s.command_id
         AND c.status IN ('expired', 'cancelled', 'failed')
         AND c.executed_at IS NULL
      RETURNING s.id
    `)) as unknown as Array<{ id: string }>;
    // #10376: the command went terminal with a FINAL result (the agent's own
    // completed/failed report, e.g. "agent restarted while command was
    // running") yet the scan is still running — the result never reached
    // handleSecurityCommandResult, which runs in the same transaction as the
    // command's terminal write. Such a row accepts no further result, so
    // nothing will ever finish the scan; waiting out the 720-minute ceiling
    // only holds the sweep (and an org/partner concurrency slot) for 12 hours.
    // Results were not recorded, so it is `failed`, never `completed`. A
    // server timeout or a parked processing failure is excluded: both still
    // accept the agent's result (services/commandResultAcceptance.ts).
    const answered = (await db.execute(sql`
      UPDATE security_scans s SET status = 'failed', completed_at = ${now.toISOString()}
        FROM device_commands c, security_scan_sweeps w
       WHERE s.sweep_id = w.id AND w.org_id = s.org_id
         AND s.status = 'running'
         AND c.id = s.command_id
         AND c.status IN ('completed', 'failed')
         AND coalesce(c.result->>'status', '') NOT IN (${SERVER_TIMEOUT_RESULT_STATUS}, ${RESULT_PROCESSING_FAILED_RESULT_STATUS})
      RETURNING s.id
    `)) as unknown as Array<{ id: string }>;
    const ceiling = new Date(
      now.getTime() - (SECURITY_SCAN_TIMEOUT_CEILING_MINUTES + sweepRunningGraceMinutes()) * 60_000,
    );
    const stale = (await db.execute(sql`
      UPDATE security_scans s SET status = 'failed', completed_at = ${now.toISOString()}
        FROM security_scan_sweeps w
       WHERE s.sweep_id = w.id AND w.org_id = s.org_id
         AND s.status = 'running'
         AND s.started_at < ${ceiling.toISOString()}
      RETURNING s.id
    `)) as unknown as Array<{ id: string }>;

    // 3. Complete.
    const completed = await db
      .update(securityScanSweeps)
      .set({ state: 'completed', completedAt: now })
      .where(
        and(
          eq(securityScanSweeps.state, 'active'),
          sql`NOT EXISTS (SELECT 1 FROM security_scans s
                           WHERE s.sweep_id = ${securityScanSweeps.id} AND s.org_id = ${securityScanSweeps.orgId}
                             AND s.status IN ('queued', 'running'))`,
        ),
      )
      .returning({ id: securityScanSweeps.id, orgId: securityScanSweeps.orgId, groupId: securityScanSweeps.groupId });
    if (completed.length > 0) {
      const progress = await db
        .select({
          sweepId: securityScans.sweepId,
          completed: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'completed')::int`,
          timedOut: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'timed_out')::int`,
          failed: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'failed')::int`,
          cancelled: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'cancelled')::int`,
          expired: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'expired')::int`,
          threatsFound: sql<number>`coalesce(sum(${securityScans.threatsFound}), 0)::int`,
        })
        .from(securityScans)
        .where(inArray(securityScans.sweepId, completed.map((c) => c.id)))
        .groupBy(securityScans.sweepId);
      const bySweep = new Map(progress.map(({ sweepId, ...counts }) => [sweepId, counts]));
      for (const row of completed) {
        audits.push(
          systemAudit(row, 'security.scan_sweep.complete', { groupId: row.groupId, progress: bySweep.get(row.id) ?? {} }),
        );
      }
    }

    // 4. Admit.
    const active = await db
      .select({ id: securityScanSweeps.id, orgId: securityScanSweeps.orgId, partnerId: organizations.partnerId })
      .from(securityScanSweeps)
      .innerJoin(organizations, eq(organizations.id, securityScanSweeps.orgId))
      .where(and(eq(securityScanSweeps.state, 'active'), gt(securityScanSweeps.expiresAt, now)))
      .orderBy(asc(securityScanSweeps.createdAt), asc(securityScanSweeps.id));
    if (active.length > 0) {
      const orgIds = [...new Set(active.map((s) => s.orgId))];
      const partnerIds = [...new Set(active.map((s) => s.partnerId))];
      const orgRunningRows = await db
        .select({ orgId: securityScans.orgId, count: sql<number>`count(*)::int` })
        .from(securityScans)
        .where(and(eq(securityScans.status, 'running'), inArray(securityScans.orgId, orgIds)))
        .groupBy(securityScans.orgId);
      const partnerRunningRows = await db
        .select({ partnerId: organizations.partnerId, count: sql<number>`count(*)::int` })
        .from(securityScans)
        .innerJoin(organizations, eq(organizations.id, securityScans.orgId))
        .where(and(eq(securityScans.status, 'running'), inArray(organizations.partnerId, partnerIds)))
        .groupBy(organizations.partnerId);
      const orgUsed = new Map(orgRunningRows.map((r) => [r.orgId, Number(r.count)]));
      const partnerUsed = new Map(partnerRunningRows.map((r) => [r.partnerId, Number(r.count)]));
      const admittedDevices = new Set<string>();

      for (const sweep of active) {
        const n = Math.min(
          orgCap() - (orgUsed.get(sweep.orgId) ?? 0),
          sweepPartnerRunningCap() - (partnerUsed.get(sweep.partnerId) ?? 0),
          sweepPumpBatch(),
        );
        if (n <= 0) continue;
        const conditions: SQL[] = [
          eq(securityScans.sweepId, sweep.id),
          eq(securityScans.orgId, sweep.orgId),
          eq(securityScans.status, 'queued'),
          eq(devices.orgId, sweep.orgId),
          eq(devices.status, 'online'),
          notParkedDeviceCondition(),
          // Nothing else in flight for the device: no running scan, no
          // scheduled/manual scan waiting, no undelivered or unanswered command.
          sql`NOT EXISTS (SELECT 1 FROM security_scans r
                           WHERE r.device_id = ${securityScans.deviceId}
                             AND (r.status = 'running' OR (r.status = 'queued' AND r.sweep_id IS NULL)))`,
          sql`NOT EXISTS (SELECT 1 FROM device_commands c
                           WHERE c.device_id = ${securityScans.deviceId}
                             AND c.type = 'security_scan' AND c.status IN ('pending', 'sent'))`,
        ];
        if (admittedDevices.size > 0) conditions.push(notInArray(securityScans.deviceId, [...admittedDevices]));
        const picked = await db
          .select({ id: securityScans.id, deviceId: securityScans.deviceId })
          .from(securityScans)
          .innerJoin(devices, eq(devices.id, securityScans.deviceId))
          .where(and(...conditions))
          .orderBy(asc(securityScans.id))
          .limit(n);
        for (const scan of picked) {
          admittedDevices.add(scan.deviceId);
          jobs.push({ type: 'dispatch-scan', scanId: scan.id, origin: 'sweep', sweepId: sweep.id });
        }
        orgUsed.set(sweep.orgId, (orgUsed.get(sweep.orgId) ?? 0) + picked.length);
        partnerUsed.set(sweep.partnerId, (partnerUsed.get(sweep.partnerId) ?? 0) + picked.length);
      }
    }

    return {
      skipped: false,
      expired: expired.length,
      finalized: undelivered.length + answered.length + stale.length,
      completed: completed.length,
      admitted: jobs.length,
    };
  }, 'securityScanSweepPump');

  for (const audit of audits) void createAuditLogAsync(audit);
  if (result.finalized > 0) {
    console.warn(`[securityScanSweepPump] finalized ${result.finalized} sweep scan(s) the agent will not answer (undelivered, answered without a recorded result, or past the scan ceiling)`);
  }
  if (jobs.length > 0) await (deps.enqueue ?? defaultEnqueue)(jobs);
  return result;
}
