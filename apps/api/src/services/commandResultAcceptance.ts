import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { deviceCommands } from '../db/schema';

/**
 * #3607 — which `device_commands` rows may still accept a result from the agent.
 *
 * Historically this was the literal `['pending','sent']`, duplicated on the WS
 * ingest path (`routes/agentWs.ts`) and its REST twin
 * (`routes/agents/commands.ts`). That set is too narrow, and the gap silently
 * destroyed real script output:
 *
 *   1. `waitForCommandResult` (services/commandQueue.ts) gives up at its
 *      deadline — 60s for the AI `run_script` tool — and terminalizes the row
 *      to `status:'failed'`, `result:{status:'timeout'}`.
 *   2. The agent's REAL result lands a moment later. The row is now `failed`,
 *      so the ingest lookup matched nothing at all — not the compare-and-set,
 *      the LOOKUP. `command` came back undefined and the handler branched into
 *      `processOrphanedCommandResult`, which knows only SNMP/discovery/tunnel.
 *   3. `handleScriptResult` — the only writer of stdout/stderr/exitCode onto
 *      `script_executions` — therefore never ran, and nothing else ever would.
 *
 * The output was not late or degraded; it was never written. Any script slower
 * than the wait deadline reported `failed / exitCode:null / stdout:null` to the
 * operator and to the AI even when it had succeeded on the device.
 *
 * So a server-side timeout is treated as PROVISIONAL: the row stays terminal
 * for every reader, but a genuine agent result may still overwrite it. The
 * `result->>'status' = 'timeout'` discriminator is what keeps that narrow —
 * an agent-reported failure stores `status:'failed'` (see
 * `buildStoredCommandResult`) and a cancellation stores `status:'cancelled'`,
 * so neither is reopened. All three server-side timeout writers stamp the same
 * marker and are covered by it: the wait deadline above,
 * `jobs/staleCommandReaper.ts`, and `markVerificationCommandTimedOut`
 * (`routes/backup/verificationScheduled.ts`). A new one MUST keep writing
 * `result.status = 'timeout'` or its commands go back to losing late results.
 *
 * Double-delivery stays protected because the acceptance test is re-evaluated
 * inside the terminal compare-and-set: the first late result rewrites `result`
 * to `status:'completed'|'failed'`, which no longer satisfies the predicate, so
 * a second copy of the same frame finds 0 rows and is ignored exactly as before.
 */
export const ACCEPTED_COMMAND_RESULT_STATUSES = ['pending', 'sent'] as const;

export type AcceptedCommandResultStatus = (typeof ACCEPTED_COMMAND_RESULT_STATUSES)[number];

/** Marker written into `device_commands.result.status` by server-side timeouts. */
export const SERVER_TIMEOUT_RESULT_STATUS = 'timeout';

/**
 * Drizzle predicate for "this row may still accept an agent result".
 *
 * Use it in BOTH the ingest lookup and the terminal compare-and-set. Applying
 * it only at the CAS does nothing: the lookup runs first and returns no row.
 */
export function commandAcceptsAgentResultCondition(): SQL {
  return or(
    inArray(deviceCommands.status, [...ACCEPTED_COMMAND_RESULT_STATUSES]),
    and(
      eq(deviceCommands.status, 'failed'),
      sql`${deviceCommands.result}->>'status' = ${SERVER_TIMEOUT_RESULT_STATUS}`,
    ),
  )!;
}

/**
 * In-memory twin of {@link commandAcceptsAgentResultCondition}, for the REST
 * route's pre-read short-circuit which already holds the row.
 */
export function commandAcceptsAgentResult(
  status: string | null | undefined,
  result: unknown,
): boolean {
  if (!status) return true;
  if ((ACCEPTED_COMMAND_RESULT_STATUSES as readonly string[]).includes(status)) return true;
  if (status !== 'failed') return false;
  const resultStatus = (result as Record<string, unknown> | null | undefined)?.status;
  return resultStatus === SERVER_TIMEOUT_RESULT_STATUS;
}
