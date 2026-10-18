import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  devices,
  organizations,
  securityAgentDeviceStatus as t,
  softwareCatalog,
  softwareComplianceStatus,
  softwarePolicies,
  type SecurityAgentCoverageState,
  type SecurityAgentDeviceStatus,
  type SoftwarePolicyViolation,
} from '../../db/schema';
import { evaluateSoftwarePolicyArming, normalizeSoftwarePolicyRules } from '../softwarePolicyService';
import {
  alertTransition,
  classifyOrgCoverage,
  normalizeHostname,
  type CoverageAlertKind,
  type CoverageDecision,
  type DeviceCoverageInput,
  type VendorEndpointSource,
  type VendorEndpointView,
} from './coverageReconciler';
import { defaultCoverageAlertDeps, logCoverageAlertFailure, type CoverageAlertDeps } from './coverageAlerts';
import { vendorForIntegrationProvider, type VendorKey } from './securityAgentVendors';
import { getVendorEndpointSource, loadPartnerDeviceHostnames } from './vendorEndpointSources';
import { notInHoldingOrgCondition } from '../unassignedPool/selectorPredicate';

/**
 * Coverage reconciliation, the I/O half (#6960 W03): one org per call, from
 * the coverage worker's partner → org fan-out.
 *
 * Its scope is the org's existing `security_agent_device_status` device rows,
 * which the compliance worker writes for every device a managed policy reaches
 * (keyed on the DEVICE's org). So a partner-wide policy (org_id NULL) is
 * covered without this code ever filtering on a policy's org.
 *
 *  1. Prune device rows whose policy is gone (SET NULL), inactive, or no longer
 *     has a rule for the row's vendor: the device is out of scope.
 *  2. Per vendor with an endpoint source: classify the non-`not_applicable`
 *     rows (`coverageReconciler.ts`), raise gap/mismatch alerts on transition,
 *     write the new state (compare-and-set on the prior state, so a concurrent
 *     compliance write of `not_applicable` is never overwritten).
 *  3. Replace the org's `vendor_only` rows for that vendor (only while the org
 *     has in-scope devices for it; otherwise they are dropped).
 *  4. Resolve open coverage alerts whose condition no longer holds.
 *
 * Loads run in one short system context; every alert create/resolve runs in
 * its own; state writes run in a final one. A transition whose alert could not
 * be raised keeps its prior state, so the next run retries the alert.
 */

export interface ReconcileOrgResult {
  orgId: string;
  evaluated: number;
  changed: number;
  pruned: number;
  vendorOnly: number;
  alertsRaised: number;
  alertsDeferred: number;
  alertsResolved: number;
}

export interface ReconcileDeps {
  alerts: CoverageAlertDeps;
  sourceFor(vendor: VendorKey): VendorEndpointSource | null;
}

const defaultDeps: ReconcileDeps = { alerts: defaultCoverageAlertDeps, sourceFor: getVendorEndpointSource };

/** Alerts raised per org per run; the rest keep their prior state and follow on later runs. */
export const COVERAGE_ALERTS_PER_ORG_RUN = 50;


const system = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

interface VendorPlan {
  vendor: VendorKey;
  rows: SecurityAgentDeviceStatus[];
  decisions: Map<string, CoverageDecision>;
  vendorOnly: Array<{ endpointId: string; detail: string }>;
  hasSource: boolean;
  deviceNames: Map<string, string | null>;
}

export async function reconcileOrgCoverage(
  orgId: string,
  deps: ReconcileDeps = defaultDeps,
  opts: { maxAlertsPerRun?: number } = {},
): Promise<ReconcileOrgResult> {
  const cap = opts.maxAlertsPerRun ?? COVERAGE_ALERTS_PER_ORG_RUN;
  const result: ReconcileOrgResult = {
    orgId, evaluated: 0, changed: 0, pruned: 0, vendorOnly: 0, alertsRaised: 0, alertsDeferred: 0, alertsResolved: 0,
  };

  // ---- load + classify (one short context) -------------------------------
  const loaded = await system(async () => {
    const rows = await db.select().from(t).where(eq(t.orgId, orgId));
    const deviceRows = rows.filter((row) => row.deviceId !== null);

    const policyIds = Array.from(new Set(deviceRows.map((row) => row.policyId).filter((id): id is string => !!id)));
    const policies = policyIds.length === 0 ? [] : await db.select().from(softwarePolicies).where(inArray(softwarePolicies.id, policyIds));
    const rulesByPolicy = new Map(policies.map((p) => [p.id, normalizeSoftwarePolicyRules(p.rules)] as const));
    const catalogIds = Array.from(new Set(Array.from(rulesByPolicy.values())
      .flatMap((rules) => (rules.software ?? []).map((rule) => rule.catalogId))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const catalogs = catalogIds.length === 0 ? [] : await db
      .select({ id: softwareCatalog.id, integrationProvider: softwareCatalog.integrationProvider })
      .from(softwareCatalog)
      .where(inArray(softwareCatalog.id, catalogIds));
    const vendorByCatalog = new Map(catalogs.map((c) => [c.id, vendorForIntegrationProvider(c.integrationProvider)] as const));

    // policyId → vendor → catalogId, for active managed policies only.
    const vendorCatalogByPolicy = new Map<string, Map<VendorKey, string>>();
    const armedByPolicy = new Map<string, boolean>();
    for (const policy of policies) {
      if (!policy.isActive || !policy.managedByLinkId) continue;
      const byVendor = new Map<VendorKey, string>();
      for (const rule of rulesByPolicy.get(policy.id)?.software ?? []) {
        const vendor = rule.catalogId ? vendorByCatalog.get(rule.catalogId) : null;
        if (vendor && rule.catalogId && !byVendor.has(vendor)) byVendor.set(vendor, rule.catalogId);
      }
      vendorCatalogByPolicy.set(policy.id, byVendor);
      armedByPolicy.set(policy.id, evaluateSoftwarePolicyArming(policy, 'install').armed);
    }

    const prune = deviceRows.filter((row) => !row.policyId || !vendorCatalogByPolicy.get(row.policyId)?.has(row.vendor));
    const pruneIds = new Set(prune.map((row) => row.id));
    const kept = deviceRows.filter((row) => !pruneIds.has(row.id));

    const deviceIds = Array.from(new Set(kept.map((row) => row.deviceId!)));
    const deviceInfo = deviceIds.length === 0 ? [] : await db
      .select({ id: devices.id, orgId: devices.orgId, hostname: devices.hostname, displayName: devices.displayName })
      .from(devices)
      .where(inArray(devices.id, deviceIds));
    const deviceById = new Map(deviceInfo.map((d) => [d.id, d] as const));
    const compliance = deviceIds.length === 0 || policyIds.length === 0 ? [] : await db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        policyId: softwareComplianceStatus.policyId,
        violations: softwareComplianceStatus.violations,
        installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
      })
      .from(softwareComplianceStatus)
      .where(and(inArray(softwareComplianceStatus.deviceId, deviceIds), inArray(softwareComplianceStatus.policyId, policyIds)));
    const complianceByKey = new Map(compliance.map((c) => [`${c.policyId}|${c.deviceId}`, c] as const));

    const vendors = Array.from(new Set(rows.map((row) => row.vendor)));
    const plans: VendorPlan[] = [];
    for (const vendor of vendors) {
      const source = deps.sourceFor(vendor);
      const vendorRows = kept.filter((row) => row.vendor === vendor);
      const plan: VendorPlan = {
        vendor, rows: vendorRows, decisions: new Map(), vendorOnly: [], hasSource: !!source, deviceNames: new Map(),
      };
      plans.push(plan);
      if (!source) continue;

      const reconcilable = vendorRows.filter((row) => row.state !== 'not_applicable' && deviceById.has(row.deviceId!));
      const inputs: DeviceCoverageInput[] = reconcilable.map((row) => {
        const info = deviceById.get(row.deviceId!)!;
        plan.deviceNames.set(info.id, info.displayName ?? info.hostname ?? null);
        const catalogId = vendorCatalogByPolicy.get(row.policyId!)!.get(vendor)!;
        const status = complianceByKey.get(`${row.policyId}|${row.deviceId}`);
        const missing = (status?.violations as SoftwarePolicyViolation[] | null | undefined)
          ?.some((v) => v.type === 'missing' && v.rule?.catalogId === catalogId);
        return {
          deviceId: info.id,
          orgId: info.orgId,
          hostnames: [normalizeHostname(info.hostname), normalizeHostname(info.displayName)].filter((h): h is string => !!h),
          install: !status ? 'unknown' : missing ? 'missing' : 'installed',
          installRemediationStatus: status?.installRemediationStatus ?? null,
          installArmed: armedByPolicy.get(row.policyId!) ?? false,
        };
      });
      // vendor_only is only meaningful where the feature reaches devices.
      const endpoints: VendorEndpointView[] = vendorRows.length > 0 ? await source.listForOrg(orgId) : [];
      const unlinkedHostnames = endpoints
        .filter((e) => e.orgId === orgId && !e.deviceId)
        .map((e) => normalizeHostname(e.hostname))
        .filter((h): h is string => !!h);
      const knownDeviceHostnames = await loadPartnerDeviceHostnames(orgId, unlinkedHostnames);
      const classified = classifyOrgCoverage({
        orgId, reportsVendorOrg: source.reportsVendorOrg, devices: inputs, endpoints, knownDeviceHostnames,
      });
      plan.decisions = classified.decisions;
      plan.vendorOnly = vendorRows.length > 0 ? classified.vendorOnly : [];
    }
    return { prune, plans };
  }, 'securityAgentCoverage.reconcile.load');

  // ---- alerts on transition (each in its own context) ---------------------
  type Write = { row: SecurityAgentDeviceStatus; decision: CoverageDecision };
  const writes: Write[] = [];
  const touched: string[] = [];
  let raisedThisRun = 0;
  for (const plan of loaded.plans) {
    for (const row of plan.rows) {
      const decision = plan.decisions.get(row.deviceId!);
      if (!decision) continue;
      result.evaluated += 1;
      if (!changedFrom(row, decision)) {
        touched.push(row.id);
        continue;
      }
      const kind = alertTransition(row.state, decision.state);
      if (kind) {
        if (raisedThisRun >= cap) { result.alertsDeferred += 1; continue; }
        const raised = await raiseSafely(deps, { orgId, deviceId: row.deviceId!, deviceName: plan.deviceNames.get(row.deviceId!) ?? null, vendor: plan.vendor, kind });
        if (!raised) { result.alertsDeferred += 1; continue; }
        raisedThisRun += 1;
        result.alertsRaised += 1;
      }
      writes.push({ row, decision });
    }
  }

  // ---- persist (one context) ----------------------------------------------
  const finalState = new Map<string, SecurityAgentCoverageState>();
  for (const plan of loaded.plans) for (const row of plan.rows) finalState.set(`${row.deviceId}|${row.vendor}`, row.state);
  await system(async () => {
    if (loaded.prune.length > 0) {
      const removed = await db.delete(t).where(inArray(t.id, loaded.prune.map((row) => row.id))).returning({ id: t.id });
      result.pruned = removed.length;
    }
    for (const { row, decision } of writes) {
      const updated = await db
        .update(t)
        .set({
          state: decision.state,
          reasonCode: decision.reasonCode,
          detail: decision.detail,
          vendorEndpointId: decision.vendorEndpointId,
          lastEvaluatedAt: sql`now()`,
          stateChangedAt: decision.state === row.state ? row.stateChangedAt : sql`now()`,
        })
        // CAS on the prior state: the compliance worker may have just moved
        // this row to not_applicable; its write wins and the next run re-judges.
        .where(and(eq(t.id, row.id), eq(t.state, row.state)))
        .returning({ id: t.id });
      if (updated.length > 0) {
        result.changed += 1;
        finalState.set(`${row.deviceId}|${row.vendor}`, decision.state);
      }
    }
    if (touched.length > 0) {
      await db.update(t).set({ lastEvaluatedAt: sql`now()` }).where(inArray(t.id, touched));
    }

    for (const plan of loaded.plans) {
      const keep = plan.vendorOnly.map((v) => v.endpointId);
      // Stale vendor_only rows: agents now matched, gone, or the org no longer in scope.
      await db.delete(t).where(and(
        eq(t.orgId, orgId),
        eq(t.vendor, plan.vendor),
        isNull(t.deviceId),
        ...(keep.length > 0 ? [notInArray(t.vendorEndpointId, keep)] : []),
      ));
      if (plan.vendorOnly.length === 0) continue;
      await db
        .insert(t)
        .values(plan.vendorOnly.map((v) => ({
          orgId, deviceId: null, vendorEndpointId: v.endpointId, vendor: plan.vendor,
          state: 'vendor_only' as const, reasonCode: null, detail: v.detail, policyId: null,
        })))
        .onConflictDoUpdate({
          target: [t.orgId, t.vendor, t.vendorEndpointId],
          targetWhere: isNull(t.deviceId),
          set: { detail: sql`excluded.detail`, lastEvaluatedAt: sql`now()` },
        });
      result.vendorOnly += plan.vendorOnly.length;
    }
  }, 'securityAgentCoverage.reconcile.persist');
  for (const row of loaded.prune) finalState.delete(`${row.deviceId}|${row.vendor}`);

  // ---- resolve cleared alerts ---------------------------------------------
  let open: Awaited<ReturnType<CoverageAlertDeps['loadOpen']>> = [];
  try {
    open = await deps.alerts.loadOpen(orgId);
  } catch (error) {
    logCoverageAlertFailure('loadOpenAlerts', error, { orgId });
  }
  for (const alert of open) {
    const current = alert.deviceId && alert.vendor ? finalState.get(`${alert.deviceId}|${alert.vendor}`) : undefined;
    if (current !== undefined && current === alert.kind) continue;
    // An indefinitely-suppressed alert keeps its mute (EDR / backup precedent).
    if (alert.status === 'suppressed' && alert.suppressedUntil === null) continue;
    try {
      if (await deps.alerts.resolve(alert.id)) result.alertsResolved += 1;
    } catch (error) {
      logCoverageAlertFailure('resolveAlert', error, { orgId, alertId: alert.id });
    }
  }

  if (result.alertsDeferred > 0) {
    console.warn(`[SecurityAgentCoverage] org ${orgId}: ${result.alertsDeferred} transition(s) deferred to the next run (alert cap ${cap} or raise failure)`);
  }
  return result;
}

function changedFrom(row: SecurityAgentDeviceStatus, decision: CoverageDecision): boolean {
  return row.state !== decision.state
    || (row.reasonCode ?? null) !== decision.reasonCode
    || (row.detail ?? null) !== decision.detail
    || (row.vendorEndpointId ?? null) !== decision.vendorEndpointId;
}

async function raiseSafely(
  deps: ReconcileDeps,
  args: { orgId: string; deviceId: string; deviceName: string | null; vendor: VendorKey; kind: CoverageAlertKind },
): Promise<boolean> {
  try {
    return await deps.alerts.raise(args);
  } catch (error) {
    logCoverageAlertFailure('raiseAlert', error, { orgId: args.orgId, deviceId: args.deviceId, kind: args.kind });
    return false;
  }
}

/**
 * Partners with any coverage row (the worker's fan-out source). Holding
 * (unassigned-pool) orgs are left out: no coverage is reconciled or alerted
 * for parked devices.
 */
export async function listCoveragePartners(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ partnerId: organizations.partnerId })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(notInHoldingOrgCondition(t.orgId));
  return rows.map((r) => r.partnerId).filter((id): id is string => !!id);
}

/** Orgs of one partner with any coverage row, holding orgs left out. */
export async function listCoverageOrgsForPartner(partnerId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: t.orgId })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(and(eq(organizations.partnerId, partnerId), notInHoldingOrgCondition(t.orgId)));
  return rows.map((r) => r.orgId);
}
