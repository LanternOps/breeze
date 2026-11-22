/**
 * Script monitor condition handler (#5291 W04).
 *
 * DESIGN: the `script` monitor kind is deliberately split into two decoupled
 * halves that only ever talk to each other through `script_executions`:
 *
 *   1. `jobs/monitorScriptWorker.ts` (the OTHER half of this task) runs on its
 *      own cadence and DISPATCHES the monitor's script to every device it
 *      applies to, writing an ordinary `script_executions` row per run.
 *   2. THIS handler runs on the normal alert-rule evaluation sweep and reads
 *      the newest such row to decide breach/no-breach. It never dispatches
 *      anything itself.
 *
 * Nothing here assumes the two run in lockstep — the handler must produce a
 * sane verdict (or explicitly "no data yet") no matter when it happens to be
 * called relative to the worker's own schedule.
 *
 * Verdict precedence, evaluated in order. Every "no data" verdict below
 * returns `dataAvailable: false`, so the evaluator reports `dataState:
 * 'unknown'`: it neither opens an episode nor auto-resolves an open alert
 * (#12325 — before, these read as an observed all-clear).
 *   1. No row at all, or the newest row is older than
 *      `3 * intervalMinutes` -> no data ("No recent probe result").
 *      A stale probe must never LATCH a breach (or a clear) — an execution
 *      pipeline outage must read as "no data", not as a silent all-clear.
 *   2. The script did not run to an exit code of its own -> no data. That is
 *      'timeout' | 'cancelled', and a 'failed' row that is not a real exit
 *      (see `ranToExitCode`): the agent refused or could not start it, it
 *      was never delivered and the reaper closed it, or it was killed by a
 *      signal. The PROBE didn't produce a verdict; that is an
 *      execution-infrastructure problem, not evidence that whatever the
 *      script checks is broken. Per spec, a timeout is explicitly NOT a
 *      breach — and a marker in a timed-out run's partial stdout is ignored.
 *   3. The newest row's `status` is still in flight (pending/queued/running/
 *      cancelling, which also means `completedAt` is NULL) -> no data; the
 *      probe simply hasn't finished yet.
 *   4. The script ran and exited: `status === 'completed'` (exit 0), or
 *      `status === 'failed'` with the script's own non-zero exit code.
 *      `handleScriptResult` (commandResultHandlers.ts) stores EVERY non-zero
 *      exit as 'failed', so this is the only row a non-zero exit ever
 *      produces (#12325: treating all of 'failed' as rule 2 made
 *      `breachOnNonZeroExit` unreachable).
 *      a. A `::breeze:monitor::` marker line is present in `stdout` (the
 *         LAST such line, parsed as JSON) -> the marker's own verdict wins
 *         over the exit code: `state: 'breach'` -> passed, `state: 'ok'` ->
 *         not passed; `description` comes from the marker's `detail`.
 *      b. No marker (missing OR malformed) -> fall back to the exit-code
 *         rule: `breachOnNonZeroExit` decides whether `exitCode !== 0`
 *         counts as a breach. A malformed marker is a SCRIPT bug, not an
 *         outage, so it must never throw — it silently degrades to this
 *         exit-code fallback instead.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { scriptExecutions } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult } from '../types';

/**
 * Evaluation-time condition shape, compiled by `monitors/kinds/script.ts`'s
 * `toAlertCondition`. Kept local to this file (mirrors the `antivirus.ts` /
 * `backupContinuity.ts` pattern in this same wave) — `alertConditions/types.ts`
 * carries the identical shape as part of the `AlertCondition` union, wired in
 * by the orchestrator alongside `alertConditions/index.ts`'s registration of
 * this handler.
 */
export interface ScriptMonitorCondition {
  type: 'script_monitor';
  monitorId: string;
  intervalMinutes: number;
  breachOnNonZeroExit: boolean;
}

const MS_PER_MINUTE = 60_000;

// A probe older than this multiple of its own interval is treated as "no
// data", never latched as a breach OR a clear. Three misses in a row is a
// deliberately generous window: it tolerates one skipped tick (e.g. a
// temporarily offline device) without flapping the monitor to "unknown".
const STALE_PROBE_INTERVAL_MULTIPLIER = 3;

const MARKER_PREFIX = '::breeze:monitor::';

interface ParsedMonitorMarker {
  state: 'breach' | 'ok';
  detail?: string;
}

/**
 * Parses the LAST `::breeze:monitor:: {...}` line in stdout, if any. Returns
 * `null` on no marker, an unparsable JSON payload, or a payload whose `state`
 * isn't `'breach'` | `'ok'` — every one of those degrades to the exit-code
 * fallback in `evaluate`, never throws. A malformed marker is a bug in the
 * MONITORED script, not in this handler or in the execution pipeline.
 */
function parseLastMonitorMarker(stdout: string | null): ParsedMonitorMarker | null {
  if (!stdout) return null;

  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith(MARKER_PREFIX)) continue;

    // Found the LAST marker line. Whatever happens parsing it, we do not
    // keep searching further back — a script that emits a broken final
    // marker does not get to fall through to an earlier, possibly stale one.
    const payload = line.slice(MARKER_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (
        parsed
        && typeof parsed === 'object'
        && ((parsed as Record<string, unknown>).state === 'breach' || (parsed as Record<string, unknown>).state === 'ok')
      ) {
        const state = (parsed as Record<string, unknown>).state as 'breach' | 'ok';
        const detail = (parsed as Record<string, unknown>).detail;
        return { state, detail: typeof detail === 'string' ? detail : undefined };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// Terminal statuses other than 'completed'. `executionStatusEnum`
// (db/schema/scripts.ts) is
// ['pending','queued','running','cancelling','completed','failed','timeout','cancelled'].
// 'timeout' and 'cancelled' never carry a verdict; 'failed' does when it is a
// real exit (`ranToExitCode`).
const NON_COMPLETED_TERMINAL_STATUSES = new Set(['failed', 'timeout', 'cancelled']);

const CAUSE_MAX_CHARS = 200;

/**
 * The run's own error (already secret-redacted at persistence), first line,
 * capped — appended to the no-data description so a monitor whose script can
 * never start says why in its activity, instead of a bare "status: failed".
 */
function causeSuffix(errorMessage: string | null): string {
  const firstLine = errorMessage?.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return '';
  return `: ${firstLine.length > CAUSE_MAX_CHARS ? `${firstLine.slice(0, CAUSE_MAX_CHARS)}…` : firstLine}`;
}

interface ProbeRow {
  status: string;
  exitCode: number | null;
  errorMessage: string | null;
}

/**
 * True when the script itself ran and exited, so its exit code (and stdout
 * marker) is a verdict.
 *
 * A 'failed' row is ambiguous, and only `exitCode` + `errorMessage` tell the
 * cases apart (the agent contract is `tools.CommandResult.ExitCode`,
 * agent/internal/remote/tools/types.go):
 *   - the script exited N > 0: the agent sends the real code and no error;
 *   - no process ran (refused, empty script, no user helper, ...): the agent
 *     sends a SYNTHETIC exit 1 WITH an error, so a code alone proves nothing;
 *   - executor failure, timeout or cancel: -1 with an error;
 *   - killed by a signal (Unix): -1 with no error — an abnormal end, not the
 *     script's answer;
 *   - never delivered / reaped / cancel-propagated: no exit code, with the
 *     server's own error message.
 * `errorMessage` is tested for falsiness, not null: an empty agent error may
 * be persisted as ''.
 */
function ranToExitCode(row: ProbeRow): boolean {
  if (row.status === 'completed') return true;
  if (row.status !== 'failed') return false;
  return typeof row.exitCode === 'number' && row.exitCode > 0 && !row.errorMessage;
}

export const scriptMonitorHandler: ConditionHandler = {
  type: 'script_monitor',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as ScriptMonitorCondition;

    const [latest] = await db
      .select({
        status: scriptExecutions.status,
        exitCode: scriptExecutions.exitCode,
        stdout: scriptExecutions.stdout,
        errorMessage: scriptExecutions.errorMessage,
        completedAt: scriptExecutions.completedAt,
        createdAt: scriptExecutions.createdAt,
      })
      .from(scriptExecutions)
      .where(and(eq(scriptExecutions.monitorId, cond.monitorId), eq(scriptExecutions.deviceId, deviceId)))
      // NULLS LAST: Postgres defaults DESC to NULLS FIRST, which would let an
      // in-flight run (completedAt IS NULL) masquerade as "the newest row"
      // ahead of a real, timestamped terminal result.
      .orderBy(sql`${scriptExecutions.completedAt} DESC NULLS LAST`)
      .limit(1);

    if (!latest) {
      return { passed: false, dataAvailable: false, description: 'No recent probe result' };
    }

    // completedAt is written for every terminal outcome (completed, failed,
    // timeout, cancelled) — see scriptExecutionTerminal.ts. Falling back to
    // createdAt only matters for a row still in flight, so staleness is
    // never computed against an undefined instant.
    const referenceTime = latest.completedAt ?? latest.createdAt;
    const ageMs = Date.now() - referenceTime.getTime();
    if (ageMs > cond.intervalMinutes * MS_PER_MINUTE * STALE_PROBE_INTERVAL_MULTIPLIER) {
      // A stale probe must never latch a breach (nor a clear): an execution
      // pipeline outage must read as "no data", not as a silent all-clear.
      return { passed: false, dataAvailable: false, description: 'No recent probe result' };
    }

    if (!ranToExitCode(latest)) {
      if (NON_COMPLETED_TERMINAL_STATUSES.has(latest.status)) {
        // Per spec, a timeout (and, by the same reasoning, a cancelled run or
        // one that never ran to an exit code) is NOT a breach — nor an
        // all-clear: the probe itself never produced a verdict.
        return {
          passed: false,
          dataAvailable: false,
          description: `Script probe did not complete (status: ${latest.status})${causeSuffix(latest.errorMessage)}`,
        };
      }
      // pending / queued / running / cancelling — the probe simply hasn't
      // finished yet.
      return {
        passed: false,
        dataAvailable: false,
        description: `Script probe still in progress (status: ${latest.status})`,
      };
    }

    const marker = parseLastMonitorMarker(latest.stdout);
    if (marker) {
      const passed = marker.state === 'breach';
      return {
        passed,
        description: marker.detail ?? (passed ? 'Script probe reported a breach' : 'Script probe reported OK'),
      };
    }

    // No marker (absent or malformed) -> exit-code fallback. Never throws.
    if (cond.breachOnNonZeroExit) {
      const passed = latest.exitCode !== 0;
      return {
        passed,
        description: `Script exited with code ${latest.exitCode}`,
      };
    }

    return { passed: false, description: `Script completed (exit code ${latest.exitCode})` };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (typeof c.monitorId !== 'string' || c.monitorId.length === 0) {
      errors.push(`${path}.monitorId: Must be a non-empty string`);
    }
    if (typeof c.intervalMinutes !== 'number' || c.intervalMinutes <= 0) {
      errors.push(`${path}.intervalMinutes: Must be a positive number`);
    }

    return errors;
  },
};
