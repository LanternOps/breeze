/**
 * Wave 4 Part B — act-mode verification, verdicts, and the attention alert
 * (Task 4, #3826).
 *
 * Runs from the run-loop's post-tool-use hook, ONLY for a call that actually
 * dispatched through the act branch (an `ActAssetPin` was stashed for it in
 * the pre-hook — see `actRevalidation.ts`). Two verdicts, not one:
 *
 *   - `execution` — what the tool dispatch itself reported (succeeded /
 *     failed / timeout / unknown). Derived from the SAME `output` string the
 *     post-hook already has; no extra I/O.
 *   - `verification` — the op's OWN read-back against its declared
 *     postcondition (is the service actually running now, is the process
 *     actually gone, did the script actually exit 0). This is a SEPARATE,
 *     bounded (≤30s) read, because a tool call reporting "completed" is not
 *     proof the underlying system state is what was intended.
 *
 * Only `verification: 'failed'` raises the rule-less attention alert —
 * `inconclusive` means the read-back itself didn't resolve (the action's
 * real effect is UNKNOWN, not negative), which is worth surfacing in the run
 * verdict but is not evidence of a bad outcome.
 */
import type { ActExecutionVerdict, ActVerificationVerdict } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { alerts } from '../../db/schema/alerts';
import type { ActAssetPin } from './actRevalidation';
import type { ActTarget } from './actManifest';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

let _commandQueue: typeof import('../commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('../commandQueue');
  return _commandQueue;
}

/**
 * Reserved, within the SAME outer budget as the verification read (see
 * below), for `recordActVerifyFailureAlert`'s DB insert — it runs AFTER the
 * read resolves, still inside the same postToolUse call.
 */
const ALERT_INSERT_BUDGET_MS = 1_000;

/**
 * Each verification read is bounded independently of the tool call it
 * verifies — but it also runs INSIDE the run-loop's postToolUse hook, which
 * `safePostToolUse` caps as a whole at `POST_TOOL_USE_TIMEOUT_MS` (10s;
 * aiAgentSdkTools.ts). This budget, plus `ALERT_INSERT_BUDGET_MS` above,
 * MUST stay under that outer cap — otherwise a read-back that is well within
 * ITS OWN budget still gets abandoned mid-flight because the hook that
 * contains it already timed out (see the wave-4b review fix; runLoop.ts's
 * post-hook now records the executed-action entry before this read even
 * starts, so that failure mode can no longer lose the record entirely, but
 * a read that never finishes is still a read that never verified anything).
 * Not imported from aiAgentSdkTools.ts on purpose — that module pulls in a
 * large, largely-unmocked service graph; the invariant is instead asserted
 * in runLoop.test.ts, which already mocks aiAgentSdkTools.ts wholesale and
 * spreads this module's real exports through its own `./actVerify` mock.
 */
export const VERIFY_READ_TIMEOUT_MS = 8_000;

export interface ActOutcome {
  execution: ActExecutionVerdict;
  verification: ActVerificationVerdict;
  /** Short, human-readable — never a raw tool input/output blob. */
  verifyDetail?: string;
}

export interface VerifyActExecutionArgs {
  pin: ActAssetPin;
  toolOutput: string;
  isError: boolean;
  run: { id: string; orgId: string; agentId: string; deviceId: string };
  /** Attribution only — same `auth.user.id` the tool dispatch itself used. */
  agentUserId: string;
}

/** Parses a CommandResult-shaped tool output (`{status, exitCode, stdout, ...}`). */
function parseCommandResult(output: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** `completed`/`failed`/`timeout` → the act verdict vocabulary; anything
 *  unparseable falls back to the SDK's own isError flag rather than 'unknown'
 *  — a status-less success/error response is still a real signal. */
function commandExecutionVerdict(output: string, isError: boolean): ActExecutionVerdict {
  const parsed = parseCommandResult(output);
  const status = parsed && typeof parsed.status === 'string' ? parsed.status : undefined;
  if (status === 'completed') return 'succeeded';
  if (status === 'timeout') return 'timeout';
  if (status === 'failed') return 'failed';
  return isError ? 'failed' : 'succeeded';
}

async function verifyServiceRunning(
  target: Extract<ActTarget, { kind: 'service' }>,
  run: VerifyActExecutionArgs['run'],
  agentUserId: string,
): Promise<{ verification: ActVerificationVerdict; detail?: string }> {
  const { executeCommand } = await getCommandQueue();
  const result = await inSystemDbContext(() =>
    executeCommand(run.deviceId, 'list_services', { search: target.serviceName }, {
      userId: agentUserId, timeoutMs: VERIFY_READ_TIMEOUT_MS,
    }));

  if (result.status !== 'completed') {
    return { verification: 'inconclusive', detail: `service status read did not complete (${result.status})` };
  }
  const parsed = parseCommandResult(result.stdout ?? '{}');
  const services = Array.isArray(parsed?.services) ? parsed!.services as unknown[] : [];
  const match = services.find((s): s is { name: string; status: string } =>
    typeof s === 'object' && s !== null
    && typeof (s as { name?: unknown }).name === 'string'
    && (s as { name: string }).name.toLowerCase() === target.serviceName.toLowerCase());

  if (match && match.status.toLowerCase() === 'running') {
    return { verification: 'passed' };
  }
  return { verification: 'failed', detail: match ? `service status is "${match.status}"` : 'service not found in read-back' };
}

async function verifyProcessAbsent(
  target: Extract<ActTarget, { kind: 'process' }>,
  run: VerifyActExecutionArgs['run'],
  agentUserId: string,
): Promise<{ verification: ActVerificationVerdict; detail?: string }> {
  const { executeCommand } = await getCommandQueue();
  const result = await inSystemDbContext(() =>
    executeCommand(run.deviceId, 'list_processes', { search: target.processName, limit: 200 }, {
      userId: agentUserId, timeoutMs: VERIFY_READ_TIMEOUT_MS,
    }));

  if (result.status !== 'completed') {
    return { verification: 'inconclusive', detail: `process list read did not complete (${result.status})` };
  }
  const parsed = parseCommandResult(result.stdout ?? '');
  // Absence of evidence is not evidence of absence: only a well-formed
  // `processes` array can prove the pid is gone. An unparseable body, a
  // shape change, or an error payload that still reported `status:
  // 'completed'` must never be scored as a silent pass — see
  // verifyServiceRunning, which already treats the analogous case
  // conservatively.
  if (!parsed || !Array.isArray(parsed.processes)) {
    return { verification: 'inconclusive', detail: 'process list read-back was not parseable' };
  }
  const stillPresent = parsed.processes.some((p) =>
    typeof p === 'object' && p !== null
    && String((p as { pid?: unknown }).pid) === target.pid);

  return stillPresent
    ? { verification: 'failed', detail: 'process with the pinned pid is still present' }
    : { verification: 'passed' };
}

function diskCleanupVerdict(output: string, isError: boolean): {
  execution: ActExecutionVerdict;
  verification: ActVerificationVerdict;
  detail?: string;
} {
  const parsed = parseCommandResult(output);
  const status = parsed && typeof parsed.status === 'string' ? parsed.status : undefined;
  const failedCount = typeof parsed?.failedCount === 'number' ? parsed.failedCount : undefined;

  const execution: ActExecutionVerdict =
    status === 'executed' ? 'succeeded' : status === 'failed' ? 'failed' : isError ? 'failed' : 'unknown';

  if (status === 'executed' && failedCount === 0) return { execution, verification: 'passed' };
  if (status === 'failed') return { execution, verification: 'failed', detail: 'no cleanup actions succeeded' };
  if (status === 'executed' && typeof failedCount === 'number' && failedCount > 0) {
    return { execution, verification: 'inconclusive', detail: `${failedCount} cleanup action(s) failed alongside successful ones` };
  }
  return { execution, verification: 'inconclusive', detail: 'cleanup result could not be parsed' };
}

function runScriptVerdict(
  output: string,
  isError: boolean,
  run: VerifyActExecutionArgs['run'],
): { execution: ActExecutionVerdict; verification: ActVerificationVerdict; detail?: string } {
  const parsed = parseCommandResult(output);
  const results = parsed && typeof parsed.results === 'object' && parsed.results !== null
    ? parsed.results as Record<string, unknown>
    : {};
  const entry = results[run.deviceId] as Record<string, unknown> | undefined;
  const status = entry && typeof entry.status === 'string' ? entry.status : undefined;
  const exitCode = entry && typeof entry.exitCode === 'number' ? entry.exitCode : undefined;

  const execution: ActExecutionVerdict =
    status === 'completed' ? 'succeeded'
      : status === 'timeout' ? 'timeout'
        : status === 'failed' ? 'failed'
          : isError ? 'failed' : 'unknown';

  if (status === 'timeout') return { execution, verification: 'inconclusive', detail: 'script execution timed out' };
  if (typeof exitCode === 'number') {
    return exitCode === 0
      ? { execution, verification: 'passed' }
      : { execution, verification: 'failed', detail: `script exited with code ${exitCode}` };
  }
  // No exit code and not a timeout — e.g. dispatch failed before the script
  // ever ran. A bare script run has no other declared postcondition to check.
  return { execution, verification: 'skipped', detail: 'no exit code available to verify against' };
}

/**
 * Verifies one act-executed tool call and returns its (execution,
 * verification) verdict. Best-effort for the read-back itself: a thrown
 * error from the verification read degrades to `inconclusive`, never throws
 * out of this function — a broken verify path must not turn a completed run
 * into a crashed one.
 */
export async function verifyActExecution(args: VerifyActExecutionArgs): Promise<ActOutcome> {
  const { pin, toolOutput, isError, run, agentUserId } = args;

  try {
    switch (pin.op.verifySpec.kind) {
      case 'service_running': {
        const execution = commandExecutionVerdict(toolOutput, isError);
        const target = pin.target as Extract<ActTarget, { kind: 'service' }>;
        const { verification, detail } = await verifyServiceRunning(target, run, agentUserId);
        return { execution, verification, ...(detail ? { verifyDetail: detail } : {}) };
      }
      case 'process_absent': {
        const execution = commandExecutionVerdict(toolOutput, isError);
        const target = pin.target as Extract<ActTarget, { kind: 'process' }>;
        const { verification, detail } = await verifyProcessAbsent(target, run, agentUserId);
        return { execution, verification, ...(detail ? { verifyDetail: detail } : {}) };
      }
      case 'disk_usage_improved': {
        const { execution, verification, detail } = diskCleanupVerdict(toolOutput, isError);
        return { execution, verification, ...(detail ? { verifyDetail: detail } : {}) };
      }
      case 'script_exit_code': {
        const { execution, verification, detail } = runScriptVerdict(toolOutput, isError, run);
        return { execution, verification, ...(detail ? { verifyDetail: detail } : {}) };
      }
      case 'playbook_aggregate':
        // Task 5 (playbookActExecutor.ts) computes this from its own
        // per-step verifies and never reaches this generic path once it
        // reroutes dispatch away from the (still-current) execute_playbook
        // stub tool. Until then, a matched built-in playbook that fell
        // through to the ordinary tool path has NO real postcondition
        // check available here — surface it as needing a human look rather
        // than silently calling it remediated.
        return {
          execution: commandExecutionVerdict(toolOutput, isError),
          verification: 'inconclusive',
          verifyDetail: 'playbook aggregate verification is not implemented on this path',
        };
      case 'none':
      default:
        // remediation_suggestion is virtual and never reaches here through
        // the real pipeline (see actManifest.ts) — defensive fallback only.
        return { execution: 'unknown', verification: 'inconclusive', verifyDetail: 'no verify spec for this op' };
    }
  } catch (error) {
    console.error('[actVerify] verification read failed (non-fatal — recorded as inconclusive)', {
      runId: run.id, opKey: pin.op.key, error,
    });
    return { execution: 'unknown', verification: 'inconclusive', verifyDetail: 'verification read failed' };
  }
}

/** Short, sanitized identity for a target — never a full path list, script
 *  content, or raw tool input/output. Used by both the alert and the
 *  finished-run notification. */
export function actTargetSummary(target: ActTarget): string {
  switch (target.kind) {
    case 'service': return target.serviceName;
    case 'disk_cleanup': return `${target.paths.length} path(s)`;
    case 'process': return target.processName;
    case 'script': return target.scriptId;
    case 'playbook': return target.playbookId;
    case 'suggestion': return target.suggestionId;
    default: {
      const exhaustive: never = target;
      return JSON.stringify(exhaustive);
    }
  }
}

export interface RecordActVerifyFailureAlertArgs {
  run: { id: string; orgId: string; deviceId: string; agentId: string };
  op: { key: string };
  target: ActTarget;
  detail?: string;
}

/**
 * Rule-less alert for a `verification: 'failed'` act execution — mirrors the
 * `dnsThreatAlerts.ts` direct-insert pattern (`ruleId: null`, `status:
 * 'active'`). Best-effort: logged on failure, never thrown, so a broken
 * alert path cannot turn a completed run into a failed one.
 */
export async function recordActVerifyFailureAlert(args: RecordActVerifyFailureAlertArgs): Promise<void> {
  const { run, op, target, detail } = args;
  try {
    await inSystemDbContext(async () => {
      await db.insert(alerts).values({
        ruleId: null,
        deviceId: run.deviceId,
        orgId: run.orgId,
        configPolicyId: null,
        configItemName: `ai_agent_act_verify_${op.key}`,
        severity: 'high',
        title: `Agent action needs attention: ${op.key}`,
        message: detail
          ? `An unattended agent action did not verify: ${detail}.`
          : 'An unattended agent action did not verify against its expected result.',
        context: {
          source: 'ai_agent_act_verify',
          runId: run.id,
          agentId: run.agentId,
          opKey: op.key,
          target,
        },
        status: 'active',
        triggeredAt: new Date(),
      });
    });
  } catch (error) {
    console.error('[actVerify] failed to record the act-verify-failure alert (non-fatal)', {
      runId: run.id, opKey: op.key, error,
    });
  }
}
