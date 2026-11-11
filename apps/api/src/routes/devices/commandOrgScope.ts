import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { deviceCommands, deviceOwnershipEpochs } from '../../db/schema';

/**
 * The start of the device's latest tenure among the epochs a query selects.
 *
 * Only `device_move` and `unspecified` epochs start a tenure. `org_merge` is
 * deliberately absent: a merge hands the merged-away organization's device
 * history to the survivor, so it continues a tenure rather than starting one.
 *
 * Text, not a `Date`: the column has microsecond precision and a JS `Date`
 * would round the boundary down past a row written just before it.
 */
function latestTenureStart() {
  return sql<string | null>`(max(${deviceOwnershipEpochs.startedAt}) FILTER (WHERE ${deviceOwnershipEpochs.cause} IN ('device_move', 'unspecified')))::text`;
}

function commandsBelongingTo(orgIds: string[], tenureStart: string | null): SQL {
  const unstamped = isNull(deviceCommands.submittedOrgId);
  // created_at has no zone and is written by the column's now() default in the
  // session zone; comparing it to a timestamptz reads it back in that same zone.
  return or(
    inArray(deviceCommands.submittedOrgId, orgIds),
    tenureStart === null
      ? unstamped
      : and(unstamped, sql`${deviceCommands.createdAt} >= ${tenureStart}::timestamptz`),
  )!;
}

/**
 * The condition that scopes a read of a device's `device_commands` rows to the
 * device's current organization.
 *
 * `device_commands` has no `org_id`, and a device org move leaves its rows in
 * place, so a device id alone selects the history of every organization the
 * device has belonged to. What a row carries instead is `submitted_org_id`, the
 * device's organization when the row was queued:
 *
 *  - Stamped with the current organization: in scope. That includes a device
 *    back in an organization it had left, whose earlier rows are its own.
 *  - NULL: nothing on the row says whose it is. It may predate the column, come
 *    from a caller that does not stamp it, or have lost its stamp when its
 *    organization was erased. It is in scope only if it was written during the
 *    current tenure, which the device's ownership epochs bound.
 *  - Stamped with anything else: out of scope, unless that organization was
 *    merged into the current one and the device arrived through a merge.
 *
 * `device` must be the access-checked row the route already loaded. Call this
 * once per request, on the caller's connection. Only a device that reached its
 * organization through a merge needs more: `org_merge_events` and the
 * merged-away organization's epochs are not visible to an org-scoped session,
 * so that path takes the partner-axis escape.
 */
export async function deviceCommandsInCurrentOrg(device: { id: string; orgId: string }): Promise<SQL> {
  const [own] = await db
    .select({
      epochCount: sql<number>`count(*)::int`,
      tenureStart: latestTenureStart(),
      viaMerge: sql<boolean>`coalesce(bool_or(${deviceOwnershipEpochs.cause} = 'org_merge'), false)`,
    })
    .from(deviceOwnershipEpochs)
    .where(and(eq(deviceOwnershipEpochs.deviceId, device.id), eq(deviceOwnershipEpochs.orgId, device.orgId)));

  // Every device has an epoch in its current organization (written by trigger).
  // None visible means the tenure could not be read, not that it is unbounded,
  // so unstamped rows stay out rather than falling through as in scope.
  if (!own || own.epochCount === 0) {
    console.warn(`[devices] no ownership epoch visible for device ${device.id}; hiding its unstamped command rows`);
    return eq(deviceCommands.submittedOrgId, device.orgId);
  }

  if (!own.viaMerge) {
    return commandsBelongingTo([device.orgId], own.tenureStart);
  }

  const { lineage, tenureStart } = await readWithPartnerAxisVisibility(async () => {
    const rows = await db.execute(sql`
      WITH RECURSIVE lineage(org_id) AS (
        SELECT ${device.orgId}::uuid
        UNION
        SELECT e.loser_org_id FROM org_merge_events e JOIN lineage l ON e.survivor_org_id = l.org_id
      )
      SELECT org_id FROM lineage
    `);
    const [whole] = await db
      .select({ tenureStart: latestTenureStart() })
      .from(deviceOwnershipEpochs)
      .where(eq(deviceOwnershipEpochs.deviceId, device.id));
    return {
      lineage: Array.from(rows as unknown as Iterable<{ org_id: string }>, (row) => row.org_id),
      tenureStart: whole?.tenureStart ?? null,
    };
  });
  return commandsBelongingTo(lineage, tenureStart);
}
