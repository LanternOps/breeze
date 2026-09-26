import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { devices, networkMonitorResults, networkMonitors } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult, NetworkCheckCondition } from '../types';
import { resolveNetworkCheckAlertDeviceForMonitor } from '../../monitors/networkCheckAlertDevice';

/**
 * #6353 — runtime capability the alerting-consolidation W05e converter gates
 * on. `true` means: a `network_check` verdict is evaluated ONCE per managed
 * check per running org (`services/monitors/networkCheckAlertSweep.ts`), on the
 * device `resolveNetworkCheckAlertDeviceForMonitor` picks, independent of that device's
 * online status — and this handler refuses to breach for any other device.
 * Removing either half must flip this to `false`, which blocks conversion.
 */
export const NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = true as const;

/**
 * `network_check` verdict handler (#5287 W04, #5291).
 *
 * A `network_check` monitor compiles to a managed `network_monitors` row that
 * the existing `monitorWorker` polls from an agent; this handler reads the
 * verdict back off `network_monitor_results`. The two halves are deliberately
 * decoupled through that table — nothing here talks to an agent.
 *
 * The results read is scoped to the EVALUATED DEVICE'S OWN ORG explicitly, and
 * must not rely on RLS to do it: the alert sweep runs this handler inside
 * `runWithSystemDbAccess` (jobs/alertWorker.ts), where
 * `breeze_current_scope() = 'system'` short-circuits
 * `network_monitor_results_isolation` to always-true. A partner-wide check
 * produces results for EVERY org under the partner against the same managed
 * row, so an unscoped read would blend those timelines: a healthy org would
 * inherit a sibling's outage, and a genuinely down org's streak would be
 * masked by a sibling's more recent `online` row.
 *
 * ONE ALERT DEVICE PER CHECK PER ORG (#6353): the probe runs once per org, so
 * the verdict is the org's, not any device's. The handler breaches only when
 * called for the device `resolveNetworkCheckAlertDeviceForMonitor` picks for
 * that org — the legacy network worker's rule, constrained to devices the
 * monitor's policy attachment reaches — and answers "not breaching"
 * for every other device an org-wide policy reaches. The device-independent
 * sweep (`networkCheckAlertSweep.ts`) is what calls it for the alert device,
 * online or not; the per-device sweep skips `network_check` rules entirely.
 *
 * `passed: true` means the monitor BREACHES.
 */
export const networkCheckHandler: ConditionHandler = {
  type: 'network_check',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as NetworkCheckCondition;
    const needed = Math.max(1, cond.consecutiveFailures ?? 2);

    // The managed row is found through the DEFINITION, not the device: one
    // network check runs from whichever agent the worker picked, so the device
    // this rule fired for is not necessarily the prober.
    const [managed] = await db
      .select({ id: networkMonitors.id, assetId: networkMonitors.assetId })
      .from(networkMonitors)
      .where(eq(networkMonitors.managedByMonitorId, cond.monitorId))
      .limit(1);

    if (!managed) {
      // The compiler has not produced the managed row yet (or it was deleted
      // behind the compiler). Absence of evidence is not a breach.
      return { passed: false, description: 'Network check not provisioned yet' };
    }

    // The running org comes from the DEVICE, never from the definition owner
    // (which is NULL for a partner-wide check). A device we cannot read is a
    // deny, not an all-clear.
    const [device] = await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device) {
      return { passed: false, description: 'Device not found for network check evaluation' };
    }

    // One probe per org raises ONE alert per org, on the device the legacy
    // worker would have chosen (within the monitor's attachment scope). Any
    // other device — and an org with no eligible device at all — is "not
    // breaching", never a duplicate alert. The only callers today are the
    // network_check sweep (always the alert device) and auto-resolve (the
    // alert's device, which may legitimately have stopped being the alert
    // device — then the alert resolves, which is the right outcome).
    const alertDeviceId = await resolveNetworkCheckAlertDeviceForMonitor({
      orgId: device.orgId,
      assetId: managed.assetId,
      monitorId: cond.monitorId,
    });
    if (alertDeviceId !== deviceId) {
      return { passed: false, description: 'Not the alert device for this network check' };
    }

    const rows = await db
      .select({
        status: networkMonitorResults.status,
        responseMs: networkMonitorResults.responseMs,
        timestamp: networkMonitorResults.timestamp,
      })
      .from(networkMonitorResults)
      .where(and(
        eq(networkMonitorResults.monitorId, managed.id),
        eq(networkMonitorResults.orgId, device.orgId),
      ))
      .orderBy(desc(networkMonitorResults.timestamp))
      .limit(needed);

    if (rows.length === 0) {
      return { passed: false, description: 'No network check results yet' };
    }

    const isFailure = (row: { status: string; responseMs: number | null }) =>
      row.status === 'offline'
      || (cond.degradedIsFailure === true && row.status === 'degraded')
      || (cond.maxResponseMs != null && row.responseMs != null && row.responseMs > cond.maxResponseMs);

    // Count leading failing results. Fewer rows than `needed` can never satisfy
    // the threshold — a check that has only run twice has not yet failed three
    // times, and treating a short history as a breach would page on every
    // newly-created monitor.
    let consecutive = 0;
    for (const row of rows) {
      if (!isFailure(row)) break;
      consecutive++;
    }

    const passed = consecutive >= needed;
    return {
      passed,
      description: passed
        ? `Network check failing for ${consecutive} consecutive result(s) (threshold ${needed})`
        : `Network check healthy (${consecutive} consecutive failing result(s), threshold ${needed})`,
      actualValue: consecutive,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;
    if (typeof c.monitorId !== 'string' || c.monitorId.length === 0) {
      errors.push(`${path}.monitorId: Must be the monitor definition id`);
    }
    if (
      c.consecutiveFailures !== undefined &&
      (typeof c.consecutiveFailures !== 'number' || c.consecutiveFailures < 1)
    ) {
      errors.push(`${path}.consecutiveFailures: Must be a positive number`);
    }
    if (
      c.maxResponseMs !== undefined &&
      (typeof c.maxResponseMs !== 'number' || c.maxResponseMs < 1)
    ) {
      errors.push(`${path}.maxResponseMs: Must be a positive number`);
    }
    if (c.degradedIsFailure !== undefined && typeof c.degradedIsFailure !== 'boolean') {
      errors.push(`${path}.degradedIsFailure: Must be a boolean`);
    }
    return errors;
  },
};
