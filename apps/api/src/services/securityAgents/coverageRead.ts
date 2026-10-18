import { and, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  securityAgentDeviceStatus as t,
  SECURITY_AGENT_COVERAGE_STATES,
  type SecurityAgentCoverageState,
  type SecurityAgentStatusVendor,
} from '../../db/schema';
import { edrOrgCondition, type EdrReadScope } from '../edrProviders/read';

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

  return {
    summary: Array.from(byVendor.values()).sort((a, b) => a.vendor.localeCompare(b.vendor)),
    rows: rows.map((r) => ({
      ...r,
      lastEvaluatedAt: r.lastEvaluatedAt.toISOString(),
      stateChangedAt: r.stateChangedAt.toISOString(),
    })),
    total: Number(total),
  };
}
