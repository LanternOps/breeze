import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { devices, edrEndpoints } from '../../db/schema';
import { isPgForeignKeyViolation, isPgUniqueViolation } from '../../utils/pgErrors';
import {
  deviceMatchNameSql,
  loadCandidateDevices,
  normalizeMatchName,
  resolveDeviceMatches,
} from '../externalDeviceMatching';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import type { EdrSyncTx } from './persist';

/*
 * Match EDR endpoints to Breeze devices (sync Phase 3). Mirrors
 * backupProviders/deviceMatching.ts step for step, on `edr_endpoints`, with the
 * EDR differences:
 *  - names are compared by their FIRST LABEL (GravityZone reports FQDNs), via
 *    `normalizeMatchName` / `deviceMatchNameSql(..., { shortenFqdn: true })`;
 *  - the "already linked" test is scoped to THIS CONNECTION, matching the
 *    per-connection partial unique index (a device may run two products);
 *  - the stale-link check is a Drizzle-builder statement so it can carry the
 *    parked-device predicate (a device that became parked loses its auto link).
 *
 * LOCK ORDER (40P01, W01a review): linking writes `edr_endpoints.breeze_device_id`,
 * whose composite FK takes a KEY SHARE lock on the `devices` row, while a device
 * hard delete / org move locks the devices row FOR UPDATE and THEN updates
 * edr_endpoints / edr_detections -- the opposite order. Either side can be the
 * deadlock victim; the sync job retries Phase 3 on `isDeadlockError` (persist.ts).
 * The write below is savepointed so a 23505/23503 race is counted, not fatal.
 */

/** The row's match name: first label of hostname, falling back to fqdn. */
export function endpointMatchName(hostname: string | null, fqdn: string | null): string | null {
  return normalizeMatchName(hostname && hostname.trim() ? hostname : fqdn);
}

/** SQL twin of {@link endpointMatchName} for the stale-link check. */
const ENDPOINT_MATCH_NAME_SQL: SQL<string> = deviceMatchNameSql(
  sql`coalesce(nullif(btrim(${edrEndpoints.hostname}), ''), ${edrEndpoints.fqdn})`,
  { shortenFqdn: true },
);

export async function matchEdrEndpoints(
  tx: EdrSyncTx,
  connectionId: string,
): Promise<{ linked: number; ambiguous: number }> {
  // 1. Stale auto links: the device must still exist in the row's org, not be
  //    decommissioned, not be parked, and still answer to the row's match name.
  await tx
    .update(edrEndpoints)
    .set({ breezeDeviceId: null, deviceMatchSource: null, updatedAt: new Date() })
    .where(and(
      eq(edrEndpoints.connectionId, connectionId),
      inArray(edrEndpoints.deviceMatchSource, ['auto_hostname', 'auto_mac']),
      sql`(
        ${edrEndpoints.breezeDeviceId} IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM ${devices}
          WHERE ${devices.id} = ${edrEndpoints.breezeDeviceId}
            AND ${devices.orgId} = ${edrEndpoints.orgId}
            AND ${devices.status} <> 'decommissioned'
            AND ${notParkedDeviceCondition()}
            AND (
              ${deviceMatchNameSql(devices.hostname, { shortenFqdn: true })} = ${ENDPOINT_MATCH_NAME_SQL}
              OR ${deviceMatchNameSql(devices.displayName, { shortenFqdn: true })} = ${ENDPOINT_MATCH_NAME_SQL}
            )
        )
      )`,
    ));

  // 2. Manual links are validated for existence only; the FK nulled a hard-deleted
  //    device's id, so clear the orphaned source marker.
  await tx
    .update(edrEndpoints)
    .set({ deviceMatchSource: null, updatedAt: new Date() })
    .where(and(
      eq(edrEndpoints.connectionId, connectionId),
      eq(edrEndpoints.deviceMatchSource, 'manual'),
      isNull(edrEndpoints.breezeDeviceId),
    ));

  // 3. Unlinked, non-manual targets.
  const targets = await tx
    .select({
      id: edrEndpoints.id,
      orgId: edrEndpoints.orgId,
      hostname: edrEndpoints.hostname,
      fqdn: edrEndpoints.fqdn,
      macAddresses: edrEndpoints.macAddresses,
    })
    .from(edrEndpoints)
    .where(and(
      eq(edrEndpoints.connectionId, connectionId),
      sql`${edrEndpoints.deviceMatchSource} IS DISTINCT FROM 'manual'`,
      isNull(edrEndpoints.breezeDeviceId),
    ));

  const named = targets
    .map((t) => ({
      id: t.id,
      orgId: t.orgId,
      matchName: endpointMatchName(t.hostname, t.fqdn),
      macAddresses: t.macAddresses ?? [],
    }))
    .filter((t): t is typeof t & { matchName: string } => t.matchName !== null);
  if (named.length === 0) {
    return { linked: await countLinked(tx, connectionId), ambiguous: 0 };
  }

  const orgIds = [...new Set(named.map((t) => t.orgId))];
  const names = [...new Set(named.map((t) => t.matchName))];

  // `claimed` is scoped to THIS connection to match the per-connection partial
  // unique index; a device linked by another connection's product stays free.
  const candidates = await loadCandidateDevices(
    tx,
    orgIds,
    names,
    (deviceIdColumn) => sql<boolean>`EXISTS (
      SELECT 1 FROM edr_endpoints x
      WHERE x.breeze_device_id = ${deviceIdColumn} AND x.connection_id = ${connectionId}::uuid
    )`,
    { shortenFqdn: true },
  );

  const { links, ambiguous } = resolveDeviceMatches(named, candidates);

  if (links.length > 0) {
    try {
      // SAVEPOINT: a concurrent sync of ANOTHER connection (different advisory
      // lock) can take the same device between the candidate read and this write.
      await tx.transaction(async (inner) => {
        const values = sql.join(
          links.map((l) => sql`(${l.rowId}::uuid, ${l.deviceId}::uuid, ${l.source})`),
          sql`, `,
        );
        await inner.execute(sql`
          UPDATE edr_endpoints AS e
          SET breeze_device_id = v.device_id, device_match_source = v.source, updated_at = now()
          FROM (VALUES ${values}) AS v(endpoint_id, device_id, source)
          WHERE e.id = v.endpoint_id
            AND e.connection_id = ${connectionId}::uuid
            AND e.breeze_device_id IS NULL
            AND e.device_match_source IS DISTINCT FROM 'manual'
        `);
      });
    } catch (error) {
      // 23505: uniqueness race. 23503: the device was deleted/moved between read and write.
      if (!isPgUniqueViolation(error) && !isPgForeignKeyViolation(error)) throw error;
      console.warn(
        `[EdrProviderSync] device link batch for connection ${connectionId} lost a race `
        + `(${links.length} link(s) skipped); the next sync retries`,
      );
      return {
        linked: await countLinked(tx, connectionId),
        ambiguous: ambiguous.length + links.length,
      };
    }
  }

  return { linked: await countLinked(tx, connectionId), ambiguous: ambiguous.length };
}

async function countLinked(tx: EdrSyncTx, connectionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(edrEndpoints)
    .where(and(eq(edrEndpoints.connectionId, connectionId), isNotNull(edrEndpoints.breezeDeviceId)));
  return row?.n ?? 0;
}
