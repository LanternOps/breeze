/**
 * Expiry and retention of reattach intents (#8318 spec §4.3 "Retention",
 * §6.5 "Expiry"). Run every minute by jobs/deviceReattachIntentSweep.ts.
 *
 *  - Expiry: a `requested` intent past its 60 minutes, or a `staged` one past
 *    its 15, becomes `expired`: the staged agent, watchdog and helper hashes
 *    are discarded (the confirmation hash is kept for the typed `expired`
 *    answer of rebind-confirm) and the pending certificate is revoked. Each
 *    intent in its own short system transaction that takes the intent row
 *    alone (FOR UPDATE, then a compare-and-set on the open states), so a
 *    confirm that holds it wins or loses cleanly, never both. A staged set is
 *    never activated after expiry, and an expired intent never reopens.
 *  - Retention: terminal intents older than 30 days are deleted, a bounded
 *    batch per run. Confirm replay does not depend on them: the ledger
 *    (device_reattachments) answers it. Done here rather than in a daily
 *    scheduleRegistry slot because the DELETE is cheap (indexed on
 *    requested_at, bounded) and a per-minute job is already running.
 *
 * Deliberately free of routes/agentWs.ts: the job is `global` placement.
 */
import { and, asc, inArray, lt, lte } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceReattachIntents } from '../../db/schema';
import { captureException } from '../sentry';
import { writeReattachAudit } from './audit';
import { endIntentInTransaction, readIntentForUpdate, revokeCertificatesAfterCommit } from './intentStore';
import { OPEN_REATTACH_INTENT_STATES, REATTACH_INTENT_RETENTION_MS, TERMINAL_REATTACH_INTENT_STATES } from './protocol';

const LOG_PREFIX = '[deviceReattachIntentSweep]';

/** Upper bound of intents expired per run; the next run picks up the rest. */
export const REATTACH_SWEEP_MAX_EXPIRED_PER_RUN = 500;
/** Upper bound of terminal intents pruned per run. */
export const REATTACH_SWEEP_MAX_PRUNED_PER_RUN = 1000;

export interface ReattachIntentSweepSummary {
  candidates: number;
  expired: number;
  /** Confirmed, cancelled or already expired between the read and the lock. */
  skippedRaced: number;
  failed: number;
  pruned: number;
}

async function expireOne(intentId: string, now: Date): Promise<'expired' | 'raced'> {
  const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const intent = await readIntentForUpdate(tx, intentId);
    if (!intent || intent.expiresAt.getTime() > now.getTime()) return null;
    const ended = await endIntentInTransaction(tx, intent, { state: 'expired' }, now);
    return ended ? { intent, ended } : null;
  })));
  if (!outcome) return 'raced';

  await revokeCertificatesAfterCommit(outcome.ended.revokeCertificateIds);
  await writeReattachAudit({
    action: 'device.reinstall.expired',
    actorUserId: null,
    targetOrgId: outcome.intent.targetOrgId,
    sourceOrgId: outcome.intent.sourceOrgId,
    targetDeviceId: outcome.intent.targetDeviceId,
    initiatedBy: 'schedule',
    details: {
      intentId: outcome.intent.id,
      sourceDeviceId: outcome.intent.sourceDeviceId,
      previousState: outcome.intent.state,
      expiresAt: outcome.intent.expiresAt.toISOString(),
      job: 'device-reattach-intent-sweep',
    },
  });
  return 'expired';
}

export async function runReattachIntentSweepOnce(now: Date = new Date()): Promise<ReattachIntentSweepSummary> {
  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: deviceReattachIntents.id })
    .from(deviceReattachIntents)
    .where(and(
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
      lte(deviceReattachIntents.expiresAt, now),
    ))
    .orderBy(asc(deviceReattachIntents.expiresAt))
    .limit(REATTACH_SWEEP_MAX_EXPIRED_PER_RUN)));

  const summary: ReattachIntentSweepSummary = { candidates: candidates.length, expired: 0, skippedRaced: 0, failed: 0, pruned: 0 };
  for (const { id } of candidates) {
    try {
      if ((await expireOne(id, now)) === 'expired') summary.expired += 1;
      else summary.skippedRaced += 1;
    } catch (err) {
      // One intent's failure must not stop the sweep.
      console.error(`${LOG_PREFIX} failed to expire reattach intent ${id}:`, err);
      captureException(err);
      summary.failed += 1;
    }
  }

  try {
    const cutoff = new Date(now.getTime() - REATTACH_INTENT_RETENTION_MS);
    const pruned = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .delete(deviceReattachIntents)
      .where(inArray(
        deviceReattachIntents.id,
        db.select({ id: deviceReattachIntents.id })
          .from(deviceReattachIntents)
          .where(and(
            inArray(deviceReattachIntents.state, [...TERMINAL_REATTACH_INTENT_STATES]),
            lt(deviceReattachIntents.requestedAt, cutoff),
          ))
          .limit(REATTACH_SWEEP_MAX_PRUNED_PER_RUN),
      ))
      .returning({ id: deviceReattachIntents.id })));
    summary.pruned = pruned.length;
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to prune terminal reattach intents:`, err);
    captureException(err);
  }

  if (summary.candidates > 0 || summary.pruned > 0) {
    console.log(`${LOG_PREFIX} expired ${summary.expired}/${summary.candidates} (raced=${summary.skippedRaced}, failed=${summary.failed}), pruned ${summary.pruned}`);
  }
  return summary;
}
