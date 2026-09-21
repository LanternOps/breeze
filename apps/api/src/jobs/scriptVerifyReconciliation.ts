import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { scriptProposals } from '../db/schema/scriptProposals';
import { scriptExecutions } from '../db/schema/scripts';
import { transitionProposal } from '../services/scriptProposals';
import {
  enqueueScriptVerify, getScriptVerifyQueue, onUnattendedVerificationOutcome,
  SCRIPT_VERIFY_MAX_ATTEMPTS,
} from '../services/scriptProposals/verify';
import { requestLikeFromSnapshot, writeAuditEventAsync } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { envInt } from '../utils/envInt';

export const SCRIPT_VERIFY_RECONCILE_JOB_NAME = 'reconcile';
const PAGE_SIZE = 200;
const TERMINAL_EXECUTIONS = new Set(['completed', 'failed', 'timeout', 'cancelled']);

/** Cross-org recovery; short DB contexts never span a queue round-trip. */
export async function sweepScriptVerifyProposals(): Promise<void> {
  const configured = envInt('SCRIPT_VERIFY_RECONCILE_MIN_AGE_MINUTES', 30);
  const minutes = configured > 0 ? configured : 30;
  const cutoff = new Date(Date.now() - minutes * 60_000);
  let cursor: string | undefined;
  for (;;) {
    const proposals = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({ id: scriptProposals.id, orgId: scriptProposals.orgId })
        .from(scriptProposals).where(and(
          eq(scriptProposals.status, 'executed'),
          lt(scriptProposals.createdAt, cutoff),
          cursor ? gt(scriptProposals.id, cursor) : undefined,
        )).orderBy(asc(scriptProposals.id)).limit(PAGE_SIZE),
    ));
    for (const proposal of proposals) {
      try {
        const executions = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          db.select({ id: scriptExecutions.id, status: scriptExecutions.status, completedAt: scriptExecutions.completedAt })
            .from(scriptExecutions).where(eq(scriptExecutions.proposalId, proposal.id)),
        ));
        // Proposals have no updated_at. Completion of ALL their executions is
        // the conservative age anchor: dispatch marks executed before results.
        if (!executions.length || executions.some((e) => !TERMINAL_EXECUTIONS.has(e.status)
          || !e.completedAt || e.completedAt >= cutoff)) continue;

        const queue = getScriptVerifyQueue();
        let live = false;
        let attempt = 1;
        let executionId = executions[0]!.id;
        let retained: Awaited<ReturnType<typeof queue.getJob>>;
        for (const execution of executions) {
          for (let n = 1; n <= SCRIPT_VERIFY_MAX_ATTEMPTS; n += 1) {
            const job = await queue.getJob(`script-verify-${proposal.id}-${execution.id}-${n}`);
            if (!job) continue;
            const state = await job.getState();
            if (state !== 'completed' && state !== 'failed' && state !== 'unknown') {
              live = true;
            } else if (state !== 'unknown' && n >= attempt) {
              attempt = n;
              executionId = execution.id;
              retained = job;
            }
          }
        }
        if (live) continue;
        // BullMQ retains terminal jobs; add() with their id would do nothing.
        // A failed lookup/removal is NOT proof of absence: defer to next sweep.
        if (retained) await retained.remove();

        let enqueueFailed = false;
        try {
          await enqueueScriptVerify({ proposalId: proposal.id, executionId, attempt });
        } catch (err) {
          enqueueFailed = true;
          captureException(err, undefined, { area: 'script_verify_reconcile_enqueue', proposalId: proposal.id });
        }
        if (enqueueFailed) {
          const moved = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
            db.transaction((tx) => transitionProposal(tx, proposal.id, ['executed'], 'verification_failed', {
              verifiedAt: new Date(),
              verificationResult: {
                outcome: 'unknown', attempts: attempt,
                evidence: { reason: 'verify_enqueue_lost' },
                detail: 'Verification could not be queued after execution completed.',
              },
            })),
          ));
          if (!moved) continue;
          await onUnattendedVerificationOutcome(proposal, 'unknown');
        }
        await writeAuditEventAsync(requestLikeFromSnapshot({}), {
          action: enqueueFailed ? 'script.proposal.verification_failed' : 'script.proposal.verification_reenqueued',
          orgId: proposal.orgId, actorType: 'system', actorId: null,
          resourceType: 'script_proposal', resourceId: proposal.id,
          details: { reason: 'verify_enqueue_lost', executionId, attempt },
        });
      } catch (err) {
        // A single queue/DB failure must not starve the rest of the page.
        captureException(err, undefined, { area: 'script_verify_reconcile', proposalId: proposal.id });
      }
    }
    if (proposals.length < PAGE_SIZE) break;
    cursor = proposals[proposals.length - 1]!.id;
  }
}

/** Shares scriptVerifyWorker's queue, placement, readiness and shutdown. */
export async function scheduleScriptVerifyReconciliation(): Promise<void> {
  const queue = getScriptVerifyQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === SCRIPT_VERIFY_RECONCILE_JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(SCRIPT_VERIFY_RECONCILE_JOB_NAME, { type: 'reconcile' }, {
    jobId: 'script-verify-reconcile',
    repeat: { pattern: jobSchedule('script-verify-reconcile') },
    removeOnComplete: { count: 20 }, removeOnFail: { count: 100 },
  });
}
