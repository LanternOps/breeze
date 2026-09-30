import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  organizations,
  sites,
  deviceTimeStatus,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { deviceScopeCondition, siteScopeCondition } from '../aiToolsSiteScope';
import { getDeviceTimeStatusView, type DeviceTimeStatusView } from './view';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { fleetTimeFiltersSchema, type FleetTimeFilters } from './fleetFilters';
export { fleetTimeFiltersSchema, type FleetTimeFilters };
export interface FleetTimeRow {
  deviceId: string;
  hostname: string;
  orgId: string;
  orgName: string;
  siteId: string | null;
  siteName: string | null;
  view: DeviceTimeStatusView;
}
export interface FleetTimeDomain {
  orgId: string;
  domainDns: string;
  pdcEnrolled: boolean;
  pdcExpected: boolean;
  pdc: FleetTimeRow | null;
}
export interface FleetTimeResult {
  data: FleetTimeRow[];
  total: number;
  page: number;
  limit: number;
  domains: FleetTimeDomain[];
}
export class FleetTimeForbidden extends Error {
  constructor() {
    super('Access to this organization denied');
  }
}
const t = deviceTimeStatus;
const projection = {
  deviceId: devices.id,
  hostname: devices.hostname,
  orgId: devices.orgId,
  orgName: organizations.name,
  siteId: devices.siteId,
  siteName: sites.name,
};
const pdcRank = sql<number>`CASE WHEN ${t.domainRole}='forest_root_pdc_emulator' THEN 0 WHEN ${t.domainRole}='pdc_emulator' THEN 1 ELSE 2 END`;
const fleetOrder = [
  asc(devices.orgId),
  asc(t.domainDns),
  pdcRank,
  asc(devices.hostname),
  asc(devices.id),
];
// Policy-dependent findings and health are evaluated from the canonical device
// view. SQL limits only authorization and policy-independent candidate selection.
export function fleetScope(
  filters: FleetTimeFilters,
  auth: AuthContext,
  displayFilters = true,
): SQL | undefined {
  if (filters.orgId && !auth.canAccessOrg(filters.orgId))
    throw new FleetTimeForbidden();
  return and(
    auth.orgCondition(devices.orgId),
    siteScopeCondition(auth, devices.siteId),
    deviceScopeCondition(auth, devices.id),
    eq(devices.osType, 'windows'),
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
    filters.orgId ? eq(devices.orgId, filters.orgId) : undefined,
    filters.deviceId ? eq(devices.id, filters.deviceId) : undefined,
    displayFilters && filters.siteId
      ? eq(devices.siteId, filters.siteId)
      : undefined,
    displayFilters && filters.role ? eq(t.domainRole, filters.role) : undefined,
    displayFilters && filters.domain
      ? eq(t.domainDns, filters.domain)
      : undefined,
  );
}
export function fleetRowsQuery() {
  return db
    .select(projection)
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(t, eq(t.deviceId, devices.id));
}
async function hydrate(
  rows: Array<Omit<FleetTimeRow, 'view'>>,
): Promise<FleetTimeRow[]> {
  const result: FleetTimeRow[] = [];
  for (const row of rows) {
    const view = await getDeviceTimeStatusView(row.deviceId);
    if (view) result.push({ ...row, view });
  }
  return result;
}
type ParsedFleetFilters = ReturnType<typeof fleetTimeFiltersSchema.parse>;
// Every statically eligible candidate is hydrated through the same uncached,
// policy-aware view used for device display; finding/health filters are applied
// only after that. One pass is O(visible candidates), sequential on the ambient
// request connection. Any later batching must reuse the same resolver; never
// restore a SQL prefilter on policy findings. Callers that need every row (the
// CSV exports) consume this stream once rather than re-walking it per page.
async function* hydratedFleetRows(
  q: ParsedFleetFilters,
  where: SQL | undefined,
): AsyncGenerator<FleetTimeRow> {
  const batchSize = 200;
  for (let offset = 0; ; offset += batchSize) {
    const candidates = await fleetRowsQuery()
      .where(where)
      .orderBy(...fleetOrder)
      .limit(batchSize)
      .offset(offset);
    for (const row of await hydrate(candidates)) {
      if (q.health && row.view.health !== q.health) continue;
      if (
        q.finding &&
        !row.view.findings.some((finding) => finding.code === q.finding)
      )
        continue;
      yield row;
    }
    if (candidates.length < batchSize) break;
  }
}
/**
 * Every visible row that passes the health/finding filters, in report order,
 * ignoring page/limit. Throws FleetTimeForbidden synchronously (at call time).
 */
export function iterateFleetTimeRows(
  filters: FleetTimeFilters,
  auth: AuthContext,
): AsyncGenerator<FleetTimeRow> {
  const q = fleetTimeFiltersSchema.parse(filters);
  return hydratedFleetRows(
    q,
    and(
      fleetScope(q, auth),
      siteScopeCondition(auth, devices.siteId),
      deviceScopeCondition(auth, devices.id),
    ),
  );
}
export async function listFleetTimeStatus(
  filters: FleetTimeFilters,
  auth: AuthContext,
): Promise<FleetTimeResult> {
  const q = fleetTimeFiltersSchema.parse(filters),
    // Site + device axes named at the entry point (idempotent with fleetScope)
    // so the aiToolsDeviceScope/SiteScope contracts can verify this delegate.
    where = and(
      fleetScope(q, auth),
      siteScopeCondition(auth, devices.siteId),
      deviceScopeCondition(auth, devices.id),
    );
  let data: FleetTimeRow[] = [];
  let total = 0;
  const start = (q.page - 1) * q.limit;
  if (!q.health && !q.finding) {
    // No policy-dependent filter: the static candidate set IS the result set,
    // so the SQL count is exact and only the requested page is hydrated (still
    // through the canonical policy-aware view). The full pass below is reserved
    // for health/finding filters, where totals need every candidate resolved.
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .leftJoin(sites, eq(sites.id, devices.siteId))
      .leftJoin(t, eq(t.deviceId, devices.id))
      .where(where);
    total = count?.total ?? 0;
    data = await hydrate(
      await fleetRowsQuery()
        .where(where)
        .orderBy(...fleetOrder)
        .limit(q.limit)
        .offset(start),
    );
  } else {
    for await (const row of hydratedFleetRows(q, where)) {
      if (total >= start && data.length < q.limit) data.push(row);
      total += 1;
    }
  }
  const domains: FleetTimeDomain[] = [];
  const keys = [
    ...new Map(
      data
        .filter((r) => r.view.domain?.domainDns)
        .map((r) => [
          `${r.orgId}:${r.view.domain!.domainDns}`,
          { orgId: r.orgId, domainDns: r.view.domain!.domainDns! },
        ]),
    ).values(),
  ];
  if (keys.length) {
    const domainRows = await db
      .select({
        orgId: devices.orgId,
        domainDns: t.domainDns,
        pdcExpected: sql<boolean>`bool_or(${t.pdcName} IS NOT NULL)`,
        pdcId: sql<
          string | null
        >`(array_agg(${devices.id} ORDER BY ${pdcRank},${devices.id}) FILTER (WHERE ${t.domainRole} IN ('forest_root_pdc_emulator','pdc_emulator')))[1]`,
      })
      .from(devices)
      .innerJoin(t, eq(t.deviceId, devices.id))
      .where(
        and(
          fleetScope(q, auth, false),
          or(
            ...keys.map((k) =>
              and(eq(devices.orgId, k.orgId), eq(t.domainDns, k.domainDns)),
            ),
          ),
        ),
      )
      .groupBy(devices.orgId, t.domainDns);
    const ids = domainRows.flatMap((r) => (r.pdcId ? [r.pdcId] : []));
    const pdcs = ids.length
      ? await hydrate(
          await fleetRowsQuery().where(
            and(fleetScope(q, auth, false), inArray(devices.id, ids)),
          ),
        )
      : [];
    for (const row of domainRows) {
      const pdc = pdcs.find((p) => p.deviceId === row.pdcId) ?? null;
      domains.push({
        orgId: row.orgId,
        domainDns: row.domainDns!,
        pdcExpected: row.pdcExpected,
        pdcEnrolled: pdc !== null,
        pdc,
      });
    }
  }
  return { data, total, page: q.page, limit: q.limit, domains };
}
