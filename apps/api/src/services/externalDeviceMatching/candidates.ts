import { and, inArray, isNotNull, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { deviceNetwork, devices } from '../../db/schema';
import type { ProviderSyncTx } from '../backupProviders/persist';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { normalizeMatchName, type MatchCandidate } from './resolve';

function normalizeExact(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * SQL twin of the caller's name normalizer for a devices column:
 * `lower(btrim(col))`, and with `shortenFqdn` also `split_part(…, '.', 1)`
 * (twin of `normalizeMatchName`). The candidate filter MUST use this rather
 * than a bare `lower(col)`, or a device stored as `ws-01.corp` is never loaded
 * for vendor name `ws-01`.
 */
export function deviceMatchNameSql(
  column: AnyColumn | SQL,
  opts: { shortenFqdn: boolean },
): SQL<string> {
  return opts.shortenFqdn
    ? sql<string>`split_part(lower(btrim(${column})), '.', 1)`
    : sql<string>`lower(btrim(${column}))`;
}

/**
 * Candidate devices (and their MACs) for a batch of vendor rows, shared by the
 * backup and EDR matchers.
 *
 * `names` must already be normalized with the same rule as `opts.shortenFqdn`.
 * `claimed` supplies the per-table "already linked" correlated EXISTS (the
 * partial unique index on the link column is global, so it must span the whole
 * table, not one connection). Decommissioned and parked devices are never
 * candidates.
 */
export async function loadCandidateDevices(
  tx: ProviderSyncTx,
  orgIds: string[],
  names: string[],
  claimed: (deviceIdColumn: SQL) => SQL<boolean>,
  opts: { shortenFqdn: boolean },
): Promise<MatchCandidate[]> {
  if (orgIds.length === 0 || names.length === 0) return [];

  const candidateRows = await tx
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      claimed: claimed(sql`${devices.id}`),
    })
    .from(devices)
    .where(and(
      inArray(devices.orgId, orgIds),
      ne(devices.status, 'decommissioned'),
      // A device parked in a holding org is never linked to a vendor row.
      notParkedDeviceCondition(),
      or(
        inArray(deviceMatchNameSql(devices.hostname, opts), names),
        inArray(deviceMatchNameSql(devices.displayName, opts), names),
      ),
    ));

  const macRows = candidateRows.length === 0 ? [] : await tx
    .select({ deviceId: deviceNetwork.deviceId, mac: sql<string>`lower(${deviceNetwork.macAddress})` })
    .from(deviceNetwork)
    .where(and(
      inArray(deviceNetwork.deviceId, candidateRows.map((c) => c.deviceId)),
      isNotNull(deviceNetwork.macAddress),
    ));

  const macsByDevice = new Map<string, string[]>();
  for (const row of macRows) {
    const bucket = macsByDevice.get(row.deviceId);
    if (bucket) bucket.push(row.mac);
    else macsByDevice.set(row.deviceId, [row.mac]);
  }

  const normalize = opts.shortenFqdn ? normalizeMatchName : normalizeExact;
  const nameSet = new Set(names);
  const candidates: MatchCandidate[] = [];
  for (const row of candidateRows) {
    for (const raw of [row.hostname, row.displayName]) {
      const matchName = normalize(raw);
      if (!matchName || !nameSet.has(matchName)) continue;
      candidates.push({
        deviceId: row.deviceId,
        orgId: row.orgId,
        matchName,
        macAddresses: macsByDevice.get(row.deviceId) ?? [],
        claimed: row.claimed,
      });
    }
  }
  return candidates;
}
