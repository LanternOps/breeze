import { Queue } from 'bullmq';
import { scriptVerificationClaimSchema } from '@breeze/shared';
import { verifyServiceRunningForTask, verifyProcessAbsentByNameForTask } from '../aiAgents/actVerify';
import { getBullMQConnection } from '../redis';
import { captureException } from '../sentry';

export type VerificationOutcome = 'verified' | 'verification_failed' | 'unknown';

export const SCRIPT_VERIFY_QUEUE = 'script-verify';
/** The single job name on the queue; the worker asserts it (bullmqValidation). */
export const SCRIPT_VERIFY_JOB_NAME = 'verify';
export const SCRIPT_VERIFY_MAX_ATTEMPTS = 3;
/** 3 attempts over 20 minutes (spec §4.9): t=0, t=10m, t=20m. */
export const SCRIPT_VERIFY_RETRY_DELAY_MS = 10 * 60 * 1000;
const VERIFY_READ_TIMEOUT_MS = 30_000;
const FILE_LIST_LIMIT = 5000;

export interface ScriptVerifyJobData {
  proposalId: string;
  executionId: string;
  attempt: number;
}

let _commandQueue: typeof import('../commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('../commandQueue');
  return _commandQueue;
}

function splitPath(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return { parent: '.', name: trimmed };
  const parent = trimmed.slice(0, idx) || trimmed.slice(0, idx + 1);
  return { parent, name: trimmed.slice(idx + 1) };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Spec §4.9. Evaluate a proposal's verification claim AFTER its execution reached a
 * terminal state.
 *
 * The operator rule (aiOperator/verification.ts) is the whole design: a dispatch
 * result is never evidence of recovery. `service_running`, `process_absent` and
 * `file_exists` are therefore INDEPENDENT device reads that ignore the execution
 * entirely; only `exit_code` and `output_matches` read the execution, and the
 * reviewer's `verificationAdequate = false` floor is what stops them being used
 * as the sole claim for a service/disk/application goal.
 *
 * `unknown` ≠ failed. A device that is offline has told us nothing; the worker's
 * retry ladder is what turns a persistent nothing into a final `unknown`.
 */
export async function evaluateVerificationClaim(
  claim: unknown,
  execution: { status: string; exitCode: number | null; stdout: string | null; stderr: string | null },
  device: { deviceId: string; orgId: string },
  actorUserId: string,
): Promise<{ outcome: VerificationOutcome; evidence: Record<string, unknown> }> {
  const parsed = scriptVerificationClaimSchema.safeParse(claim);
  if (!parsed.success) {
    return { outcome: 'unknown', evidence: { reason: 'claim_not_parseable' } };
  }
  const c = parsed.data;

  switch (c.kind) {
    case 'exit_code': {
      if (execution.exitCode === null || execution.status !== 'completed') {
        return { outcome: 'unknown', evidence: { reason: 'execution_not_terminal', status: execution.status } };
      }
      return execution.exitCode === c.equals
        ? { outcome: 'verified', evidence: { exitCode: execution.exitCode } }
        : { outcome: 'verification_failed', evidence: { exitCode: execution.exitCode, expected: c.equals } };
    }

    case 'output_matches': {
      let re: RegExp;
      try {
        re = new RegExp(c.regex);
      } catch {
        // A bad regex is the AUTHOR's mistake, not the device's. Unknown, so the
        // run is never claimed as proven on the strength of a pattern that
        // cannot be evaluated. (The shared schema compiles it at authoring time
        // too; this is defence in depth against a schema change.)
        return { outcome: 'unknown', evidence: { reason: 'invalid_regex', regex: c.regex } };
      }
      if (execution.stdout === null && execution.stderr === null) {
        return { outcome: 'unknown', evidence: { reason: 'no_output', status: execution.status } };
      }
      const haystack = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`;
      return re.test(haystack)
        ? { outcome: 'verified', evidence: { matched: true } }
        : { outcome: 'verification_failed', evidence: { matched: false, regex: c.regex } };
    }

    case 'service_running': {
      const { verification, detail } = await verifyServiceRunningForTask({ serviceName: c.name }, device, actorUserId);
      return {
        outcome: verification === 'passed' ? 'verified' : verification === 'failed' ? 'verification_failed' : 'unknown',
        evidence: { independentRead: 'list_services', service: c.name, verification, detail: detail ?? null },
      };
    }

    case 'process_absent': {
      const { verification, detail } = await verifyProcessAbsentByNameForTask({ processName: c.name }, device, actorUserId);
      return {
        outcome: verification === 'passed' ? 'verified' : verification === 'failed' ? 'verification_failed' : 'unknown',
        evidence: { independentRead: 'list_processes', process: c.name, verification, detail: detail ?? null },
      };
    }

    case 'file_exists': {
      // `file_list` lists a DIRECTORY, so the read is of the parent and the
      // claim is satisfied by an entry whose path (or name) matches.
      const { parent, name } = splitPath(c.path);
      const { executeCommandWithSystemPrecheck } = await getCommandQueue();
      const result = await executeCommandWithSystemPrecheck(
        device.deviceId,
        'file_list',
        { path: parent, limit: FILE_LIST_LIMIT },
        { userId: actorUserId, timeoutMs: VERIFY_READ_TIMEOUT_MS, expectedOrgId: device.orgId },
      );
      if (result.status !== 'completed') {
        return { outcome: 'unknown', evidence: { independentRead: 'file_list', reason: `read_${result.status}` } };
      }
      let listing: { entries?: unknown; truncated?: unknown } | null = null;
      try {
        const raw = JSON.parse(result.stdout ?? '') as unknown;
        listing = raw && typeof raw === 'object' ? (raw as { entries?: unknown; truncated?: unknown }) : null;
      } catch {
        listing = null;
      }
      if (!listing || !Array.isArray(listing.entries)) {
        return { outcome: 'unknown', evidence: { independentRead: 'file_list', reason: 'read_not_parseable' } };
      }
      const wantedPath = normalizePath(c.path);
      const wantedName = name.toLowerCase();
      const found = (listing.entries as unknown[]).some((e) => {
        if (!e || typeof e !== 'object') return false;
        const entry = e as { path?: unknown; name?: unknown };
        if (typeof entry.path === 'string' && normalizePath(entry.path) === wantedPath) return true;
        return typeof entry.name === 'string' && entry.name.toLowerCase() === wantedName;
      });
      if (found) {
        return { outcome: 'verified', evidence: { independentRead: 'file_list', path: c.path, found: true } };
      }
      if (listing.truncated === true) {
        // The directory has more entries than we read; absence is unproven.
        return { outcome: 'unknown', evidence: { independentRead: 'file_list', path: c.path, reason: 'listing_truncated' } };
      }
      return { outcome: 'verification_failed', evidence: { independentRead: 'file_list', path: c.path, found: false } };
    }
  }
}

// ---------------------------------------------------------------------------
// Queue accessor + enqueue
// ---------------------------------------------------------------------------

let verifyQueue: Queue<ScriptVerifyJobData> | null = null;
export function getScriptVerifyQueue(): Queue<ScriptVerifyJobData> {
  if (!verifyQueue) {
    verifyQueue = new Queue<ScriptVerifyJobData>(SCRIPT_VERIFY_QUEUE, { connection: getBullMQConnection() });
  }
  return verifyQueue;
}

/**
 * Deterministic id per (proposal, execution, attempt): a duplicate enqueue from
 * the result-ingest retry path is a no-op rather than a second device read.
 * `-` separated — colons are forbidden in job ids (jobs/quoteSendQueue.ts).
 */
export async function enqueueScriptVerify(data: ScriptVerifyJobData, delayMs = 0): Promise<void> {
  await getScriptVerifyQueue().add(SCRIPT_VERIFY_JOB_NAME, data, {
    jobId: `script-verify-${data.proposalId}-${data.executionId}-${data.attempt}`,
    delay: delayMs,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  });
}

// ---------------------------------------------------------------------------
// W04 hook registry
// ---------------------------------------------------------------------------

export type UnattendedVerificationHandler = (
  proposal: { id: string; orgId: string; decidedVia?: string | null },
  outcome: VerificationOutcome,
) => Promise<void>;

let unattendedHandler: UnattendedVerificationHandler | null = null;

/** W04 registers the lane-state updater here at boot. Kept as a registry rather
 *  than a direct import so verify.ts never depends on the lane. */
export function registerUnattendedVerificationOutcomeHandler(h: UnattendedVerificationHandler | null): void {
  unattendedHandler = h;
}

/**
 * Fired for EVERY terminal verification outcome of a proposal-backed run.
 * No-op in W03 — W04's `ai_script_lane_state` circuit breaker is the first
 * consumer (spec §4.6 "After execution"). A handler failure must never fail the
 * verification job, so it is caught here.
 */
export async function onUnattendedVerificationOutcome(
  proposal: { id: string; orgId: string; decidedVia?: string | null },
  outcome: VerificationOutcome,
): Promise<void> {
  if (!unattendedHandler) return;
  try {
    await unattendedHandler(proposal, outcome);
  } catch (err) {
    console.error(`[scriptVerify] unattended outcome handler failed for ${proposal.id}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      area: 'script_verify_unattended_hook', proposalId: proposal.id,
    });
  }
}
