/**
 * Wave 6.2a (#3828) — resolving one due fix-held watch.
 *
 * Every check returns one of three verdicts, and the distinction between the
 * last two is the whole point of the file:
 *
 *   - `held`         — the remediation is still in effect.
 *   - `regressed`    — it is not. This is the only verdict that counts against
 *                      a circuit.
 *   - `inconclusive` — the CHECK did not resolve (device offline, unparseable
 *                      read-back, an identity we cannot ask about). Never
 *                      evidence about the agent, and never allowed to move a
 *                      counter: an offline device must not open a breaker.
 */
import { and, eq, gt, isNull, ne, or, type SQL } from 'drizzle-orm';
import { readServiceRunningState } from './actVerify';
import { alerts } from '../../db/schema/alerts';
import type { AiAgentFixWatchRow } from '../../db/schema/aiAgentFixWatches';
import { db } from '../../db';

export type FixWatchVerdict = 'held' | 'regressed' | 'inconclusive';

export interface FixWatchCheckResult {
  verdict: FixWatchVerdict;
  /** Short, human-readable — never a raw tool input/output blob. */
  detail: string;
}

/** The subset of a watch row a check actually reads. */
export type FixWatchCheckInput = Pick<
  AiAgentFixWatchRow,
  | 'id' | 'deviceId' | 'agentId' | 'watchKind' | 'verifySpecKind' | 'target'
  | 'alertId' | 'alertRuleId' | 'alertConfigItemName' | 'baselineAt'
>;

/**
 * Did an alert of the SAME identity trigger again after the remediation?
 *
 * Identity, not row: the originating alert may have been resolved (or deleted,
 * taking `alert_id` to NULL with it) long before this runs, which is why the
 * rule id and config item name were captured at scheduling time.
 *
 * Pure DB read — no device I/O — so this lane still answers while the device is
 * offline, and it is the only lane that says anything at all about
 * `run_script` or `execute_playbook`.
 */
export async function checkAlertRecurrence(
  watch: FixWatchCheckInput,
): Promise<FixWatchCheckResult> {
  // With neither half of the identity there is no question to ask. Explicitly
  // inconclusive rather than a cheerful `held`: we did not verify anything.
  if (!watch.alertRuleId && !watch.alertConfigItemName) {
    return {
      verdict: 'inconclusive',
      detail: 'the originating alert identity was not recorded, so recurrence cannot be evaluated',
    };
  }

  // Both branches are POSITIVE conditions. A `NOT (...)` over the nullable
  // rule_id would silently drop exactly the rows this needs to see.
  const identity: SQL[] = [];
  if (watch.alertRuleId) {
    identity.push(eq(alerts.ruleId, watch.alertRuleId));
  }
  if (watch.alertConfigItemName) {
    identity.push(and(
      isNull(alerts.ruleId),
      eq(alerts.configItemName, watch.alertConfigItemName),
    )!);
  }

  const [recurrence] = await db
    .select({ id: alerts.id, triggeredAt: alerts.triggeredAt })
    .from(alerts)
    .where(and(
      eq(alerts.deviceId, watch.deviceId),
      gt(alerts.triggeredAt, watch.baselineAt),
      // Belt and braces alongside the timestamp filter: the originating alert
      // triggered before the run finished, so it cannot match `gt(baselineAt)`
      // anyway, but an alert whose triggered_at was later corrected would.
      ...(watch.alertId ? [ne(alerts.id, watch.alertId)] : []),
      identity.length === 1 ? identity[0]! : or(...identity)!,
    ))
    .orderBy(alerts.triggeredAt)
    .limit(1);

  if (!recurrence) {
    return { verdict: 'held', detail: 'no matching alert re-triggered inside the watch window' };
  }
  return {
    verdict: 'regressed',
    detail: 'an alert of the same kind re-triggered on this device after the remediation',
  };
}

/**
 * Re-runs the op's own postcondition read-back — the SAME predicate the
 * immediate verify used (`readServiceRunningState`), so `held` means exactly
 * what the original `passed` meant.
 *
 * `service_running` is the only kind reachable here; anything else is a
 * scheduling bug rather than a device problem, so it reports inconclusive
 * loudly instead of guessing.
 */
export async function checkPostcondition(
  watch: FixWatchCheckInput,
): Promise<FixWatchCheckResult> {
  if (watch.verifySpecKind !== 'service_running') {
    return {
      verdict: 'inconclusive',
      detail: `no delayed re-check is defined for "${watch.verifySpecKind ?? 'unknown'}"`,
    };
  }

  const target = watch.target as { kind?: unknown; serviceName?: unknown };
  const serviceName = typeof target.serviceName === 'string' && target.serviceName.length > 0
    ? target.serviceName
    : null;
  if (!serviceName) {
    return { verdict: 'inconclusive', detail: 'the watched service name was not recorded' };
  }

  // `agentId` is the attribution user id the run itself used — see
  // buildAgentAuthContext, where auth.user.id IS the agent id.
  const state = await readServiceRunningState(watch.deviceId, serviceName, watch.agentId);

  switch (state.verification) {
    case 'passed':
      return { verdict: 'held', detail: `${serviceName} is still running` };
    case 'failed':
      return {
        verdict: 'regressed',
        detail: state.detail ? `${serviceName}: ${state.detail}` : `${serviceName} is no longer running`,
      };
    default:
      // 'inconclusive' or 'skipped' — an offline device lands here, and must
      // never be scored as a regression.
      return {
        verdict: 'inconclusive',
        detail: state.detail ?? 'the service status read did not resolve',
      };
  }
}

/** Dispatches to the lane the watch was scheduled under. */
export async function runFixWatchCheck(
  watch: FixWatchCheckInput,
): Promise<FixWatchCheckResult> {
  try {
    return watch.watchKind === 'alert_recurrence'
      ? await checkAlertRecurrence(watch)
      : await checkPostcondition(watch);
  } catch (error) {
    // A broken check is not a regression. Degrade, log, and let the retry
    // budget decide when to give up.
    console.error('[fixWatchCheck] check threw (recorded as inconclusive)', {
      watchId: watch.id, watchKind: watch.watchKind, error,
    });
    return { verdict: 'inconclusive', detail: 'the fix-held check did not complete' };
  }
}
