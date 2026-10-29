/**
 * #10057 — finalize scheduled and manual (non-sweep) security scans the agent
 * will never answer. The sweep pump finalizes sweep children
 * (jobs/securityScanSweepPump.ts, step 2); before this nothing did the same for
 * any other scan, so an agent that vanished mid-scan left the row `running` — or
 * a manual "Scan now" row, which stays `queued` until its result, `queued` —
 * indefinitely. A `running` orphan holds the device's concurrency slot (the
 * claim's device cap is 1, so every later scheduled scan on that device was
 * throttled forever) and counts against the org and partner caps; a `queued`
 * manual orphan blocks sweep admission on its device.
 *
 * Runs inside the pump's single-flight system transaction, every tick:
 *   1. The command terminalized before delivery (`executed_at IS NULL`) →
 *      `expired`. Same rule as the pump's sweep finalize.
 *   2. No result 720 + SECURITY_SWEEP_RUNNING_GRACE_MINUTES after DELIVERY →
 *      `failed`. A command still `pending` is skipped: a manual scan for an
 *      offline device can wait for its `deliver_by` (the standard 7-day queue),
 *      and the reaper expiring it hands the row to rule 1. A row whose command
 *      row is gone falls back to `started_at`. 720 is the longest deadline a
 *      policy can give the agent, so a shorter clock could fail a scan the
 *      agent is still running.
 *
 * Releasing the slot is safe only because the agent's scan is bounded by the
 * same ceiling: the payload always carries `timeoutMinutes` (the policy budget,
 * or 720 with no policy — services/securityScanPayload.ts), and agents from
 * this build also default to 720 themselves (security.MaxScanTimeout). Without
 * that a policy-less agent scanned with no deadline, and a scan dispatched into
 * the freed slot could overlap one still running (#10057).
 *
 * Both are provisional in the same way as the sweep finalize: a late agent
 * result still lands, because the result handler (routes/agents/helpers.ts
 * `handleSecurityCommandResult`) overwrites the scan status.
 *
 * Not here: a command that went terminal with a FINAL result the scan never
 * received. PR #10435 (#10376) adds that rule for sweep children only; until
 * the two land, the clock above is the backstop for non-sweep scans.
 */
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { SECURITY_SCAN_TIMEOUT_CEILING_MINUTES, sweepRunningGraceMinutes } from '../services/securityScanSweepConfig';

const { db } = dbModule;

export interface OrphanFinalizeResult {
  expired: number;
  failed: number;
}

export async function finalizeOrphanedDeviceScans(now: Date): Promise<OrphanFinalizeResult> {
  const undelivered = (await db.execute(sql`
    UPDATE security_scans s SET status = 'expired', completed_at = ${now.toISOString()}
      FROM device_commands c
     WHERE s.sweep_id IS NULL
       AND s.status IN ('queued', 'running')
       AND c.id = s.command_id
       AND c.device_id = s.device_id
       AND c.status IN ('expired', 'cancelled', 'failed')
       AND c.executed_at IS NULL
    RETURNING s.id
  `)) as unknown as Array<{ id: string }>;

  const ceiling = new Date(
    now.getTime() - (SECURITY_SCAN_TIMEOUT_CEILING_MINUTES + sweepRunningGraceMinutes()) * 60_000,
  );
  const stale = (await db.execute(sql`
    UPDATE security_scans s SET status = 'failed', completed_at = ${now.toISOString()}
     WHERE s.sweep_id IS NULL
       AND (s.status = 'running' OR (s.status = 'queued' AND s.command_id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM device_commands c
                        WHERE c.id = s.command_id AND c.device_id = s.device_id AND c.status = 'pending')
       AND coalesce(
             (SELECT c.executed_at FROM device_commands c
               WHERE c.id = s.command_id AND c.device_id = s.device_id),
             s.started_at
           ) < ${ceiling.toISOString()}
    RETURNING s.id
  `)) as unknown as Array<{ id: string }>;

  if (undelivered.length + stale.length > 0) {
    console.warn('[securityScanOrphanFinalize] finalized scheduled/manual scan(s) the agent will not answer', {
      expired: undelivered.slice(0, 20).map((r) => r.id),
      failed: stale.slice(0, 20).map((r) => r.id),
    });
  }
  return { expired: undelivered.length, failed: stale.length };
}
