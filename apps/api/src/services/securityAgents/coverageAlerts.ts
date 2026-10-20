import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts } from '../../db/schema';
import { createSourcedAlert, resolveAlert } from '../alertService';
import { captureException } from '../sentry';
import type { CoverageAlertKind } from './coverageReconciler';
import { getVendor, type VendorKey } from './securityAgentVendors';

/**
 * Gap / mismatch alerts for managed security agents (#6960 W03, spec 2.6/2.7).
 *
 * Finding (W03 Task 3.2 step 3): a persistent software-compliance violation
 * raises NO alert today. `softwareComplianceWorker.ts` publishes no event and
 * no alert producer reads `software_compliance_status`; the two policy bridges
 * (policyAlertBridge / configComplianceAlertBridge) cover automation and
 * configuration policies only. So these alerts are new, but through the
 * EXISTING alert pipeline with no new alert category (Open Decision 3a):
 * `createSourcedAlert` (the rule-less producer path the EDR framework uses)
 * inserts the row and publishes `alert.triggered`, so notifications,
 * escalation, automations and AI verdicts all see it. Default severity
 * (`medium`), no new notification surface.
 *
 * `createAlert` was not used: it needs an `alert_rules` row and applies a
 * per-rule cooldown (default 5 min), an open-alert dedupe and flap
 * suppression, any of which can swallow a real transition (a device that goes
 * gap → covered → gap inside the cooldown would never re-alert). Here the
 * TRANSITION itself is the dedupe, judged against the persisted prior state in
 * `security_agent_device_status`; the open-alert check below only guards the
 * retry after a raise succeeded but its state write did not.
 *
 * Every create / resolve runs in its OWN system context (EDR precedent), so one
 * failure never rolls back the others or the reconciler's state writes.
 */

export const SECURITY_AGENT_COVERAGE_ALERT_SOURCE = 'security_agent_coverage';
export const SECURITY_AGENT_COVERAGE_PUBLISHER = 'security-agent-coverage';
const RESOLUTION_NOTE = 'Condition cleared by security agent coverage reconciliation';

const system = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export interface OpenCoverageAlert {
  id: string;
  status: string;
  suppressedUntil: Date | null;
  deviceId: string | null;
  vendor: string | null;
  kind: string | null;
}

export interface CoverageAlertDeps {
  /** True when an alert exists (already open, or created now). */
  raise(args: { orgId: string; deviceId: string; deviceName: string | null; vendor: VendorKey; kind: CoverageAlertKind }): Promise<boolean>;
  loadOpen(orgId: string): Promise<OpenCoverageAlert[]>;
  resolve(alertId: string): Promise<boolean>;
}

function titleFor(kind: CoverageAlertKind, label: string, deviceName: string | null): string {
  const name = deviceName ?? 'device';
  return (kind === 'gap'
    ? `${label} coverage gap on ${name}`
    : `${label} reports ${name} under a different organization`).slice(0, 500);
}

function messageFor(kind: CoverageAlertKind, label: string): string {
  return kind === 'gap'
    ? `A security agents policy requires ${label} on this device, but it is not installed and ${label} does not report it.`
    : `${label} reports this device under another organization's ${label} account. Nothing is reinstalled automatically; reassign the agent in the ${label} console.`;
}

export const defaultCoverageAlertDeps: CoverageAlertDeps = {
  async raise({ orgId, deviceId, deviceName, vendor, kind }) {
    const open = await system(async () => {
      const [row] = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(
          eq(alerts.deviceId, deviceId),
          inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
          sql`${alerts.context}->>'source' = ${SECURITY_AGENT_COVERAGE_ALERT_SOURCE}`,
          sql`${alerts.context}->>'vendor' = ${vendor}`,
          sql`${alerts.context}->>'kind' = ${kind}`,
        ))
        .limit(1);
      return row ?? null;
    }, 'securityAgentCoverage.alerts.findOpen');
    if (open) return true;

    const label = getVendor(vendor).label;
    const alertId = await system(() => createSourcedAlert({
      deviceId,
      orgId,
      severity: 'medium',
      title: titleFor(kind, label, deviceName),
      message: messageFor(kind, label),
      context: { source: SECURITY_AGENT_COVERAGE_ALERT_SOURCE, kind, vendor, deviceId },
      configItemName: SECURITY_AGENT_COVERAGE_ALERT_SOURCE,
      publisher: SECURITY_AGENT_COVERAGE_PUBLISHER,
      eventPayload: { vendor, kind },
    }), 'securityAgentCoverage.alerts.raise');
    return alertId !== null;
  },

  loadOpen(orgId) {
    return system(async () => db
      .select({
        id: alerts.id,
        status: alerts.status,
        suppressedUntil: alerts.suppressedUntil,
        deviceId: alerts.deviceId,
        vendor: sql<string | null>`${alerts.context}->>'vendor'`,
        kind: sql<string | null>`${alerts.context}->>'kind'`,
      })
      .from(alerts)
      .where(and(
        eq(alerts.orgId, orgId),
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${SECURITY_AGENT_COVERAGE_ALERT_SOURCE}`,
      )), 'securityAgentCoverage.alerts.loadOpen');
  },

  resolve(alertId) {
    return system(
      () => resolveAlert(alertId, RESOLUTION_NOTE, undefined, false, 'condition_cleared'),
      'securityAgentCoverage.alerts.resolve',
    );
  },
};

export function logCoverageAlertFailure(operation: string, error: unknown, extra: Record<string, string>): void {
  console.error(`[SecurityAgentCoverage] ${operation} failed:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
    service: 'securityAgentCoverage', operation, ...extra,
  });
}
