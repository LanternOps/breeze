// apps/api/src/jobs/scriptVerifyWorker.ts
//
// `script-verify` (W03, #5612, spec §4.9, roadmap §3.5). One job per
// proposal-backed execution that reached a terminal state; three attempts over
// twenty minutes.
//
// `unknown` is RE-ENQUEUED rather than thrown: a throw would make BullMQ's own
// backoff the retry ladder, and an exhausted-attempts failure looks like a fault
// in Sentry when the truth is "the device never came back". The attempt count is
// carried in the job data so the ladder is visible in the payload, the same way
// ScriptReviewJobData carries it.
//
// Placement is `socket-owner`: evaluateVerificationClaim ->
// executeCommandWithSystemPrecheck -> agentCommandAwait / agentWs, the same
// dependency that puts alertVerdictScheduler there.
import { Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { scriptExecutions } from '../db/schema/scripts';
import { getBullMQConnection } from '../services/redis';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { scriptVerifyQueueJobDataSchema } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import {
  SCRIPT_VERIFY_JOB_NAME, SCRIPT_VERIFY_MAX_ATTEMPTS, SCRIPT_VERIFY_QUEUE, SCRIPT_VERIFY_RETRY_DELAY_MS,
  enqueueScriptVerify, evaluateVerificationClaim, onUnattendedVerificationOutcome,
  type ScriptVerifyJobData, type VerificationOutcome,
} from '../services/scriptProposals/verify';
import { transitionProposal } from '../services/scriptProposals';
import { loadProposalRequesterUserId, loadProposalRow } from '../services/scriptProposals/queries';
import { postProposalOutcomeToAuthor } from '../services/scriptProposals/authorNotify';
import { requestLikeFromSnapshot, writeAuditEventAsync } from '../services/auditEvents';

const WORKER_NAME = 'scriptVerifyWorker';
const WORKER_CONCURRENCY = 5;
// A file_list / list_services round-trip is bounded at 30 s; BullMQ's default
// 30 s lock would expire mid-read. Same class of fix as scriptReviewWorker.
const LOCK_DURATION_MS = 90_000;

export async function runScriptVerifyJob(data: ScriptVerifyJobData): Promise<VerificationOutcome | 'retry'> {
  const proposal = await loadProposalRow(data.proposalId);
  // Only an `executed` proposal has a claim to evaluate; anything else (a
  // late duplicate after a verdict, a promoted script, an erased org) is a
  // no-op — never a device read.
  if (!proposal || proposal.status !== 'executed') return 'unknown';

  const [execution] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select()
        .from(scriptExecutions)
        .where(and(eq(scriptExecutions.id, data.executionId), eq(scriptExecutions.proposalId, data.proposalId)))
        .limit(1),
    ),
  );
  if (!execution) return 'unknown';

  const requesterId = await loadProposalRequesterUserId(proposal);

  const { outcome, evidence } = await evaluateVerificationClaim(
    proposal.verification,
    { status: execution.status, exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr },
    { deviceId: execution.deviceId, orgId: proposal.orgId },
    requesterId ?? '',
  );

  if (outcome === 'unknown' && data.attempt < SCRIPT_VERIFY_MAX_ATTEMPTS) {
    await enqueueScriptVerify({ ...data, attempt: data.attempt + 1 }, SCRIPT_VERIFY_RETRY_DELAY_MS);
    return 'retry';
  }

  // A final `unknown` still leaves the proposal, so it can never sit in
  // `executed` forever and block the Save-to-library gate with an ambiguous
  // state. The STATUS is verification_failed; the RESULT records that the
  // truth was unknown, and the detail DTO surfaces that distinction.
  const finalStatus = outcome === 'verified' ? 'verified' : 'verification_failed';
  const result = { outcome, attempts: data.attempt, evidence, detail: describeOutcome(outcome, evidence) };

  const moved = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction((tx) =>
        transitionProposal(tx, proposal.id, ['executed'], finalStatus, {
          verifiedAt: new Date(),
          verificationResult: result,
        }),
      ),
    ),
  );

  if (moved) {
    await postProposalOutcomeToAuthor(
      {
        id: proposal.id, orgId: proposal.orgId, authorKind: proposal.authorKind,
        sessionId: proposal.sessionId, agentRunId: proposal.agentRunId, requestedByUserId: requesterId,
      },
      {
        kind: outcome === 'verified' ? 'verified' : outcome === 'unknown' ? 'verification_unknown' : 'verification_failed',
        detail: result.detail,
      },
    );
    void writeAuditEventAsync(requestLikeFromSnapshot({}), {
      action: outcome === 'verified' ? 'script.proposal.verified' : 'script.proposal.verification_failed',
      orgId: proposal.orgId,
      actorType: 'system',
      actorId: null,
      resourceType: 'script_proposal',
      resourceId: proposal.id,
      details: { outcome, attempts: data.attempt, executionId: execution.id, deviceId: execution.deviceId },
    });
  }
  await onUnattendedVerificationOutcome({ id: proposal.id, orgId: proposal.orgId }, outcome);
  return outcome;
}

function describeOutcome(outcome: VerificationOutcome, evidence: Record<string, unknown>): string {
  if (outcome === 'verified') {
    return typeof evidence.independentRead === 'string'
      ? `The proposal’s verification claim was confirmed by an independent ${evidence.independentRead} read.`
      : 'The proposal’s verification claim was confirmed by the execution result.';
  }
  if (outcome === 'unknown') {
    return `The claim could not be evaluated after ${SCRIPT_VERIFY_MAX_ATTEMPTS} attempts (${String(evidence.reason ?? 'no response')}).`;
  }
  const detail = typeof evidence.detail === 'string' ? evidence.detail
    : typeof evidence.exitCode === 'number' ? `exit code ${evidence.exitCode}, expected ${String(evidence.expected)}`
    : evidence.matched === false ? 'output did not match the expected pattern'
    : evidence.found === false ? `file not found: ${String(evidence.path)}`
    : 'claim not satisfied';
  return `The claim was not satisfied: ${detail}.`;
}

export async function processScriptVerifyJob(job: Job<unknown>): Promise<void> {
  assertQueueJobName(SCRIPT_VERIFY_QUEUE, job, SCRIPT_VERIFY_JOB_NAME);
  const data = parseQueueJobData(SCRIPT_VERIFY_QUEUE, job, scriptVerifyQueueJobDataSchema);
  // The retry ladder lives in the job data, not in BullMQ's `attempts`: a
  // throw out of here is a genuine fault (DB / Redis down) and retries under
  // BullMQ's default policy, never as an extra verification attempt.
  await runScriptVerifyJob(data);
}

let scriptVerifyWorker: Worker | null = null;

export function createScriptVerifyWorker(): Worker {
  return new Worker(
    SCRIPT_VERIFY_QUEUE,
    (job: Job) => processScriptVerifyJob(job),
    { connection: getBullMQConnection(), concurrency: WORKER_CONCURRENCY, lockDuration: LOCK_DURATION_MS },
  );
}

export async function initializeScriptVerifyWorker(): Promise<void> {
  if (scriptVerifyWorker) return;
  scriptVerifyWorker = createScriptVerifyWorker();
  attachWorkerObservability(scriptVerifyWorker, WORKER_NAME);
}

export async function shutdownScriptVerifyWorker(): Promise<void> {
  if (scriptVerifyWorker) {
    await scriptVerifyWorker.close();
    scriptVerifyWorker = null;
  }
}
