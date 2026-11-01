import { and, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  securityAgentDeviceStatus as t,
  softwareCatalog,
  softwarePolicies,
  SECURITY_AGENT_COVERAGE_STATES,
  type SecurityAgentCoverageState,
  type SecurityAgentStatusVendor,
} from '../../db/schema';
import { edrOrgCondition, type EdrReadScope } from '../edrProviders/read';
import { vendorForCatalogPackage } from './securityAgentVendors';

/**
 * Read model for security agent coverage (#6960 W03): the rows behind the EDR
 * summary, the device EDR panel and the software compliance dashboard.
 *
 * Org-scoped and read-only. Runs in the caller's request context, so RLS
 * (shape 1, `breeze_has_org_access(org_id)`) bounds every row; the explicit org
 * condition mirrors the EDR read model (an org user is pinned to its org, a
 * partner user may narrow to one accessible org). Site-restricted users see
 * only rows of devices on their sites, and no `vendor_only` rows (those belong
 * to no device, so no site).
 */

export const COVERAGE_MAX_LIMIT = 200;

export interface CoverageQuery {
  orgId?: string;
  deviceId?: string;
  vendor?: SecurityAgentStatusVendor;
  states?: SecurityAgentCoverageState[];
  limit: number;
  offset: number;
}

export interface CoverageRowDto {
  id: string;
  orgId: string;
  deviceId: string | null;
  deviceName: string | null;
  vendor: SecurityAgentStatusVendor;
  state: SecurityAgentCoverageState;
  reasonCode: string | null;
  detail: string | null;
  /**
   * Where the partner fixes the row's cause, when the read can say. Today only
   * `installer_missing` (#9247): the Versions tab of the package the row's
   * policy installs the vendor from (`/software#versions=<catalogId>`).
   */
  setupPath: string | null;
  lastEvaluatedAt: string;
  stateChangedAt: string;
}

export interface CoverageSummaryDto {
  vendor: SecurityAgentStatusVendor;
  total: number;
  counts: Record<SecurityAgentCoverageState, number>;
}


function baseConditions(scope: EdrReadScope, q: CoverageQuery): SQL[] {
  const conditions: SQL[] = [];
  const org = edrOrgCondition(scope.auth, q.orgId, t.orgId);
  if (org) conditions.push(org);
  if (q.deviceId) conditions.push(eq(t.deviceId, q.deviceId));
  if (q.vendor) conditions.push(eq(t.vendor, q.vendor));
  if (scope.allowedDeviceIds) {
    conditions.push(scope.allowedDeviceIds.length === 0
      ? sql`false`
      : and(isNotNull(t.deviceId), inArray(t.deviceId, scope.allowedDeviceIds))!);
  }
  return conditions;
}

function emptyCounts(): Record<SecurityAgentCoverageState, number> {
  return Object.fromEntries(SECURITY_AGENT_COVERAGE_STATES.map((s) => [s, 0])) as Record<SecurityAgentCoverageState, number>;
}

export async function readSecurityAgentCoverage(scope: EdrReadScope, q: CoverageQuery): Promise<{
  summary: CoverageSummaryDto[];
  rows: CoverageRowDto[];
  total: number;
}> {
  const base = baseConditions(scope, q);
  const filtered = q.states && q.states.length > 0 ? [...base, inArray(t.state, q.states)] : base;

  const grouped = await db
    .select({ vendor: t.vendor, state: t.state, count: sql<number>`count(*)::int` })
    .from(t)
    .where(base.length > 0 ? and(...base) : undefined)
    .groupBy(t.vendor, t.state);
  const byVendor = new Map<SecurityAgentStatusVendor, CoverageSummaryDto>();
  for (const g of grouped) {
    const entry = byVendor.get(g.vendor) ?? { vendor: g.vendor, total: 0, counts: emptyCounts() };
    entry.counts[g.state] = Number(g.count);
    entry.total += Number(g.count);
    byVendor.set(g.vendor, entry);
  }

  const where = filtered.length > 0 ? and(...filtered) : undefined;
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(t).where(where);
  const rows = await db
    .select({
      id: t.id,
      orgId: t.orgId,
      deviceId: t.deviceId,
      deviceName: sql<string | null>`coalesce(${devices.displayName}, ${devices.hostname})`,
      vendor: t.vendor,
      state: t.state,
      reasonCode: t.reasonCode,
      detail: t.detail,
      policyId: t.policyId,
      lastEvaluatedAt: t.lastEvaluatedAt,
      stateChangedAt: t.stateChangedAt,
    })
    .from(t)
    .leftJoin(devices, eq(devices.id, t.deviceId))
    .where(where)
    // Problems first: gaps and mismatches, then offline, then the rest.
    .orderBy(
      sql`CASE ${t.state} WHEN 'mismatched_org' THEN 0 WHEN 'gap' THEN 1 WHEN 'vendor_offline' THEN 2 WHEN 'vendor_only' THEN 3 WHEN 'pending' THEN 4 WHEN 'not_applicable' THEN 5 ELSE 6 END`,
      desc(t.stateChangedAt),
      t.id,
    )
    .limit(q.limit)
    .offset(q.offset);

  const installerPaths = await installerMissingSetupPaths(rows);
  return {
    summary: Array.from(byVendor.values()).sort((a, b) => a.vendor.localeCompare(b.vendor)),
    rows: rows.map(({ policyId, ...r }) => ({
      ...r,
      setupPath: (policyId && installerPaths.get(`${policyId}|${r.vendor}`)) || null,
      lastEvaluatedAt: r.lastEvaluatedAt.toISOString(),
      stateChangedAt: r.stateChangedAt.toISOString(),
    })),
    total: Number(total),
  };
}

/**
 * `policyId|vendor` → the Versions-tab link of the package that policy's rule
 * for the vendor installs from, for the page's `installer_missing` rows only
 * (#9247). Read in the caller's request context: a policy or catalog row RLS
 * hides yields no link, and the row still carries its reason. No query when
 * the page has no such row.
 */
async function installerMissingSetupPaths(
  rows: ReadonlyArray<{ vendor: SecurityAgentStatusVendor; reasonCode: string | null; policyId: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const policyIds = Array.from(new Set(rows
    .filter((r) => r.reasonCode === 'installer_missing' && r.policyId)
    .map((r) => r.policyId!)));
  if (policyIds.length === 0) return out;

  const policies = await db
    .select({ id: softwarePolicies.id, rules: softwarePolicies.rules })
    .from(softwarePolicies)
    .where(inArray(softwarePolicies.id, policyIds));
  const catalogIdsByPolicy = new Map(policies.map((p) => [p.id, ruleCatalogIds(p.rules)] as const));
  const catalogIds = Array.from(new Set(Array.from(catalogIdsByPolicy.values()).flat()));
  if (catalogIds.length === 0) return out;

  const catalogs = await db
    .select({
      id: softwareCatalog.id,
      integrationProvider: softwareCatalog.integrationProvider,
      builtinPackageKey: softwareCatalog.builtinPackageKey,
    })
    .from(softwareCatalog)
    .where(inArray(softwareCatalog.id, catalogIds));
  const vendorByCatalog = new Map(catalogs.map((c) => [c.id, vendorForCatalogPackage(c)?.vendor ?? null] as const));

  for (const [policyId, ids] of catalogIdsByPolicy) {
    for (const catalogId of ids) {
      const vendor = vendorByCatalog.get(catalogId);
      const key = `${policyId}|${vendor}`;
      // First rule per vendor, in rule order (an uploaded-installer vendor has one).
      if (vendor && !out.has(key)) out.set(key, `/software#versions=${catalogId}`);
    }
  }
  return out;
}

function ruleCatalogIds(rules: unknown): string[] {
  const software = (rules as { software?: unknown } | null)?.software;
  if (!Array.isArray(software)) return [];
  return software
    .map((rule) => (rule && typeof rule === 'object' ? (rule as { catalogId?: unknown }).catalogId : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
