/**
 * Script exit-code alerts (#6690).
 *
 * A script's opt-in `exit_code_severity_mapping` turns an exit code into an
 * alert severity (`deriveSeverityFromScript`). This module is the consumer the
 * mapping was missing: it raises, dedupes and auto-resolves one alert per
 * script + device. Contract (decisions recorded on #6690, 2026-09-23):
 *
 *  - Opt-in only. A NULL or `{}` mapping does nothing — not even the legacy
 *    "any non-zero exit = medium" branch, which would page on every failing
 *    scheduled script fleet-wide the moment this shipped.
 *  - Create only for UNATTENDED runs (`scheduled`, `automation`, `policy`,
 *    `alert`). A `manual` run has a tech looking at the result; a `monitor`
 *    probe is judged by `script_monitor`'s own breach logic.
 *  - One open alert per script + device. A dismissed one is a durable opt-out.
 *  - ANY run of the script on the device (manual re-runs included) that maps to
 *    no alert resolves the open one — same resolvable set as the warranty
 *    evaluator (#1320, #2110).
 *  - The mapping never changes the execution's completed/failed status and
 *    nothing is persisted outside the `alerts` row.
 *
 * Never throws: the caller is the agent result-ingest path, and losing an alert
 * must never cost the execution row that path exists to persist.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { alerts, devices, scripts } from '../db/schema';
import { createSourcedAlert, resolveAlert } from './alertService';
import { deriveSeverityFromScript } from './scriptSeverity';
import { captureException } from './sentry';

/** `alerts.config_item_name` discriminator for this producer. */
export const SCRIPT_EXIT_CODE_CONFIG_ITEM = 'script_exit_code';
const SOURCE = 'script_exit_code';
const PUBLISHER = 'route:agentWs:script-result';
const MESSAGE_MAX = 300;

/** Trigger types that can CREATE an alert. Resolution accepts any trigger type. */
const UNATTENDED_TRIGGER_TYPES: ReadonlySet<string> = new Set(['scheduled', 'automation', 'policy', 'alert']);

export type ScriptTriggerType = 'manual' | 'scheduled' | 'alert' | 'policy' | 'automation' | 'monitor';

export interface ScriptExitCodeAlertInput {
  executionId: string;
  scriptId: string | null;
  /** The EXECUTION's org — never the script owner's (a partner-wide script has none). */
  orgId: string;
  deviceId: string;
  triggerType: ScriptTriggerType;
  /** The agent-reported exit code. Null for timeout / cancel / failed-to-start: nothing is evaluated. */
  exitCode: number | null;
  /** Already-redacted stderr as persisted on the execution row. */
  stderr: string | null;
}

export async function evaluateScriptExitCodeAlert(input: ScriptExitCodeAlertInput): Promise<void> {
  // Ad-hoc commands and proposal-backed runs have no library script, so there
  // is no mapping to consult — and no query is spent finding that out.
  if (!input.scriptId) return;
  // Only a real exit code is a verdict. Timeouts, cancels and failures to start
  // neither raise nor clear an alert.
  if (typeof input.exitCode !== 'number' || !Number.isFinite(input.exitCode)) return;

  try {
    // A SAVEPOINT under the ingest transaction: a failed statement in here rolls
    // back to it and leaves the caller's transaction (and the execution row it
    // just wrote) committable. A caught error on a bare statement would instead
    // poison the outer commit.
    await withDbTransaction(() => evaluate(input as ScriptExitCodeAlertInput & { scriptId: string; exitCode: number }));
  } catch (err) {
    console.error(`[ScriptExitCodeAlerts] alert evaluation failed for execution ${input.executionId}:`, err);
    captureException(err, undefined, {
      area: 'script_exit_code_alert',
      executionId: input.executionId,
      scriptId: input.scriptId,
      deviceId: input.deviceId,
    });
  }
}

async function evaluate(input: ScriptExitCodeAlertInput & { scriptId: string; exitCode: number }): Promise<void> {
  const { scriptId, deviceId, exitCode } = input;

  const [script] = await db
    .select({ name: scripts.name, exitCodeSeverityMapping: scripts.exitCodeSeverityMapping })
    .from(scripts)
    .where(eq(scripts.id, scriptId))
    .limit(1);
  if (!script) return;

  // Opt-in gate, checked BEFORE deriveSeverityFromScript so its legacy
  // NULL/{} → 'medium' branch is never reached from here.
  const mapping = script.exitCodeSeverityMapping;
  if (!mapping || typeof mapping !== 'object' || Object.keys(mapping).length === 0) return;

  const severity = deriveSeverityFromScript(exitCode, mapping);
  const thisScriptsAlert = and(
    eq(alerts.deviceId, deviceId),
    eq(alerts.configItemName, SCRIPT_EXIT_CODE_CONFIG_ITEM),
    sql`(${alerts.context} ->> 'scriptId') = ${scriptId}`,
  );

  if (severity === null) {
    await autoResolve(thisScriptsAlert, exitCode);
    return;
  }

  if (!UNATTENDED_TRIGGER_TYPES.has(input.triggerType)) return;

  const [open] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(thisScriptsAlert, inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])))
    .limit(1);
  if (open) return;

  // A dismissed alert for this script + device is the tech saying "stop telling
  // me" — never re-create it (same rule as the warranty evaluator).
  const [dismissed] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(thisScriptsAlert, eq(alerts.status, 'dismissed')))
    .limit(1);
  if (dismissed) return;

  const [device] = await db
    .select({ hostname: devices.hostname, displayName: devices.displayName })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  const deviceName = device?.displayName || device?.hostname || deviceId;

  await createSourcedAlert({
    deviceId,
    orgId: input.orgId,
    severity,
    title: `Script "${script.name}" exited ${exitCode}: ${deviceName}`,
    message: buildMessage(exitCode, severity, input.triggerType, input.stderr),
    context: {
      source: SOURCE,
      scriptId,
      executionId: input.executionId,
      exitCode,
      triggerType: input.triggerType,
    },
    configItemName: SCRIPT_EXIT_CODE_CONFIG_ITEM,
    publisher: PUBLISHER,
  });
}

/**
 * Resolve this script's open alert on the device. Resolves `active` /
 * `acknowledged` and TIMED suppressions only. Two deliberate exclusions, the
 * warranty evaluator's rule (#1320, #2110):
 *   - `dismissed` is terminal and stays dismissed.
 *   - an indefinite suppression (`suppressed` with NULL `suppressedUntil`, the
 *     user's "Forever") survives, so the dedupe gate keeps blocking a fresh
 *     alert the next time the script fails — which is what "Forever" promised.
 */
async function autoResolve(thisScriptsAlert: ReturnType<typeof and>, exitCode: number): Promise<void> {
  const candidates = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(
      thisScriptsAlert,
      or(
        inArray(alerts.status, ['active', 'acknowledged']),
        and(eq(alerts.status, 'suppressed'), isNotNull(alerts.suppressedUntil)),
      ),
    ))
    .limit(25);

  for (const candidate of candidates) {
    // No resolvedBy: a system resolution. resolveAlert's status CAS decides the
    // winner if a tech resolves the same alert concurrently.
    await resolveAlert(candidate.id, `Auto-resolved: a later run exited ${exitCode}, which maps to no alert`);
  }
}

function buildMessage(exitCode: number, severity: string, triggerType: string, stderr: string | null): string {
  let message = `The ${triggerType} run exited with code ${exitCode}, which this script maps to ${severity} severity.`;
  const firstLine = stderr?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) message += ` stderr: ${firstLine}`;
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message;
}
