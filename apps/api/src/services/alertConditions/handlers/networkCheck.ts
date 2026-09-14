import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { networkMonitorResults, networkMonitors } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult, NetworkCheckCondition } from '../types';

/**
 * `network_check` verdict handler (#5287 W04, #5291).
 *
 * A `network_check` monitor compiles to a managed `network_monitors` row that
 * the existing `monitorWorker` polls from an agent; this handler reads the
 * verdict back off `network_monitor_results`. The two halves are deliberately
 * decoupled through that table — nothing here talks to an agent.
 *
 * The results row carries its own `org_id` since W04 (a partner-wide parent has
 * none), so the newest N rows for the managed monitor are already narrowed to
 * the reading tenant by RLS; no org predicate is needed or wanted here.
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
      .select({ id: networkMonitors.id })
      .from(networkMonitors)
      .where(eq(networkMonitors.managedByMonitorId, cond.monitorId))
      .limit(1);

    if (!managed) {
      // The compiler has not produced the managed row yet (or it was deleted
      // behind the compiler). Absence of evidence is not a breach.
      return { passed: false, description: 'Network check not provisioned yet' };
    }

    const rows = await db
      .select({ status: networkMonitorResults.status, timestamp: networkMonitorResults.timestamp })
      .from(networkMonitorResults)
      .where(and(eq(networkMonitorResults.monitorId, managed.id)))
      .orderBy(desc(networkMonitorResults.timestamp))
      .limit(needed);

    if (rows.length === 0) {
      return { passed: false, description: 'No network check results yet' };
    }

    // Count leading offline results. Fewer rows than `needed` can never satisfy
    // the threshold — a check that has only run twice has not yet failed three
    // times, and treating a short history as a breach would page on every
    // newly-created monitor.
    let consecutive = 0;
    for (const row of rows) {
      if (row.status !== 'offline') break;
      consecutive++;
    }

    const passed = consecutive >= needed;
    return {
      passed,
      description: passed
        ? `Network check offline for ${consecutive} consecutive result(s) (threshold ${needed})`
        : `Network check reachable (${consecutive} consecutive offline result(s), threshold ${needed})`,
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
    return errors;
  },
};
