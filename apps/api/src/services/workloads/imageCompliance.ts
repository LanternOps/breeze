/**
 * Container image term of patch compliance (workload inventory W06, #8195,
 * spec §10.1, OD-2 option b).
 *
 * `containerImageComplianceTerms` is the ONE place that turns stored
 * `device_workloads.upstream_status` values into compliance counts. Every
 * compute site (device %, org % and compliant-device count, the CSV report,
 * and — through the API's numbers — the web fallback) calls it, then folds the
 * counts in with `compliancePercentWithImageTerm` from `@breeze/shared`.
 *
 * Per device it counts DISTINCT image `repository:tag` pairs on container rows
 * (replicas, and the same image under several runtimes, count once). When
 * replicas of one image disagree, the worst wins: any replica `behind` makes
 * the image stale; else any unknown-class replica makes it unknown (an image
 * is never current while part of it is unchecked); else a `current` replica
 * makes it current. `pinned`, `local` and `not_found` rows are neither. VM and
 * LXC rows are never images. Devices with nothing to count are absent from
 * the result, so callers can leave their output untouched for them.
 *
 * Runs in the caller's DB context (RLS applies); `securityPosture.ts` and the
 * patch-compliance alert handler deliberately do not use it.
 */
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { WORKLOAD_UPSTREAM_UNKNOWN_STATUSES, type ContainerImageComplianceTerms } from '@breeze/shared';
import { db } from '../../db';
import { devices, deviceWorkloads } from '../../db/schema';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';

export type ContainerImageComplianceScope =
  | { deviceIds: readonly string[] }
  | { orgIds: readonly string[]; siteIds?: readonly string[] };

/** One jsonb bind regardless of list size (Postgres caps a statement at 65,535 binds). */
const uuidList = (ids: readonly string[]): SQL =>
  sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;

export async function containerImageComplianceTerms(
  scope: ContainerImageComplianceScope,
): Promise<Map<string, ContainerImageComplianceTerms>> {
  const result = new Map<string, ContainerImageComplianceTerms>();
  const conditions: SQL[] = [
    eq(deviceWorkloads.kind, 'container'),
    isNotNull(deviceWorkloads.imageRepository),
    isNotNull(deviceWorkloads.imageTag),
  ];
  if ('deviceIds' in scope) {
    if (scope.deviceIds.length === 0) return result;
    conditions.push(sql`${deviceWorkloads.deviceId} IN ${uuidList(scope.deviceIds)}`);
  } else {
    if (scope.orgIds.length === 0 || scope.siteIds?.length === 0) return result;
    // The same device population as the patch-compliance report: no Quick
    // Support (ephemeral) devices, nothing parked in the unassigned pool.
    conditions.push(
      sql`${devices.orgId} IN ${uuidList(scope.orgIds)}`,
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
    );
    if (scope.siteIds) conditions.push(inArray(devices.siteId, [...scope.siteIds]));
  }

  const unknown = sql.join(WORKLOAD_UPSTREAM_UNKNOWN_STATUSES.map((s) => sql`${s}`), sql`, `);
  const images = db
    .select({
      deviceId: deviceWorkloads.deviceId,
      anyBehind: sql<boolean>`bool_or(${deviceWorkloads.upstreamStatus} = 'behind')`.as('any_behind'),
      anyUnknown: sql<boolean>`bool_or(${deviceWorkloads.upstreamStatus} IN (${unknown}))`.as('any_unknown'),
      anyCurrent: sql<boolean>`bool_or(${deviceWorkloads.upstreamStatus} = 'current')`.as('any_current'),
    })
    .from(deviceWorkloads)
    .innerJoin(devices, and(eq(devices.id, deviceWorkloads.deviceId), eq(devices.orgId, deviceWorkloads.orgId)))
    .where(and(...conditions))
    .groupBy(deviceWorkloads.deviceId, deviceWorkloads.imageRepository, deviceWorkloads.imageTag)
    .as('images');

  const rows = await db
    .select({
      deviceId: images.deviceId,
      stale: sql<number>`count(*) FILTER (WHERE ${images.anyBehind})`,
      unknown: sql<number>`count(*) FILTER (WHERE NOT ${images.anyBehind} AND ${images.anyUnknown})`,
      current: sql<number>`count(*) FILTER (WHERE NOT ${images.anyBehind} AND NOT ${images.anyUnknown} AND ${images.anyCurrent})`,
    })
    .from(images)
    .groupBy(images.deviceId);

  for (const row of rows) {
    const terms = { stale: Number(row.stale), current: Number(row.current), unknown: Number(row.unknown) };
    if (terms.stale + terms.current + terms.unknown > 0) result.set(row.deviceId, terms);
  }
  return result;
}

/** Sum per-device terms (org %, report); null when no device has anything to count. */
export function sumContainerImageTerms(
  terms: Iterable<ContainerImageComplianceTerms>,
): ContainerImageComplianceTerms | null {
  let total: ContainerImageComplianceTerms | null = null;
  for (const t of terms) {
    total ??= { stale: 0, current: 0, unknown: 0 };
    total.stale += t.stale;
    total.current += t.current;
    total.unknown += t.unknown;
  }
  return total;
}

/**
 * A view filtered by severity, source or update ring is about patches with
 * those properties; an image has none of them, so the term is excluded.
 */
export function imageTermAppliesToView(filters: {
  severity?: string | null;
  source?: string | null;
  ringId?: string | null;
}): boolean {
  return !filters.severity && !filters.source && !filters.ringId;
}
