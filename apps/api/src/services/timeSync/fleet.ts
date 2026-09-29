import { z } from 'zod';
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  TIME_SYNC_DOMAIN_ROLES,
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
  TIME_SYNC_HEALTH,
} from '@breeze/shared';
import windowsZones from '../../../../../packages/shared/src/data/windowsZones.json';
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
import { resolveExpectedTimezone } from './expectedTimezone';
export const fleetTimeFiltersSchema = z
  .object({
    health: z.enum(TIME_SYNC_HEALTH).optional(),
    finding: z.enum(TIME_SYNC_FINDING_CODES).optional(),
    role: z.enum(TIME_SYNC_DOMAIN_ROLES).optional(),
    orgId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    domain: z.string().min(1).max(255).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type FleetTimeFilters = z.input<typeof fleetTimeFiltersSchema>;
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
// Build the SQL lookup through the same pure resolver as ingest and the view.
// Source id/name affect provenance only; this synthetic site is never persisted.
const expectedWindowsByIana = Object.fromEntries(
  Object.keys(windowsZones.ianaToWindows).map((timezone) => [
    timezone,
    resolveExpectedTimezone({
      site: {
        id: '00000000-0000-4000-8000-000000000000',
        name: null,
        timezone,
      },
    })?.windowsId ?? null,
  ]),
);
const expectedWindows = sql<
  string | null
>`${JSON.stringify(expectedWindowsByIana)}::jsonb ->> ${sites.timezone}`;
export const fleetFindingCodes = sql<
  string[]
>`array_remove(coalesce(${t.findings},'{}'::text[]),'timezone_mismatch') || CASE WHEN ${t.deviceId} IS NOT NULL AND ${expectedWindows} IS NOT NULL AND ${t.timezoneAutoUpdate}<>'on' AND ${t.timezoneWindowsId} IS DISTINCT FROM ${expectedWindows} THEN ARRAY['timezone_mismatch']::text[] ELSE '{}'::text[] END`;
const critical = TIME_SYNC_FINDING_CODES.filter(
  (c) => TIME_SYNC_FINDING_SEVERITY[c] === 'critical',
);
const warning = TIME_SYNC_FINDING_CODES.filter(
  (c) => TIME_SYNC_FINDING_SEVERITY[c] === 'warning',
);
export const fleetHealth = sql<string>`CASE WHEN ${fleetFindingCodes} && ARRAY[${sql.join(
  critical.map((c) => sql`${c}`),
  sql`, `,
)}]::text[] THEN 'critical' WHEN ${fleetFindingCodes} && ARRAY[${sql.join(
  warning.map((c) => sql`${c}`),
  sql`, `,
)}]::text[] THEN 'warning' WHEN ${t.deviceId} IS NULL OR (${t.statusMethod}='unavailable' AND cardinality(${fleetFindingCodes})=0) THEN 'unknown' ELSE 'healthy' END`;
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
    filters.orgId ? eq(devices.orgId, filters.orgId) : undefined,
    filters.deviceId ? eq(devices.id, filters.deviceId) : undefined,
    displayFilters && filters.siteId
      ? eq(devices.siteId, filters.siteId)
      : undefined,
    displayFilters && filters.role ? eq(t.domainRole, filters.role) : undefined,
    displayFilters && filters.domain
      ? eq(t.domainDns, filters.domain)
      : undefined,
    displayFilters && filters.health
      ? sql`${fleetHealth}=${filters.health}`
      : undefined,
    displayFilters && filters.finding
      ? sql`${filters.finding}=ANY(${fleetFindingCodes})`
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
export async function listFleetTimeStatus(
  filters: FleetTimeFilters,
  auth: AuthContext,
): Promise<FleetTimeResult> {
  const q = fleetTimeFiltersSchema.parse(filters),
    where = fleetScope(q, auth);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(devices)
    .leftJoin(t, eq(t.deviceId, devices.id))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .where(where);
  const data = await hydrate(
    await fleetRowsQuery()
      .where(where)
      .orderBy(
        asc(devices.orgId),
        asc(t.domainDns),
        pdcRank,
        asc(devices.hostname),
        asc(devices.id),
      )
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
  );
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
  return {
    data,
    total: count?.total ?? 0,
    page: q.page,
    limit: q.limit,
    domains,
  };
}
